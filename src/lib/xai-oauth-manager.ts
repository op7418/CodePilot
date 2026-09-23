/** xAI OAuth lifecycle: atomic bundle persistence, refresh single-flight, browser/device login. */
import { createServer, type Server } from 'node:http';
import { getSetting, setSetting } from './db';
import { envProxyFetch } from './env-proxy-fetch';
import { ProviderTransportError } from './provider-transport-error';
import {
  XAI_GROK_BUILD_API_BASE_URL,
  XAI_GROK_BUILD_AUTHENTICATE_RESPONSE,
  XAI_GROK_BUILD_CLIENT_IDENTIFIER,
  XAI_GROK_BUILD_CLIENT_MODE,
  XAI_GROK_BUILD_CLIENT_VERSION,
  XAI_GROK_BUILD_RESPONSES_PATH,
  XAI_GROK_BUILD_TOKEN_HEADER,
  XAI_OAUTH_CALLBACK_HOST,
  XAI_OAUTH_CALLBACK_PATH,
  accessTokenIsExpiring,
  buildXaiOAuthRedirectUri,
  exchangeXaiAuthorizationCode,
  parseJwtClaims,
  pollXaiDeviceTokens,
  prepareXaiBrowserFlow,
  refreshXaiTokens,
  requestXaiDeviceAuthorization,
  XaiOAuthTokenError,
  type XaiDeviceAuthorization,
  type XaiOAuthTokenBundle,
  type XaiOAuthTokenResponse,
} from './xai-oauth';

export const XAI_OAUTH_BUNDLE_SETTING = 'xai_oauth_bundle';
const BROWSER_TIMEOUT_MS = 5 * 60 * 1000;
const ALLOWED_CALLBACK_ORIGINS = new Set(['https://auth.x.ai', 'https://accounts.x.ai']);

export function isXaiOAuthEnabled(): boolean {
  return process.env.CODEPILOT_XAI_OAUTH_ENABLED !== '0';
}

export interface XaiOAuthStatus {
  enabled: boolean;
  authenticated: boolean;
  email?: string;
  expiresAt?: number;
  needsRefresh?: boolean;
  loginPending?: 'browser' | 'device';
  disabledReason?: string;
  error?: string;
  accountUrl: string;
}

interface PendingBrowser {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  controller: AbortController;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface XaiOAuthGlobalState {
  server?: Server;
  pendingBrowser?: PendingBrowser;
  /** Remains set while callback token exchange is in flight. */
  browserController?: AbortController;
  browserTimeout?: ReturnType<typeof setTimeout>;
  deviceController?: AbortController;
  deviceCompletion?: Promise<void>;
  refreshPromise?: Promise<XaiOAuthTokenBundle | undefined>;
  lastError?: string;
}

const GLOBAL_KEY = '__codepilot_xai_oauth__';
const globals = globalThis as unknown as Record<string, XaiOAuthGlobalState>;
if (!globals[GLOBAL_KEY]) globals[GLOBAL_KEY] = {};
const state = globals[GLOBAL_KEY];

export function readXaiOAuthBundle(): XaiOAuthTokenBundle | undefined {
  const raw = getSetting(XAI_OAUTH_BUNDLE_SETTING);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<XaiOAuthTokenBundle>;
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) return undefined;
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined,
      idToken: typeof parsed.idToken === 'string' ? parsed.idToken : undefined,
      expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
      email: typeof parsed.email === 'string' ? parsed.email : undefined,
      subject: typeof parsed.subject === 'string' ? parsed.subject : undefined,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return undefined;
  }
}

/** One settings write is the atomic credential boundary for rotation. */
export function persistXaiOAuthBundle(
  bundle: XaiOAuthTokenBundle,
  write: (key: string, value: string) => void = setSetting,
): void {
  write(XAI_OAUTH_BUNDLE_SETTING, JSON.stringify(bundle));
}

