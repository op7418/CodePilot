import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  XAI_OAUTH_AUTHORIZE_URL,
  XAI_OAUTH_CALLBACK_PORT,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_DEVICE_URL,
  XAI_OAUTH_REDIRECT_URI,
  XAI_OAUTH_SCOPE,
  XAI_OAUTH_TOKEN_URL,
  XaiOAuthTokenError,
  accessTokenIsExpiring,
  exchangeXaiAuthorizationCode,
  parseJwtClaims,
  pollXaiDeviceTokens,
  prepareXaiBrowserFlow,
  refreshXaiTokens,
  requestXaiDeviceAuthorization,
  type XaiDeviceAuthorization,
} from '../../lib/xai-oauth';

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('xAI OAuth protocol primitives', () => {
  it('pins the public Grok CLI client and registered callback contract', () => {
    assert.equal(XAI_OAUTH_CLIENT_ID, 'b1a00492-073a-47ea-816f-4c329264a828');
    assert.equal(XAI_OAUTH_CALLBACK_PORT, 56121);
    assert.equal(XAI_OAUTH_REDIRECT_URI, 'http://127.0.0.1:56121/callback');
    assert.equal(XAI_OAUTH_AUTHORIZE_URL, 'https://auth.x.ai/oauth2/authorize');
    assert.equal(XAI_OAUTH_TOKEN_URL, 'https://auth.x.ai/oauth2/token');
    assert.equal(XAI_OAUTH_DEVICE_URL, 'https://auth.x.ai/oauth2/device/code');
  });

  it('builds PKCE S256 authorize URL with state, nonce, generic plan and CodePilot referrer', () => {
    const flow = prepareXaiBrowserFlow();
    const url = new URL(flow.authUrl);
    assert.equal(url.origin + url.pathname, XAI_OAUTH_AUTHORIZE_URL);
    assert.equal(url.searchParams.get('client_id'), XAI_OAUTH_CLIENT_ID);
    assert.equal(url.searchParams.get('redirect_uri'), XAI_OAUTH_REDIRECT_URI);
    assert.equal(url.searchParams.get('scope'), XAI_OAUTH_SCOPE);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    assert.equal(url.searchParams.get('state'), flow.state);
    assert.equal(url.searchParams.get('nonce'), flow.nonce);
    assert.equal(url.searchParams.get('plan'), 'generic');
    assert.equal(url.searchParams.get('referrer'), 'codepilot');
  });

  it('generates independent state, nonce and verifier for each browser attempt', () => {
    const first = prepareXaiBrowserFlow();
    const second = prepareXaiBrowserFlow();
    assert.notEqual(first.state, second.state);
    assert.notEqual(first.nonce, second.nonce);
    assert.notEqual(first.codeVerifier, second.codeVerifier);
  });

  it('parses JWT metadata without exposing or requiring signature verification', () => {
    assert.deepEqual(parseJwtClaims(jwt({ exp: 123, email: 'user@example.com', sub: 'acct' })), {
      exp: 123,
      email: 'user@example.com',
      sub: 'acct',
    });
    assert.deepEqual(parseJwtClaims('not-a-jwt'), {});
  });

  it('refreshes when persisted expiry is inside the two-minute buffer', () => {
    assert.equal(accessTokenIsExpiring({ accessToken: 'opaque', expiresAt: 121_001 }, 1_000), false);
    assert.equal(accessTokenIsExpiring({ accessToken: 'opaque', expiresAt: 120_999 }, 1_000), true);
  });

  it('uses JWT exp even when persisted expiry is later', () => {
    const now = 1_000_000;
    assert.equal(accessTokenIsExpiring({
      accessToken: jwt({ exp: Math.floor((now + 60_000) / 1000) }),
      expiresAt: now + 3_600_000,
    }, now), true);
  });

  it('treats opaque tokens with no expiry evidence as usable', () => {
    assert.equal(accessTokenIsExpiring({ accessToken: 'opaque' }, 0), false);
  });

  it('exchanges browser code with verifier and validates matching nonce', async () => {
    let captured = '';
    const tokens = await exchangeXaiAuthorizationCode('auth-code', 'verifier', 'nonce-1', async (input, init) => {
      assert.equal(String(input), XAI_OAUTH_TOKEN_URL);
      captured = String(init?.body);
      return jsonResponse({
        access_token: 'access',
        refresh_token: 'refresh',
        id_token: jwt({ nonce: 'nonce-1', email: 'user@example.com' }),
        expires_in: 3600,
      });
    });
    const form = new URLSearchParams(captured);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('code_verifier'), 'verifier');
    assert.equal(form.get('redirect_uri'), XAI_OAUTH_REDIRECT_URI);
    assert.equal(tokens.refreshToken, 'refresh');
  });

  it('rejects an ID token with the wrong nonce', async () => {
    await assert.rejects(
      () => exchangeXaiAuthorizationCode('code', 'verifier', 'expected', async () => jsonResponse({
        access_token: 'access',
        id_token: jwt({ nonce: 'different' }),
      })),
      /nonce validation failed/,
    );
  });

  it('rejects a browser exchange that cannot prove the nonce', async () => {
    await assert.rejects(
      () => exchangeXaiAuthorizationCode('code', 'verifier', 'expected', async () => jsonResponse({
        access_token: 'access-without-id-token',
      })),
      /did not include an ID token.*nonce validation/,
    );
  });

  it('preserves the previous refresh token when the server does not rotate it', async () => {
    const tokens = await refreshXaiTokens('old-refresh', async (_input, init) => {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'old-refresh');
      return jsonResponse({ access_token: 'new-access', expires_in: 3600 });
    });
    assert.equal(tokens.refreshToken, 'old-refresh');
  });

  it('accepts refresh-token rotation as one returned bundle', async () => {
    const tokens = await refreshXaiTokens('old-refresh', async () => jsonResponse({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
    }));
    assert.equal(tokens.accessToken, 'new-access');
    assert.equal(tokens.refreshToken, 'new-refresh');
  });

  it('classifies invalid_grant as credential-clearing, not retryable', async () => {
    await assert.rejects(
      () => refreshXaiTokens('revoked', async () => jsonResponse({ error: 'invalid_grant' }, 400)),
      (error: unknown) => error instanceof XaiOAuthTokenError
        && error.shouldClearCredentials
        && !error.retryable,
    );
  });

  it('classifies 429/5xx and network failures as transient without clearing credentials', async () => {
    for (const response of [
      () => Promise.resolve(jsonResponse({ error: 'server_error' }, 503)),
      () => Promise.resolve(jsonResponse({ error: 'slow_down' }, 429)),
      () => Promise.reject(new Error('socket reset')),
    ]) {
      await assert.rejects(
        () => refreshXaiTokens('keep-me', response as typeof fetch),
        (error: unknown) => error instanceof XaiOAuthTokenError
          && error.retryable
          && !error.shouldClearCredentials,
      );
    }
  });

  it('surfaces a sanitized low-level network code without leaking proxy details', async () => {
    const socketError = Object.assign(new Error('connect failed for redacted proxy'), { code: 'ECONNREFUSED' });
    const fetchError = new TypeError('fetch failed', { cause: socketError });
    await assert.rejects(
      () => refreshXaiTokens('keep-me', async () => Promise.reject(fetchError)),
      (error: unknown) => error instanceof XaiOAuthTokenError
        && error.message === 'xAI OAuth network failure: fetch failed (ECONNREFUSED)'
        && !error.message.includes('redacted proxy'),
    );
  });

  it('parses device authorization response and honors server interval', async () => {
    const authorization = await requestXaiDeviceAuthorization(async (input, init) => {
      assert.equal(String(input), XAI_OAUTH_DEVICE_URL);
      assert.match(String(init?.body), /api%3Aaccess/);
      return jsonResponse({
        device_code: 'device-secret',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.x.ai/device',
        verification_uri_complete: 'https://auth.x.ai/device?user_code=ABCD-EFGH',
        expires_in: 600,
        interval: 7,
      });
    });
    assert.equal(authorization.interval, 7);
    assert.equal(authorization.userCode, 'ABCD-EFGH');
  });

  it('device polling handles authorization_pending then succeeds', async () => {
    const authorization: XaiDeviceAuthorization = {
      deviceCode: 'device', userCode: 'CODE', verificationUri: 'https://auth.x.ai/device', expiresIn: 60, interval: 1,
    };
    let calls = 0;
    let now = 0;
    const tokens = await pollXaiDeviceTokens(authorization, {
      now: () => now,
      sleep: async ms => { now += ms; },
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ error: 'authorization_pending' }, 400)
          : jsonResponse({ access_token: 'device-access', refresh_token: 'device-refresh' });
      },
    });
    assert.equal(calls, 2);
    assert.equal(tokens.accessToken, 'device-access');
  });

  it('device polling adds five seconds after slow_down', async () => {
    const authorization: XaiDeviceAuthorization = {
      deviceCode: 'device', userCode: 'CODE', verificationUri: 'https://auth.x.ai/device', expiresIn: 60, interval: 1,
    };
    const sleeps: number[] = [];
    let now = 0;
    let calls = 0;
    await pollXaiDeviceTokens(authorization, {
      now: () => now,
      sleep: async ms => { sleeps.push(ms); now += ms; },
      fetchImpl: async () => (++calls === 1
        ? jsonResponse({ error: 'slow_down' }, 400)
        : jsonResponse({ access_token: 'ok' })),
    });
    assert.deepEqual(sleeps, [1000, 6000]);
  });

  it('device polling reports denial, expiry and cancellation explicitly', async () => {
    const authorization: XaiDeviceAuthorization = {
      deviceCode: 'device', userCode: 'CODE', verificationUri: 'https://auth.x.ai/device', expiresIn: 60, interval: 1,
    };
    for (const [code, message] of [['access_denied', /denied/], ['expired_token', /expired/]] as const) {
      let now = 0;
      await assert.rejects(() => pollXaiDeviceTokens(authorization, {
        now: () => now,
        sleep: async ms => { now += ms; },
        fetchImpl: async () => jsonResponse({ error: code }, 400),
      }), message);
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => pollXaiDeviceTokens(authorization, {
      signal: controller.signal,
      sleep: async () => {},
    }), /cancelled/);
  });

  it('does not send a token request when cancellation happens during the polling sleep', async () => {
    const authorization: XaiDeviceAuthorization = {
      deviceCode: 'device', userCode: 'CODE', verificationUri: 'https://auth.x.ai/device', expiresIn: 60, interval: 1,
    };
    const controller = new AbortController();
    let releaseSleep!: () => void;
    const sleeping = new Promise<void>(resolve => { releaseSleep = resolve; });
    let requests = 0;
    const pending = pollXaiDeviceTokens(authorization, {
      signal: controller.signal,
      sleep: async () => sleeping,
      fetchImpl: async () => {
        requests += 1;
        return jsonResponse({ access_token: 'must-not-be-returned' });
      },
    });

    controller.abort();
    releaseSleep();
    await assert.rejects(pending, /cancelled/);
    assert.equal(requests, 0);
  });
});
