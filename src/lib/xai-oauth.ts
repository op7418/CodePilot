/**
 * xAI OAuth protocol primitives.
 *
 * Compatibility source: OpenCode's xAI integration uses the public Grok CLI
 * client below. This is not a CodePilot-owned client and xAI may revoke or
 * restrict it; UI and release notes must keep that risk visible.
 */
import { createHash, randomBytes } from 'node:crypto';
import { envProxyFetch } from './env-proxy-fetch';

export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const XAI_OAUTH_AUTHORIZE_URL = 'https://auth.x.ai/oauth2/authorize';
export const XAI_OAUTH_TOKEN_URL = 'https://auth.x.ai/oauth2/token';
export const XAI_OAUTH_DEVICE_URL = 'https://auth.x.ai/oauth2/device/code';
export const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
export const XAI_OAUTH_CALLBACK_PORT = 56121;
export const XAI_OAUTH_REDIRECT_URI = `http://127.0.0.1:${XAI_OAUTH_CALLBACK_PORT}/callback`;

export interface XaiOAuthTokenBundle {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  email?: string;
  subject?: string;
  updatedAt: number;
}

export interface XaiOAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
}

export interface XaiPreparedBrowserFlow {
  authUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface XaiDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface JwtClaims {
  exp?: number;
  email?: string;
  sub?: string;
  nonce?: string;
}

export class XaiOAuthTokenError extends Error {
  readonly status?: number;
  readonly oauthCode?: string;
  readonly retryable: boolean;
  readonly shouldClearCredentials: boolean;

  constructor(input: {
    message: string;
    status?: number;
    oauthCode?: string;
    retryable: boolean;
    shouldClearCredentials?: boolean;
  }) {
    super(input.message);
    this.name = 'XaiOAuthTokenError';
    this.status = input.status;
    this.oauthCode = input.oauthCode;
    this.retryable = input.retryable;
    this.shouldClearCredentials = input.shouldClearCredentials ?? false;
  }
}

/** Extract only a stable socket/DNS/TLS code; never include proxy URLs or credentials. */
function findNetworkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function randomBase64Url(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function prepareXaiBrowserFlow(): XaiPreparedBrowserFlow {
  const state = randomBase64Url();
  const nonce = randomBase64Url();
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: XAI_OAUTH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: XAI_OAUTH_REDIRECT_URI,
    scope: XAI_OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    plan: 'generic',
    referrer: 'codepilot',
  });
  return { authUrl: `${XAI_OAUTH_AUTHORIZE_URL}?${params}`, state, nonce, codeVerifier };
}

export function parseJwtClaims(token: string | undefined): JwtClaims {
  if (!token) return {};
  try {
    const payload = token.split('.')[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    return {};
  }
}

export function accessTokenIsExpiring(
  bundle: Pick<XaiOAuthTokenBundle, 'accessToken' | 'expiresAt'>,
  now = Date.now(),
  bufferMs = 2 * 60 * 1000,
): boolean {
  const jwtExp = parseJwtClaims(bundle.accessToken).exp;
  const candidates = [bundle.expiresAt, jwtExp ? jwtExp * 1000 : undefined]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (candidates.length === 0) return false;
  return Math.min(...candidates) <= now + bufferMs;
}

function parseTokenPayload(payload: Record<string, unknown>, previousRefreshToken?: string): XaiOAuthTokenResponse {
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new XaiOAuthTokenError({
      message: 'xAI OAuth token response did not include an access token.',
      retryable: false,
    });
  }
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string'
      ? payload.refresh_token
      : previousRefreshToken,
    idToken: typeof payload.id_token === 'string' ? payload.id_token : undefined,
    expiresAt: typeof payload.expires_in === 'number'
      ? Date.now() + payload.expires_in * 1000
      : undefined,
  };
}

async function parseTokenError(response: Response): Promise<XaiOAuthTokenError> {
  let payload: Record<string, unknown> = {};
  try { payload = await response.json() as Record<string, unknown>; } catch { /* no body */ }
  const code = typeof payload.error === 'string' ? payload.error : undefined;
  const description = typeof payload.error_description === 'string'
    ? payload.error_description
    : code || `HTTP ${response.status}`;
  const shouldClear = code === 'invalid_grant' || code === 'invalid_token' || code === 'token_expired';
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  return new XaiOAuthTokenError({
    message: `xAI OAuth token request failed: ${description}`,
    status: response.status,
    oauthCode: code,
    retryable,
    shouldClearCredentials: shouldClear,
  });
}

