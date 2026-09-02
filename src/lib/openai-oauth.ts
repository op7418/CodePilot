/**
 * openai-oauth.ts — OpenAI PKCE OAuth + Token Exchange.
 *
 * Implements the Codex CLI OAuth flow for ChatGPT Plus/Pro users.
 * Based on CraftAgent's verified implementation.
 *
 * Flow: PKCE auth → code exchange → id_token → RFC 8693 token exchange → OpenAI API Key
 */

import { randomBytes, createHash } from 'node:crypto';

// ── OAuth Configuration ────────────────────────────────────────

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPES = 'openid profile email offline_access';
export const CALLBACK_PORT = 1455;

// ── Types ──────────────────────────────────────────────────────

export interface OAuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // Unix ms
}

export interface PreparedFlow {
  authUrl: string;
  state: string;
  codeVerifier: string;
}

export interface JwtClaims {
  email?: string;
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
  organizations?: Array<{ id: string }>;
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
  };
}

// ── PKCE ───────────────────────────────────────────────────────

function generateState(): string {
  return randomBytes(32).toString('hex');
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

// ── Prepare OAuth Flow ─────────────────────────────────────────

export function prepareOAuthFlow(): PreparedFlow {
  const state = generateState();
  const { codeVerifier, codeChallenge } = generatePKCE();

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    codex_cli_simplified_flow: 'true',
    id_token_add_organizations: 'true',
  });

  return {
    authUrl: `${AUTH_URL}?${params.toString()}`,
    state,
    codeVerifier,
  };
}

// ── Exchange Code for Tokens ───────────────────────────────────

/**
 * Determine if a token-exchange failure is worth retrying.
 *
 * Network errors (TypeError from fetch on connection reset, ETIMEDOUT, DNS
 * failure) and transient 5xx server errors are retryable. 4xx (auth errors)
 * are not — retrying won't help if the code is genuinely invalid.
 *
 * 403 sits in a grey zone: OpenAI's token endpoint occasionally returns 403
 * for first-attempt requests when the auth code is fresh and propagation
 * hasn't completed across their edge. Treating 403 as retryable matches
 * what the upstream OpenCode client does (codex.ts:580 `if (status !== 403
 * && status !== 404) return failed`).
 */
export function isRetryableTokenExchangeFailure(status: number | null, err?: unknown): boolean {
  if (status === null) return true; // network-level error (TypeError from fetch)
  if (status >= 500) return true;   // server-side transient
  if (status === 403 || status === 408 || status === 429) return true;
  if (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
      return true;
    }
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function extractOAuthErrorMessage(rawBody: string, fallbackErr?: unknown): string {
  if (!rawBody) {
    return fallbackErr instanceof Error ? fallbackErr.message : 'unknown';
  }
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const candidates: unknown[] = [
      parsed.error_description,
      typeof parsed.error === 'object' && parsed.error !== null
        ? (parsed.error as Record<string, unknown>).message
        : undefined,
      typeof parsed.error === 'object' && parsed.error !== null
        ? (parsed.error as Record<string, unknown>).code
        : undefined,
      parsed.error,
      parsed.message,
      parsed,
    ];
    for (const item of candidates) {
      const text = stringifyUnknown(item).trim();
      if (text) return text;
    }
    return rawBody;
  } catch {
    return rawBody;
  }
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  // Retry up to 3 times with exponential backoff (1s, 2s, 4s) for transient
  // network failures + 403/5xx. Issue #464 reports users on macOS + Windows
  // hitting "Token exchange failed: 403" while the maintainer's two machines
  // never reproduce — strong signal of network-stability dependence. The
  // upstream OpenCode reference implementation handles this with polling
  // retries on the same status codes.
  const MAX_ATTEMPTS = 3;
  let lastStatus: number | null = null;
  let lastBody = '';
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: params.toString(),
      });
    } catch (err) {
      // Network-level failure (DNS, connection reset, TLS handshake failed)
      lastStatus = null;
      lastErr = err;
      lastBody = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS && isRetryableTokenExchangeFailure(null, err)) {
        await sleep(1000 * Math.pow(2, attempt - 1));
        continue;
      }
      throw new Error(`Token exchange failed (network): ${lastBody}`);
    }

    if (response.ok) {
      const data = await response.json() as {
        id_token: string;
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };
      return {
        idToken: data.id_token,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      };
    }

    // Non-OK response — capture body for the error message and decide whether to retry
    lastStatus = response.status;
    lastBody = await response.text();

    if (attempt < MAX_ATTEMPTS && isRetryableTokenExchangeFailure(response.status)) {
      await sleep(1000 * Math.pow(2, attempt - 1));
      continue;
    }
    break;
  }

  // Out of retries — produce a useful error. Nested `{error:{message}}`
  // bodies used to interpolate as "[object Object]" (issue #464).
  const msg = extractOAuthErrorMessage(lastBody, lastErr);
  throw new Error(`Token exchange failed after ${MAX_ATTEMPTS} attempts: ${lastStatus ?? 'network'} - ${msg}`);
}

// ── Refresh Tokens ─────────────────────────────────────────────

export async function refreshTokens(refreshToken: string): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    const msg = extractOAuthErrorMessage(text);
    throw new Error(`Token refresh failed: ${response.status} - ${msg}`);
  }

  const data = await response.json() as {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

// ── Parse JWT Claims (without verification) ────────────────────

export function parseIdTokenClaims(idToken: string): JwtClaims {
  try {
    const payload = idToken.split('.')[1];
    const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}

/**
 * Extract ChatGPT account ID from JWT claims.
 * Used as ChatGPT-Account-Id header for Codex API calls.
 */
export function extractAccountId(claims: JwtClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims['https://api.openai.com/auth']?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  );
}

/**
 * Codex API endpoint — ChatGPT Plus/Pro users access OpenAI models through this.
 * Uses access_token as Bearer + ChatGPT-Account-Id header.
 */
export const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
