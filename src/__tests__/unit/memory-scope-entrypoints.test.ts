import '../db-isolation.setup';
import { after, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSession, deleteSession, getSetting, getSession, getDb, setSetting, addMessage, acquireSessionLock, releaseSessionLock } from '@/lib/db';
import { ASSISTANT_MEMORY_MIGRATION_KEY, migrateLegacyAssistantMemoryBindings } from '@/lib/assistant-memory-migration';
import { bindAssistantMemory, getAssistantMemoryWorkspace, getSessionMemoryWorkspace } from '@/lib/memory-binding';
import { createBinding } from '@/lib/bridge/channel-router';
import { consumeStream } from '@/lib/bridge/conversation-engine';
import { getMemoryJobStatus, resumeMemoryJobs } from '@/lib/memory-lifecycle';
import { GET as sessionGET } from '@/app/api/chat/sessions/[id]/route';
import { assembleContext } from '@/lib/context-assembler';
import { initializeWorkspace } from '@/lib/assistant-workspace';
import { POST as wizardPOST } from '@/app/api/workspace/wizard/route';
import { POST as assistantPOST } from '@/app/api/workspace/session/route';

const roots: string[] = [];
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-entrypoint-')); roots.push(root);
  setSetting('assistant_workspace_path', root);
});
after(() => roots.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
it('migrates old assistant sessions once and keeps new ordinary same-cwd sessions unbound', async () => {
  initializeWorkspace(root);
  fs.writeFileSync(path.join(root, 'soul.md'), '# Soul\nLEGACY_ASSISTANT_PERSONALITY');
  const old = createSession('Old manual assistant', '', '', root);
  const project = createSession('Ordinary project', '', '', path.dirname(root));
  assert.ok(getDb().prepare('SELECT 1 FROM settings WHERE key = ?').get(ASSISTANT_MEMORY_MIGRATION_KEY), 'production DB bootstrap runs the versioned migration');
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(ASSISTANT_MEMORY_MIGRATION_KEY);
  migrateLegacyAssistantMemoryBindings(getDb());
  assert.equal(getAssistantMemoryWorkspace(old), fs.realpathSync(root));
  assert.equal(getSessionMemoryWorkspace(project.id), undefined);
  const fresh = createSession('New ordinary session', '', '', root);
  migrateLegacyAssistantMemoryBindings(getDb());
  assert.equal(getAssistantMemoryWorkspace(fresh), undefined);
  const readsBefore = getDb().prepare('SELECT COUNT(*) as n FROM settings').get();
  getAssistantMemoryWorkspace(old); getAssistantMemoryWorkspace(old);
  assert.deepEqual(getDb().prepare('SELECT COUNT(*) as n FROM settings').get(), readsBefore, 'read path has no DB writes');
  const ui = await sessionGET({} as never, { params: Promise.resolve({ id: old.id }) });
  assert.equal((await ui.json()).assistantMemoryEnabled, true);
  const context = await assembleContext({ session: getSession(old.id)!, entryPoint: 'desktop', userPrompt: 'Hi' });
  assert.equal(context.isAssistantProject, true);
  assert.match(context.systemPrompt || '', /LEGACY_ASSISTANT_PERSONALITY/);
  assert.equal((await (await sessionGET({} as never, { params: Promise.resolve({ id: fresh.id }) })).json()).assistantMemoryEnabled, false);
});
it('real Bridge creation plus three committed turns queues extraction without test-side binding', async () => {
  const priorKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-entrypoint';
  setSetting('agent_runtime', 'claude-code-sdk');
  setSetting('bridge_default_provider_id', 'env');
  setSetting('bridge_default_model', 'haiku');
  setSetting('bridge_default_work_dir', root);
  try {
    const binding = createBinding({ channelType: 'telegram', chatId: `test-${path.basename(root)}` });
    const session = getSession(binding.codepilotSessionId)!;
    assert.equal(session.runtime_binding_source, 'bridge_create');
    assert.equal(getAssistantMemoryWorkspace(session), fs.realpathSync(root));
    // Delete only the provider selection so execution exercises unavailable without network.
    getDb().prepare("UPDATE chat_sessions SET provider_id = 'missing-fixture' WHERE id = ?").run(session.id);
    for (let i = 0; i < 3; i++) {
      const user = addMessage(session.id, 'user', 'I prefer concise responses.');
      const lock = `bridge-${i}`; acquireSessionLock(session.id, lock, 'test', 60);
      const stream = new ReadableStream<string>({ start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'Understood.' })}\n\n`);
        controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ finish_reason: 'stop' }) })}\n\n`);
        controller.close();
      } });
      await consumeStream(stream, session.id, lock, undefined, undefined, undefined, user.id);
      releaseSessionLock(session.id, lock);
    }
    await resumeMemoryJobs(root);
    assert.equal(getMemoryJobStatus(root).jobs.length, 1);
    assert.equal(getMemoryJobStatus(root).jobs[0].reason, 'provider_missing');
    const outside = createBinding({ channelType: 'telegram', chatId: `outside-${path.basename(root)}` }, path.dirname(root));
    assert.equal(getSessionMemoryWorkspace(outside.codepilotSessionId), undefined);
  } finally { if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey; }
});
it('a workspace switch during assistant entry returns a conflict without orphaning a session', async () => {
  createSession('Existing assistant check-in', '', '', root);
  const before = getDb().prepare('SELECT COUNT(*) as n FROM chat_sessions').get();
  const response = await assistantPOST({ json: async () => {
    setSetting('assistant_workspace_path', path.dirname(root));
    return { mode: 'checkin' };
  } } as never);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'assistant_scope_changed');
  assert.deepEqual(getDb().prepare('SELECT COUNT(*) as n FROM chat_sessions').get(), before);
});

