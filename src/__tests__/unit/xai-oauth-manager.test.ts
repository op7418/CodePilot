import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const originalDataDir = process.env.CLAUDE_GUI_DATA_DIR;
const originalFeatureSwitch = process.env.CODEPILOT_XAI_OAUTH_ENABLED;
const originalDisableMigration = process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS;
const originalFetch = globalThis.fetch;
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-xai-oauth-manager-'));
process.env.CLAUDE_GUI_DATA_DIR = tempDataDir;
process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS = '1';
fs.writeFileSync(path.join(tempDataDir, 'codepilot.db'), '');

/* eslint-disable @typescript-eslint/no-require-imports */
const db = require('../../lib/db') as typeof import('../../lib/db');
const manager = require('../../lib/xai-oauth-manager') as typeof import('../../lib/xai-oauth-manager');
/* eslint-enable @typescript-eslint/no-require-imports */

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  globalThis.fetch = originalFetch;
  process.env.CODEPILOT_XAI_OAUTH_ENABLED = '1';
  await manager.cancelXaiOAuthFlow();
  manager.clearXaiOAuthTokens();
});

after(async () => {
  await manager.cancelXaiOAuthFlow();
  manager.clearXaiOAuthTokens();
  db.closeDb();
  globalThis.fetch = originalFetch;
  if (originalFeatureSwitch === undefined) delete process.env.CODEPILOT_XAI_OAUTH_ENABLED;
  else process.env.CODEPILOT_XAI_OAUTH_ENABLED = originalFeatureSwitch;
  if (originalDisableMigration === undefined) delete process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS;
  else process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS = originalDisableMigration;
  if (originalDataDir === undefined) delete process.env.CLAUDE_GUI_DATA_DIR;
  else process.env.CLAUDE_GUI_DATA_DIR = originalDataDir;
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

describe('xAI OAuth manager lifecycle', () => {
  it('refuses to persist a completed device grant after cancellation', () => {
    const controller = new AbortController();
    controller.abort();
    assert.throws(
      () => manager.saveXaiDeviceTokensIfActive({ accessToken: 'late-access' }, controller.signal),
      /cancelled/,
    );
    assert.equal(manager.readXaiOAuthBundle(), undefined);
  });

  it('persists access/refresh/expiry/account metadata as one JSON setting', () => {
    const idToken = jwt({ email: 'user@example.com', sub: 'account-1' });
    const bundle = manager.saveXaiOAuthTokens({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      idToken,
      expiresAt: Date.now() + 3600_000,
    });
    const raw = db.getSetting(manager.XAI_OAUTH_BUNDLE_SETTING);
    assert.ok(raw);
    assert.deepEqual(JSON.parse(raw), bundle);
    assert.equal(bundle.email, 'user@example.com');
    assert.equal(bundle.subject, 'account-1');
  });

  it('fails closed if the single atomic persistence write fails', () => {
    const bundle = {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      updatedAt: Date.now(),
    };
    assert.throws(() => manager.persistXaiOAuthBundle(bundle, () => {
      throw new Error('synthetic disk failure');
    }), /synthetic disk failure/);
    assert.equal(manager.readXaiOAuthBundle(), undefined);
  });

  it('status never returns access or refresh tokens', () => {
    manager.saveXaiOAuthTokens({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      idToken: jwt({ email: 'safe@example.com' }),
      expiresAt: Date.now() + 3600_000,
    });
    const statusText = JSON.stringify(manager.getXaiOAuthStatus());
    assert.doesNotMatch(statusText, /access-secret|refresh-secret/);
    assert.match(statusText, /safe@example\.com/);
  });

  it('malformed bundle is treated as logged out without throwing', () => {
    db.setSetting(manager.XAI_OAUTH_BUNDLE_SETTING, '{broken');
    assert.equal(manager.readXaiOAuthBundle(), undefined);
    assert.equal(manager.getXaiOAuthStatus().authenticated, false);
  });

  it('two concurrent expiry checks perform exactly one refresh and observe one rotated bundle', async () => {
    manager.saveXaiOAuthTokens({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() - 1,
    });
    let calls = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = (async () => {
      calls += 1;
      await barrier;
      return jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
    }) as typeof fetch;

    const first = manager.ensureXaiTokenFresh();
    const second = manager.ensureXaiTokenFresh();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    assert.deepEqual(await Promise.all([first, second]), [
      { accessToken: 'new-access' },
      { accessToken: 'new-access' },
    ]);
    assert.equal(manager.readXaiOAuthBundle()?.refreshToken, 'new-refresh');
  });

  it('transient refresh failure preserves the complete old bundle', async () => {
    const old = manager.saveXaiOAuthTokens({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() - 1,
    });
    globalThis.fetch = (async () => jsonResponse({ error: 'server_error' }, 503)) as typeof fetch;
    await assert.rejects(() => manager.ensureXaiTokenFresh(), /server_error/);
    assert.deepEqual(manager.readXaiOAuthBundle(), old);
  });

  it('invalid_grant clears the revoked bundle and requires reconnect', async () => {
    manager.saveXaiOAuthTokens({
      accessToken: 'old-access',
      refreshToken: 'revoked-refresh',
      expiresAt: Date.now() - 1,
    });
    globalThis.fetch = (async () => jsonResponse({ error: 'invalid_grant' }, 400)) as typeof fetch;
    assert.equal(await manager.ensureXaiTokenFresh(), undefined);
    assert.equal(manager.readXaiOAuthBundle(), undefined);
  });

  it('fetch override replaces a dummy bearer without mutating caller headers', async () => {
    manager.saveXaiOAuthTokens({ accessToken: 'fresh-access', expiresAt: Date.now() + 3600_000 });
    const callerHeaders = new Headers({ Authorization: 'Bearer dummy', 'x-test': 'keep' });
    let observed: Headers | undefined;
    const wrapped = manager.createXaiOAuthFetch((async (_input, init) => {
      observed = new Headers(init?.headers);
      return jsonResponse({ ok: true });
    }) as typeof fetch);
    await wrapped('https://api.x.ai/v1/responses', { headers: callerHeaders });
    assert.equal(callerHeaders.get('authorization'), 'Bearer dummy');
    assert.equal(observed?.get('authorization'), 'Bearer fresh-access');
    assert.equal(observed?.get('x-test'), 'keep');
  });

  it('fetch override preserves Request headers while replacing only authorization', async () => {
    manager.saveXaiOAuthTokens({ accessToken: 'fresh-access', expiresAt: Date.now() + 3600_000 });
    const request = new Request('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer dummy', 'Content-Type': 'application/json', 'x-request': 'keep' },
      body: '{}',
    });
    let observed: Headers | undefined;
    const wrapped = manager.createXaiOAuthFetch((async (_input, init) => {
      observed = new Headers(init?.headers);
      return jsonResponse({ ok: true });
    }) as typeof fetch);
    await wrapped(request, { headers: { 'x-init': 'override' } });
    assert.equal(observed?.get('authorization'), 'Bearer fresh-access');
    assert.equal(observed?.get('content-type'), 'application/json');
    assert.equal(observed?.get('x-request'), 'keep');
    assert.equal(observed?.get('x-init'), 'override');
  });

  it('fetch override refuses to leak OAuth bearer to a custom gateway', async () => {
    manager.saveXaiOAuthTokens({ accessToken: 'fresh-access', expiresAt: Date.now() + 3600_000 });
    let requests = 0;
    const wrapped = manager.createXaiOAuthFetch((async () => {
      requests += 1;
      return jsonResponse({});
    }) as typeof fetch);
    await assert.rejects(() => wrapped('https://gateway.example/v1/responses'), /non-xAI endpoint/);
    assert.equal(requests, 0);
  });

  it('refuses a custom gateway before attempting token refresh', async () => {
    manager.saveXaiOAuthTokens({
      accessToken: 'expired-access',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() - 1,
    });
    let requests = 0;
    const wrapped = manager.createXaiOAuthFetch((async () => {
      requests += 1;
      return jsonResponse({});
    }) as typeof fetch);
    await assert.rejects(() => wrapped('https://gateway.example/v1/responses'), /non-xAI endpoint/);
    assert.equal(requests, 0, 'neither refresh nor upstream request may run for a rejected origin');
    assert.equal(manager.readXaiOAuthBundle()?.refreshToken, 'refresh-secret');
  });

  it('feature switch disables status and credential usability without deleting the bundle', () => {
    manager.saveXaiOAuthTokens({ accessToken: 'fresh-access', expiresAt: Date.now() + 3600_000 });
    process.env.CODEPILOT_XAI_OAUTH_ENABLED = '0';
    assert.equal(manager.getXaiOAuthStatus().enabled, false);
    assert.equal(manager.isXaiOAuthUsable(), false);
    assert.ok(manager.readXaiOAuthBundle(), 'switch must be reversible and preserve credentials');
  });

  it('browser callback validates state/nonce and persists the completed login', async () => {
    globalThis.fetch = (async (_input, init) => {
      const form = new URLSearchParams(String(init?.body));
      const authUrl = currentAuthUrl;
      const nonce = new URL(authUrl).searchParams.get('nonce');
      assert.equal(form.get('grant_type'), 'authorization_code');
      return jsonResponse({
        access_token: 'browser-access',
        refresh_token: 'browser-refresh',
        id_token: jwt({ nonce, email: 'browser@example.com' }),
        expires_in: 3600,
      });
    }) as typeof fetch;
    let currentAuthUrl = '';
    const flow = await manager.startXaiBrowserFlow();
    currentAuthUrl = flow.authUrl;
    const state = new URL(flow.authUrl).searchParams.get('state');
    const response = await originalFetch(
      `http://127.0.0.1:56121/callback?code=browser-code&state=${state}`,
      { headers: { Origin: 'https://auth.x.ai' } },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://auth.x.ai');
    assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
    assert.equal(response.headers.get('vary'), 'Origin');
    assert.doesNotMatch(await response.text(), /browser-code|browser-access/);
    await flow.completion;
    assert.equal(manager.getXaiOAuthStatus().email, 'browser@example.com');
  });

  it('does not persist a late browser token response after the flow is cancelled', async () => {
    let currentAuthUrl = '';
    let resolveTokenResponse!: (response: Response) => void;
    let markTokenRequestStarted!: () => void;
    const tokenRequestStarted = new Promise<void>(resolve => { markTokenRequestStarted = resolve; });
    const tokenResponse = new Promise<Response>(resolve => { resolveTokenResponse = resolve; });
    globalThis.fetch = (async () => {
      markTokenRequestStarted();
      return tokenResponse;
    }) as typeof fetch;

    const flow = await manager.startXaiBrowserFlow();
    currentAuthUrl = flow.authUrl;
    const authUrl = new URL(currentAuthUrl);
    const callback = originalFetch(
      `http://127.0.0.1:56121/callback?code=browser-code&state=${authUrl.searchParams.get('state')}`,
      { headers: { Connection: 'close' } },
    );
    const completionError = flow.completion.catch(error => error as Error);
    await tokenRequestStarted;

    const cancellation = manager.cancelXaiOAuthFlow();
    resolveTokenResponse(jsonResponse({
      access_token: 'late-browser-access',
      refresh_token: 'late-browser-refresh',
      id_token: jwt({ nonce: authUrl.searchParams.get('nonce') }),
      expires_in: 3600,
    }));

    await callback;
    await cancellation;
    const cancellationError = await completionError;
    assert.ok(cancellationError instanceof Error);
    assert.match(cancellationError.message, /cancelled/);
    assert.equal(manager.readXaiOAuthBundle(), undefined);
  });

  it('callback HTML escapes provider errors and leaves credentials empty', async () => {
    const flow = await manager.startXaiBrowserFlow();
    const rejection = flow.completion.catch(error => error as Error);
    const response = await originalFetch('http://127.0.0.1:56121/callback?error=access_denied&error_description=%3Cscript%3Ebad%3C%2Fscript%3E');
    const html = await response.text();
    assert.doesNotMatch(html, /<script>bad<\/script>/);
    assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
    const rejectionError = await rejection;
    assert.ok(rejectionError instanceof Error);
    assert.match(rejectionError.message, /access_denied|script/);
    assert.equal(manager.readXaiOAuthBundle(), undefined);
  });

  it('callback server rejects untrusted CORS origins and supports approved private-network preflight', async () => {
    const flow = await manager.startXaiBrowserFlow();
    const completion = flow.completion.catch(() => undefined);
    const rejected = await originalFetch('http://127.0.0.1:56121/callback', {
      method: 'OPTIONS',
      headers: { Origin: 'https://attacker.example' },
    });
    assert.equal(rejected.status, 403);

    const approved = await originalFetch('http://127.0.0.1:56121/callback', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://auth.x.ai',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    assert.equal(approved.status, 204);
    assert.equal(approved.headers.get('access-control-allow-origin'), 'https://auth.x.ai');
    assert.equal(approved.headers.get('access-control-allow-private-network'), 'true');
    await manager.cancelXaiOAuthFlow();
    await completion;
  });

  it('reports fixed callback port occupation with device-code guidance', async () => {
    const blocker = http.createServer((_req, res) => res.end('occupied'));
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(56121, '127.0.0.1', resolve);
    });
    try {
      await assert.rejects(() => manager.startXaiBrowserFlow(), /already in use.*device-code/i);
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()));
    }
  });

  it('logout clears only the xAI OAuth bundle', () => {
    db.setSetting('unrelated_api_key_marker', 'keep');
    manager.saveXaiOAuthTokens({ accessToken: 'fresh-access', expiresAt: Date.now() + 3600_000 });
    manager.clearXaiOAuthTokens();
    assert.equal(manager.readXaiOAuthBundle(), undefined);
    assert.equal(db.getSetting('unrelated_api_key_marker'), 'keep');
  });

  it('virtual provider resolves to xAI Responses without a DB row', async () => {
    manager.saveXaiOAuthTokens({ accessToken: 'fresh-access', expiresAt: Date.now() + 3600_000 });
    const { resolveProvider, toAiSdkConfig } = await import('../../lib/provider-resolver');
    const resolved = resolveProvider({ providerId: 'xai-oauth', callScene: 'interactive_chat', model: 'grok-4.5' });
    assert.equal(resolved._xaiOAuth, true);
    assert.equal(resolved.provider, undefined);
    assert.equal(resolved.protocol, 'xai');
    assert.deepEqual(toAiSdkConfig(resolved), {
      sdkType: 'xai',
      apiKey: undefined,
      authToken: undefined,
      baseUrl: 'https://api.x.ai/v1',
      modelId: 'grok-4.5',
      headers: {},
      processEnvInjections: {},
      useXaiOAuth: true,
    });
  });
});