function bundleFromTokens(
  tokens: XaiOAuthTokenResponse,
  previous?: XaiOAuthTokenBundle,
): XaiOAuthTokenBundle {
  const claims = parseJwtClaims(tokens.idToken || tokens.accessToken);
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || previous?.refreshToken,
    idToken: tokens.idToken || previous?.idToken,
    expiresAt: tokens.expiresAt,
    email: claims.email || previous?.email,
    subject: claims.sub || previous?.subject,
    updatedAt: Date.now(),
  };
}

export function saveXaiOAuthTokens(tokens: XaiOAuthTokenResponse, previous?: XaiOAuthTokenBundle): XaiOAuthTokenBundle {
  const bundle = bundleFromTokens(tokens, previous);
  // Persist before returning or mutating any other state. A failed write means
  // callers must not use a rotated access/refresh pair that cannot survive restart.
  persistXaiOAuthBundle(bundle);
  return bundle;
}

/** Persist a completed device grant only while its owning flow is active. */
export function saveXaiDeviceTokensIfActive(
  tokens: XaiOAuthTokenResponse,
  signal: AbortSignal,
): XaiOAuthTokenBundle {
  if (signal.aborted) throw new Error('xAI device login cancelled.');
  return saveXaiOAuthTokens(tokens);
}

/** Persist a completed browser grant only while its owning flow is active. */
export function saveXaiBrowserTokensIfActive(
  tokens: XaiOAuthTokenResponse,
  signal: AbortSignal,
): XaiOAuthTokenBundle {
  if (signal.aborted) throw new Error('xAI browser login cancelled.');
  return saveXaiOAuthTokens(tokens);
}

export function clearXaiOAuthTokens(): void {
  setSetting(XAI_OAUTH_BUNDLE_SETTING, '');
}

export function getXaiOAuthStatus(): XaiOAuthStatus {
  const enabled = isXaiOAuthEnabled();
  if (!enabled) {
    return {
      enabled: false,
      authenticated: false,
      disabledReason: 'xAI OAuth is disabled by CODEPILOT_XAI_OAUTH_ENABLED=0. Use xAI API Key instead.',
      accountUrl: 'https://accounts.x.ai',
    };
  }
  const bundle = readXaiOAuthBundle();
  return {
    enabled: true,
    authenticated: !!bundle,
    email: bundle?.email,
    expiresAt: bundle?.expiresAt,
    needsRefresh: bundle ? accessTokenIsExpiring(bundle) : undefined,
    loginPending: state.browserController ? 'browser' : state.deviceCompletion ? 'device' : undefined,
    error: state.lastError,
    accountUrl: 'https://accounts.x.ai',
  };
}

export function isXaiOAuthUsable(): boolean {
  if (!isXaiOAuthEnabled()) return false;
  const bundle = readXaiOAuthBundle();
  return !!bundle && (!accessTokenIsExpiring(bundle) || !!bundle.refreshToken);
}

async function refreshBundle(force = false): Promise<XaiOAuthTokenBundle | undefined> {
  const current = readXaiOAuthBundle();
  if (!current) return undefined;
  if (!force && !accessTokenIsExpiring(current)) return current;
  if (!current.refreshToken) {
    if (accessTokenIsExpiring(current, Date.now(), 0)) {
      clearXaiOAuthTokens();
      return undefined;
    }
    // Still valid but inside the early-refresh window and no refresh grant is
    // available: use it until actual expiry instead of logging the user out early.
    return current;
  }
  try {
    const tokens = await refreshXaiTokens(current.refreshToken);
    return saveXaiOAuthTokens(tokens, current);
  } catch (error) {
    if (error instanceof XaiOAuthTokenError && error.shouldClearCredentials) {
      clearXaiOAuthTokens();
      return undefined;
    }
    // Network/timeout/429/5xx and unknown persistence failures preserve the
    // previous bundle. The request fails closed and a later request may retry.
    throw error;
  }
}

