/**
 * Interrupt lifecycle — `/api/chat/interrupt` returns the
 * authoritative runtime_status and must NOT release/settle the session lock
 * (d-interrupt-returns-status, d-interrupt-no-kill-newowner).
 *
 * Real-DB driven (per-worker temp DB via db-isolation.setup.ts), not a
 * source-pin: the route reads chat_sessions.runtime_status and fans out
 * interrupts. The I1 correctness property we lock in here is that a Stop
 * carrying ONLY a sessionId (no owner lockId) never touches session_runtime_locks
 * — otherwise it would kill a newer turn that already reclaimed the lock. Real
 * release + terminal-status write stay with the chat route's lockId-scoped
 * settleLock / watchdog.
 */

// CRITICAL — this side-effect import MUST be first. It points
// CLAUDE_GUI_DATA_DIR at a fresh per-worker temp DB BEFORE any @/lib import
// chain triggers src/lib/db.ts module-load (which captures the env var at
// module-load time). The full suite preloads this via `tsx --test --import`;
// importing it here too lets this file run standalone without leaking into the
// real DB.
import '../db-isolation.setup';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { POST } from '@/app/api/chat/interrupt/route';
import {
  createSession,
  acquireSessionLock,
  getSubagentRun,
  isLockOwner,
  setSessionRuntimeStatus,
  startSubagentRun,
} from '@/lib/db';
import {
  registerConversation,
  getConversation,
  unregisterConversation,
} from '@/lib/conversation-registry';

// The route fans out interrupts, including to the Codex runtime. Hard-disable
// Codex so no app-server is probed/spawned during the test. The runtime module
// is imported lazily inside POST (call time), so setting this before any POST
// call suffices. The full suite already sets CODEX_DISABLED=1 via env; this
// keeps standalone runs of this file safe too.
process.env.CODEX_DISABLED = process.env.CODEX_DISABLED || '1';

function callInterrupt(sessionId: unknown) {
  const req = new Request('http://local/api/chat/interrupt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  return POST(req as never);
}

describe('/api/chat/interrupt — authoritative runtime_status, lock-safe', () => {
  it('d-interrupt-returns-status: echoes chat_sessions.runtime_status', async () => {
    const sid = createSession('interrupt-returns-status').id;
    setSessionRuntimeStatus(sid, 'running');

    const res = await callInterrupt(sid);
    const body = await res.json();

    assert.equal(body.interrupted, true);
    assert.equal(body.runtime_status, 'running', 'route must return the DB runtime_status');
  });

  it('d-interrupt-no-kill-newowner: a sessionId-only interrupt does NOT release the lock a newer turn owns', async () => {
    const sid = createSession('interrupt-no-kill-newowner').id;
    const newLock = 'new-owner-lock-xyz';

    // A newer turn has taken over the session lock and is actively running.
    assert.equal(acquireSessionLock(sid, newLock, 'newer-turn', 600), true);
    setSessionRuntimeStatus(sid, 'running');

    // A stale Stop arrives carrying only the sessionId (no owner lockId).
    const res = await callInterrupt(sid);
    const body = await res.json();

    // It returns the authoritative status...
    assert.equal(body.interrupted, true);
    assert.equal(body.runtime_status, 'running');
    // ...but MUST NOT have released/settled the new owner's lock (Codex I1).
    assert.equal(
      isLockOwner(sid, newLock),
      true,
      'interrupt must not release the lock a newer turn owns — that would kill the reclaimed turn',
    );
  });

  it('d-interrupt-no-kill-newowner: interrupts the registered conversation but does NOT clear the registry', async () => {
    const sid = createSession('interrupt-registry-intact').id;
    const newLock = 'newer-lock-registry';
    acquireSessionLock(sid, newLock, 'newer-turn', 600);
    setSessionRuntimeStatus(sid, 'running');

    // A live SDK conversation for this session (the newer turn's stream).
    let interrupted = 0;
    const controller = new AbortController();
    const sentinel = { interrupt: async () => { interrupted += 1; } } as unknown as Query;
    registerConversation(sid, sentinel, newLock, controller);

    await callInterrupt(sid);

    // Fan-out reached the conversation (best-effort graceful interrupt)...
    assert.equal(interrupted, 1, 'SDK conversation.interrupt() should be invoked by the fan-out');
    assert.equal(controller.signal.aborted, true, 'Stop must also abort the application-owned child signal');
    // ...but the registry entry must remain — interrupt never unregisters, so the
    // newer turn keeps its live stream handle.
    assert.equal(getConversation(sid), sentinel, 'interrupt must not evict the conversation registry entry');
    assert.equal(isLockOwner(sid, newLock), true, 'lock still owned by the newer turn');

    unregisterConversation(sid, newLock); // cleanup for worker-shared registry
  });

  it('converges executing and queued child rows to durable cancelled facts', async () => {
    const sid = createSession(
      'interrupt-cancels-managed-children',
      'qwen-max',
      undefined,
      undefined,
      'code',
      'provider-qwen',
      'default',
      'user',
      undefined,
      {
        runtimeId: 'claude_code',
        state: 'bound',
        source: 'first_execution',
      },
    ).id;
    startSubagentRun({
      id: 'interrupt-running-child',
      parentSessionId: sid,
      runtime: 'claude_code',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Running child',
      providerId: 'provider-qwen',
      requestedModel: 'qwen-max',
      workflowId: 'interrupt-workflow',
      taskKey: 'upstream',
      prompt: 'Run the long task.',
    });
    startSubagentRun({
      id: 'interrupt-queued-child',
      parentSessionId: sid,
      runtime: 'claude_code',
      toolName: 'codepilot_spawn_subagent',
      agentName: 'Queued child',
      providerId: 'provider-deepseek',
      requestedModel: 'deepseek-pro',
      workflowId: 'interrupt-workflow',
      taskKey: 'downstream',
      dependencyTaskKeys: ['upstream'],
      prompt: 'Use the upstream handoff.',
    });

    await callInterrupt(sid);

    for (const id of ['interrupt-running-child', 'interrupt-queued-child']) {
      const run = getSubagentRun(id);
      assert.equal(run?.status, 'cancelled');
      assert.equal(run?.phase, 'terminal');
      assert.equal(run?.dispatch_state, 'terminal');
      assert.equal(run?.terminal, 1);
      assert.match(run?.result_text || '', /Parent turn stopped/);
    }
  });

  it('interrupt does not clobber the runtime_status either (read-only, no settle)', async () => {
    const sid = createSession('interrupt-no-status-write').id;
    const newLock = 'newer-lock-2';
    acquireSessionLock(sid, newLock, 'newer-turn', 600);
    setSessionRuntimeStatus(sid, 'running');

    await callInterrupt(sid);

    // The interrupt route only READS runtime_status; the newer turn's 'running'
    // must survive (no settle → no flip to idle/interrupted here).
    const res = await callInterrupt(sid);
    const body = await res.json();
    assert.equal(body.runtime_status, 'running', 'status stays running — interrupt never writes a terminal status');
  });

  it('missing sessionId → 400 (guard unchanged)', async () => {
    const res = await callInterrupt(undefined);
    assert.equal(res.status, 400);
  });

  it('unknown session → runtime_status null, still interrupted:true', async () => {
    const res = await callInterrupt('does-not-exist-session-id');
    const body = await res.json();
    assert.equal(body.interrupted, true);
    assert.equal(body.runtime_status, null);
  });
});