it('rolls back a newly inserted assistant session if binding fails after creation', async () => {
  const priorKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-assistant-entrypoint';
  setSetting('agent_runtime', 'claude-code-sdk');
  try {
    const before = getDb().prepare('SELECT COUNT(*) as n FROM chat_sessions').get();
    const response = await assistantPOST({ json: async () => {
      setSetting('assistant_workspace_path', path.dirname(root));
      return { mode: 'onboarding', provider_id: 'env', model: 'haiku' };
    } } as never);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'assistant_scope_changed');
    assert.deepEqual(getDb().prepare('SELECT COUNT(*) as n FROM chat_sessions').get(), before);
  } finally { if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey; }
});

it('checkin never binds a task session and deleting a user session removes only its own binding', async () => {
  const user = createSession('visible assistant', '', '', root);
  const task = createSession('hidden task', '', '', root);
  getDb().prepare("UPDATE chat_sessions SET source = 'task', updated_at = '2099-01-01' WHERE id = ?").run(task.id);
  const response = await assistantPOST({ json: async () => ({ mode: 'checkin' }) } as never);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).session.id, user.id);
  assert.equal(getSessionMemoryWorkspace(task.id), undefined);
  assert.throws(() => bindAssistantMemory(task.id), /MEMORY_BINDING_SCOPE_MISMATCH/);
  assert.ok(getSetting(`memory.assistant-binding.${user.id}`));
  setSetting(`memory.assistant-binding.${task.id}`, 'unrelated fixture');
  assert.equal(deleteSession(user.id), true);
  assert.equal(getSetting(`memory.assistant-binding.${user.id}`), undefined);
  assert.equal(getSetting(`memory.assistant-binding.${task.id}`), 'unrelated fixture');
});

for (const entry of ['bridge', 'wizard'] as const) {
  it(`${entry} rolls back session creation if the memory binding cannot be persisted`, async () => {
    const priorKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'synthetic-transaction-test';
    setSetting('agent_runtime', 'claude-code-sdk');
    setSetting('bridge_default_provider_id', 'env');
    setSetting('bridge_default_model', 'haiku');
    setSetting('bridge_default_work_dir', root);
    setSetting('global_default_model_provider', 'env');
    setSetting('global_default_model', 'haiku');
    // Fail only the real binding INSERT, after real createSession has run.
    const db = getDb();
    db.exec(`CREATE TEMP TRIGGER fail_memory_binding BEFORE INSERT ON settings
      WHEN NEW.key LIKE 'memory.assistant-binding.%'
      BEGIN SELECT RAISE(ABORT, 'synthetic binding persistence failure'); END`);
    const before = db.prepare('SELECT COUNT(*) as n FROM chat_sessions').get();
    const beforeBindings = db.prepare('SELECT COUNT(*) as n FROM channel_bindings').get();
    try {
      if (entry === 'bridge') {
        assert.throws(() => createBinding({ channelType: 'telegram', chatId: `rollback-${path.basename(root)}` }), /synthetic binding persistence failure/);
      } else {
        const response = await wizardPOST({ json: async () => ({}) } as never);
        assert.equal(response.status, 500);
        assert.match((await response.json()).error, /synthetic binding persistence failure/);
      }
      assert.deepEqual(db.prepare('SELECT COUNT(*) as n FROM chat_sessions').get(), before);
      assert.deepEqual(db.prepare('SELECT COUNT(*) as n FROM channel_bindings').get(), beforeBindings);
    } finally {
      db.exec('DROP TRIGGER fail_memory_binding');
      if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey;
    }
  });
}
