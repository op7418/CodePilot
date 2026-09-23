import '../db-isolation.setup';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  commitSessionCompaction,
  createSession,
  deleteSession,
  getLatestSessionCompactionEvent,
  getSessionSummary,
} from '@/lib/db';
import { buildContextCompressedStatus } from '@/lib/context-compressor';
import { getRuntimeCompactionPolicy } from '@/lib/runtime/compaction-policy';

describe('Runtime compaction policy', () => {
  it('keeps CodePilot-owned summaries proactive and leaves Codex compaction runtime-managed', () => {
    assert.deepEqual(getRuntimeCompactionPolicy('claude_code'), {
      runtimeId: 'claude_code',
      mode: 'proactive',
      source: 'codepilot_context_summary',
      recreatedUnderlyingSession: true,
    });
    assert.equal(getRuntimeCompactionPolicy('codepilot_runtime').mode, 'proactive');
    assert.equal(getRuntimeCompactionPolicy('codepilot_runtime').recreatedUnderlyingSession, false);
    assert.equal(getRuntimeCompactionPolicy('codex_runtime').mode, 'reactive_only');
    assert.equal(getRuntimeCompactionPolicy('codex_runtime').source, 'runtime_managed');
  });

  it('puts boundary, trigger and cache impact in the visible status event', () => {
    const status = buildContextCompressedStatus({
      messagesCompressed: 12,
      tokensSaved: 4000,
      trigger: 'automatic',
      sourceBoundaryRowid: 88,
      recreatedUnderlyingSession: true,
    });
    assert.equal(status.stats.sourceBoundaryRowid, 88);
    assert.equal(status.stats.trigger, 'automatic');
    assert.equal(status.stats.recreatedUnderlyingSession, true);
    assert.match(status.message, /cache may rebuild/);
  });
});

describe('durable compaction fact', () => {
  const sessions: string[] = [];
  afterEach(() => {
    for (const id of sessions.splice(0)) deleteSession(id);
  });

  it('commits summary coverage and its event as one durable fact', () => {
    const session = createSession('compact event');
    sessions.push(session.id);
    const event = commitSessionCompaction({
      sessionId: session.id,
      summary: 'A real summary long enough to use.',
      boundaryRowid: 42,
      trigger: 'manual',
      messagesCompressed: 9,
      estimatedTokensSaved: 3000,
      auxiliaryProviderId: 'provider-a',
      auxiliaryModelId: 'small-a',
      auxiliaryRouteSource: 'role_model_small',
      recreatedUnderlyingSession: true,
    });
    assert.equal(getSessionSummary(session.id).boundaryRowid, 42);
    assert.equal(event.source_boundary_rowid, 42);
    assert.equal(event.recreated_underlying_session, 1);
    assert.equal(getLatestSessionCompactionEvent(session.id)?.auxiliary_model_id, 'small-a');
  });

  it('rolls back instead of leaving an event for a missing session', () => {
    assert.throws(() => commitSessionCompaction({
      sessionId: 'missing-session',
      summary: 'unused',
      boundaryRowid: 1,
      trigger: 'reactive',
      messagesCompressed: 1,
      estimatedTokensSaved: 1,
      recreatedUnderlyingSession: true,
    }), /SESSION_NOT_FOUND/);
    assert.equal(getLatestSessionCompactionEvent('missing-session'), undefined);
  });
});
