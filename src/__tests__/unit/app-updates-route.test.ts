import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GET } from '../../app/api/app/updates/route';

const originalFetch = globalThis.fetch;
const originalVersion = process.env.NEXT_PUBLIC_APP_VERSION;

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_VERSION = '0.1.0';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (typeof originalVersion === 'string') {
    process.env.NEXT_PUBLIC_APP_VERSION = originalVersion;
  } else {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
  }
});

describe('GET /api/app/updates', () => {
  it('returns compatible success payload when upstream release is fetched', async () => {
    globalThis.fetch = (async () => (
      new Response(
        JSON.stringify({
          tag_name: 'v0.2.0',
          name: 'v0.2.0',
          body: 'release notes',
          published_at: '2026-04-18T00:00:00.000Z',
          html_url: 'https://github.com/op7418/CodePilot/releases/tag/v0.2.0',
          assets: [],
        }),
        { status: 200 },
      )
    )) as typeof fetch;

    const response = await GET();
    assert.equal(response.status, 200);
    const payload = await response.json() as Record<string, unknown>;

    assert.equal(payload.latestVersion, '0.2.0');
    assert.equal(payload.currentVersion, '0.1.0');
    assert.equal(payload.updateAvailable, true);
    assert.equal(typeof payload.releaseName, 'string');
    assert.equal(typeof payload.releaseNotes, 'string');
    assert.equal(typeof payload.releaseUrl, 'string');
    assert.equal(typeof payload.downloadUrl, 'string');
    assert.equal(typeof payload.detectedPlatform, 'string');
  });

  it('maps upstream 5xx into a readable 502 payload', async () => {
    globalThis.fetch = (async () => (
      new Response('bad gateway', { status: 503, statusText: 'Service Unavailable' })
    )) as typeof fetch;

    const response = await GET();
    assert.equal(response.status, 502);
    const payload = await response.json() as Record<string, unknown>;

    assert.equal(payload.error, 'Failed to fetch release info');
    assert.equal(typeof payload.detail, 'string');
    assert.equal(typeof payload.requestId, 'string');
  });

  it('returns 500 when response JSON is invalid', async () => {
    globalThis.fetch = (async () => (
      new Response('not-json', { status: 200 })
    )) as typeof fetch;

    const response = await GET();
    assert.equal(response.status, 500);
    const payload = await response.json() as Record<string, unknown>;

    assert.equal(payload.error, 'Failed to check for updates');
    assert.equal(typeof payload.detail, 'string');
    assert.equal(typeof payload.requestId, 'string');
  });
});
