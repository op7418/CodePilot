import '../db-isolation.setup';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireSessionLock, createProvider, createSession, getMessages, getSession,
  releaseSessionLock, upsertProviderModel,
} from '../../lib/db';
import { getPreset } from '../../lib/provider-catalog';
import { collectStreamResponse } from '../../lib/chat-collect-stream-response';
import { resolveChatMessageRoute } from '../../lib/chat-message-route';
import { findModelOption } from '../../lib/model-option-match';

function provider(key: string) {
  const preset = getPreset(key)!;
  return createProvider({
    name: 'message-route-fixture', provider_type: 'anthropic', protocol: 'anthropic',
    base_url: preset.baseUrl, api_key: 'fixture-not-a-real-key', preset_key: key,
  });
}

async function report(sid: string, actual: string, requested: string) {
  const lock = `owner-${sid}`;
  assert.equal(acquireSessionLock(sid, lock, 'test', 600), true);
  const stream = new ReadableStream<string>({ start(c) {
    for (const event of [
      { type: 'status', data: JSON.stringify({ session_id: 'fixture-sdk', model: actual, requested_model: requested }) },
      { type: 'text', data: 'fixture reply' },
      { type: 'done', data: '' },
    ]) c.enqueue(`data: ${JSON.stringify(event)}\n\n`);
    c.close();
  } });
  await collectStreamResponse(stream, sid, lock, {}, () => {
    releaseSessionLock(sid, lock);
  }, { suppressNotifications: true });
}

for (const key of ['xiaomi-mimo-token-plan', 'minimax-cn', 'anthropic-official']) {
  for (const legacy of [false, true]) {
    it(`${key}: ${legacy ? 'legacy upstream' : 'picker alias'} route survives repeated init and reopening`, async () => {
      const p = provider(key);
      const row = getPreset(key)!.defaultModels[0];
      const alias = row.modelId;
      const actual = row.upstreamModelId!;
      const saved = legacy ? actual : alias;
      const s = createSession('route-fixture', saved, '', '', 'code', p.id, undefined, 'user', 'manual', {
        state: 'bound', runtimeId: 'claude_code', source: 'first_execution',
      });
      for (let turn = 0; turn < 3; turn++) {
        // A reopened composer resolves a stored upstream ID back to its row.
        const snapshot = getSession(s.id)!;
        const sent = findModelOption([{ value: alias, upstreamModelId: actual }], snapshot.model)!.value;
        const resolved = resolveChatMessageRoute({ provider_id: snapshot.provider_id, model: snapshot.model,
          requestProviderId: p.id, requestModel: sent }, 'claude_code');
        assert.ok(resolved);
        assert.equal(resolved.upstreamModel, actual);
        await report(s.id, actual, sent);
        const after = getSession(s.id)!;
        assert.equal(after.model, saved);
        assert.equal(after.provider_id, p.id);
        assert.equal(after.route_revision, s.route_revision);
        assert.equal(after.runtime_pin, 'claude_code');
        assert.equal(after.sdk_session_id, 'fixture-sdk');
      }
      assert.equal(getMessages(s.id).messages.length, 3);
    });
  }
}

describe('message route identity boundaries', () => {
  it('accepts unchanged direct IDs, and preserves invalid provider errors for exact echoes', () => {
    const p = provider('minimax-cn');
    assert.ok(resolveChatMessageRoute({ provider_id: p.id, model: 'MiniMax-M2.7', requestModel: 'MiniMax-M2.7' }, 'claude_code'));
    assert.equal(resolveChatMessageRoute({ provider_id: 'deleted', model: 'sonnet', requestModel: 'sonnet' }, 'claude_code')?.invalidReason, 'provider-missing');
  });
  it('rejects different provider instances even for the same model', () => {
    const a = provider('minimax-cn'); const b = provider('minimax-cn');
    assert.equal(resolveChatMessageRoute({ provider_id: a.id, model: 'MiniMax-M2.7', requestProviderId: b.id, requestModel: 'sonnet' }, 'claude_code'), undefined);
  });
  it('rejects hidden mappings, changed custom upstream IDs and absent models', () => {
    const p = provider('minimax-cn');
    const input = { provider_id: p.id, model: 'MiniMax-M2.7', requestModel: 'sonnet' };
    upsertProviderModel({ provider_id: p.id, model_id: 'sonnet', upstream_model_id: 'MiniMax-M2.7', enabled: 0 });
    assert.equal(resolveChatMessageRoute(input, 'claude_code'), undefined);
    upsertProviderModel({ provider_id: p.id, model_id: 'sonnet', upstream_model_id: 'custom-other', enabled: 1, user_edited: 1 });
    assert.equal(resolveChatMessageRoute(input, 'claude_code'), undefined);
    assert.equal(resolveChatMessageRoute({ ...input, requestModel: 'missing' }, 'claude_code'), undefined);
  });
  it('rejects ambiguous upstreams and never merges distinct model IDs', () => {
    const p = provider('minimax-cn');
    upsertProviderModel({ provider_id: p.id, model_id: 'other-alias', upstream_model_id: 'MiniMax-M2.7', enabled: 1 });
    assert.equal(resolveChatMessageRoute({ provider_id: p.id, model: 'MiniMax-M2.7', requestModel: 'sonnet' }, 'claude_code'), undefined);
    assert.equal(resolveChatMessageRoute({ provider_id: p.id, model: 'other-alias', requestModel: 'sonnet' }, 'claude_code'), undefined);
  });
  it('an explicit catalog ID wins over an overlapping upstream ID', () => {
    const p = provider('minimax-cn');
    upsertProviderModel({ provider_id: p.id, model_id: 'MiniMax-M2.7', upstream_model_id: 'different-wire-model', enabled: 1 });
    assert.equal(resolveChatMessageRoute({ provider_id: p.id, model: 'MiniMax-M2.7', requestModel: 'sonnet' }, 'claude_code'), undefined);
  });
  it('does not reinterpret Codex Account model names using unrelated provider aliases', () => {
    assert.equal(resolveChatMessageRoute({ provider_id: 'codex_account', model: 'gpt-fixture', requestModel: 'sonnet' }, 'codex_runtime'), undefined);
  });
  it('legacy compatibility respects the owner Runtime, including Native direct providers', () => {
    const p = createProvider({ name: 'native-only-fixture', provider_type: 'openai', protocol: 'openai-compatible',
      base_url: 'https://fixture.invalid/v1', api_key: 'fixture-not-a-real-key', preset_key: 'openai-compatible' });
    upsertProviderModel({ provider_id: p.id, model_id: 'custom-alias', upstream_model_id: 'custom-wire', enabled: 1 });
    const input = { provider_id: p.id, model: 'custom-wire', requestModel: 'custom-alias' };
    assert.equal(resolveChatMessageRoute(input, 'claude_code'), undefined);
    assert.equal(resolveChatMessageRoute(input, 'codepilot_runtime')?.upstreamModel, 'custom-wire');
    assert.equal(resolveChatMessageRoute(input, 'codex_runtime')?.upstreamModel, 'custom-wire');
  });
});
