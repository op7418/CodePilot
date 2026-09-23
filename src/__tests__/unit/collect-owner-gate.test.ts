/**
 * Session ownership — session-level write owner gate.
 *
 * Behavioral (real-driven) test, NOT a source-pin. It drives the REAL exported
 * `collectStreamResponse` with a real SSE `ReadableStream` and a real DB lock
 * state (per-worker temp DB from db-isolation.setup.ts), then asserts against
 * the DB (getMessages / getSession / getTasksBySession).
 *
 * The I1/DP1 invariant: every session-level write inside collect — sdk_session_id,
 * model, SDK tasks, and the assistant `addMessage` — must be gated on
 * `isLockOwner(sessionId, lockId)`. A superseded turn (its lock taken over by a
 * newer send) reaches collect LATE carrying its OLD lockId and must write NOTHING.
 *
 *   - happy path (true owner still holds the lock): assistant message lands,
 *     sdk_session_id / tasks persisted, committed model preserved — proves
 *     the gate does NOT drop the legitimate owner's writes.
 *   - stale path (lock taken over by lockB): assistant message DROPPED (DP1),
 *     sdk_session_id / model / tasks all left untouched — only diagnostic logs.
 *
 * Ordering-safety note (why the owner is never falsely dropped): in production
 * `addMessage` runs inside collect's try, BEFORE onComplete→settleLock releases
 * the lock (finally). So the true owner is still the lock holder when it persists.
 *
 * This file is also run directly during stream-persistence debugging. Keep the
 * isolation preload as the FIRST import so a bare
 * `npx tsx --test collect-owner-gate.test.ts` can never open the Dev database.
 */

import '../db-isolation.setup';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { collectStreamResponse } from '../../lib/chat-collect-stream-response';
import {
  createSession,
  acquireSessionLock,
  releaseSessionLock,
  isLockOwner,
  getMessages,
  getSession,
  getTasksBySession,
  updateSdkSessionId,
  updateSessionModel,
  addMessage,
  createPermissionRequest,
  getPermissionRequest,
  recoverInterruptedMessageStreams,
  runRuntimeStartupRecoveryOnce,
} from '../../lib/db';

