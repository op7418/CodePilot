import '../db-isolation.setup';
import { after, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, addMessage, setSetting, getDb } from '@/lib/db';
import { bindAssistantMemory, getAssistantMemoryWorkspace, getSessionMemoryWorkspace } from '@/lib/memory-binding';
import { enqueueCommittedMemoryTurn, getMemoryJobStatus, resumeMemoryJobs, memoryMessageText } from '@/lib/memory-lifecycle';

const roots: string[] = [];
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lifecycle-'));
  roots.push(root);
  setSetting('assistant_workspace_path', root);
});
after(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });
const session = () => createSession('Memory lifecycle', '', '', root, 'code', 'missing-test-provider');
function turn(sessionId: string) {
  addMessage(sessionId, 'user', 'I prefer Chinese responses.');
  const reply = addMessage(sessionId, 'assistant', 'Understood.');
  return { sessionId, assistantMessageId: reply.id, successful: true, ownerValid: true,
    entryPoint: 'desktop' as const, blocks: [] };
}
it('requires explicit assistant intent and excludes ordinary project memory', () => {
  const s = session();
  assert.equal(getAssistantMemoryWorkspace(s), undefined);
  assert.equal(getSessionMemoryWorkspace(s.id), undefined);
  assert.equal(enqueueCommittedMemoryTurn(turn(s.id)), false);
  assert.equal(fs.existsSync(path.join(root, '.assistant')), false);
  bindAssistantMemory(s.id);
  assert.equal(getAssistantMemoryWorkspace(s), fs.realpathSync(root));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-other-')); roots.push(other);
  assert.equal(getSessionMemoryWorkspace(s.id, other), undefined);
  setSetting('assistant_workspace_path', other);
  assert.equal(getAssistantMemoryWorkspace(s), undefined);
});
it('rejects unsuccessful, stolen-owner, system and headless turns before counting', async () => {
  const s = session(); bindAssistantMemory(s.id);
  const input = turn(s.id);
  for (const patch of [{ successful: false }, { ownerValid: false }, { systemTurn: true }, { entryPoint: 'headless' as const }]) {
    assert.equal(enqueueCommittedMemoryTurn({ ...input, ...patch }), false);
  }
  assert.equal(fs.existsSync(path.join(root, '.assistant')), false);
  assert.equal(enqueueCommittedMemoryTurn(input), false);
  assert.equal(enqueueCommittedMemoryTurn(input), false);
  assert.equal(enqueueCommittedMemoryTurn(turn(s.id)), false);
  assert.equal(enqueueCommittedMemoryTurn({ ...turn(s.id), entryPoint: 'bridge' }), true);
  await resumeMemoryJobs(root);
  const state = getMemoryJobStatus(root);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, 'unavailable');
  assert.equal(state.jobs[0].reason, 'provider_missing');
  const persisted = fs.readFileSync(path.join(root, '.assistant/memory-jobs.json'), 'utf8');
  assert.equal(persisted.includes('I prefer'), false, 'job ledger must contain references, not conversation text');
});
it('requires a successfully persisted assistant source', () => {
  const s = session(); bindAssistantMemory(s.id);
  const input = turn(s.id);
  getDb().prepare("UPDATE messages SET stream_status = 'interrupted' WHERE id = ?").run(input.assistantMessageId);
  assert.equal(enqueueCommittedMemoryTurn(input), false);
  assert.equal(enqueueCommittedMemoryTurn({ ...input, assistantMessageId: 'missing' }), false);
});
it('read-only and failed memory tools do not suppress extraction', async () => {
  const s = session(); bindAssistantMemory(s.id);
  enqueueCommittedMemoryTurn(turn(s.id)); enqueueCommittedMemoryTurn(turn(s.id));
  assert.equal(enqueueCommittedMemoryTurn({ ...turn(s.id), blocks: [
    { type: 'tool_use', id: 'r', name: 'codepilot_memory_get', input: { path: 'memory.md' } },
    { type: 'tool_result', tool_use_id: 'r', content: 'memory.md contents' },
  ] }), true);
  await resumeMemoryJobs(root);
  assert.equal(getMemoryJobStatus(root).jobs.length, 1);
});
it('uses only actual text blocks as extraction input', () => {
  assert.equal(memoryMessageText(JSON.stringify([{ type: 'thinking', thinking: 'private' }, { type: 'tool_result', content: 'fake preference' }, { type: 'text', text: 'actual' }])), 'actual');
});
it('does not create metadata for an unused workspace', async () => {
  await resumeMemoryJobs(root);
  assert.deepEqual(getMemoryJobStatus(root).jobs, []);
  assert.equal(fs.existsSync(path.join(root, '.assistant')), false);
});

