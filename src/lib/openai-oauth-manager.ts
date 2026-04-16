/**
 * openai-oauth-manager.ts — Token lifecycle management + local callback server.
 *
 * Manages OAuth tokens in SQLite, handles lazy refresh, and runs a temporary
 * HTTP server on port 1455 to receive the OAuth callback.
 */

import { createServer, type Server } from 'node:http';
import { getSetting, setSetting } from './db';
import {
  type OAuthTokens,
  CALLBACK_PORT,
  prepareOAuthFlow,
  exchangeCodeForTokens,
  refreshTokens,
  parseIdTokenClaims,
  extractAccountId,
} from './openai-oauth';

// ── Settings Keys ──────────────────────────────────────────────

const KEYS = {
  accessToken: 'openai_oauth_access_token',
  refreshToken: 'openai_oauth_refresh_token',
  idToken: 'openai_oauth_id_token',
  expiresAt: 'openai_oauth_expires_at',
  email: 'openai_oauth_email',
  plan: 'openai_oauth_plan',
  accountId: 'openai_oauth_account_id',
  lastError: 'openai_oauth_last_error',
} as const;

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ── Token Persistence ──────────────────────────────────────────

export interface OpenAIOAuthStatus {
  authenticated: boolean;
  email?: string;
  plan?: string;
  accountId?: string;
  /** True when token is near/past expiry but a refresh token exists */
  needsRefresh?: boolean;
  oauthError?: string;
}

export function getOAuthStatus(): OpenAIOAuthStatus {
  const accessToken = getSetting(KEYS.accessToken);
  if (!accessToken) {
    return {
      authenticated: false,
      oauthError: getSetting(KEYS.lastError) || undefined,
    };
  }

  // Check if token is expired and no refresh token available
  const expiresAt = Number(getSetting(KEYS.expiresAt) || '0');
  const refreshToken = getSetting(KEYS.refreshToken);
  if (expiresAt && Date.now() > expiresAt && !refreshToken) {
    // Token expired with no way to refresh — treat as unauthenticated
    clearOAuthTokens();
    return { authenticated: false };
  }

  // If token is expired but refresh token exists, report authenticated
  // (ensureTokenFresh will refresh it when needed)
  const needsRefresh = expiresAt > 0 && Date.now() > expiresAt - REFRESH_BUFFER_MS;

  return {
    authenticated: true,
    email: getSetting(KEYS.email),
    plan: getSetting(KEYS.plan),
    accountId: getSetting(KEYS.accountId),
    needsRefresh,
    oauthError: undefined,
  };
}

/**
 * Synchronous status check — returns false for expired tokens even if
 * a refresh token exists (since refresh is async). Use ensureTokenFresh()
 * for async callers that can wait for refresh.
 */
export function isOAuthUsable(): boolean {
  const accessToken = getSetting(KEYS.accessToken);
  if (!accessToken) return false;
  const expiresAt = Number(getSetting(KEYS.expiresAt) || '0');
  if (expiresAt && Date.now() > expiresAt) {
    // Expired — only usable if refresh token exists (caller must refresh async)
    return !!getSetting(KEYS.refreshToken);
  }
  return true;
}

export function getOAuthCredentialsSync(): { accessToken: string; accountId?: string } | undefined {
  const accessToken = getSetting(KEYS.accessToken);
  if (!accessToken) return undefined;

  const expiresAt = getSetting(KEYS.expiresAt);
  if (expiresAt && Date.now() > Number(expiresAt)) {
    return undefined;
  }

  return { accessToken, accountId: getSetting(KEYS.accountId) || undefined };
}