// Build a single SSE chunk for a `{ type, data }` event, matching what the
// runtime emits and what collect parses (`data:` prefix; `data` is a JSON
// string for status/result/task_update, raw text for `text`).
function sse(type: string, data: unknown): string {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${JSON.stringify({ type, data: dataStr })}\n\n`;
}

function streamOf(chunks: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

const NO_TELEGRAM = {} as { sessionId?: string; sessionTitle?: string; workingDirectory?: string };
// suppressNotifications avoids telegram / memory side effects during the test.
const OPTS = { suppressNotifications: true } as const;

function assistantMessages(sessionId: string) {
  return getMessages(sessionId).messages.filter((m) => m.role === 'assistant');
}

describe('collectStreamResponse session-level write owner gate (Phase 3 B)', () => {
  it('happy path: the lock owner persists output and SDK reference without changing the committed model', async () => {
    const sid = createSession('collect-owner-happy', 'sonnet').id;
    const lockA = 'lockA-happy';
    assert.equal(acquireSessionLock(sid, lockA, 'test-owner', 600), true, 'acquire should succeed');
    assert.equal(isLockOwner(sid, lockA), true, 'A owns the lock');

    const stream = streamOf([
      sse('status', { session_id: 'sdk-happy', model: 'claude-happy' }),
      sse('task_update', { session_id: sid, todos: [{ id: 't1', content: 'do work', status: 'in_progress' }] }),
      sse('text', 'Hello from the true owner'),
      sse('result', { session_id: 'sdk-happy', is_error: false, usage: { input_tokens: 3, output_tokens: 5 } }),
    ]);

    await collectStreamResponse(stream, sid, lockA, NO_TELEGRAM, undefined, OPTS);

    // Assistant message DID land (reverse example — gate must not drop the owner).
    const msgs = assistantMessages(sid);
    assert.equal(msgs.length, 1, 'owner assistant message must be persisted');
    assert.equal(msgs[0].content, 'Hello from the true owner', 'persisted content matches');
    assert.equal(msgs[0].stream_status, 'completed', 'terminal row must not remain a streaming checkpoint');

    // Session-level state written by the owner.
    const row = getSession(sid)!;
    assert.equal(row.sdk_session_id, 'sdk-happy', 'owner wrote sdk_session_id');
    assert.equal(row.model, 'sonnet', 'reported model must not overwrite committed route');
    assert.equal(row.route_revision, 0, 'runtime reports are not route mutations');

    // SDK tasks synced by the owner.
    const tasks = getTasksBySession(sid);
    assert.equal(tasks.length, 1, 'owner synced SDK tasks');
    assert.equal(tasks[0].title, 'do work', 'synced task content matches');
  });

  it('stale owner (lock taken over): assistant NOT persisted (DP1) and all session-level writes dropped', async () => {
    const sid = createSession('collect-owner-stale').id;
    const lockA = 'lockA-stale';
    const lockB = 'lockB-newowner';

    // A originally owned the session, then a newer send takes over: production
    // path is Stop → watchdog releaseSessionLock(A) → new request acquire(B).
    assert.equal(acquireSessionLock(sid, lockA, 'test-owner-A', 600), true, 'A acquires');
    assert.equal(releaseSessionLock(sid, lockA), true, 'watchdog releases A');
    assert.equal(acquireSessionLock(sid, lockB, 'test-owner-B', 600), true, 'B takes over');
    assert.equal(isLockOwner(sid, lockA), false, 'A is no longer the owner (superseded)');
    assert.equal(isLockOwner(sid, lockB), true, 'B is the current owner');

    // Establish B's persisted state so we can prove the stale turn does NOT clobber it.
    updateSdkSessionId(sid, 'B-OWNED-SID');
    updateSessionModel(sid, 'B-OWNED-MODEL');

    // The stale turn (lockA) reaches collect late and tries to write everything.
    const stream = streamOf([
      sse('status', { session_id: 'STALE-SID-MUST-NOT-WRITE', model: 'STALE-MODEL-MUST-NOT-WRITE' }),
      sse('task_update', { session_id: sid, todos: [{ id: 'x', content: 'stale task', status: 'pending' }] }),
      sse('text', 'Stale assistant answer that must be dropped'),
      sse('result', { session_id: 'STALE-SID-MUST-NOT-WRITE', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }),
    ]);

    await collectStreamResponse(stream, sid, lockA, NO_TELEGRAM, undefined, OPTS);

    // DP1: the stale assistant content must NOT be persisted into `messages`.
    assert.equal(assistantMessages(sid).length, 0, 'stale assistant message must be dropped (DP1)');

    // Session-level writes dropped — B's state is untouched.
    const row = getSession(sid)!;
    assert.equal(row.sdk_session_id, 'B-OWNED-SID', 'stale turn must not overwrite sdk_session_id');
    assert.equal(row.model, 'B-OWNED-MODEL', 'stale turn must not overwrite model');

    // SDK task sync dropped for the stale turn.
    assert.equal(getTasksBySession(sid).length, 0, 'stale turn must not sync SDK tasks');
  });

  it('checkpoints a structured Sub-agent transcript before stream end, then finalizes the same row', async () => {
    const sid = createSession('collect-checkpoint-refresh').id;
    const lockId = 'lock-checkpoint-refresh';
    assert.equal(acquireSessionLock(sid, lockId, 'test-owner', 600), true);

    let controller!: ReadableStreamDefaultController<string>;
    const stream = new ReadableStream<string>({
      start(nextController) {
        controller = nextController;
      },
    });
    const collecting = collectStreamResponse(stream, sid, lockId, NO_TELEGRAM, undefined, OPTS);

    controller.enqueue(sse('text', 'Preparing result. '));
    controller.enqueue(sse('tool_use', {
      id: 'subagent-run-1',
      name: 'codepilot_spawn_subagent',
      input: { agent_name: 'researcher', model: 'qwen3.8-max' },
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const during = assistantMessages(sid);
    assert.equal(during.length, 1, 'first meaningful output creates one durable checkpoint row');
    assert.equal(during[0].stream_status, 'streaming');
    const duringBlocks = JSON.parse(during[0].content) as Array<Record<string, unknown>>;
    assert.equal(duringBlocks[1]?.type, 'tool_use');
    assert.equal(duringBlocks[1]?.id, 'subagent-run-1', 'real Sub-agent tool id survives refresh checkpoint');

    controller.enqueue(sse('tool_result', {
      tool_use_id: 'subagent-run-1',
      content: JSON.stringify({ status: 'completed', terminal: true, text: 'done' }),
      is_error: false,
    }));
    controller.enqueue(sse('text', 'Finished.'));
    controller.enqueue(sse('result', {
      session_id: 'sdk-checkpoint',
      is_error: false,
      usage: { input_tokens: 7, output_tokens: 11 },
    }));
    controller.close();
    await collecting;

    const after = assistantMessages(sid);
    assert.equal(after.length, 1, 'terminal persistence updates the checkpoint instead of inserting a duplicate');
    assert.equal(after[0].id, during[0].id, 'checkpoint identity is stable across completion');
    assert.equal(after[0].stream_status, 'completed');
    const finalBlocks = JSON.parse(after[0].content) as Array<Record<string, unknown>>;
    assert.equal(finalBlocks.some((block) => block.type === 'tool_result'), true);
    assert.equal(finalBlocks.at(-1)?.type, 'text');
  });

  it('startup recovery marks only unfinished assistant checkpoints interrupted', () => {
    const sid = createSession('collect-checkpoint-restart').id;
    const partial = addMessage(sid, 'assistant', 'Saved partial response', null, {
      stream_status: 'streaming',
    });
    const complete = addMessage(sid, 'assistant', 'Already complete', null, {
      stream_status: 'completed',
    });

    assert.equal(recoverInterruptedMessageStreams(), 1);
    const rows = assistantMessages(sid);
    assert.equal(rows.find((row) => row.id === partial.id)?.stream_status, 'interrupted');
    assert.equal(rows.find((row) => row.id === complete.id)?.stream_status, 'completed');
    assert.equal(recoverInterruptedMessageStreams(), 0, 'recovery is idempotent');
  });

  it('repeated DB/module initialization cannot recover a live process owner', () => {
    const previousDisableMigration = process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS;
    delete process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS;
    try {
      // Claim this test worker as the one runtime owner before creating live
      // state. A second Next route/module instance sees the same live PID and
      // must not run the destructive process-restart sweep.
      runRuntimeStartupRecoveryOnce();

      const sid = createSession('collect-live-runtime-owner').id;
      const lockId = 'lock-live-runtime-owner';
      assert.equal(acquireSessionLock(sid, lockId, `chat-${process.pid}`, 600), true);
      const checkpoint = addMessage(sid, 'assistant', 'Still running', null, {
        stream_status: 'streaming',
      });
      createPermissionRequest({
        id: 'permission-live-runtime-owner',
        sessionId: sid,
        toolName: 'Agent',
        toolInput: '{}',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      assert.equal(
        runRuntimeStartupRecoveryOnce(),
        false,
        'the same live process owner must make repeated initialization a no-op',
      );
      assert.equal(isLockOwner(sid, lockId), true, 'live session lock must survive');
      assert.equal(
        assistantMessages(sid).find((row) => row.id === checkpoint.id)?.stream_status,
        'streaming',
        'live checkpoint must not be relabeled interrupted',
      );
      assert.equal(
        getPermissionRequest('permission-live-runtime-owner')?.status,
        'pending',
        'live child permission must not be aborted as Process restarted',
      );
    } finally {
      if (previousDisableMigration === undefined) {
        delete process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS;
      } else {
        process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS = previousDisableMigration;
      }
    }
  });
});
