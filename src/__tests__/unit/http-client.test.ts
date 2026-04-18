import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getJson } from '../../lib/http/client';
import { HttpClientError } from '../../lib/http/errors';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('http client', () => {
  it('retries network errors with exponential backoff and keeps requestId', async () => {
    let attempts = 0;
    const requestIds: string[] = [];

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      requestIds.push(new Headers(init?.headers).get('x-request-id') || '');
      if (attempts === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const result = await getJson<{ ok: boolean }>('https://example.test/retry', {
      retries: 2,
      retryDelayMs: 1,
      retryJitterMs: 0,
    });

    assert.equal(result.data.ok, true);
    assert.equal(attempts, 2);
    assert.equal(Boolean(requestIds[0]), true);
    assert.equal(requestIds[0], requestIds[1]);
  });

  it('retries on 429 and succeeds', async () => {
    let attempts = 0;

    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('rate limited', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'retry-after': '0' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const result = await getJson<{ ok: boolean }>('https://example.test/rate-limit', {
      retries: 2,
      retryDelayMs: 1,
      retryJitterMs: 0,
    });

    assert.equal(result.data.ok, true);
    assert.equal(attempts, 2);
  });

  it('does not retry non-retryable 4xx errors', async () => {
    let attempts = 0;

    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }) as typeof fetch;

    await assert.rejects(
      () => getJson('https://example.test/not-found', { retries: 3, retryDelayMs: 1, retryJitterMs: 0 }),
      (error: unknown) => {
        assert.equal(error instanceof HttpClientError, true);
        const httpError = error as HttpClientError;
        assert.equal(httpError.code, 'http_status');
        assert.equal(httpError.status, 404);
        assert.equal(httpError.retryable, false);
        return true;
      },
    );
    assert.equal(attempts, 1);
  });

  it('times out and returns normalized timeout error', async () => {
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        }, { once: true });
      })
    )) as typeof fetch;

    await assert.rejects(
      () => getJson('https://example.test/timeout', { timeoutMs: 20, retries: 0 }),
      (error: unknown) => {
        assert.equal(error instanceof HttpClientError, true);
        const httpError = error as HttpClientError;
        assert.equal(httpError.code, 'timeout');
        assert.match(httpError.requestId, /.+/);
        return true;
      },
    );
  });
});
