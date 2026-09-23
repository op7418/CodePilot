import '../db-isolation.setup';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  acquireSessionLock,
  addMessage,
  bindSessionForExecution,
  createSession,
  createSessionHandoff,
  deleteSession,
  getHandoffForTargetSession,
  getMessages,
  getSession,
  getSessionHandoffPreview,
  releaseSessionLock,
  updateSdkSessionId,
  updateSessionRouteCas,
  updateSessionTitle,
} from '@/lib/db';
import {
  classifyLegacyRuntimeBinding,
  decideExecutionBinding,
  isInternalRuntimeSwitchMarker,
} from '@/lib/runtime/thread-execution-binding';
import {
  getRuntimeContinuationPolicy,
  routeChangeMode,
  runtimeRefToClearForRouteChange,
} from '@/lib/runtime/continuation-policy';
import {
  buildRuntimeHandoffContextFragment,
  buildRuntimeHandoffPayload,
} from '@/lib/runtime/handoff-payload';
import { runtimeDisplayLabelKey } from '@/lib/runtime/runtime-display';

describe('ThreadExecutionBinding pure contract', () => {
  it('classifies legacy refs conservatively and ignores internal switch markers as execution', () => {
    assert.deepEqual(classifyLegacyRuntimeBinding({
      hasRealExecutionMessage: false,
      runtimePin: '',
      sdkSessionId: '',
      codexThreadId: '',
    }), { state: 'unbound' });
    assert.deepEqual(classifyLegacyRuntimeBinding({
      hasRealExecutionMessage: true,
      runtimePin: '',
      sdkSessionId: 'sdk-1',
      codexThreadId: '',
    }), { state: 'bound', runtimeId: 'claude_code', source: 'legacy_runtime_ref' });
    assert.equal(classifyLegacyRuntimeBinding({
      hasRealExecutionMessage: true,
      runtimePin: '',
      sdkSessionId: 'sdk-1',
      codexThreadId: 'thread-1',
    }).state, 'legacy_unbound');
    assert.equal(isInternalRuntimeSwitchMarker('[__RUNTIME_SWITCH__ from=claude_code to=codex_runtime]'), true);
  });

  it('lets manual first execution bind but never lets background work pick an owner', () => {
    const unbound = { sessionId: 's', state: 'unbound' as const, routeRevision: 0 };
    assert.deepEqual(decideExecutionBinding(unbound, 'manual', 'codepilot_runtime'), {
      ok: true,
      shouldBind: true,
      runtimeId: 'codepilot_runtime',
    });
    assert.deepEqual(decideExecutionBinding(unbound, 'auto', 'codepilot_runtime'), {
      ok: false,
      code: 'RUNTIME_OWNER_REQUIRED',
    });
    assert.deepEqual(decideExecutionBinding({ ...unbound, state: 'legacy_unbound' }, 'manual', 'claude_code'), {
      ok: false,
      code: 'RUNTIME_RECOVERY_REQUIRED',
    });
  });
});