it('rejects scheduled and heartbeat user-shaped rows, including explicit wrong provenance', () => {
  const s = session(); bindAssistantMemory(s.id);
  for (const field of ['task_run_id', 'is_heartbeat_ack']) {
    const input = turn(s.id);
    const user = getDb().prepare("SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1").get(s.id) as { id: string };
    getDb().prepare(`UPDATE messages SET ${field} = ? WHERE id = ?`).run(field === 'task_run_id' ? 'scheduled-fixture' : 1, user.id);
    assert.equal(enqueueCommittedMemoryTurn({ ...input, userMessageId: user.id }), false);
  }
  const input = turn(s.id);
  const futureUser = addMessage(s.id, 'user', 'Not this turn');
  assert.equal(enqueueCommittedMemoryTurn({ ...input, userMessageId: futureUser.id }), false);
  assert.equal(fs.existsSync(path.join(root, '.assistant')), false);
});

// Exercise the real extraction -> SDK -> record write path using synthetic SSE,
// with no network, credentials, CLI, or production database access.
import { mock } from 'node:test';
import { createProvider, updateProvider, updateSessionProviderId, acquireSessionLock, releaseSessionLock } from '@/lib/db';
import { readMemoryRecords } from '@/lib/memory-records';
import { captureAuxiliaryRoute } from '@/lib/auxiliary-provider';
import { resolveCodePilotDataDir } from '@/lib/codepilot-data-dir';
import { collectStreamResponse } from '@/lib/chat-collect-stream-response';
import { consumeStream } from '@/lib/bridge/conversation-engine';