export async function ensureXaiTokenFresh(): Promise<{ accessToken: string } | undefined> {
  if (!isXaiOAuthEnabled()) return undefined;
  const current = readXaiOAuthBundle();
  if (!current) return undefined;
  if (!accessTokenIsExpiring(current)) return { accessToken: current.accessToken };
  if (!state.refreshPromise) {
    state.refreshPromise = refreshBundle().finally(() => { state.refreshPromise = undefined; });
  }
  const refreshed = await state.refreshPromise;
  return refreshed ? { accessToken: refreshed.accessToken } : undefined;
}

async function refreshXaiTokenAfterUnauthorized(
  rejectedAccessToken: string,
): Promise<{ accessToken: string } | undefined> {
  const current = readXaiOAuthBundle();
  if (!current) return undefined;
  if (current.accessToken !== rejectedAccessToken) {
    return { accessToken: current.accessToken };
  }
  if (!current.refreshToken) return undefined;
  if (!state.refreshPromise) {
    state.refreshPromise = refreshBundle(true).finally(() => { state.refreshPromise = undefined; });
  }
  const refreshed = await state.refreshPromise;
  return refreshed ? { accessToken: refreshed.accessToken } : undefined;
}

const GROK_BUILD_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function createXaiOAuthFetch(
  modelId: string,
  fetchImpl: typeof fetch = envProxyFetch,
): typeof fetch {
  if (!GROK_BUILD_MODEL_ID_PATTERN.test(modelId)) {
    throw new Error('Grok Build OAuth requires a valid selected model ID.');
  }
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === 'string'
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL(input.url);
    if (
      target.origin !== new URL(XAI_GROK_BUILD_API_BASE_URL).origin
      || target.pathname !== XAI_GROK_BUILD_RESPONSES_PATH
      || target.username
      || target.password
      || target.search
      || target.hash
    ) {
      throw new Error('Grok Build OAuth refused to send credentials to a non-Grok Build endpoint.');
    }
    const credentials = await ensureXaiTokenFresh();
    if (!credentials) throw new ProviderTransportError('PROVIDER_OAUTH_EXPIRED', 'xAI OAuth credentials are unavailable. Reconnect in Settings or use xAI API Key.');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.delete('authorization');
    headers.set('Authorization', `Bearer ${credentials.accessToken}`);
    headers.set('X-XAI-Token-Auth', XAI_GROK_BUILD_TOKEN_HEADER);
    headers.set('x-authenticateresponse', XAI_GROK_BUILD_AUTHENTICATE_RESPONSE);
    headers.set('x-grok-client-version', XAI_GROK_BUILD_CLIENT_VERSION);
    headers.set('x-grok-client-identifier', XAI_GROK_BUILD_CLIENT_IDENTIFIER);
    headers.set('x-grok-client-mode', XAI_GROK_BUILD_CLIENT_MODE);
    headers.set('x-grok-model-override', modelId);
    return fetchImpl(input, { ...init, headers });
  }) as typeof fetch;
}

const XAI_MEDIA_API_ORIGIN = 'https://api.x.ai';
const XAI_VIDEO_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isAllowedXaiMediaRequest(target: URL, method: string): boolean {
  if (
    target.origin !== XAI_MEDIA_API_ORIGIN
    || target.username
    || target.password
    || target.search
    || target.hash
  ) return false;
  if (method === 'POST') {
    return target.pathname === '/v1/images/generations'
      || target.pathname === '/v1/images/edits'
      || target.pathname === '/v1/videos/generations';
  }
  if (method !== 'GET') return false;
  const match = /^\/v1\/videos\/([^/]+)$/.exec(target.pathname);
  return !!match && XAI_VIDEO_REQUEST_ID_PATTERN.test(match[1]);
}

