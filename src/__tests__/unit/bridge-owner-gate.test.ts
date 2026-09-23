/**
 * Session ownership regression — bridge conversation-engine owner gate.
 *
 * Behavioral (real-driven) test, NOT a source-pin. Bridge is the SECOND entry
 * point that shares `session_runtime_locks`; the P1 race finding was that it
 * never adopted Phase 3's owner-token semantics, so a superseded bridge turn
 * (its lock taken over by a newer web/bridge send) could still overwrite the new
 * owner's session-level DB state or insert a stale assistant message (I1/DP1).
 *
 * These tests drive the REAL exported `consumeStream` with a real SSE
 * `ReadableStream` and a real DB lock state (per-worker temp DB from
 * db-isolation.setup.ts), then assert against the DB (getMessages / getSession /
 * getTasksBySession). They also drive the REAL bridge-wired settler
 * (createSessionLockSettler) to prove the finally-settle path is ownership-gated.
 *
 * The I1/DP1 invariant: every session-level write inside consume —
 * sdk_session_id, model, SDK tasks, and the assistant `addMessage` — plus the
 * finally's runtime_status write, must be gated on `isLockOwner(sessionId,
 * lockId)`. A superseded turn reaches consume LATE carrying its OLD lockId and
 * must write NOTHING to shared session state.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { consumeStream } from '../../lib/bridge/conversation-engine';
import { createSessionLockSettler } from '../../lib/session-lock-settle';
import { evaluateRenewal } from '../../lib/session-lock-renewal';
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
  setSessionRuntimeStatus,
} from '../../lib/db';

// Build a single SSE chunk for a `{ type, data }` event, matching what the
// runtime emits and what consumeStream parses (`data:` prefix; `data` is a JSON
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

function assistantMessages(sessionId: string) {
  return getMessages(sessionId).messages.filter((m) => m.role === 'assistant');
}

describe('bridge consumeStream session-level write owner gate (Phase 3 E)', () => {
  it('happy path: the lock owner persists assistant message + sdk_session_id + tasks without rewriting the atomic route model', async () => {
    const sid = createSession('bridge-owner-happy').id;
    const lockA = 'bridgeA-happy';
    assert.equal(acquireSessionLock(sid, lockA, 'bridge-test-owner', 600), true, 'acquire should succeed');
    assert.equal(isLockOwner(sid, lockA), true, 'A owns the lock');

    const stream = streamOf([
      sse('status', { session_id: 'sdk-happy', model: 'claude-happy' }),
      sse('task_update', { session_id: sid, todos: [{ id: 't1', content: 'do work', status: 'in_progress' }] }),
      sse('text', 'Hello from the true bridge owner'),
      sse('result', { session_id: 'sdk-happy', is_error: false, usage: { input_tokens: 3, output_tokens: 5 } }),
    ]);

    const res = await consumeStream(stream, sid, lockA);

    // Assistant message DID land (reverse example — gate must not drop the owner).
    const msgs = assistantMessages(sid);
    assert.equal(msgs.length, 1, 'owner assistant message must be persisted');
    assert.equal(msgs[0].content, 'Hello from the true bridge owner', 'persisted content matches');

    // Session-level state written by the owner.
    const row = getSession(sid)!;
    assert.equal(row.sdk_session_id, 'sdk-happy', 'owner wrote sdk_session_id');
    assert.equal(row.model, '', 'Runtime-reported model is observational and cannot rewrite the atomic route');

    // SDK tasks synced by the owner.
    const tasks = getTasksBySession(sid);
    assert.equal(tasks.length, 1, 'owner synced SDK tasks');
    assert.equal(tasks[0].title, 'do work', 'synced task content matches');

    // Return value still carries the captured sdk session id for this binding.
    assert.equal(res.sdkSessionId, 'sdk-happy', 'owner returns captured sdk session id');
    assert.equal(res.hasError, false, 'happy path has no error');
  });

  it('stale owner (lock taken over): assistant NOT persisted (DP1), sdk_session_id/model/tasks/runtime_status untouched', async () => {
    const sid = createSession('bridge-owner-stale').id;
    const lockA = 'bridgeA-stale';
    const lockB = 'bridgeB-newowner';

    // A originally owned the session (a bridge turn), then a newer web/bridge
    // send takes over: production path is takeover via acquireSessionLock, which
    // deletes the stale row and inserts a new one under lockB.
    assert.equal(acquireSessionLock(sid, lockA, 'bridge-test-owner-A', 600), true, 'A acquires');
    assert.equal(releaseSessionLock(sid, lockA), true, 'takeover releases A');
    assert.equal(acquireSessionLock(sid, lockB, 'new-owner-B', 600), true, 'B takes over');
    assert.equal(isLockOwner(sid, lockA), false, 'A is no longer the owner (superseded)');
    assert.equal(isLockOwner(sid, lockB), true, 'B is the current owner');

    // Establish B's persisted state so we can prove the stale turn does NOT clobber it.
    updateSdkSessionId(sid, 'B-OWNED-SID');
    updateSessionModel(sid, 'B-OWNED-MODEL');
    setSessionRuntimeStatus(sid, 'running');

    // The stale turn (lockA) reaches consume late and tries to write everything.
    const stream = streamOf([
      sse('status', { session_id: 'STALE-SID-MUST-NOT-WRITE', model: 'STALE-MODEL-MUST-NOT-WRITE' }),
      sse('task_update', { session_id: sid, todos: [{ id: 'x', content: 'stale task', status: 'pending' }] }),
      sse('text', 'Stale bridge assistant answer that must be dropped'),
      sse('result', { session_id: 'STALE-SID-MUST-NOT-WRITE', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }),
    ]);

    await consumeStream(stream, sid, lockA);

    // DP1: the stale assistant content must NOT be persisted into `messages`.
    assert.equal(assistantMessages(sid).length, 0, 'stale assistant message must be dropped (DP1)');

    // Session-level writes dropped — B's state is untouched.
    const row = getSession(sid)!;
    assert.equal(row.sdk_session_id, 'B-OWNED-SID', 'stale turn must not overwrite sdk_session_id');
    assert.equal(row.model, 'B-OWNED-MODEL', 'stale turn must not overwrite model');

    // consumeStream never writes runtime_status directly — prove it stays B's 'running'.
    assert.equal(row.runtime_status, 'running', 'stale consume must not touch runtime_status');

    // SDK task sync dropped for the stale turn.
    assert.equal(getTasksBySession(sid).length, 0, 'stale turn must not sync SDK tasks');
  });

  it('stale owner: error-path assistant persist is also dropped (DP1)', async () => {
    const sid = createSession('bridge-owner-stale-error').id;
    const lockA = 'bridgeA-stale-err';
    const lockB = 'bridgeB-newowner-err';

    assert.equal(acquireSessionLock(sid, lockA, 'bridge-test-owner-A', 600), true, 'A acquires');
    assert.equal(releaseSessionLock(sid, lockA), true, 'takeover releases A');
    assert.equal(acquireSessionLock(sid, lockB, 'new-owner-B', 600), true, 'B takes over');
    assert.equal(isLockOwner(sid, lockA), false, 'A superseded');

    // A stream that yields text then aborts mid-flight, driving the catch branch's
    // best-effort addMessage — which must also be owner-gated.
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(sse('text', 'partial stale answer before error'));
        controller.error(new Error('stream blew up'));
      },
    });

    const res = await consumeStream(stream, sid, lockA);
    assert.equal(res.hasError, true, 'error path reports hasError');

    // DP1 on the error path: no stale assistant message persisted.
    assert.equal(assistantMessages(sid).length, 0, 'error-path stale assistant message must be dropped (DP1)');
  });
});

describe('bridge finally-settle ownership gate (Phase 3 E)', () => {
  it('superseded bridge turn: settleLock does NOT overwrite the new owner runtime_status', () => {
    const sid = createSession('bridge-settle-stale').id;
    const lockA = 'settleA-stale';
    const lockB = 'settleB-newowner';

    assert.equal(acquireSessionLock(sid, lockA, 'bridge-test-owner-A', 600), true, 'A acquires');
    assert.equal(releaseSessionLock(sid, lockA), true, 'takeover releases A');
    assert.equal(acquireSessionLock(sid, lockB, 'new-owner-B', 600), true, 'B takes over');
    setSessionRuntimeStatus(sid, 'running'); // B is actively running.

    let renewalCleared = false;
    // Same wiring as processMessage's finally settler, but with lockA (the
    // superseded turn's token).
    const settleLock = createSessionLockSettler({
      clearRenewal: () => { renewalCleared = true; },
      releaseLock: () => releaseSessionLock(sid, lockA),
      setStatus: (status) => setSessionRuntimeStatus(sid, status),
    });

    settleLock('idle');

    // clearRenewal always runs (stops the leaked interval)...
    assert.equal(renewalCleared, true, 'settle always clears the renewal interval');
    // ...but the stale turn must NOT flip B's 'running' to 'idle' (releaseSessionLock
    // returned false because lockA no longer owns the row).
    assert.equal(getSession(sid)!.runtime_status, 'running', 'stale settle must not clobber new owner runtime_status');
  });

  it('true owner: settleLock releases the lock and writes idle', () => {
    const sid = createSession('bridge-settle-owner').id;
    const lockA = 'settleA-owner';

    assert.equal(acquireSessionLock(sid, lockA, 'bridge-test-owner', 600), true, 'A acquires');
    setSessionRuntimeStatus(sid, 'running');

    let renewalCleared = false;
    const settleLock = createSessionLockSettler({
      clearRenewal: () => { renewalCleared = true; },
      releaseLock: () => releaseSessionLock(sid, lockA),
      setStatus: (status) => setSessionRuntimeStatus(sid, status),
    });

    settleLock('idle');

    assert.equal(renewalCleared, true, 'settle clears the renewal interval');
    assert.equal(isLockOwner(sid, lockA), false, 'owner lock released');
    assert.equal(getSession(sid)!.runtime_status, 'idle', 'owner settle writes idle');
  });
});

describe('bridge renewal renew-false stop (Phase 3 E)', () => {
  it('bridge params (autoTrigger:false, max:Infinity): renew-false stops, renew-true continues, never caps', () => {
    // The exact params conversation-engine passes to evaluateRenewal. Bridge is
    // not an autoTrigger turn, so it must never hit the cap — only DP3 renew-false
    // can stop it.
    assert.equal(
      evaluateRenewal({ autoTrigger: false, renewalCount: 0, renewed: false, max: Infinity }),
      'stop-renew-false',
      'lost ownership → stop renewing',
    );
    assert.equal(
      evaluateRenewal({ autoTrigger: false, renewalCount: 999999, renewed: true, max: Infinity }),
      'continue',
      'still owned + no cap for bridge → keep renewing',
    );
  });
});