function providerFixture() {
  return createProvider({ name: 'memory synthetic', provider_type: 'anthropic', protocol: 'anthropic',
    api_key: 'synthetic-memory-key', base_url: 'https://example.invalid' });
}
function extractionResponse(text: string, model: string) {
  const events = [
    { type: 'message_start', message: { id: 'synthetic', type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
function extractionFetch(onTurns?: (turns: Array<{ messageId: string; user: string }>) => void) {
  return mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const content = body.messages.at(-1).content;
    const { turns } = JSON.parse(typeof content === 'string' ? content : content[0].text);
    onTurns?.(turns);
    return extractionResponse(JSON.stringify(turns.map((t: { messageId: string; user: string }) => ({
      messageId: t.messageId, content: t.user, evidence: t.user,
    }))), body.model);
  });
}
function ledgerPath() { return path.join(root, '.assistant/memory-jobs.json'); }
async function pendingBatch() {
  const s = session(); bindAssistantMemory(s.id);
  for (let i = 0; i < 3; i++) {
    const user = addMessage(s.id, 'user', `I prefer response format ${i + 1}.`);
    const assistant = addMessage(s.id, 'assistant', 'Understood.');
    enqueueCommittedMemoryTurn({ sessionId: s.id, assistantMessageId: assistant.id, userMessageId: user.id,
      successful: true, ownerValid: true, entryPoint: 'desktop', blocks: [] });
  }
  await resumeMemoryJobs(root);
  return s;
}

it('extracts all three committed user turns with exact provenance and recovers a committed batch without regenerating', async () => {
  const s = await pendingBatch();
  const p = providerFixture(); updateSessionProviderId(s.id, p.id);
  const mocked = extractionFetch(turns => assert.equal(turns.length, 3));
  try {
    await resumeMemoryJobs(root);
    assert.equal(mocked.mock.callCount(), 1);
    const records = readMemoryRecords(root).records;
    assert.equal(records.length, 3, 'first and second turns must not be lost');
    assert.equal(new Set(records.map(r => r.source.messageId)).size, 3);
    assert.equal(getMemoryJobStatus(root).jobs[0].status, 'completed');
    // Crash point: records atomically committed but job status write never happened.
    const ledger = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    ledger.jobs[0].status = 'running';
    fs.writeFileSync(ledgerPath(), JSON.stringify(ledger));
    await resumeMemoryJobs(root);
    assert.equal(mocked.mock.callCount(), 1, 'recovery must not ask a model for different content under the old key');
    assert.equal(readMemoryRecords(root).records.length, 3);
    assert.equal(getMemoryJobStatus(root).jobs[0].status, 'completed');
  } finally { mocked.mock.restore(); }
});

it('persists a retry deadline across runner state loss and lets a credential change recover immediately', async () => {
  const s = await pendingBatch();
  const p = providerFixture(); updateSessionProviderId(s.id, p.id);
  const route = captureAuxiliaryRoute(p.id)!;
  const ledger = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
  Object.assign(ledger.jobs[0], { status: 'failed', routeFingerprint: route.fingerprint, retryAt: Date.now() + 300_000 });
  fs.writeFileSync(ledgerPath(), JSON.stringify(ledger));
  const mocked = extractionFetch();
  try {
    await resumeMemoryJobs(root);
    assert.equal(mocked.mock.callCount(), 0);
    updateProvider(p.id, { api_key: 'synthetic-memory-key-changed' });
    await resumeMemoryJobs(root);
    assert.equal(mocked.mock.callCount(), 1);
    assert.equal(getMemoryJobStatus(root).jobs[0].status, 'completed');
    assert.equal(fs.readFileSync(ledgerPath(), 'utf8').includes('synthetic-memory-key'), false);
  } finally { mocked.mock.restore(); }
});

it('does not save stale user evidence changed during asynchronous extraction', async () => {
  const s = await pendingBatch();
  const p = providerFixture(); updateSessionProviderId(s.id, p.id);
  const mocked = extractionFetch(turns => {
    getDb().prepare('UPDATE messages SET content = ? WHERE id = ?').run('Corrected preference', turns[0].messageId);
  });
  try {
    await resumeMemoryJobs(root);
    assert.equal(readMemoryRecords(root).records.length, 0);
    assert.equal(getMemoryJobStatus(root).jobs[0].reason, 'source_changed');
  } finally { mocked.mock.restore(); }
});

for (const entry of ['desktop', 'bridge'] as const) {
  it(`real ${entry} collector queues only committed successful owner turns before persistence callbacks`, async () => {
    const s = session(); bindAssistantMemory(s.id);
    for (const [index, finish] of ['interrupted', 'inProgress', 'error', 'stream-error', 'malformed', 'missing', 'stale', 'stop', 'stop', 'stop'].entries()) {
      const user = addMessage(s.id, 'user', 'I prefer concise answers.');
      const lock = `${entry}-${index}`;
      acquireSessionLock(s.id, lock, 'test', 600);
      if (finish === 'stale') releaseSessionLock(s.id, lock);
      const events = [{ type: 'text', data: 'Understood.' }];
      if (finish === 'stream-error') events.push({ type: 'error', data: 'synthetic stream failure' });
      if (finish !== 'missing') events.push({ type: 'result', data: finish === 'malformed' ? 'invalid JSON' : JSON.stringify({ is_error: finish === 'error', finish_reason: finish === 'stream-error' ? 'stop' : finish }) });
      const stream = new ReadableStream<string>({ start(c) {
        for (const event of events) c.enqueue(`data: ${JSON.stringify(event)}\n\n`);
        c.close();
      } });
      if (entry === 'desktop') {
        await collectStreamResponse(stream, s.id, lock, {}, undefined, {
          onPersistenceSettled: () => { releaseSessionLock(s.id, lock); },
        });
      } else {
        await consumeStream(stream, s.id, lock, undefined, undefined, undefined, user.id);
        releaseSessionLock(s.id, lock);
      }
    }
    await resumeMemoryJobs(root);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    assert.equal(ledger.turns.length, 3, 'failed/interrupted/unconfirmed turns cannot increment extraction cadence');
    assert.equal(ledger.jobs.length, 1);
    assert.equal(ledger.jobs[0].sources.length, 3);
  });
}

it('rotates bounded retries so an older failed job cannot starve a newer pending batch', async () => {
  const s = session(); bindAssistantMemory(s.id);
  for (let i = 0; i < 12; i++) enqueueCommittedMemoryTurn(turn(s.id));
  await resumeMemoryJobs(root);
  await resumeMemoryJobs(root);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
  assert.equal(ledger.jobs.length, 4);
  assert.ok(ledger.jobs.every((job: { status: string }) => job.status === 'unavailable'));
});

it('cools malformed model output too, instead of repeatedly calling a successful transport', async () => {
  const s = await pendingBatch();
  const p = providerFixture(); updateSessionProviderId(s.id, p.id);
  const mocked = mock.method(globalThis, 'fetch', async () => extractionResponse('not JSON', 'synthetic'));
  try {
    await resumeMemoryJobs(root);
    await resumeMemoryJobs(root);
    assert.equal(mocked.mock.callCount(), 1);
    assert.equal(getMemoryJobStatus(root).jobs[0].status, 'failed');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    assert.ok(ledger.jobs[0].retryAt > Date.now());
  } finally { mocked.mock.restore(); }
});

it('Plan never queues or saves automatic memory, and queued work resumes after returning to code mode', async () => {
  const s = session(); bindAssistantMemory(s.id);
  getDb().prepare("UPDATE chat_sessions SET mode = 'plan' WHERE id = ?").run(s.id);
  assert.equal(enqueueCommittedMemoryTurn(turn(s.id)), false);
  assert.equal(fs.existsSync(path.join(root, '.assistant')), false);
  getDb().prepare("UPDATE chat_sessions SET mode = 'code' WHERE id = ?").run(s.id);
  for (let i = 0; i < 3; i++) enqueueCommittedMemoryTurn(turn(s.id));
  await resumeMemoryJobs(root);
  const p = providerFixture(); updateSessionProviderId(s.id, p.id);
  getDb().prepare("UPDATE chat_sessions SET mode = 'plan' WHERE id = ?").run(s.id);
  let flipDuringGeneration = true;
  const mocked = extractionFetch(() => {
    if (flipDuringGeneration) getDb().prepare("UPDATE chat_sessions SET mode = 'plan' WHERE id = ?").run(s.id);
  });
  try {
    await resumeMemoryJobs(root);
    assert.equal(mocked.mock.callCount(), 0);
    assert.equal(getMemoryJobStatus(root).jobs[0].reason, 'policy_blocked');
    getDb().prepare("UPDATE chat_sessions SET mode = 'code' WHERE id = ?").run(s.id);
    await resumeMemoryJobs(root);
    assert.equal(mocked.mock.callCount(), 1);
    assert.equal(readMemoryRecords(root).records.length, 0, 'mode must be checked again after the await');
    assert.equal(getMemoryJobStatus(root).jobs[0].status, 'unavailable');
    flipDuringGeneration = false;
    getDb().prepare("UPDATE chat_sessions SET mode = 'code' WHERE id = ?").run(s.id);
    await resumeMemoryJobs(root);
    assert.equal(getMemoryJobStatus(root).jobs[0].status, 'completed');
    assert.equal(readMemoryRecords(root).records.length, 3);
  } finally { mocked.mock.restore(); }
});

for (const failure of ['capacity', 'corrupt', 'busy'] as const) {
  it(`blocks ${failure} storage before model execution and resumes only after repair`, async () => {
    const s = await pendingBatch();
    const p = providerFixture(); updateSessionProviderId(s.id, p.id);
    const dir = path.join(root, 'memory'); fs.mkdirSync(dir, { recursive: true });
    const blockedFile = path.join(dir, failure === 'busy' ? '.records-lock' : 'records.md');
    fs.writeFileSync(blockedFile, failure === 'capacity' ? 'x'.repeat(2 * 1024 * 1024 + 1) : 'corrupt fixture');
    const mocked = extractionFetch();
    try {
      await resumeMemoryJobs(root);
      const job = getMemoryJobStatus(root).jobs[0];
      assert.equal(job.status, failure === 'busy' ? 'failed' : 'unavailable');
      if (failure !== 'busy') assert.equal(job.reason, `storage_${failure}`);
      // Even an expired retry timer cannot authorize spending on a broken store.
      const ledger = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
      ledger.jobs[0].retryAt = 1;
      fs.writeFileSync(ledgerPath(), JSON.stringify(ledger));
      await resumeMemoryJobs(root);
      assert.equal(mocked.mock.callCount(), 0);
      // Test-only invalid fixture removal; never delete a user's valid tombstones.
      fs.unlinkSync(blockedFile);
      const repaired = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
      repaired.jobs[0].retryAt = 1;
      fs.writeFileSync(ledgerPath(), JSON.stringify(repaired));
      await resumeMemoryJobs(root);
      assert.equal(mocked.mock.callCount(), 1);
      assert.equal(getMemoryJobStatus(root).jobs[0].status, 'completed');
    } finally { mocked.mock.restore(); }
  });
}

it('persisted configuration-required jobs never retry by timer, but changed credentials resume', async () => {
  const s = await pendingBatch();
  const p = providerFixture(); updateSessionProviderId(s.id, p.id);
  const route = captureAuxiliaryRoute(p.id)!;
  assert.ok(route.fingerprint);
  assert.match(route.fingerprint, /^hmac-v1:[a-f0-9]{64}$/);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
  Object.assign(ledger.jobs[0], { status: 'unavailable', reason: 'credentials_missing',
    routeFingerprint: route.fingerprint, requiresConfigurationChange: true, retryAt: 1 });
  fs.writeFileSync(ledgerPath(), JSON.stringify(ledger));
  const mocked = extractionFetch();
  try {
    await resumeMemoryJobs(root); await resumeMemoryJobs(root);
    assert.equal(mocked.mock.callCount(), 0);
    updateProvider(p.id, { api_key: 'synthetic-config-changed' });
    await resumeMemoryJobs(root);
    assert.equal(mocked.mock.callCount(), 1);
    assert.equal(getMemoryJobStatus(root).jobs[0].status, 'completed');
  } finally { mocked.mock.restore(); }
});

it('caps malformed-output model attempts at three across passive resumes and does not reset on configuration changes', async () => {
  const s = await pendingBatch();
  assert.equal(JSON.parse(fs.readFileSync(ledgerPath(), 'utf8')).jobs[0].attempts, 0, 'unavailable provider is not a paid attempt');
  const p = providerFixture(); updateSessionProviderId(s.id, p.id);
  const mocked = mock.method(globalThis, 'fetch', async () => extractionResponse('not JSON', 'synthetic'));
  try {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
      ledger.jobs[0].retryAt = 1;
      fs.writeFileSync(ledgerPath(), JSON.stringify(ledger));
      await resumeMemoryJobs(root);
      assert.equal(mocked.mock.callCount(), Math.min(attempt, 3));
    }
    const exhausted = getMemoryJobStatus(root).jobs[0];
    assert.equal(exhausted.status, 'unavailable');
    assert.equal(exhausted.reason, 'retry_exhausted');
    assert.equal(exhausted.retryAt, undefined);
    updateProvider(p.id, { api_key: 'synthetic-changed-after-exhaustion' });
    await resumeMemoryJobs(root);
    assert.equal(mocked.mock.callCount(), 3);
    assert.equal(readMemoryRecords(root).records.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(ledgerPath(), 'utf8')).jobs[0].attempts, 3);
  } finally { mocked.mock.restore(); }
});

