import '../db-isolation.setup';
import { after, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';
import type { ClaudeStreamOptions } from '../../types';
import { createProvider, createSession, getMessages, getSession, upsertProviderModel } from '../../lib/db';
import { stopScheduler } from '../../lib/task-scheduler';

// Replace only the external Runtime transport before loading the actual route.
// The request handler, catalog resolution, locks, collector and SQLite are real.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const transport = require('../../lib/claude-client') as typeof import('../../lib/claude-client');
const transportPath = require.resolve('../../lib/claude-client');
const originalModule = require.cache[transportPath]!;
let calls = 0;
const models: string[] = [];
require.cache[transportPath] = { ...originalModule, exports: {
  ...transport,
  streamClaude(options: ClaudeStreamOptions) {
    calls++;
    models.push(options.model!);
    return new ReadableStream<string>({ start(c) {
      for (const event of [
        { type: 'status', data: JSON.stringify({ session_id: 'http-fixture-sdk', model: options.model }) },
        { type: 'text', data: 'isolated HTTP reply' },
        { type: 'done', data: '' },
      ]) c.enqueue(`data: ${JSON.stringify(event)}\n\n`);
      c.close();
    } });
  },
} };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { POST } = require('../../app/api/chat/route') as typeof import('../../app/api/chat/route');
after(() => { require.cache[transportPath] = originalModule; stopScheduler(); });
// Catch accidental outbound model/background requests rather than using real credentials.
mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network in route fixture'); });

const p = createProvider({ name: 'http-route-fixture', provider_type: 'anthropic', protocol: 'anthropic',
  base_url: 'https://token-plan-cn.xiaomimimo.com/anthropic', preset_key: 'xiaomi-mimo-token-plan', api_key: 'fixture-not-a-real-key' });
function session(model: string) {
  return createSession('explicit fixture title', model, '', '', 'code', p.id, undefined, 'user', 'manual', {
    state: 'bound', runtimeId: 'claude_code', source: 'first_execution',
  });
}
async function send(sid: string, model = 'sonnet', providerId = p.id) {
  return POST(new Request('http://localhost/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sid, content: 'route regression fixture', model, provider_id: providerId }),
  }) as NextRequest);
}
async function readSse(response: Response) {
  // Next's server adapter accepts the route's string chunks; Node's bare
  // Response.text() expects bytes. Consume the exported handler as-is here.
  const reader = response.body!.getReader();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += typeof value === 'string' ? value : new TextDecoder().decode(value);
  }
}
for (const stored of ['sonnet', 'mimo-v2.5-pro']) {
  it(`POST accepts two consecutive turns with stored ${stored}, retaining route and history`, async () => {
    const s = session(stored);
    for (let turn = 0; turn < 2; turn++) {
      const response = await send(s.id);
      assert.equal(response.status, 200);
      assert.match(await readSse(response), /isolated HTTP reply/);
      // Persistence settles before the collector's background finalization.
      for (let i = 0; i < 20 && getSession(s.id)?.runtime_status === 'running'; i++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(getSession(s.id)!.model, stored);
      assert.equal(getSession(s.id)!.route_revision, s.route_revision);
      assert.equal(models.at(-1), 'mimo-v2.5-pro');
    }
    assert.equal(getMessages(s.id).messages.length, 4);
  });
}
it('POST refuses actual model/provider changes and ambiguous legacy identity before transcript or Runtime work', async () => {
  const s = session('sonnet');
  const before = calls;
  for (const [model, providerId] of [['other-model', p.id], ['sonnet', 'other-provider']]) {
    const response = await send(s.id, model, providerId);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'MESSAGE_ROUTE_MISMATCH');
  }
  upsertProviderModel({ provider_id: p.id, model_id: 'second-alias', upstream_model_id: 'mimo-v2.5-pro', enabled: 1 });
  const legacy = session('mimo-v2.5-pro');
  const response = await send(legacy.id);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'MESSAGE_ROUTE_MISMATCH');
  assert.equal(getMessages(s.id).messages.length, 0);
  assert.equal(getMessages(legacy.id).messages.length, 0);
  assert.equal(calls, before);
});