describe('route CAS and continuation capability', () => {
  const sessions: string[] = [];
  afterEach(() => {
    for (const id of sessions.splice(0)) deleteSession(id);
  });

  it('binds and changes a complete route with one revision per real mutation', () => {
    const session = createSession(
      'route CAS', 'sonnet-a', undefined, undefined, 'code', 'provider-a',
      undefined, undefined, undefined,
      { runtimeId: 'claude_code', state: 'unbound' },
    );
    sessions.push(session.id);
    const bound = bindSessionForExecution({
      sessionId: session.id,
      expectedRouteRevision: 0,
      runtimeId: 'claude_code',
    });
    assert.equal(bound.ok && bound.changed, true);
    assert.equal(bound.ok && bound.session.route_revision, 1);

    updateSdkSessionId(session.id, 'sdk-old');
    const changed = updateSessionRouteCas({
      sessionId: session.id,
      expectedRouteRevision: 1,
      route: { runtimeId: 'claude_code', providerId: 'provider-a', modelId: 'sonnet-b' },
      clearRuntimeRefFor: 'claude_code',
    });
    assert.equal(changed.ok && changed.session.route_revision, 2);
    assert.equal(getSession(session.id)?.sdk_session_id, '');

    const noOp = updateSessionRouteCas({
      sessionId: session.id,
      expectedRouteRevision: 2,
      route: { runtimeId: 'claude_code', providerId: 'provider-a', modelId: 'sonnet-b' },
    });
    assert.equal(noOp.ok && noOp.changed, false);
    assert.equal(getSession(session.id)?.route_revision, 2);
    updateSessionTitle(session.id, 'unrelated write', 'manual');
    assert.equal(getSession(session.id)?.route_revision, 2);

    const stale = updateSessionRouteCas({
      sessionId: session.id,
      expectedRouteRevision: 1,
      route: { runtimeId: 'claude_code', providerId: 'provider-a', modelId: 'sonnet-c' },
    });
    assert.deepEqual(stale.ok ? null : stale.reason, 'revision_conflict');
    assert.equal(getSession(session.id)?.model, 'sonnet-b');
  });

  it('atomically prepares a pre-created empty chat route and binds its first execution owner', () => {
    const session = createSession('sidebar empty chat');
    sessions.push(session.id);

    const prepared = updateSessionRouteCas({
      sessionId: session.id,
      expectedRouteRevision: 0,
      route: {
        runtimeId: 'claude_code',
        providerId: 'provider-a',
        modelId: 'sonnet-a',
      },
      binding: { state: 'bound', source: 'first_execution' },
    });

    assert.equal(prepared.ok, true);
    assert.equal(prepared.ok && prepared.changed, true);
    assert.equal(prepared.ok && prepared.session.runtime_binding_state, 'bound');
    assert.equal(prepared.ok && prepared.session.runtime_binding_source, 'first_execution');
    assert.equal(prepared.ok && prepared.session.runtime_pin, 'claude_code');
    assert.equal(prepared.ok && prepared.session.provider_id, 'provider-a');
    assert.equal(prepared.ok && prepared.session.model, 'sonnet-a');
    assert.equal(prepared.ok && prepared.session.route_revision, 1);
  });

  it('wires first Send to bind the complete route before adding an optimistic bubble', () => {
    const root = path.resolve(__dirname, '../..');
    const chatView = readFileSync(path.join(root, 'components/chat/ChatView.tsx'), 'utf8');
    const routeHandler = readFileSync(
      path.join(root, 'app/api/chat/sessions/[id]/route/route.ts'),
      'utf8',
    );

    assert.match(
      chatView,
      /runtimeBindingState\s*===\s*'unbound'[\s\S]{0,1800}?await commitRoute\([\s\S]{0,500}?bindForExecution:\s*true[\s\S]{0,800}?const userMessage/,
      'an unbound sidebar chat must commit+bind its exact route before rendering the first optimistic message',
    );
    assert.match(
      routeHandler,
      /bind_for_execution[\s\S]{0,2400}?binding\.state\s*===\s*'unbound'\s*&&\s*bindForExecution[\s\S]{0,300}?source:\s*'first_execution'/,
      'the route CAS endpoint must translate the explicit send intent into a first_execution binding in the same mutation',
    );
  });

  it('reconciles a stale route revision from the authoritative session without an optimistic send', () => {
    const root = path.resolve(__dirname, '../..');
    const chatView = readFileSync(path.join(root, 'components/chat/ChatView.tsx'), 'utf8');

    assert.match(
      chatView,
      /ROUTE_REVISION_CONFLICT[\s\S]{0,240}?adoptAuthoritativeRoute\(data\.session, data\.route_revision\)[\s\S]{0,240}?return 'reconciled'/,
      'a stale window must adopt the server route snapshot instead of retrying the same revision forever',
    );
    assert.match(
      chatView,
      /routeOutcome\s*!==\s*'committed'\)\s*return false;[\s\S]{0,240}?const userMessage/,
      'a reconciled first Send must preserve the draft and must not create an optimistic message',
    );
    assert.doesNotMatch(chatView, /pendingRuntimeSelectionRef/);
    assert.match(
      chatView,
      /if \(opts\?\.isAuto\) return;/,
      'automatic catalog reconciliation must remain local until the first explicit execution',
    );
  });

  it('maps Runtime wire ids to shared user-facing labels', () => {
    assert.equal(runtimeDisplayLabelKey('claude_code'), 'runtimeSelector.claudeCode');
    assert.equal(runtimeDisplayLabelKey('codepilot_runtime'), 'runtimeSelector.codepilotRuntime');
    assert.equal(runtimeDisplayLabelKey('codex_runtime'), 'runtimeSelector.codexRuntime');
    assert.equal(runtimeDisplayLabelKey('unknown-runtime'), 'runtimeSwitchMarker.followGlobal');
  });

  it('declares the real same-Runtime modes instead of guessing from model names', () => {
    assert.equal(routeChangeMode(
      { runtimeId: 'claude_code', providerId: 'a', modelId: 'm1' },
      { runtimeId: 'claude_code', providerId: 'a', modelId: 'm2' },
    ), 'replay_context');
    assert.equal(runtimeRefToClearForRouteChange('claude_code', 'replay_context'), 'claude_code');
    assert.equal(routeChangeMode(
      { runtimeId: 'codex_runtime', providerId: 'a', modelId: 'm1' },
      { runtimeId: 'codex_runtime', providerId: 'a', modelId: 'm2' },
    ), 'in_session');
    assert.equal(routeChangeMode(
      { runtimeId: 'codex_runtime', providerId: 'a', modelId: 'm1' },
      { runtimeId: 'codex_runtime', providerId: 'b', modelId: 'm1' },
    ), 'replay_context');
    assert.equal(runtimeRefToClearForRouteChange('codex_runtime', 'replay_context'), undefined,
      'retain the previous provider ref until the replacement turn is accepted');
    assert.equal(routeChangeMode(
      { runtimeId: 'codex_runtime', providerId: 'a', modelId: 'm1' },
      { runtimeId: 'claude_code', providerId: 'a', modelId: 'm1' },
    ), 'new_session');
    assert.match(getRuntimeContinuationPolicy('codex_runtime').continuationKey, /^codex_runtime:/);
  });
});