it('a crash reservation is included in the durable attempt budget', async () => {
  const s = await pendingBatch();
  const p = providerFixture(); updateSessionProviderId(s.id, p.id);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
  Object.assign(ledger.jobs[0], { status: 'running', attempts: 3 });
  fs.writeFileSync(ledgerPath(), JSON.stringify(ledger));
  const mocked = extractionFetch();
  try {
    await resumeMemoryJobs(root);
    assert.equal(mocked.mock.callCount(), 0);
    assert.equal(getMemoryJobStatus(root).jobs[0].reason, 'retry_exhausted');
  } finally { mocked.mock.restore(); }
});

it('recovers a legacy configuration_required latch without requiring a needless provider change', async () => {
  const s = await pendingBatch();
  const p = providerFixture(); updateSessionProviderId(s.id, p.id);
  const route = captureAuxiliaryRoute(p.id)!;
  const ledger = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
  Object.assign(ledger.jobs[0], { status: 'unavailable', reason: 'configuration_required',
    routeFingerprint: route.fingerprint, requiresConfigurationChange: true });
  fs.writeFileSync(ledgerPath(), JSON.stringify(ledger));
  const mocked = extractionFetch();
  try {
    await resumeMemoryJobs(root);
    assert.equal(mocked.mock.callCount(), 1);
    assert.equal(getMemoryJobStatus(root).jobs[0].status, 'completed');
  } finally { mocked.mock.restore(); }
});

it('identity file failure is unavailable with zero paid attempts and recovers after local repair', async () => {
  const s = await pendingBatch();
  const p = providerFixture(); updateSessionProviderId(s.id, p.id);
  captureAuxiliaryRoute(p.id);
  const file = path.join(resolveCodePilotDataDir(), 'auxiliary-identity-key.v1');
  const key = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.alloc(1));
  const mocked = extractionFetch();
  try {
    await resumeMemoryJobs(root); await resumeMemoryJobs(root);
    assert.equal(mocked.mock.callCount(), 0);
    assert.equal(getMemoryJobStatus(root).jobs[0].status, 'unavailable');
    assert.equal(getMemoryJobStatus(root).jobs[0].reason, 'identity_unavailable');
    assert.equal(JSON.parse(fs.readFileSync(ledgerPath(), 'utf8')).jobs[0].attempts, 0);
    fs.writeFileSync(file, key);
    await resumeMemoryJobs(root);
    assert.equal(mocked.mock.callCount(), 1);
    assert.equal(getMemoryJobStatus(root).jobs[0].status, 'completed');
  } finally { fs.writeFileSync(file, key); mocked.mock.restore(); }
});
