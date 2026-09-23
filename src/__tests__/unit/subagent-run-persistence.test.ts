import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const originalDataDir = process.env.CLAUDE_GUI_DATA_DIR;
const originalDisableMigration = process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS;
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-subagent-runs-'));
process.env.CLAUDE_GUI_DATA_DIR = tempDataDir;
process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS = '1';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const db = require('../../lib/db') as typeof import('../../lib/db');
const {
  SUBAGENT_RUN_FACT_SOURCE,
  buildCodexSubagentRunContext,
  buildSubagentRunDetails,
  formatSubagentRunToolResult,
// eslint-disable-next-line @typescript-eslint/no-require-imports
} = require('../../lib/subagent-run-context') as typeof import('../../lib/subagent-run-context');
const {
  createCodePilotBuiltinTools,
// eslint-disable-next-line @typescript-eslint/no-require-imports
} = require('../../lib/codex/proxy/builtin-bridge') as typeof import('../../lib/codex/proxy/builtin-bridge');
const {
  parseSubagentStatusResult,
// eslint-disable-next-line @typescript-eslint/no-require-imports
} = require('../../lib/subagent-status') as typeof import('../../lib/subagent-status');
const {
  resolveSubagentDependencies,
// eslint-disable-next-line @typescript-eslint/no-require-imports
} = require('../../lib/subagent-orchestration') as typeof import('../../lib/subagent-orchestration');
const {
  registerCodexSubagentParentContext,
  resolveCodexSubagentPermission,
// eslint-disable-next-line @typescript-eslint/no-require-imports
} = require('../../lib/codex/subagent') as typeof import('../../lib/codex/subagent');

