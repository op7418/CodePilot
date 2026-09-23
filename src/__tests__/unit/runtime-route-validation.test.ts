import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, deleteProvider, getAllModelsForProvider, upsertProviderModel } from '@/lib/db';
import { validateRuntimeRoute } from '@/lib/runtime/route-validation';
import { buildCodexProviderModelGroup, invalidateCodexModelsCache } from '@/lib/codex/models';

describe('route validation uses the executable provider catalog', () => {
  const providerIds: string[] = [];
  afterEach(() => { for (const id of providerIds.splice(0)) deleteProvider(id); });
  function provider() {
    const result = createProvider({
      name: 'route-validation-fixture', provider_type: 'anthropic',
      protocol: 'anthropic', base_url: 'https://open.bigmodel.cn/api/anthropic',
      api_key: 'fixture-not-a-real-key',
    });
    providerIds.push(result.id);
    return result.id;
  }

  it('accepts a compatible catalog model without requiring a visit to model settings', async () => {
    const providerId = provider();
    assert.equal(getAllModelsForProvider(providerId).length, 0);
    for (const runtimeId of ['claude_code', 'codepilot_runtime', 'codex_runtime'] as const) {
      const route = { runtimeId, providerId, modelId: 'sonnet' };
      assert.deepEqual(await validateRuntimeRoute(route), { ok: true, route });
    }
    assert.equal(getAllModelsForProvider(providerId).length, 0, 'validation must remain read-only');
  });

  it('accepts a newly available catalog model alongside old materialized rows', async () => {
    const providerId = provider();
    upsertProviderModel({ provider_id: providerId, model_id: 'sonnet', enabled: 1 });
    const route = { runtimeId: 'codex_runtime' as const, providerId, modelId: 'haiku' };
    assert.deepEqual(await validateRuntimeRoute(route), { ok: true, route });
  });

  it('continues rejecting hidden and nonexistent models', async () => {
    const providerId = provider();
    upsertProviderModel({ provider_id: providerId, model_id: 'haiku', enabled: 0 });
    for (const modelId of ['haiku', 'not-in-this-provider']) {
      assert.deepEqual(await validateRuntimeRoute({ runtimeId: 'codex_runtime', providerId, modelId }), {
        ok: false, code: 'INVALID_ROUTE_MODEL',
      });
    }
  });

  it('continues rejecting models incompatible with the selected Runtime', async () => {
    const other = createProvider({
      name: 'openai-route-fixture', provider_type: 'openai', protocol: 'openai-compatible',
      base_url: 'https://api.openai.com/v1', api_key: 'fixture-not-a-real-key',
    });
    providerIds.push(other.id);
    upsertProviderModel({ provider_id: other.id, model_id: 'custom-chat', enabled: 1 });
    assert.deepEqual(await validateRuntimeRoute({
      runtimeId: 'claude_code', providerId: other.id, modelId: 'custom-chat',
    }), { ok: false, code: 'RUNTIME_ROUTE_INCOMPATIBLE' });
  });

  it('discovers an explicitly selected Codex model when this route has a cold cache', async () => {
    invalidateCodexModelsCache();
    let calls = 0;
    const route = { runtimeId: 'codex_runtime' as const, providerId: 'codex_account', modelId: 'gpt-fixture' };
    try {
      const result = await validateRuntimeRoute(route, opts => buildCodexProviderModelGroup(opts, async () => ({
        client: { request: async <T>() => {
          calls++;
          return { data: [{ id: 'gpt-fixture', model: 'gpt-fixture', displayName: 'Test', hidden: false }] } as T;
        } },
      })));
      assert.deepEqual(result, { ok: true, route });
      assert.equal(calls, 1);
      assert.deepEqual(await validateRuntimeRoute({ ...route, modelId: 'absent' }), {
        ok: false, code: 'INVALID_ROUTE_MODEL',
      });
    } finally { invalidateCodexModelsCache(); }
  });

  it('never starts Codex discovery in recovery safe mode', async () => {
    const previous = process.env.CODEPILOT_RECOVERY_SAFE_MODE;
    process.env.CODEPILOT_RECOVERY_SAFE_MODE = '1';
    invalidateCodexModelsCache();
    let calls = 0;
    try {
      const result = await validateRuntimeRoute({
        runtimeId: 'codex_runtime', providerId: 'codex_account', modelId: 'gpt-fixture',
      }, opts => buildCodexProviderModelGroup(opts, async () => { calls++; throw new Error('must not spawn'); }));
      assert.deepEqual(result, { ok: false, code: 'INVALID_ROUTE_MODEL' });
      assert.equal(calls, 0);
    } finally {
      if (previous === undefined) delete process.env.CODEPILOT_RECOVERY_SAFE_MODE;
      else process.env.CODEPILOT_RECOVERY_SAFE_MODE = previous;
    }
  });
});