export async function ensureTokenFresh(): Promise<{ accessToken: string; accountId?: string } | undefined> {
  const accessToken = getSetting(KEYS.accessToken);
  if (!accessToken) return undefined;

  const expiresAt = Number(getSetting(KEYS.expiresAt) || '0');
  if (expiresAt && Date.now() < expiresAt - REFRESH_BUFFER_MS) {
    return { accessToken, accountId: getSetting(KEYS.accountId) || undefined };
  }

  const refreshToken = getSetting(KEYS.refreshToken);
  if (!refreshToken) {
    clearOAuthTokens();
    return undefined;
  }

  try {
    console.log('[openai-oauth] Refreshing tokens...');
    const newTokens = await refreshTokens(refreshToken);
    saveTokens(newTokens);
    console.log('[openai-oauth] Tokens refreshed successfully');
    return {
      accessToken: newTokens.accessToken,
      accountId: getSetting(KEYS.accountId) || undefined,
    };
  } catch (err) {
    console.error('[openai-oauth] Token refresh failed:', err);
    clearOAuthTokens();
    return undefined;
  }
}

function saveTokens(tokens: OAuthTokens): void {
  setSetting(KEYS.accessToken, tokens.accessToken);
  setSetting(KEYS.idToken, tokens.idToken);
  if (tokens.refreshToken) setSetting(KEYS.refreshToken, tokens.refreshToken);
  if (tokens.expiresAt) setSetting(KEYS.expiresAt, String(tokens.expiresAt));
  setSetting(KEYS.lastError, '');

  const claims = parseIdTokenClaims(tokens.idToken);
  if (claims.email) setSetting(KEYS.email, claims.email);

  const authClaims = claims['https://api.openai.com/auth'];
  const plan = claims.chatgpt_plan_type || authClaims?.chatgpt_plan_type;
  const accountId = extractAccountId(claims);
  if (plan) setSetting(KEYS.plan, plan);
  if (accountId) setSetting(KEYS.accountId, accountId);
}

export function clearOAuthTokens(): void {
  for (const key of Object.values(KEYS)) {
    setSetting(key, '');
  }
}

/**
 * Cancel any in-progress OAuth flow and clean up.
 * Safe to call even when no flow is pending.
 */
export async function cancelOAuthFlow(): Promise<void> {
  const pendingEntries = Object.values(getPendingOAuthMap());
  for (const pending of pendingEntries) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('OAuth flow cancelled by user'));
  }
  oauthState.pendingOAuthByState = {};
  await stopOAuthServer();
}

// ── OAuth Flow Orchestration ───────────────────────────────────

interface PendingOAuth {
  codeVerifier: string;
  state: string;
  resolve: (accessToken: string) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// Use globalThis to survive Next.js HMR / module re-evaluation in dev mode.
// Without this, hot reload would orphan the callback server and lose pending state.
interface OAuthGlobalState {
  oauthServer?: Server;
  pendingOAuthByState?: Record<string, PendingOAuth>;
}
const GLOBAL_KEY = '__codepilot_openai_oauth__' as const;
const g = globalThis as unknown as Record<string, OAuthGlobalState>;
if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = {};
const oauthState = g[GLOBAL_KEY];

// Convenience accessors — all reads/writes go through oauthState
function getOAuthServer(): Server | undefined { return oauthState.oauthServer; }
function setOAuthServer(s: Server | undefined) { oauthState.oauthServer = s; }
function getPendingOAuthMap(): Record<string, PendingOAuth> {
  if (!oauthState.pendingOAuthByState) oauthState.pendingOAuthByState = {};
  return oauthState.pendingOAuthByState;
}
function getPendingOAuthCount(): number {
  return Object.keys(getPendingOAuthMap()).length;
}
function getPendingOAuthByState(state: string): PendingOAuth | undefined {
  return getPendingOAuthMap()[state];
}
function setPendingOAuth(state: string, pending: PendingOAuth): void {
  getPendingOAuthMap()[state] = pending;
}
function clearPendingOAuth(state: string): PendingOAuth | undefined {
  const pendingMap = getPendingOAuthMap();
  const pending = pendingMap[state];
  if (!pending) return undefined;
  delete pendingMap[state];
  return pending;
}

/**
 * Start the OAuth flow: prepare PKCE, start callback server, return auth URL.
 * MUST be awaited — the server needs to be listening before opening the browser.
 */
export async function startOAuthFlow(): Promise<{ authUrl: string; completion: Promise<string> }> {
  const flow = prepareOAuthFlow();
  setSetting(KEYS.lastError, '');

  // Start callback server and WAIT for it to be listening
  await startOAuthServer();

  const completion = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = clearPendingOAuth(flow.state);
      if (pending) {
        reject(new Error('OAuth callback timeout'));
        if (getPendingOAuthCount() === 0) {
          stopOAuthServer();
        }
      }
    }, 5 * 60 * 1000);

    setPendingOAuth(flow.state, {
      codeVerifier: flow.codeVerifier,
      state: flow.state,
      timeout,
      resolve: (token) => { clearTimeout(timeout); resolve(token); },
      reject: (err) => { clearTimeout(timeout); reject(err); },
    });
  });

  return { authUrl: flow.authUrl, completion };
}

