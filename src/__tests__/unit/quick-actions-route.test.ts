import '../db-isolation.setup';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProvider, deleteProvider, setDefaultProviderId, setSetting, updateProvider } from '@/lib/db';
import { GET, POST } from '@/app/api/workspace/quick-actions/route';

const originalFetch = globalThis.fetch;
const roots: string[] = [];
const providers: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  setDefaultProviderId(''); setSetting('assistant_workspace_path', '');
  for (const id of providers.splice(0)) deleteProvider(id);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-actions-route-')); roots.push(root);
  setSetting('assistant_workspace_path', root);
  const provider = createProvider({ name: 'Quick suggestions test', provider_type: 'anthropic', api_key: 'synthetic-before', base_url: 'https://quick-actions.invalid' });
  providers.push(provider.id); setDefaultProviderId(provider.id);
  return provider;
}
function retry() { return POST(new Request('http://localhost:3000/api/workspace/quick-actions', {
  method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'retry' }),
})); }
function stream(text: string, model: string) {
  const chunks = [
    { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  return new Response(chunks.map(chunk => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

test('production endpoint bypasses both failure and success cache immediately after provider configuration changes', async () => {
  const provider = fixture();
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const key = new Headers(init?.headers).get('x-api-key');
    if (key === 'synthetic-before') return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    return stream(key === 'synthetic-after' ? 'Review our current goals?' : 'Plan the next milestone?', JSON.parse(String(init?.body)).model);
  };
  const failed = await (await GET()).json();
  assert.equal(failed.enhancement.status, 'unavailable');
  assert.equal(failed.enhancement.reason, 'credentials_missing');
  assert.ok(failed.actions.includes('__review_week__'));
  assert.equal(calls, 1);
  const same = await (await retry()).json();
  assert.equal(same.retryRequested, true);
  assert.equal(same.enhancement.status, 'unavailable');
  assert.equal(calls, 1, 'explicit retry cannot bypass a configuration block');
  updateProvider(provider.id, { api_key: 'synthetic-after' });
  const recovered = await (await GET()).json();
  assert.equal(recovered.enhancement.status, 'completed');
  assert.ok(recovered.actions.includes('Review our current goals?'));
  assert.equal(calls, 2, 'changed credentials recover in the same minute');
  await GET(); assert.equal(calls, 2, 'success cached');
  updateProvider(provider.id, { api_key: 'synthetic-final' });
  const changed = await (await GET()).json();
  assert.ok(changed.actions.includes('Plan the next milestone?'));
  assert.ok(!changed.actions.includes('Review our current goals?'));
  assert.equal(calls, 3, 'success invalidated by config identity');
  const refreshed = await retry();
  assert.equal(refreshed.headers.get('cache-control'), 'no-store');
  assert.equal((await refreshed.json()).retryRequested, true);
  assert.equal(calls, 4, 'explicit retry refreshes successful results');
});

test('retry returns the real future deadline without another model request', async () => {
  fixture();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '120' } }); };
  const first = await (await GET()).json();
  assert.notEqual(first.enhancement.status, 'completed');
  assert.ok(first.enhancement.retryAt > Date.now());
  const before = calls;
  const retried = await (await retry()).json();
  assert.equal(retried.enhancement.retryAt, first.enhancement.retryAt);
  assert.equal(retried.retryRequested, true);
  assert.equal(calls, before);
});

test('missing workspace remains a visible unavailable status and cross-origin retry is rejected', async () => {
  setSetting('assistant_workspace_path', '');
  assert.deepEqual(await (await GET()).json(), { actions: [], enhancement: { status: 'unavailable', reason: 'workspace_unavailable' } });
  const denied = await POST(new Request('http://localhost:3000/api/workspace/quick-actions', { method: 'POST', headers: { origin: 'https://outside.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'retry' }) }));
  assert.equal(denied.status, 403);
});

test('retry accepts the browser Host origin and rejects cross-site requests even with matching Origin', async () => {
  setSetting('assistant_workspace_path', '');
  const request = (site: string) => new Request('http://localhost:3000/api/workspace/quick-actions', {
    method: 'POST', headers: { host: '127.0.0.1:4567', origin: 'http://127.0.0.1:4567', 'content-type': 'application/json', 'sec-fetch-site': site },
    body: JSON.stringify({ action: 'retry' }),
  });
  assert.equal((await POST(request('same-origin'))).status, 200);
  assert.equal((await POST(request('cross-site'))).status, 403);
});

test('a provider change during generation discards the old response and keeps the new cache', async () => {
  const provider = fixture();
  let releaseOld!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const waiting = new Promise<void>(resolve => { releaseOld = resolve; });
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const old = new Headers(init?.headers).get('x-api-key') === 'synthetic-before';
    if (old) { markStarted(); await waiting; }
    return stream(old ? 'OLD provider suggestion?' : 'NEW provider suggestion?', JSON.parse(String(init?.body)).model);
  };
  const pending = GET();
  await started;
  updateProvider(provider.id, { api_key: 'synthetic-new-during-request' });
  const current = await (await GET()).json();
  assert.ok(current.actions.includes('NEW provider suggestion?'));
  releaseOld();
  const stale = await (await pending).json();
  assert.equal(stale.enhancement.reason, 'configuration_changed');
  assert.ok(!stale.actions.includes('OLD provider suggestion?'));
  const cached = await (await GET()).json();
  assert.ok(cached.actions.includes('NEW provider suggestion?'));
  assert.equal(calls, 2);
});
