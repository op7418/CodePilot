import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { POST as verifyDiscord } from '../../app/api/settings/discord/verify/route';
import { POST as verifyFeishu } from '../../app/api/settings/feishu/verify/route';
import { POST as verifyQq } from '../../app/api/settings/qq/verify/route';

const originalFetch = globalThis.fetch;

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('settings verify routes with shared HTTP client', () => {
  it('keeps Discord success shape', async () => {
    globalThis.fetch = (async () => (
      new Response(JSON.stringify({
        id: '123',
        username: 'test-bot',
        discriminator: '0001',
      }), { status: 200 })
    )) as typeof fetch;

    const response = await verifyDiscord(makeRequest({ bot_token: 'discord_token' }));
    assert.equal(response.status, 200);

    const payload = await response.json() as Record<string, unknown>;
    assert.equal(payload.verified, true);
    assert.equal(payload.botName, 'test-bot#0001');
  });

  it('adds detail/requestId on Discord upstream http error', async () => {
    globalThis.fetch = (async () => (
      new Response('unauthorized', { status: 401, statusText: 'Unauthorized' })
    )) as typeof fetch;

    const response = await verifyDiscord(makeRequest({ bot_token: 'bad_token' }));
    assert.equal(response.status, 200);

    const payload = await response.json() as Record<string, unknown>;
    assert.equal(payload.verified, false);
    assert.equal(payload.error, 'HTTP 401: Token verification failed');
    assert.equal(typeof payload.detail, 'string');
    assert.equal(typeof payload.requestId, 'string');
  });

  it('keeps QQ success shape', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/getAppAccessToken')) {
        return new Response(JSON.stringify({ access_token: 'qq_token' }), { status: 200 });
      }
      if (url.includes('/gateway')) {
        return new Response(JSON.stringify({ url: 'wss://gateway.qq.test/ws' }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const response = await verifyQq(makeRequest({ app_id: 'appid', app_secret: 'appsecret' }));
    assert.equal(response.status, 200);

    const payload = await response.json() as Record<string, unknown>;
    assert.equal(payload.verified, true);
    assert.equal(payload.gatewayUrl, 'wss://gateway.qq.test/ws');
  });

  it('adds detail/requestId on QQ upstream http error', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response('service unavailable', { status: 503, statusText: 'Service Unavailable' });
    }) as typeof fetch;

    const response = await verifyQq(makeRequest({ app_id: 'appid', app_secret: 'appsecret' }));
    assert.equal(response.status, 200);

    const payload = await response.json() as Record<string, unknown>;
    assert.equal(payload.verified, false);
    assert.equal(payload.error, 'HTTP 503: Verification failed');
    assert.equal(typeof payload.detail, 'string');
    assert.equal(typeof payload.requestId, 'string');
    assert.equal(attempts, 2);
  });

  it('keeps Feishu success shape', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ tenant_access_token: 'token_123' }), { status: 200 });
      }
      if (url.includes('/bot/v3/info/')) {
        return new Response(JSON.stringify({ bot: { open_id: 'ou_xxx', app_name: 'FeishuBot' } }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const response = await verifyFeishu(makeRequest({
      app_id: 'appid',
      app_secret: 'secret',
      domain: 'feishu',
    }));
    assert.equal(response.status, 200);

    const payload = await response.json() as Record<string, unknown>;
    assert.equal(payload.verified, true);
    assert.equal(payload.botName, 'FeishuBot');
  });

  it('adds detail/requestId on Feishu upstream http error', async () => {
    let attempts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/tenant_access_token/internal')) {
        attempts += 1;
        return new Response('forbidden', { status: 403, statusText: 'Forbidden' });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const response = await verifyFeishu(makeRequest({
      app_id: 'appid',
      app_secret: 'secret',
      domain: 'feishu',
    }));
    assert.equal(response.status, 200);

    const payload = await response.json() as Record<string, unknown>;
    assert.equal(payload.verified, false);
    assert.equal(payload.error, 'HTTP 403: Verification failed');
    assert.equal(typeof payload.detail, 'string');
    assert.equal(typeof payload.requestId, 'string');
    assert.equal(attempts, 1);
  });
});