// ── Callback Server ────────────────────────────────────────────

async function startOAuthServer(): Promise<void> {
  if (getOAuthServer()) return;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${CALLBACK_PORT}`);

    if (url.pathname !== '/auth/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDesc = url.searchParams.get('error_description');

    if (error) {
      const msg = errorDesc || error;
      setSetting(KEYS.lastError, msg);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(errorHtml(msg));
      if (state) {
        const pending = clearPendingOAuth(state);
        pending?.reject(new Error(msg));
      }
      if (getPendingOAuthCount() === 0) {
        stopOAuthServer();
      }
      return;
    }

    const pending = state ? getPendingOAuthByState(state) : undefined;
    if (!code || !state || !pending) {
      const msg = !code ? 'Missing authorization code' : 'Invalid or expired state';
      setSetting(KEYS.lastError, msg);
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(errorHtml(msg));
      if (getPendingOAuthCount() === 0) {
        stopOAuthServer();
      }
      return;
    }

    clearPendingOAuth(state);

    // Exchange code for tokens FIRST, then show result to user
    try {
      const tokens = await exchangeCodeForTokens(code, pending.codeVerifier);
      saveTokens(tokens);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(successHtml());
      pending.resolve(tokens.accessToken);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSetting(KEYS.lastError, `Token exchange failed: ${message}`);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(errorHtml(`Token exchange failed: ${message}`));
      pending.reject(err instanceof Error ? err : new Error(message));
    }

    if (getPendingOAuthCount() === 0) {
      stopOAuthServer();
    }
  });

  setOAuthServer(server);

  // Wait for the server to actually be listening before returning
  // Bind to localhost only — no need to expose to LAN
  await new Promise<void>((resolve, reject) => {
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      console.log(`[openai-oauth] Callback server listening on 127.0.0.1:${CALLBACK_PORT}`);
      resolve();
    });
    server.on('error', (err) => {
      console.error(`[openai-oauth] Callback server failed to start:`, err);
      setOAuthServer(undefined);
      reject(err);
    });
  });
}

function stopOAuthServer(): Promise<void> {
  return new Promise((resolve) => {
    const server = getOAuthServer();
    if (server) {
      server.close(() => {
        console.log('[openai-oauth] Callback server stopped');
        resolve();
      });
      setOAuthServer(undefined);
    } else {
      resolve();
    }
  });
}

// ── HTML Responses ─────────────────────────────────────────────

function successHtml(): string {
  return `<!DOCTYPE html><html><head><title>Login Successful</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;}
.card{text-align:center;padding:2rem;border-radius:12px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,0.1);}
h1{color:#10b981;font-size:1.5rem;}p{color:#6b7280;}</style></head>
<body><div class="card"><h1>✓ Login Successful</h1><p>You can close this tab and return to CodePilot.</p></div>
<script>setTimeout(()=>window.close(),2000)</script></body></html>`;
}

function errorHtml(message: string): string {
  const safe = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><head><title>Login Failed</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;}
.card{text-align:center;padding:2rem;border-radius:12px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,0.1);}
h1{color:#ef4444;font-size:1.5rem;}p{color:#6b7280;}</style></head>
<body><div class="card"><h1>✗ Login Failed</h1><p>${safe}</p></div></body></html>`;
}