/**
 * Purpose-specific Grok Build OAuth transport for Imagine.
 *
 * Unlike text inference, Imagine calls the public xAI media endpoints. Keep
 * this wrapper separate so widening media access cannot widen the Build proxy
 * bearer boundary. The allowlist is checked before token refresh, headers are
 * cloned, and proxy-only identity headers are forcibly removed.
 */
export function createXaiOAuthMediaFetch(
  fetchImpl: typeof fetch = envProxyFetch,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === 'string'
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL(input.url);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!isAllowedXaiMediaRequest(target, method)) {
      throw new Error('Grok Build OAuth refused to send media credentials to a non-Imagine endpoint.');
    }

    const credentials = await ensureXaiTokenFresh();
    if (!credentials) {
      throw new ProviderTransportError('PROVIDER_OAUTH_EXPIRED', 'xAI OAuth credentials are unavailable. Reconnect Grok Build in Settings.');
    }

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.delete('authorization');
    headers.delete('x-xai-token-auth');
    headers.delete('x-authenticateresponse');
    headers.delete('x-grok-client-mode');
    headers.delete('x-grok-model-override');
    headers.set('Authorization', `Bearer ${credentials.accessToken}`);
    headers.set('x-grok-client-version', XAI_GROK_BUILD_CLIENT_VERSION);
    headers.set('x-grok-client-identifier', XAI_GROK_BUILD_CLIENT_IDENTIFIER);
    const retryInput = input instanceof Request ? input.clone() : input;
    const response = await fetchImpl(input, { ...init, method, headers });
    if (response.status !== 401) return response;

    const refreshed = await refreshXaiTokenAfterUnauthorized(credentials.accessToken);
    if (!refreshed || refreshed.accessToken === credentials.accessToken) return response;
    try { await response.body?.cancel(); } catch { /* best-effort release before retry */ }
    headers.set('Authorization', `Bearer ${refreshed.accessToken}`);
    return fetchImpl(retryInput, { ...init, method, headers });
  }) as typeof fetch;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function callbackHtml(ok: boolean, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>xAI Login</title></head><body style="font-family:system-ui;padding:40px"><h1>${ok ? 'xAI login complete' : 'xAI login failed'}</h1><p>${htmlEscape(message)}</p></body></html>`;
}

async function stopBrowserServer(): Promise<void> {
  if (state.browserTimeout) clearTimeout(state.browserTimeout);
  state.browserTimeout = undefined;
  const server = state.server;
  state.server = undefined;
  if (!server) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function rejectPendingBrowser(error: Error): void {
  const pending = state.pendingBrowser;
  state.pendingBrowser = undefined;
  const controller = state.browserController;
  state.browserController = undefined;
  controller?.abort();
  pending?.reject(error);
}

async function startBrowserServer(): Promise<string> {
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_CALLBACK_ORIGINS.has(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Origin not allowed');
      return;
    }
    // xAI's completion page calls the loopback callback with fetch() and
    // reads the response before replacing its "copy this code" fallback UI.
    // CORS/PNA therefore belongs on the actual GET response too, not only on
    // the OPTIONS preflight. Keep the allowlist fail-closed before reflecting
    // the origin.
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url || '/', `http://${XAI_OAUTH_CALLBACK_HOST}`);
    if (req.method !== 'GET' || url.pathname !== XAI_OAUTH_CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const pending = state.pendingBrowser;
    const providerError = url.searchParams.get('error');
    if (providerError) {
      const message = url.searchParams.get('error_description') || providerError;
      state.lastError = `xAI OAuth rejected: ${message}`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackHtml(false, message));
      rejectPendingBrowser(new Error(`xAI OAuth rejected: ${message}`));
      // Do not await server.close() from inside the active request handler:
      // close waits for this response to finish, which would deadlock the callback.
      void stopBrowserServer();
      return;
    }
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    if (!pending || !code || returnedState !== pending.state) {
      const message = !code ? 'Missing authorization code.' : 'OAuth state validation failed.';
      state.lastError = message;
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackHtml(false, message));
      rejectPendingBrowser(new Error(message));
      void stopBrowserServer();
      return;
    }

    state.pendingBrowser = undefined;
    try {
      const tokens = await exchangeXaiAuthorizationCode(
        code,
        pending.codeVerifier,
        pending.nonce,
        pending.redirectUri,
        undefined,
        pending.controller.signal,
      );
      saveXaiBrowserTokensIfActive(tokens, pending.controller.signal);
      state.lastError = undefined;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackHtml(true, 'Return to CodePilot. You may close this tab.'));
      pending.resolve();
    } catch (error) {
      const safeMessage = error instanceof Error ? error.message : String(error);
      if (!pending.controller.signal.aborted) state.lastError = safeMessage;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackHtml(false, safeMessage));
      pending.reject(error instanceof Error ? error : new Error(safeMessage));
    }
    if (state.browserController === pending.controller) state.browserController = undefined;
    void stopBrowserServer();
  });
  state.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', error => {
      state.server = undefined;
      reject(new Error(`xAI OAuth callback server failed: ${error.message}`));
    });
    server.listen(0, XAI_OAUTH_CALLBACK_HOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await stopBrowserServer();
    throw new Error('xAI OAuth callback server did not expose a loopback port.');
  }
  return buildXaiOAuthRedirectUri(address.port);
}

