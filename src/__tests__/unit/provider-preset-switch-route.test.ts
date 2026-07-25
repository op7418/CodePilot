import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { PUT } from '../../app/api/providers/[id]/route';
import {
  createProvider,
  deleteProvider,
  getAllModelsForProvider,
  getProvider,
  upsertProviderModel,
} from '../../lib/db';

const TOKEN_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic';
const createdIds: string[] = [];

function request(id: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/providers/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createTokenProvider(presetKey = '') {
  const provider = createProvider({
    name: 'Legacy Qwen Token Plan',
    preset_key: presetKey,
    provider_type: 'anthropic',
    protocol: 'anthropic',
    base_url: TOKEN_URL,
    api_key: 'sk-sp-test',
    role_models_json: '{}',
  });
  createdIds.push(provider.id);
  return provider;
}

afterEach(() => {
  while (createdIds.length) deleteProvider(createdIds.pop()!);
});

describe('PUT /api/providers/[id] — explicit preset switch', () => {
  it('rejects changing a managed preset base URL while silently retaining its identity', async () => {
    const provider = createTokenProvider('qwen-token-plan-personal-cn');
    const response = await PUT(
      request(provider.id, { base_url: 'https://credential-sink.example/v1' }),
      { params: Promise.resolve({ id: provider.id }) },
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_PRESET_IDENTITY');
    assert.equal(getProvider(provider.id)?.base_url, TOKEN_URL);
  });

  it('persists Personal identity and reconciles only catalog-managed model rows', async () => {
    const provider = createTokenProvider();
    for (const modelId of ['qwen3.6-plus', 'glm-5', 'MiniMax-M2.5']) {
      upsertProviderModel({
        provider_id: provider.id,
        model_id: modelId,
        upstream_model_id: modelId,
        display_name: modelId,
        source: 'catalog',
        user_edited: 0,
        enable_source: 'recommended',
      });
    }
    upsertProviderModel({
      provider_id: provider.id,
      model_id: 'my-private-model',
      upstream_model_id: 'my-private-model',
      display_name: 'My private model',
      source: 'manual',
      user_edited: 1,
      enable_source: 'manual_enabled',
    });

    const response = await PUT(
      request(provider.id, {
        preset_key: 'qwen-token-plan-personal-cn',
        reconcile_catalog: true,
      }),
      { params: Promise.resolve({ id: provider.id }) },
    );
    assert.equal(response.status, 200);
    assert.equal(getProvider(provider.id)?.preset_key, 'qwen-token-plan-personal-cn');

    const rows = getAllModelsForProvider(provider.id);
    const byId = new Map(rows.map(row => [row.model_id, row]));
    assert.deepEqual(
      rows.filter(row => row.source === 'catalog').map(row => row.model_id).sort(),
      [
        'deepseek-v4-pro', 'glm-5.2', 'qwen3.6-flash',
        'qwen3.7-max', 'qwen3.7-plus', 'qwen3.8-max-preview',
      ].sort(),
    );
    assert.equal(byId.get('my-private-model')?.display_name, 'My private model');
    assert.equal(byId.get('my-private-model')?.user_edited, 1);
    assert.equal(byId.get('my-private-model')?.enable_source, 'manual_enabled');
  });

  it('adopts a stable identity without silently reconciling catalog rows on an ordinary legacy edit', async () => {
    const provider = createTokenProvider();
    for (const modelId of ['qwen3.6-plus', 'glm-5', 'MiniMax-M2.5']) {
      upsertProviderModel({
        provider_id: provider.id,
        model_id: modelId,
        upstream_model_id: modelId,
        display_name: modelId,
        source: 'catalog',
        user_edited: 0,
        enable_source: 'recommended',
      });
    }

    const response = await PUT(
      request(provider.id, { preset_key: 'qwen-token-plan-personal-cn' }),
      { params: Promise.resolve({ id: provider.id }) },
    );
    assert.equal(response.status, 200);
    assert.equal(getProvider(provider.id)?.preset_key, 'qwen-token-plan-personal-cn');
    assert.deepEqual(
      getAllModelsForProvider(provider.id).map(row => row.model_id).sort(),
      ['MiniMax-M2.5', 'glm-5', 'qwen3.6-plus'].sort(),
    );
  });

  it('rejects clearing a managed identity instead of returning to URL inference', async () => {
    const provider = createTokenProvider('bailian-token-plan-cn');
    const response = await PUT(
      request(provider.id, { preset_key: '' }),
      { params: Promise.resolve({ id: provider.id }) },
    );
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'PRESET_IDENTITY_REQUIRED');
    assert.equal(getProvider(provider.id)?.preset_key, 'bailian-token-plan-cn');
  });
});