after(() => {
  db.closeDb();
  fs.rmSync(tempDataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CLAUDE_GUI_DATA_DIR;
  else process.env.CLAUDE_GUI_DATA_DIR = originalDataDir;
  if (originalDisableMigration === undefined) {
    delete process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS;
  } else {
    process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS = originalDisableMigration;
  }
});

function createParentSession(
  title: string,
  runtime: 'codepilot_runtime' | 'claude_code' | 'codex_runtime' = 'codex_runtime',
) {
  return db.createSession(
    title,
    'sonnet',
    '',
    tempDataDir,
    'code',
    'provider-parent',
    undefined,
    undefined,
    undefined,
    { runtimeId: runtime, state: 'bound', source: 'inherited_owner' },
  );
}

describe('subagent_runs durable lifecycle', () => {
  it('migrates physical-only legacy rows without guessing retry relationships', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE chat_sessions (id TEXT PRIMARY KEY);
      INSERT INTO chat_sessions (id) VALUES ('parent-legacy');
      CREATE TABLE subagent_runs (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        tool_name TEXT NOT NULL DEFAULT '',
        agent_name TEXT NOT NULL DEFAULT 'Sub-agent',
        provider_id TEXT NOT NULL DEFAULT '',
        requested_model TEXT NOT NULL DEFAULT '',
        effective_model TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running',
        terminal INTEGER NOT NULL DEFAULT 0,
        result_text TEXT NOT NULL DEFAULT '',
        error_json TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO subagent_runs (
        id, parent_session_id, runtime, status, terminal, created_at, updated_at
      ) VALUES
        ('legacy-running', 'parent-legacy', 'claude_code', 'running', 0, '2026-01-01 00:00:00', '2026-01-01 00:00:01'),
        ('legacy-complete', 'parent-legacy', 'codex_runtime', 'completed', 1, '2026-01-01 00:00:02', '2026-01-01 00:00:03');
      CREATE TABLE subagent_run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        logical_run_id TEXT NOT NULL DEFAULT '',
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        activity TEXT NOT NULL DEFAULT '',
        tool_name TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO subagent_run_events (
        id, run_id, logical_run_id, sequence, event_type, created_at, updated_at
      ) VALUES (
        'legacy-event', 'legacy-running', 'legacy-running', 1, 'started',
        '2026-01-01 00:00:00', '2026-01-01 00:00:00'
      );
    `);

    db.migrateSubagentRunSchema(legacy);
    const rows = legacy.prepare(`
      SELECT id, logical_run_id, attempt_number, phase, last_activity_at
      FROM subagent_runs
      ORDER BY id
    `).all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      {
        id: 'legacy-complete',
        logical_run_id: 'legacy-complete',
        attempt_number: 1,
        phase: 'terminal',
        last_activity_at: '2026-01-01 00:00:03',
      },
      {
        id: 'legacy-running',
        logical_run_id: 'legacy-running',
        attempt_number: 1,
        phase: 'running',
        last_activity_at: '2026-01-01 00:00:01',
      },
    ]);
    assert.ok(legacy.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'subagent_run_events'
    `).get());
    assert.ok(
      (legacy.prepare('PRAGMA table_info(subagent_run_events)').all() as Array<{ name: string }>)
        .some(column => column.name === 'cursor'),
      'additive migration must install the monotonic event cursor',
    );
    const migratedRunColumns = new Set(
      (legacy.prepare('PRAGMA table_info(subagent_runs)').all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    for (const column of ['workflow_id', 'task_key', 'dependencies_json', 'dispatch_state']) {
      assert.ok(migratedRunColumns.has(column), `additive migration must install ${column}`);
    }
    assert.ok(
      (legacy.prepare('SELECT cursor FROM subagent_run_events WHERE id = ?')
        .get('legacy-event') as { cursor: number }).cursor > 0,
      'legacy event rows must receive a usable cursor',
    );
    legacy.close();
  });

  it('re-runs structural migrations on a cached database after a dev schema revision changes', () => {
    const handle = db.getDb();
    const session = createParentSession('hmr migration must not recover runtime state');
    const checkpoint = db.addMessage(
      session.id,
      'assistant',
      'Live partial output',
      null,
      { stream_status: 'streaming' },
    );
    handle.exec('DROP INDEX IF EXISTS idx_subagent_runs_workflow_task');

    const stateMap = (
      globalThis as typeof globalThis & {
        [key: symbol]: Map<string, { db: Database.Database | null; schemaRevision?: string }> | undefined;
      }
    )[Symbol.for('codepilot.database-process-states')];
    const processState = stateMap?.get(path.join(tempDataDir, 'codepilot.db'));
    assert.ok(processState, 'the process-global database state must exist');
    processState.schemaRevision = 'stale-test-revision';

    delete process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS;
    try {
      assert.equal(db.getDb(), handle, 'schema refresh should reuse the live database handle');
    } finally {
      process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS = '1';
    }
    assert.ok(
      handle.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_subagent_runs_workflow_task'
      `).get(),
      'the idempotent migration must run again for the newly loaded schema revision',
    );
    const liveCheckpoint = handle.prepare(
      'SELECT content, stream_status FROM messages WHERE id = ?',
    ).get(checkpoint.id) as { content: string; stream_status: string };
    assert.deepEqual(
      liveCheckpoint,
      { content: 'Live partial output', stream_status: 'streaming' },
      'an HMR schema refresh must never run process-restart recovery against a live stream',
    );
  });

  it('starts running, settles exactly once, and cascades with the parent session', () => {
    const session = createParentSession('durable lifecycle');
    const started = db.startSubagentRun({
      id: 'run-terminal-once',
      parentSessionId: session.id,
      runtime: 'codex_runtime',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Researcher',
      providerId: 'provider-qwen',
      requestedModel: 'Qwen 3.8 Max Preview',
      prompt: 'Find the latest race news.',
    });

    assert.equal(started.status, 'running');
    assert.equal(started.phase, 'running');
    assert.equal(started.logical_run_id, 'run-terminal-once');
    assert.equal(started.attempt_number, 1);
    assert.equal(started.terminal, 0);
    assert.equal(started.completed_at, '');

    const oversizedCheckpoint = db.checkpointSubagentRun('run-terminal-once', {
      resultText: `discarded-prefix:${'x'.repeat(db.SUBAGENT_RUN_CHECKPOINT_MAX_CHARS)}`,
    });
    assert.equal(
      oversizedCheckpoint?.result_text.length,
      db.SUBAGENT_RUN_CHECKPOINT_MAX_CHARS,
      'running checkpoints must not grow without a bound',
    );
    assert.doesNotMatch(oversizedCheckpoint?.result_text ?? '', /discarded-prefix/);

    const checkpoint = db.checkpointSubagentRun('run-terminal-once', {
      resultText: 'Two sources collected so far.',
      effectiveProviderId: 'provider-qwen',
      effectiveModel: 'Qwen 3.8 Max Preview',
    });
    assert.equal(checkpoint?.status, 'running');
    assert.equal(checkpoint?.terminal, 0);
    assert.equal(checkpoint?.result_text, 'Two sources collected so far.');
    assert.equal(checkpoint?.effective_provider_id, 'provider-qwen');
    assert.equal(checkpoint?.effective_model, 'Qwen 3.8 Max Preview');
    assert.equal(checkpoint?.completed_at, '');

    const settling = db.markSubagentRunSettling('run-terminal-once');
    assert.equal(settling?.status, 'running');
    assert.equal(settling?.phase, 'settling');
    assert.equal(settling?.terminal, 0);

    const completed = db.settleSubagentRun('run-terminal-once', {
      status: 'completed',
      resultText: 'Verified race summary.',
      effectiveProviderId: 'provider-qwen',
      effectiveModel: 'Qwen 3.8 Max Preview',
      usage: { requests: 1, inputTokens: 123, outputTokens: 45 },
    });
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.phase, 'terminal');
    assert.equal(completed?.terminal, 1);
    assert.equal(completed?.result_text, 'Verified race summary.');
    assert.ok(completed?.completed_at);
    assert.deepEqual(JSON.parse(completed!.result_json), {
      status: 'completed',
      summary: 'Verified race summary.',
      sources: [],
      artifacts: [],
      warnings: [],
      usage: { requests: 1, inputTokens: 123, outputTokens: 45 },
      provenance: {
        logicalRunId: 'run-terminal-once',
        attemptId: 'run-terminal-once',
        attemptNumber: 1,
        requestedProviderId: 'provider-qwen',
        requestedModel: 'Qwen 3.8 Max Preview',
        effectiveProviderId: 'provider-qwen',
        effectiveModel: 'Qwen 3.8 Max Preview',
        factSource: 'sqlite.subagent_runs',
      },
    });
    assert.deepEqual(
      db.listSubagentRunEvents(session.id, 'run-terminal-once').map(event => event.event_type),
      ['started', 'partial_result', 'settling', 'terminal'],
      'coalesced checkpoints must produce one durable partial event and a typed terminal sequence',
    );

    const lateFailure = db.settleSubagentRun('run-terminal-once', {
      status: 'failed',
      resultText: 'Late duplicate must not win.',
      error: { code: 'RUNTIME_ERROR', retryable: false },
    });
    assert.equal(lateFailure?.status, 'completed');
    assert.equal(lateFailure?.result_text, 'Verified race summary.');
    assert.equal(lateFailure?.error_json, '');

    const lateCheckpoint = db.checkpointSubagentRun('run-terminal-once', {
      resultText: 'Late running output must not replace the terminal result.',
      effectiveProviderId: 'wrong-late-provider',
      effectiveModel: 'Wrong late model',
    });
    assert.equal(lateCheckpoint?.status, 'completed');
    assert.equal(lateCheckpoint?.result_text, 'Verified race summary.');
    assert.equal(lateCheckpoint?.effective_provider_id, 'provider-qwen');
    assert.equal(lateCheckpoint?.effective_model, 'Qwen 3.8 Max Preview');

    assert.equal(db.deleteSession(session.id), true);
    assert.equal(db.getSubagentRun('run-terminal-once'), undefined);
  });

  it('queues a dependent task and injects the upstream durable result before execution', async () => {
    const session = createParentSession('workflow dependency handoff', 'claude_code');
    const upstream = db.startSubagentRun({
      id: 'workflow-upstream',
      parentSessionId: session.id,
      runtime: 'claude_code',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Researcher',
      providerId: 'provider-qwen',
      requestedModel: 'qwen-max',
      workflowId: 'tour-news',
      taskKey: 'research',
      prompt: 'Research verified race news.',
    });
    db.markSubagentRunSettling(upstream.id);
    db.settleSubagentRun(upstream.id, {
      status: 'completed',
      resultText: 'Verified race facts: https://example.com/race',
    });
    const downstream = db.startSubagentRun({
      id: 'workflow-downstream',
      parentSessionId: session.id,
      runtime: 'claude_code',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Copywriter',
      providerId: 'provider-deepseek',
      requestedModel: 'deepseek-copy',
      workflowId: 'tour-news',
      taskKey: 'copy',
      dependencyTaskKeys: ['research'],
      prompt: 'Write a Chinese article.',
    });
    assert.equal(downstream.dispatch_state, 'queued');
    assert.match(downstream.current_activity, /Waiting for dependencies: research/);

    const resolved = await resolveSubagentDependencies({
      runId: downstream.id,
      parentSessionId: session.id,
      prompt: downstream.prompt,
      workflowId: downstream.workflow_id,
      dependencyTaskKeys: ['research'],
      timeoutMs: 100,
      pollMs: 5,
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.match(resolved.prompt, /Verified race facts/);
    assert.match(resolved.prompt, /"task_key":"research"/);
    assert.equal(db.getSubagentRun(downstream.id)?.dispatch_state, 'executing');
  });

  it('keeps a concurrently accepted downstream task queued until its upstream attempt settles', async () => {
    const session = createParentSession('parallel dependency wait', 'codepilot_runtime');
    const upstream = db.startSubagentRun({
      id: 'parallel-upstream',
      parentSessionId: session.id,
      runtime: 'codepilot_runtime',
      toolName: 'Agent',
      agentName: 'Researcher',
      workflowId: 'parallel-workflow',
      taskKey: 'research',
      prompt: 'Research.',
    });
    const downstream = db.startSubagentRun({
      id: 'parallel-downstream',
      parentSessionId: session.id,
      runtime: 'codepilot_runtime',
      toolName: 'Agent',
      agentName: 'Writer',
      workflowId: 'parallel-workflow',
      taskKey: 'copy',
      dependencyTaskKeys: ['research'],
      prompt: 'Write from research.',
    });
    const resolution = resolveSubagentDependencies({
      runId: downstream.id,
      parentSessionId: session.id,
      prompt: downstream.prompt,
      workflowId: downstream.workflow_id,
      dependencyTaskKeys: ['research'],
      timeoutMs: 250,
      pollMs: 5,
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(db.getSubagentRun(downstream.id)?.dispatch_state, 'queued');
    db.settleSubagentRun(upstream.id, {
      status: 'completed',
      resultText: 'Upstream completed after the downstream call was accepted.',
    });
    const resolved = await resolution;
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.match(resolved.prompt, /Upstream completed after/);
    }
    assert.equal(db.getSubagentRun(downstream.id)?.dispatch_state, 'executing');
  });

  it('distinguishes an existing upstream that stays active past the dependency deadline', async () => {
    const session = createParentSession('workflow dependency timeout');
    db.startSubagentRun({
      id: 'timeout-upstream',
      parentSessionId: session.id,
      runtime: 'codex_runtime',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Researcher',
      workflowId: 'timeout-workflow',
      taskKey: 'research',
      prompt: 'Research.',
    });
    const downstream = db.startSubagentRun({
      id: 'timeout-downstream',
      parentSessionId: session.id,
      runtime: 'codex_runtime',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Writer',
      workflowId: 'timeout-workflow',
      taskKey: 'copy',
      dependencyTaskKeys: ['research'],
      prompt: 'Write after research.',
    });
    const resolved = await resolveSubagentDependencies({
      runId: downstream.id,
      parentSessionId: session.id,
      prompt: downstream.prompt,
      workflowId: downstream.workflow_id,
      dependencyTaskKeys: ['research'],
      timeoutMs: 25,
      pollMs: 5,
    });
    assert.equal(resolved.ok, false);
    if (resolved.ok) return;
    assert.equal(resolved.error?.code, 'DEPENDENCY_TIMEOUT');
    assert.match(resolved.message, /^DEPENDENCY_TIMEOUT:/);
    assert.equal(db.getSubagentRun(downstream.id)?.dispatch_state, 'queued');
  });

  it('cancels dependency waiting when the parent chat turn is stopped', async () => {
    const session = createParentSession('workflow parent stop');
    db.startSubagentRun({
      id: 'stop-upstream',
      parentSessionId: session.id,
      runtime: 'codex_runtime',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Researcher',
      workflowId: 'stop-workflow',
      taskKey: 'research',
      prompt: 'Research.',
    });
    const downstream = db.startSubagentRun({
      id: 'stop-downstream',
      parentSessionId: session.id,
      runtime: 'codex_runtime',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Writer',
      workflowId: 'stop-workflow',
      taskKey: 'copy',
      dependencyTaskKeys: ['research'],
      prompt: 'Write after research.',
    });
    const parentAbort = new AbortController();
    const resolution = resolveSubagentDependencies({
      runId: downstream.id,
      parentSessionId: session.id,
      prompt: downstream.prompt,
      workflowId: downstream.workflow_id,
      dependencyTaskKeys: ['research'],
      abortSignal: parentAbort.signal,
      timeoutMs: 500,
      pollMs: 5,
    });
    setTimeout(() => parentAbort.abort(), 10);
    const resolved = await resolution;
    assert.equal(resolved.ok, false);
    if (resolved.ok) return;
    assert.equal(resolved.status, 'cancelled');
    assert.match(resolved.message, /parent turn was cancelled/);
    assert.equal(db.getSubagentRun(downstream.id)?.dispatch_state, 'queued');
  });

  it('fails a dependency edge without starting the downstream Runtime', async () => {
    const session = createParentSession('workflow dependency failure');
    const upstream = db.startSubagentRun({
      id: 'workflow-failed-upstream',
      parentSessionId: session.id,
      runtime: 'codex_runtime',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Researcher',
      workflowId: 'failed-workflow',
      taskKey: 'research',
      prompt: 'Research.',
    });
    db.settleSubagentRun(upstream.id, {
      status: 'failed',
      error: { code: 'AUTH_FORBIDDEN', httpStatus: 403, retryable: false },
    });
    const downstream = db.startSubagentRun({
      id: 'workflow-blocked-downstream',
      parentSessionId: session.id,
      runtime: 'codex_runtime',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Writer',
      workflowId: 'failed-workflow',
      taskKey: 'copy',
      dependencyTaskKeys: ['research'],
      prompt: 'Write.',
    });
    const resolved = await resolveSubagentDependencies({
      runId: downstream.id,
      parentSessionId: session.id,
      prompt: downstream.prompt,
      workflowId: downstream.workflow_id,
      dependencyTaskKeys: ['research'],
      timeoutMs: 100,
      pollMs: 5,
    });
    assert.equal(resolved.ok, false);
    if (resolved.ok) return;
    assert.equal(resolved.error?.code, 'DEPENDENCY_FAILED');
    assert.equal(db.getSubagentRun(downstream.id)?.dispatch_state, 'queued');
  });

  it('fails a missing upstream quickly so reverse tool order cannot deadlock a serial Runtime', async () => {
    const session = createParentSession('workflow missing upstream', 'claude_code');
    const downstream = db.startSubagentRun({
      id: 'workflow-missing-downstream',
      parentSessionId: session.id,
      runtime: 'claude_code',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Writer',
      workflowId: 'missing-workflow',
      taskKey: 'copy',
      dependencyTaskKeys: ['research'],
      prompt: 'Write after research.',
    });
    const resolved = await resolveSubagentDependencies({
      runId: downstream.id,
      parentSessionId: session.id,
      prompt: downstream.prompt,
      workflowId: downstream.workflow_id,
      dependencyTaskKeys: ['research'],
      timeoutMs: 500,
      pollMs: 5,
      missingDependencyGraceMs: 20,
    });
    assert.equal(resolved.ok, false);
    if (resolved.ok) return;
    assert.equal(resolved.error?.code, 'DEPENDENCY_NOT_FOUND');
    assert.match(resolved.message, /Create upstream tasks before their dependents/);
    assert.equal(db.getSubagentRun(downstream.id)?.dispatch_state, 'queued');
  });

  it('keeps a never-created upstream classified as not found when timeout is shorter than grace', async () => {
    const session = createParentSession('workflow short missing deadline');
    const downstream = db.startSubagentRun({
      id: 'workflow-short-missing-downstream',
      parentSessionId: session.id,
      runtime: 'codex_runtime',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Writer',
      workflowId: 'short-missing-workflow',
      taskKey: 'copy',
      dependencyTaskKeys: ['research'],
      prompt: 'Write after research.',
    });
    const resolved = await resolveSubagentDependencies({
      runId: downstream.id,
      parentSessionId: session.id,
      prompt: downstream.prompt,
      workflowId: downstream.workflow_id,
      dependencyTaskKeys: ['research'],
      timeoutMs: 15,
      pollMs: 5,
      missingDependencyGraceMs: 100,
    });
    assert.equal(resolved.ok, false);
    if (resolved.ok) return;
    assert.equal(resolved.error?.code, 'DEPENDENCY_NOT_FOUND');
    assert.match(resolved.message, /^DEPENDENCY_NOT_FOUND:/);
    assert.equal(db.getSubagentRun(downstream.id)?.dispatch_state, 'queued');
  });

  it('fails closed when the durable run disappears before Runtime execution', async () => {
    const session = createParentSession('workflow execution ownership');
    const resolved = await resolveSubagentDependencies({
      runId: 'missing-durable-attempt',
      parentSessionId: session.id,
      prompt: 'This child must never start.',
      timeoutMs: 20,
      pollMs: 5,
    });
    assert.equal(resolved.ok, false);
    if (resolved.ok) return;
    assert.equal(resolved.error?.code, 'RUNTIME_ERROR');
    assert.match(resolved.message, /child was not started/i);
  });

  it('rejects duplicate task keys unless the failed logical task is explicitly retried', () => {
    const session = createParentSession('workflow duplicate task', 'codepilot_runtime');
    const first = db.startSubagentRun({
      id: 'workflow-task-first',
      parentSessionId: session.id,
      runtime: 'codepilot_runtime',
      toolName: 'Agent',
      agentName: 'Researcher',
      workflowId: 'duplicate-workflow',
      taskKey: 'research',
      prompt: 'Research.',
    });
    db.settleSubagentRun(first.id, {
      status: 'failed',
      error: { code: 'RATE_LIMITED', retryable: true },
    });
    assert.throws(() => db.startSubagentRun({
      id: 'workflow-task-duplicate',
      parentSessionId: session.id,
      runtime: 'codepilot_runtime',
      toolName: 'Agent',
      agentName: 'Researcher',
      workflowId: 'duplicate-workflow',
      taskKey: 'research',
      prompt: 'Research again without retry identity.',
    }), (error: unknown) => {
      const rejection = db.describeSubagentRunStartRejection(error);
      assert.equal(rejection?.error.code, 'DUPLICATE_TASK_KEY');
      return true;
    });
    const retry = db.startSubagentRun({
      id: 'workflow-task-retry',
      logicalRunId: first.logical_run_id,
      parentSessionId: session.id,
      runtime: 'codepilot_runtime',
      toolName: 'Agent',
      agentName: 'Researcher',
      workflowId: 'duplicate-workflow',
      taskKey: 'research',
      prompt: 'Retry research.',
    });
    assert.equal(retry.attempt_number, 2);
    assert.equal(retry.task_key, 'research');
  });

  it('rejects an indirect workflow cycle before creating the closing task', () => {
    const session = createParentSession('workflow cycle', 'codepilot_runtime');
    db.startSubagentRun({
      id: 'cycle-task-a',
      parentSessionId: session.id,
      runtime: 'codepilot_runtime',
      toolName: 'Agent',
      agentName: 'Task A',
      workflowId: 'cycle-workflow',
      taskKey: 'a',
      dependencyTaskKeys: ['b'],
      prompt: 'Run after B.',
    });
    assert.throws(() => db.startSubagentRun({
      id: 'cycle-task-b',
      parentSessionId: session.id,
      runtime: 'codepilot_runtime',
      toolName: 'Agent',
      agentName: 'Task B',
      workflowId: 'cycle-workflow',
      taskKey: 'b',
      dependencyTaskKeys: ['a'],
      prompt: 'Run after A.',
    }), (error: unknown) => {
      const rejection = db.describeSubagentRunStartRejection(error);
      assert.equal(rejection?.error.code, 'INVALID_DEPENDENCY_SPEC');
      assert.match(rejection?.message || '', /a → b → a|b → a → b/);
      return true;
    });
    assert.equal(db.getSubagentRun('cycle-task-b'), undefined);
  });

  it('keeps retries under one logical run while preserving physical attempts', () => {
    const session = createParentSession('logical retry', 'claude_code');
    const first = db.startSubagentRun({
      id: 'attempt-first',
      logicalRunId: 'research-weather',
      parentSessionId: session.id,
      runtime: 'claude_code',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Researcher',
      providerId: 'provider-qwen',
      requestedModel: 'Qwen 3.8 Max Preview',
      prompt: 'Research the weather.',
    });
    db.settleSubagentRun(first.id, {
      status: 'failed',
      error: { code: 'RATE_LIMITED', httpStatus: 429, retryable: true },
    });
    const second = db.startSubagentRun({
      id: 'attempt-second',
      logicalRunId: 'research-weather',
      parentSessionId: session.id,
      runtime: 'claude_code',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Researcher',
      providerId: 'provider-qwen',
      requestedModel: 'Qwen 3.8 Max Preview',
      prompt: 'Research the weather.',
    });
    db.recordSubagentRunEvent(second.id, {
      type: 'tool_started',
      activity: 'Searching the web',
      toolName: 'WebSearch',
    });
    db.markSubagentRunSettling(second.id);
    db.settleSubagentRun(second.id, {
      status: 'completed',
      resultText: 'Sunny.',
      effectiveProviderId: 'provider-qwen',
      effectiveModel: 'Qwen 3.8 Max Preview',
    });

    assert.equal(first.attempt_number, 1);
    assert.equal(second.attempt_number, 2);
    const details = buildSubagentRunDetails(session.id, 'research-weather');
    assert.ok(details);
    assert.equal(details.logicalRunId, 'research-weather');
    assert.deepEqual(details.attempts.map(attempt => attempt.id), ['attempt-first', 'attempt-second']);
    assert.deepEqual(details.attempts.map(attempt => attempt.status), ['failed', 'completed']);
    assert.ok(details.events.some(event => (
      event.attemptId === 'attempt-second'
      && event.type === 'tool_started'
      && event.toolName === 'WebSearch'
    )));
    assert.equal(
      db.listSubagentRuns(session.id).filter(run => run.logical_run_id === 'research-weather').length,
      2,
      'the database keeps both auditable attempts even though the UI renders one logical capsule',
    );
    assert.deepEqual(
      db.listLatestSubagentRuns(session.id).map(run => run.id),
      ['attempt-second'],
      'parent/UI summaries expose only the latest attempt for one logical task',
    );
    const parentSummary = JSON.parse(formatSubagentRunToolResult({
      sessionId: session.id,
    })) as { runs: Array<{ logical_run_id: string; attempt_number: number }> };
    assert.equal(parentSummary.runs.length, 1);
    assert.equal(parentSummary.runs[0]?.logical_run_id, 'research-weather');
    assert.equal(parentSummary.runs[0]?.attempt_number, 2);
  });

  it('bounds event history and returns coalesced updates through an incremental cursor', () => {
    const session = createParentSession('bounded event cursor', 'codepilot_runtime');
    const started = db.startSubagentRun({
      id: 'attempt-bounded-events',
      logicalRunId: 'bounded-events',
      parentSessionId: session.id,
      runtime: 'codepilot_runtime',
      toolName: 'Agent',
      agentName: 'Writer',
      providerId: 'provider-deepseek',
      requestedModel: 'deepseek-v4',
      prompt: 'Run a long tool-heavy task.',
    });
    const firstActivity = db.recordSubagentRunEvent(started.id, {
      type: 'activity',
      activity: 'First activity',
      coalesceKey: 'current-activity',
    });
    assert.ok(firstActivity);
    const firstDetails = buildSubagentRunDetails(session.id, 'bounded-events');
    assert.ok(firstDetails);
    const firstCursor = firstDetails.nextEventCursor;

    const updatedActivity = db.recordSubagentRunEvent(started.id, {
      type: 'activity',
      activity: 'Updated activity',
      coalesceKey: 'current-activity',
    });
    assert.equal(updatedActivity?.id, firstActivity?.id);
    assert.ok((updatedActivity?.cursor || 0) > (firstActivity?.cursor || 0));
    const delta = buildSubagentRunDetails(session.id, 'bounded-events', {
      afterEventCursor: firstCursor,
    });
    assert.ok(delta);
    assert.equal(delta.events.length, 1);
    assert.equal(delta.events[0]?.id, firstActivity?.id);
    assert.equal(delta.events[0]?.activity, 'Updated activity');
    assert.ok(delta.nextEventCursor > firstCursor);

    for (let index = 0; index < db.SUBAGENT_RUN_EVENT_LIMIT_PER_ATTEMPT + 10; index += 1) {
      db.recordSubagentRunEvent(started.id, {
        type: index % 2 === 0 ? 'tool_started' : 'tool_completed',
        activity: `Tool event ${index}`,
        toolName: `tool-${index}`,
      });
    }
    const stored = db.listSubagentRunEvents(session.id, 'bounded-events');
    assert.equal(stored.length, db.SUBAGENT_RUN_EVENT_LIMIT_PER_ATTEMPT);
    assert.ok(
      stored.every((event, index) => index === 0 || event.cursor > stored[index - 1]!.cursor),
      'event cursor must be strictly increasing in API order',
    );
    const boundedDetails = buildSubagentRunDetails(session.id, 'bounded-events');
    assert.equal(
      boundedDetails?.events.length,
      db.SUBAGENT_RUN_EVENT_LIMIT_PER_ATTEMPT,
      'the first details payload is bounded rather than replaying unbounded history',
    );
  });

  it('rejects an explicit retry while the prior logical attempt is running or settling', () => {
    const session = createParentSession('logical retry active guard', 'claude_code');
    const first = db.startSubagentRun({
      id: 'attempt-active-first',
      logicalRunId: 'research-active',
      parentSessionId: session.id,
      runtime: 'claude_code',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Researcher',
      providerId: 'provider-qwen',
      requestedModel: 'Qwen 3.8 Max Preview',
      prompt: 'Research the active task.',
    });
    const retry = (id: string) => db.startSubagentRun({
      id,
      logicalRunId: 'research-active',
      parentSessionId: session.id,
      runtime: 'claude_code',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Researcher',
      providerId: 'provider-qwen',
      requestedModel: 'Qwen 3.8 Max Preview',
      prompt: 'Do not start a parallel retry.',
    });
    const assertActiveRejection = (id: string, phase: 'running' | 'settling') => {
      assert.throws(
        () => retry(id),
        (error) => {
          const rejection = db.describeSubagentRunStartRejection(error);
          assert.equal(rejection?.error.code, 'LOGICAL_RUN_STILL_RUNNING');
          assert.equal(rejection?.error.retryable, false);
          assert.match(rejection?.message || '', new RegExp(`phase "${phase}"`));
          return true;
        },
      );
    };

    assertActiveRejection('attempt-active-parallel-running', 'running');
    db.markSubagentRunSettling(first.id);
    assertActiveRejection('attempt-active-parallel-settling', 'settling');
    assert.deepEqual(
      db.listSubagentRunAttempts(session.id, 'research-active').map(run => run.id),
      ['attempt-active-first'],
      'rejected preflight calls must not create hidden physical attempts',
    );
  });

  it('rejects an explicit retry after the logical run completed successfully', () => {
    const session = createParentSession('logical retry completed guard');
    const first = db.startSubagentRun({
      id: 'attempt-completed-first',
      logicalRunId: 'research-completed',
      parentSessionId: session.id,
      runtime: 'codex_runtime',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Researcher',
      providerId: 'provider-kimi',
      requestedModel: 'Kimi for Coding',
      prompt: 'Finish successfully.',
    });
    db.settleSubagentRun(first.id, {
      status: 'completed',
      resultText: 'Delivered result.',
      effectiveProviderId: 'provider-kimi',
      effectiveModel: 'Kimi for Coding',
    });

    assert.throws(
      () => db.startSubagentRun({
        id: 'attempt-after-completed',
        logicalRunId: 'research-completed',
        parentSessionId: session.id,
        runtime: 'codex_runtime',
        toolName: 'codepilot_spawn_subagent',
        agentName: 'Researcher',
        providerId: 'provider-kimi',
        requestedModel: 'Kimi for Coding',
        prompt: 'Do not replace the delivered result.',
      }),
      (error) => {
        const rejection = db.describeSubagentRunStartRejection(error);
        assert.equal(rejection?.error.code, 'LOGICAL_RUN_ALREADY_COMPLETED');
        assert.equal(rejection?.error.retryable, false);
        assert.match(rejection?.message || '', /Do not replace or hide the delivered result/);
        return true;
      },
    );
    assert.deepEqual(
      db.listSubagentRunAttempts(session.id, 'research-completed').map(run => ({
        id: run.id,
        status: run.status,
      })),
      [{ id: 'attempt-completed-first', status: 'completed' }],
    );
  });

  it('stores durable lifecycle facts for every managed Runtime', () => {
    const sessions = [];
    for (const runtime of ['codepilot_runtime', 'claude_code', 'codex_runtime'] as const) {
      const session = createParentSession(`all runtime durability: ${runtime}`, runtime);
      sessions.push(session);
      const runId = `run-${runtime}`;
      db.startSubagentRun({
        id: runId,
        parentSessionId: session.id,
        runtime,
        toolName: runtime === 'codepilot_runtime' ? 'Agent' : 'codepilot_spawn_subagent',
        agentName: `${runtime} worker`,
        providerId: 'provider-child',
        requestedModel: 'child-model',
        prompt: 'Complete the task.',
      });
      const settled = db.settleSubagentRun(runId, {
        status: 'completed',
        resultText: `${runtime} result`,
        effectiveModel: 'effective-child-model',
      });
      assert.equal(settled?.runtime, runtime);
      assert.equal(settled?.terminal, 1);
      assert.equal(settled?.result_text, `${runtime} result`);
    }
    assert.deepEqual(
      new Set(sessions.flatMap(session => db.listSubagentRuns(session.id)).map((run) => run.runtime)),
      new Set(['codepilot_runtime', 'claude_code', 'codex_runtime']),
    );
  });

  it('refuses to launch an unowned run whose parent session does not exist', () => {
    assert.throws(
      () => db.startSubagentRun({
        id: 'run-without-parent',
        parentSessionId: 'missing-parent',
        runtime: 'codex_runtime',
        toolName: 'codepilot_spawn_subagent',
        agentName: 'Unowned worker',
        requestedModel: 'model-x',
        prompt: 'Do work.',
      }),
      /SUBAGENT_PARENT_RUNTIME_UNBOUND/,
    );
  });

  it('injects lifecycle facts without putting child prompt/result text in system instructions', () => {
    const session = createParentSession('context snapshot');
    db.startSubagentRun({
      id: 'run-still-running',
      parentSessionId: session.id,
      runtime: 'codex_runtime',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Writer',
      providerId: 'provider-deepseek',
      requestedModel: 'DeepSeek V4 Pro',
      prompt: 'PROMPT_SECRET_SHOULD_NOT_BE_IN_SYSTEM_CONTEXT',
    });
    db.startSubagentRun({
      id: 'run-failed',
      parentSessionId: session.id,
      runtime: 'codex_runtime',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Researcher',
      providerId: 'provider-qwen',
      requestedModel: 'Qwen 3.8 Max Preview',
      prompt: 'Research.',
    });
    db.settleSubagentRun('run-failed', {
      status: 'failed',
      resultText: 'RESULT_SECRET_SHOULD_NOT_BE_IN_SYSTEM_CONTEXT',
      error: { code: 'AUTH_FORBIDDEN', httpStatus: 403, retryable: false },
    });

    const context = buildCodexSubagentRunContext(session.id);
    assert.match(context, new RegExp(SUBAGENT_RUN_FACT_SOURCE.replace('.', '\\.')));
    assert.match(context, /"run_id":"run-still-running"/);
    assert.match(context, /"status":"running","phase":"running","terminal":false/);
    assert.match(context, /"status":"failed","phase":"terminal","terminal":true/);
    assert.match(context, /Do not infer progress from filenames or modification times/);
    assert.doesNotMatch(context, /PROMPT_SECRET_SHOULD_NOT_BE_IN_SYSTEM_CONTEXT/);
    assert.doesNotMatch(context, /RESULT_SECRET_SHOULD_NOT_BE_IN_SYSTEM_CONTEXT/);
  });

  it('returns bounded result excerpts only when the query explicitly requests them', () => {
    const session = createParentSession('query tool');
    db.startSubagentRun({
      id: 'run-query',
      parentSessionId: session.id,
      runtime: 'codex_runtime',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Frontend engineer',
      providerId: 'provider-kimi',
      requestedModel: 'Kimi for Coding',
      prompt: 'Build the page.',
    });
    db.settleSubagentRun('run-query', {
      status: 'partial',
      resultText: 'Partial HTML output',
      error: { code: 'MAX_TURNS', retryable: true },
    });

    const withoutResults = JSON.parse(formatSubagentRunToolResult({
      sessionId: session.id,
    })) as { source: string; runs: Array<Record<string, unknown>> };
    assert.equal(withoutResults.source, SUBAGENT_RUN_FACT_SOURCE);
    assert.equal(withoutResults.runs[0]?.status, 'partial');
    assert.equal(withoutResults.runs[0]?.terminal, true);
    assert.equal(withoutResults.runs[0]?.result_excerpt, undefined);

    const withResults = JSON.parse(formatSubagentRunToolResult({
      sessionId: session.id,
      includeResults: true,
    })) as { runs: Array<Record<string, unknown>> };
    assert.equal(withResults.runs[0]?.result_excerpt, 'Partial HTML output');
  });

  it('rejects an invalid Codex route before creating a durable workflow attempt', async () => {
    const session = createParentSession('bridge persistence');
    const bridge = createCodePilotBuiltinTools({
      sessionId: session.id,
      targetProviderId: 'provider-parent',
      workspacePath: tempDataDir,
    });
    const spawn = bridge.tools.codepilot_spawn_subagent as {
      execute?: (input: unknown, options: { abortSignal?: AbortSignal }) => Promise<unknown>;
    };
    assert.ok(spawn.execute);

    const wire = String(await spawn.execute!({
      prompt: 'Attempt an unavailable route.',
      agent_name: 'Unavailable worker',
      provider_id: 'missing-provider',
      model: 'missing-model',
    }, {}));
    const parsed = parseSubagentStatusResult(wire);
    assert.equal(parsed.metadata?.status, 'failed');
    assert.equal(parsed.metadata?.error?.code, 'MODEL_UNAVAILABLE');
    assert.ok(parsed.metadata?.taskId);

    const run = db.getSubagentRun(parsed.metadata!.taskId!);
    assert.equal(
      run,
      undefined,
      'a route that never existed must not claim a workflow task key or create a ghost capsule',
    );
    assert.match(
      parsed.body || '',
      /rejected before a durable workflow attempt was created/,
    );
  });

  it('settles a queued Codex dependency attempt as terminal cancelled when the parent turn stops', async () => {
    const session = createParentSession('bridge queued parent stop');
    db.startSubagentRun({
      id: 'bridge-stop-upstream',
      parentSessionId: session.id,
      runtime: 'codex_runtime',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Researcher',
      providerId: 'provider-research',
      requestedModel: 'research-model',
      workflowId: 'bridge-stop-workflow',
      taskKey: 'research',
      prompt: 'Keep researching.',
    });

    const parentAbort = new AbortController();
    const unregister = registerCodexSubagentParentContext(session.id, {
      permission: resolveCodexSubagentPermission(),
      abortSignal: parentAbort.signal,
    });
    let childStarted = false;
    const route = {
      providerId: 'provider-writer',
      providerName: 'Writer Provider',
      id: 'writer-model',
      displayName: 'Writer Model',
    };
    try {
      const bridge = createCodePilotBuiltinTools({
        sessionId: session.id,
        targetProviderId: 'provider-parent',
        workspacePath: tempDataDir,
      }, {
        listSubagentRoutes: () => [route],
        runCodexSubagent: async () => {
          childStarted = true;
          return { status: 'completed', text: 'must not run' };
        },
      });
      const spawn = bridge.tools.codepilot_spawn_subagent as {
        execute?: (input: unknown, options: { abortSignal?: AbortSignal }) => Promise<unknown>;
      };
      assert.ok(spawn.execute);

      const execution = spawn.execute!({
        prompt: 'Write only after research completes.',
        agent_name: 'Writer',
        provider_id: route.providerId,
        model: route.id,
        workflow_id: 'bridge-stop-workflow',
        task_key: 'copy',
        depends_on: ['research'],
      }, {});
      setTimeout(() => parentAbort.abort('parent Stop'), 10);

      const parsed = parseSubagentStatusResult(String(await execution));
      assert.equal(parsed.metadata?.status, 'cancelled');
      assert.equal(parsed.metadata?.phase, 'terminal');
      assert.equal(childStarted, false, 'parent Stop during dependency wait must not start Codex');

      const run = db.getSubagentRun(parsed.metadata!.taskId!);
      assert.ok(run, 'an accepted queued attempt must remain auditable');
      assert.equal(run!.status, 'cancelled');
      assert.equal(run!.phase, 'terminal');
      assert.equal(run!.terminal, 1);
      assert.equal(run!.dispatch_state, 'terminal');
      assert.match(run!.result_text, /parent turn was cancelled/);
    } finally {
      unregister();
    }
  });

  it('returns the immutable cancelled fact when a Codex child reports completed after Stop', async () => {
    const session = createParentSession('bridge late completion after stop');
    const route = {
      providerId: 'provider-late',
      providerName: 'Late Provider',
      id: 'late-model',
      displayName: 'Late Model',
    };
    let announceChildStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      announceChildStarted = resolve;
    });
    let finishChild!: () => void;
    const childCanFinish = new Promise<void>((resolve) => {
      finishChild = resolve;
    });
    const bridge = createCodePilotBuiltinTools({
      sessionId: session.id,
      targetProviderId: 'provider-parent',
      workspacePath: tempDataDir,
    }, {
      listSubagentRoutes: () => [route],
      runCodexSubagent: async () => {
        announceChildStarted();
        await childCanFinish;
        return {
          status: 'completed',
          text: 'late completed transport result',
          effectiveModel: route.id,
        };
      },
    });
    const spawn = bridge.tools.codepilot_spawn_subagent as {
      execute?: (
        input: unknown,
        options: { toolCallId: string; messages: unknown[]; context?: unknown },
      ) => Promise<unknown>;
    };
    assert.ok(spawn.execute);

    const execution = spawn.execute!({
      prompt: 'Stay active until Stop wins.',
      agent_name: 'Late Worker',
      provider_id: route.providerId,
      model: route.id,
    }, {
      toolCallId: 'late-wire-call',
      messages: [],
      context: undefined,
    });
    await childStarted;
    assert.deepEqual(
      db.cancelSubagentRunsForParentSession(session.id),
      ['late-wire-call'],
    );
    finishChild();

    const parsed = parseSubagentStatusResult(String(await execution));
    assert.equal(parsed.metadata?.status, 'cancelled');
    assert.equal(parsed.metadata?.phase, 'terminal');
    assert.doesNotMatch(parsed.body || '', /late completed transport result/);

    const run = db.getSubagentRun('late-wire-call');
    assert.equal(run?.status, 'cancelled');
    assert.equal(run?.terminal, 1);
  });
});