export async function startXaiBrowserFlow(): Promise<{ authUrl: string; completion: Promise<void> }> {
  if (!isXaiOAuthEnabled()) throw new Error('xAI OAuth is disabled. Use xAI API Key instead.');
  await cancelXaiOAuthFlow();
  state.lastError = undefined;
  const redirectUri = await startBrowserServer();
  const flow = prepareXaiBrowserFlow(redirectUri);
  const controller = new AbortController();
  state.browserController = controller;
  const completion = new Promise<void>((resolve, reject) => {
    state.pendingBrowser = {
      state: flow.state,
      nonce: flow.nonce,
      codeVerifier: flow.codeVerifier,
      redirectUri,
      controller,
      resolve,
      reject,
    };
    state.browserTimeout = setTimeout(() => {
      state.lastError = 'xAI browser login timed out.';
      rejectPendingBrowser(new Error('xAI browser login timed out.'));
      void stopBrowserServer();
    }, BROWSER_TIMEOUT_MS);
  });
  return { authUrl: flow.authUrl, completion };
}

export async function startXaiDeviceFlow(): Promise<{
  authorization: XaiDeviceAuthorization;
  completion: Promise<void>;
}> {
  if (!isXaiOAuthEnabled()) throw new Error('xAI OAuth is disabled. Use xAI API Key instead.');
  await cancelXaiOAuthFlow();
  state.lastError = undefined;
  const authorization = await requestXaiDeviceAuthorization();
  const controller = new AbortController();
  state.deviceController = controller;
  const completion = pollXaiDeviceTokens(authorization, { signal: controller.signal })
    .then(tokens => {
      // pollXaiDeviceTokens checks around both sleep and fetch, but keep the
      // persistence boundary independently fail-closed as well. This protects
      // against a cancel arriving after the protocol promise resolves and
      // before this continuation runs.
      saveXaiDeviceTokensIfActive(tokens, controller.signal);
      state.lastError = undefined;
    })
    .catch(error => {
      if (!controller.signal.aborted) state.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      if (state.deviceController === controller) state.deviceController = undefined;
      state.deviceCompletion = undefined;
    });
  state.deviceCompletion = completion;
  return { authorization, completion };
}

export async function cancelXaiOAuthFlow(): Promise<void> {
  rejectPendingBrowser(new Error('xAI OAuth flow cancelled.'));
  state.deviceController?.abort();
  state.deviceController = undefined;
  state.deviceCompletion = undefined;
  await stopBrowserServer();
}