async function tokenRequest(
  params: URLSearchParams,
  fetchImpl: typeof fetch,
  previousRefreshToken?: string,
  signal?: AbortSignal,
): Promise<XaiOAuthTokenResponse> {
  if (signal?.aborted) throw new Error('xAI OAuth flow cancelled.');
  let response: Response;
  try {
    response = await fetchImpl(XAI_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('xAI OAuth flow cancelled.');
    const networkCode = findNetworkErrorCode(error);
    throw new XaiOAuthTokenError({
      message: `xAI OAuth network failure: ${error instanceof Error ? error.message : String(error)}${networkCode ? ` (${networkCode})` : ''}`,
      retryable: true,
    });
  }
  if (!response.ok) throw await parseTokenError(response);
  return parseTokenPayload(await response.json() as Record<string, unknown>, previousRefreshToken);
}

export async function exchangeXaiAuthorizationCode(
  code: string,
  codeVerifier: string,
  expectedNonce: string,
  fetchImpl: typeof fetch = envProxyFetch,
  signal?: AbortSignal,
): Promise<XaiOAuthTokenResponse> {
  const tokens = await tokenRequest(new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: XAI_OAUTH_CLIENT_ID,
    code,
    redirect_uri: XAI_OAUTH_REDIRECT_URI,
    code_verifier: codeVerifier,
  }), fetchImpl, undefined, signal);
  if (signal?.aborted) throw new Error('xAI OAuth flow cancelled.');
  if (!tokens.idToken) {
    throw new XaiOAuthTokenError({
      message: 'xAI OAuth token response did not include an ID token for nonce validation.',
      retryable: false,
    });
  }
  const claims = parseJwtClaims(tokens.idToken);
  if (claims.nonce !== expectedNonce) {
    throw new XaiOAuthTokenError({ message: 'xAI OAuth nonce validation failed.', retryable: false });
  }
  return tokens;
}

export async function refreshXaiTokens(
  refreshToken: string,
  fetchImpl: typeof fetch = envProxyFetch,
): Promise<XaiOAuthTokenResponse> {
  return tokenRequest(new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: XAI_OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  }), fetchImpl, refreshToken);
}

export async function requestXaiDeviceAuthorization(
  fetchImpl: typeof fetch = envProxyFetch,
): Promise<XaiDeviceAuthorization> {
  const response = await fetchImpl(XAI_OAUTH_DEVICE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE }).toString(),
  });
  if (!response.ok) throw await parseTokenError(response);
  const data = await response.json() as Record<string, unknown>;
  if (
    typeof data.device_code !== 'string'
    || typeof data.user_code !== 'string'
    || typeof data.verification_uri !== 'string'
  ) {
    throw new Error('xAI device authorization response is incomplete.');
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: typeof data.verification_uri_complete === 'string'
      ? data.verification_uri_complete
      : undefined,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 600,
    interval: Math.max(1, typeof data.interval === 'number' ? data.interval : 5),
  };
}

export async function pollXaiDeviceTokens(
  authorization: XaiDeviceAuthorization,
  options: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    signal?: AbortSignal;
  } = {},
): Promise<XaiOAuthTokenResponse> {
  const fetchImpl = options.fetchImpl ?? envProxyFetch;
  const cancelled = () => new Error('xAI device login cancelled.');
  const throwIfCancelled = () => {
    if (options.signal?.aborted) throw cancelled();
  };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(cancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      options.signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    options.signal?.addEventListener('abort', onAbort, { once: true });
  }));
  const now = options.now ?? Date.now;
  const deadline = now() + authorization.expiresIn * 1000;
  let intervalMs = authorization.interval * 1000;

  while (now() < deadline) {
    throwIfCancelled();
    await sleep(intervalMs);
    // Cancellation can happen while the interval elapses. Re-check before
    // constructing a credential-bearing token request, not only before sleep.
    throwIfCancelled();
    try {
      const tokens = await tokenRequest(new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: XAI_OAUTH_CLIENT_ID,
        device_code: authorization.deviceCode,
      }), fetchImpl, undefined, options.signal);
      // A response and a UI cancel may race. Never hand successful tokens to
      // the persistence layer after the cancellation signal has won.
      throwIfCancelled();
      return tokens;
    } catch (error) {
      throwIfCancelled();
      if (!(error instanceof XaiOAuthTokenError)) throw error;
      if (error.oauthCode === 'authorization_pending') continue;
      if (error.oauthCode === 'slow_down') {
        intervalMs += 5_000;
        continue;
      }
      if (error.oauthCode === 'access_denied') throw new Error('xAI device login was denied.');
      if (error.oauthCode === 'expired_token') throw new Error('xAI device code expired.');
      if (error.retryable) continue;
      throw error;
    }
  }
  throw new Error('xAI device login timed out.');
}