describe('cross-Runtime handoff transaction', () => {
  const sessions: string[] = [];
  afterEach(() => {
    for (const id of sessions.splice(0)) deleteSession(id);
  });

  function sourceSession() {
    const source = createSession(
      'Source', 'sonnet', undefined, '/tmp/project', 'code', 'provider-a',
      undefined, undefined, undefined,
      { runtimeId: 'claude_code', state: 'bound', source: 'first_execution' },
    );
    sessions.push(source.id);
    addMessage(source.id, 'user', 'Keep this decision. token=super-secret /Users/alice/private.ts');
    addMessage(source.id, 'assistant', 'Decision confirmed.');
    return source;
  }

  it('creates a bound target once and leaves the source route untouched', () => {
    const source = sourceSession();
    const preview = getSessionHandoffPreview(source.id)!;
    const { messages } = getMessages(source.id, { limit: 20 });
    const payload = buildRuntimeHandoffPayload({
      sourceSession: source,
      sourceRuntimeId: 'claude_code',
      sourceBoundaryRowid: preview.sourceBoundaryRowid,
      targetRuntimeId: 'codex_runtime',
      targetProviderId: 'codex_account',
      targetModelId: 'gpt-5',
      messages,
    });
    const first = createSessionHandoff({
      sourceSessionId: source.id,
      expectedSourceRouteRevision: 0,
      expectedSourceBoundaryRowid: preview.sourceBoundaryRowid,
      targetRoute: { runtimeId: 'codex_runtime', providerId: 'codex_account', modelId: 'gpt-5' },
      payloadVersion: 1,
      payloadJson: JSON.stringify(payload),
      payloadSource: 'recent_transcript',
      idempotencyKey: 'same-click',
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    sessions.push(first.targetSession.id);
    assert.equal(first.targetSession.runtime_binding_state, 'bound');
    assert.equal(first.targetSession.runtime_binding_source, 'handoff_create');
    assert.equal(first.targetSession.route_revision, 0);
    assert.equal(getSession(source.id)?.route_revision, 0);
    assert.equal(buildRuntimeHandoffContextFragment(payload).includes('native thread state were not transferred'), true);
    assert.equal(JSON.stringify(payload).includes('super-secret'), false);

    const second = createSessionHandoff({
      sourceSessionId: source.id,
      expectedSourceRouteRevision: 0,
      expectedSourceBoundaryRowid: preview.sourceBoundaryRowid,
      targetRoute: { runtimeId: 'codex_runtime', providerId: 'codex_account', modelId: 'gpt-5' },
      payloadVersion: 1,
      payloadJson: JSON.stringify(payload),
      payloadSource: 'recent_transcript',
      idempotencyKey: 'same-click',
    });
    assert.equal(second.ok && second.idempotent, true);
    assert.equal(second.ok && second.targetSession.id, first.targetSession.id);
  });

  it('rejects busy, stale route and stale transcript without creating a target', () => {
    const source = sourceSession();
    const preview = getSessionHandoffPreview(source.id)!;
    acquireSessionLock(source.id, 'handoff-lock', 'turn', 600);
    const busy = createSessionHandoff({
      sourceSessionId: source.id,
      expectedSourceRouteRevision: 0,
      expectedSourceBoundaryRowid: preview.sourceBoundaryRowid,
      targetRoute: { runtimeId: 'codex_runtime', providerId: 'p', modelId: 'm' },
      payloadVersion: 1,
      payloadJson: '{}',
      payloadSource: 'recent_transcript',
    });
    assert.deepEqual(busy.ok ? null : busy.reason, 'source_busy');
    releaseSessionLock(source.id, 'handoff-lock');

    const staleRoute = createSessionHandoff({
      sourceSessionId: source.id,
      expectedSourceRouteRevision: 99,
      expectedSourceBoundaryRowid: preview.sourceBoundaryRowid,
      targetRoute: { runtimeId: 'codex_runtime', providerId: 'p', modelId: 'm' },
      payloadVersion: 1,
      payloadJson: '{}',
      payloadSource: 'recent_transcript',
    });
    assert.deepEqual(staleRoute.ok ? null : staleRoute.reason, 'source_route_advanced');

    addMessage(source.id, 'user', 'new boundary');
    const staleTranscript = createSessionHandoff({
      sourceSessionId: source.id,
      expectedSourceRouteRevision: 0,
      expectedSourceBoundaryRowid: preview.sourceBoundaryRowid,
      targetRoute: { runtimeId: 'codex_runtime', providerId: 'p', modelId: 'm' },
      payloadVersion: 1,
      payloadJson: '{}',
      payloadSource: 'recent_transcript',
    });
    assert.deepEqual(staleTranscript.ok ? null : staleTranscript.reason, 'source_transcript_advanced');
    assert.equal(getHandoffForTargetSession('not-created'), undefined);
  });
});
