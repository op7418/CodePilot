/**
 * User-path regressions reported during the 2026-07-19 foundation refresh
 * acceptance pass.
 *
 * These deliberately exercise the LAST local boundary the composer consumes:
 * the final /api/providers/models response after DB/catalog/cache merging.
 * Helper-only tests stayed green while the actual selector had no effort
 * control, so a helper result is not sufficient evidence for these outcomes.
 */

import '../db-isolation.setup';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import {
  createProvider,
  deleteProviderModel,
  getDb,
  deleteProvider,
  getAllModelsForProvider,
  getAllProviders,
  upsertProviderModel,
} from '@/lib/db';
import {
  invalidateCodexModelsCache,
  listCodexModels,
} from '@/lib/codex/models';
import {
  GET as modelsGET,
  normalizeModelCapabilitySurface,
} from '@/app/api/providers/models/route';
import {
  GET as providerModelsGET,
  PATCH as providerModelsPATCH,
  POST as providerModelsPOST,
} from '@/app/api/providers/[id]/models/route';
import { POST as searchModelsPOST } from '@/app/api/providers/[id]/search-models/route';
import {
  buildSearchCandidateMutation,
  filterSearchCandidates,
  isModelIdentityConflictResponse,
  type SearchCandidate,
} from '@/components/settings/OpenRouterSearchDialog';

const TEST_PROVIDER_PREFIX = '__test_foundation_user_path_';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('capability API boundary rejects malformed runtime data', () => {
  it('does not turn string "false" into a truthy effort capability', () => {
    const normalized = normalizeModelCapabilitySurface({
      value: 'dirty',
      label: 'Dirty',
      capabilities: { supportsEffort: 'false' },
    });
    assert.equal(normalized.supportsEffort, undefined);
  });

  it('drops a mixed-type effort allowlist instead of trusting an assertion', () => {
    const normalized = normalizeModelCapabilitySurface({
      value: 'dirty',
      label: 'Dirty',
      capabilities: { supportedEffortLevels: ['high', 42] },
    });
    assert.equal(normalized.supportedEffortLevels, undefined);
  });

  it('preserves explicit false and a valid string allowlist', () => {
    const normalized = normalizeModelCapabilitySurface({
      value: 'valid',
      label: 'Valid',
      supportsEffort: false,
      capabilities: { supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    });
    assert.equal(normalized.supportsEffort, false, 'top-level explicit false stays authoritative');
    assert.deepEqual(normalized.supportedEffortLevels, ['low', 'high']);
  });
});

function cleanupProviders() {
  for (const provider of getAllProviders()) {
    if (provider.name.startsWith(TEST_PROVIDER_PREFIX)) deleteProvider(provider.id);
  }
}

function fakeCodexServer(data: unknown[]) {
  return async () => ({
    client: {
      request: <T>(): Promise<T> => Promise.resolve({ data, nextCursor: null } as T),
    },
  });
}

type RouteModel = {
  value: string;
  label: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
};

type RouteGroup = {
  provider_id: string;
  models: RouteModel[];
};

async function getGroups(): Promise<RouteGroup[]> {
  const response = await modelsGET(new NextRequest('http://localhost/api/providers/models'));
  assert.equal(response.status, 200);
  const body = await response.json() as { groups: RouteGroup[] };
  return body.groups;
}

beforeEach(() => {
  cleanupProviders();
  invalidateCodexModelsCache();
});

afterEach(() => {
  cleanupProviders();
  invalidateCodexModelsCache();
});

describe('U1 — GPT-5.6 effort survives into the final composer feed', () => {
  it('lifts Codex model/list effort metadata to the top-level fields MessageInput reads', async () => {
    await listCodexModels(
      { force: true },
      fakeCodexServer([
        {
          id: 'gpt-5.6-sol',
          model: 'gpt-5.6-sol',
          displayName: 'GPT-5.6 Sol',
          description: 'Frontier',
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: 'low' },
            { reasoningEffort: 'high' },
            { reasoningEffort: 'xhigh' },
            { reasoningEffort: 'max' },
          ],
          defaultReasoningEffort: 'high',
          inputModalities: ['text'],
        },
      ]),
    );

    const groups = await getGroups();
    const codex = groups.find(group => group.provider_id === 'codex_account');
    assert.ok(codex, 'a warm Codex model cache must reach the full-catalog route');
    const model = codex.models.find(row => row.value === 'gpt-5.6-sol');
    assert.ok(model, 'GPT-5.6 Sol must be present in the Codex account group');
    assert.equal(
      model.supportsEffort,
      true,
      'MessageInput reads the top-level field; nested capabilities alone render no selector',
    );
    assert.deepEqual(model.supportedEffortLevels, ['low', 'high', 'xhigh', 'max']);
  });
});

describe('U2 — the real Kimi for Coding DB shape is enriched, not shadowed', () => {
  it('keeps the channel name and exposes Auto / Low / High / Max for a manual user-edited row', async () => {
    const provider = createProvider({
      name: `${TEST_PROVIDER_PREFIX}${Date.now()}`,
      provider_type: 'anthropic',
      protocol: 'anthropic',
      base_url: 'https://api.kimi.com/coding/',
      api_key: 'sk-test',
      extra_env: '{}',
    });

    // The user's provider also has the catalog's legacy alias explicitly
    // hidden. The read-only enrichment must still use the catalog as a source
    // of display/capability facts for the exact manual channel row; filtering
    // the hidden alias before enrichment was the production-only failure.
    upsertProviderModel({
      provider_id: provider.id,
      model_id: 'sonnet',
      upstream_model_id: 'kimi-for-coding',
      display_name: 'Kimi for Coding',
      capabilities_json: JSON.stringify({ supportsEffort: true, supportedEffortLevels: ['max'] }),
      variants_json: '{}',
      sort_order: 1,
      enabled: 0,
      source: 'catalog',
      last_refreshed_at: '2026-07-19 00:00:00',
      user_edited: 1,
      enable_source: 'manual_hidden',
    });

    // Matches the row observed in the user's database. The row id is the real
    // channel id rather than the catalog's legacy Claude-compatible alias, and
    // user ownership means catalog realignment must not overwrite the DB row.
    // The read path still has to enrich the composer response by matching the
    // catalog upstream id; otherwise the capability disappears forever.
    upsertProviderModel({
      provider_id: provider.id,
      model_id: 'kimi-for-coding',
      upstream_model_id: 'kimi-for-coding',
      display_name: 'kimi-for-coding',
      capabilities_json: '{}',
      variants_json: '{}',
      sort_order: 0,
      enabled: 1,
      source: 'manual',
      last_refreshed_at: '2026-07-19 00:00:00',
      user_edited: 1,
      enable_source: 'manual_enabled',
    });

    const groups = await getGroups();
    const group = groups.find(row => row.provider_id === provider.id);
    assert.ok(group, 'Kimi provider must be present in the final model feed');
    assert.equal(
      group.models.some(row => row.value === 'sonnet'),
      false,
      'the hidden Claude-compatible sonnet alias must not leak back into the final composer feed',
    );
    const model = group.models.find(row => row.value === 'kimi-for-coding');
    assert.ok(model, 'the real kimi-for-coding row must remain selectable');
    assert.equal(model.label, 'Kimi for Coding', 'the UI exposes the channel name, never K3 or a raw id');
    assert.doesNotMatch(model.label, /\bK3\b/i);
    assert.equal(model.supportsEffort, true);
    assert.deepEqual(
      model.supportedEffortLevels,
      ['low', 'high', 'max'],
      'Auto is the absence of an override; Low/High/Max are vendor tiers',
    );
  });
});

describe('U3 — CodePlan add-model is not held hostage by an optional upstream index', () => {
  it('filters by the displayed upstream id and turns hidden candidates into PATCH', () => {
    const candidate: SearchCandidate = {
      modelId: 'sonnet',
      upstreamModelId: 'glm-5.3[1m]',
      displayName: 'GLM-5.3',
      alreadyAdded: true,
      existingHidden: true,
      existingModelId: 'glm-5.3[1m]',
    };
    assert.deepEqual(filterSearchCandidates([candidate], '5.3[1m]'), [candidate]);
    assert.deepEqual(buildSearchCandidateMutation(candidate), {
      method: 'PATCH',
      body: { model_id: 'glm-5.3[1m]', enabled: 1 },
    });
    assert.deepEqual(buildSearchCandidateMutation({
      ...candidate,
      alreadyAdded: false,
      existingHidden: false,
      existingModelId: undefined,
    }), {
      method: 'POST',
      body: {
        model_id: 'sonnet',
        upstream_model_id: 'glm-5.3[1m]',
        display_name: 'GLM-5.3',
      },
    });
    assert.equal(isModelIdentityConflictResponse(409, {
      code: 'MODEL_IDENTITY_CONFLICT',
      conflictModelIds: ['sonnet'],
    }), true);
    assert.equal(isModelIdentityConflictResponse(500, {
      code: 'MODEL_IDENTITY_CONFLICT',
    }), false);
  });

  it('renders conflict row ids with an action instead of a dead warning badge', () => {
    const dialogSource = fs.readFileSync(
      path.join(SRC, 'components/settings/OpenRouterSearchDialog.tsx'),
      'utf8',
    );
    assert.match(dialogSource, /candidate\.conflictModelIds\?\.join/);
    assert.match(dialogSource, /provider\.search\.openrouter\.identityConflictDetail/);
    assert.match(dialogSource, /provider\.search\.openrouter\.reviewModels/);
    assert.match(dialogSource, /await fetchCandidates\(\)/,
      'mutation success must be followed by the server-owned classifier, not an optimistic badge flip');
    assert.match(dialogSource, /isModelIdentityConflictResponse\(res\.status, body\)[\s\S]*await fetchCandidates\(\)/,
      'a conflict response must also reload the server-owned candidate list');
    assert.match(dialogSource, /provider\.search\.openrouter\.mutationIdentityConflict/,
      'the renderer must translate the typed 409 instead of showing the route fallback string');
  });

  it('returns a typed 409 without overwriting a user-owned GLM identity', async () => {
    const provider = createProvider({
      name: `${TEST_PROVIDER_PREFIX}glm_conflict_${Date.now()}`,
      provider_type: 'anthropic',
      protocol: 'anthropic',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      api_key: 'sk-test',
      extra_env: '{}',
    });
    upsertProviderModel({
      provider_id: provider.id,
      model_id: 'sonnet',
      upstream_model_id: 'user-owned-glm-route',
      display_name: 'My GLM route',
      capabilities_json: JSON.stringify({ private: true }),
      sort_order: 7,
      enabled: 1,
      source: 'manual',
      user_edited: 1,
      enable_source: 'manual_enabled',
    });

    const response = await providerModelsPOST(
      new NextRequest(`http://localhost/api/providers/${provider.id}/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model_id: 'sonnet',
          upstream_model_id: 'glm-5.3[1m]',
          display_name: 'GLM-5.3',
        }),
      }),
      { params: Promise.resolve({ id: provider.id }) },
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'Model identity conflict requires review in Settings > Models',
      code: 'MODEL_IDENTITY_CONFLICT',
      conflictModelIds: ['sonnet'],
    });
    const preserved = getAllModelsForProvider(provider.id).find(model => model.model_id === 'sonnet');
    assert.equal(preserved?.upstream_model_id, 'user-owned-glm-route');
    assert.equal(preserved?.display_name, 'My GLM route');
    assert.deepEqual(JSON.parse(preserved!.capabilities_json), { private: true });
  });

  it('falls back to the built-in GLM plan catalog when /models is unreachable', async () => {
    const provider = createProvider({
      name: `${TEST_PROVIDER_PREFIX}glm_${Date.now()}`,
      provider_type: 'anthropic',
      protocol: 'anthropic',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      api_key: 'sk-test',
      extra_env: '{}',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('simulated DNS failure');
    };

    try {
      const response = await searchModelsPOST(
        new NextRequest(`http://localhost/api/providers/${provider.id}/search-models`, {
          method: 'POST',
        }),
        { params: Promise.resolve({ id: provider.id }) },
      );
      assert.equal(
        response.status,
        200,
        'GLM CodePlan has a curated SKU catalog; upstream index failure must not make Add Model unusable',
      );
      const body = await response.json() as {
        candidates: Array<{
          modelId: string;
          upstreamModelId?: string;
          displayName: string;
          alreadyAdded: boolean;
          existingHidden?: boolean;
          existingModelId?: string;
        }>;
      };
      const flagship = body.candidates.find(candidate => candidate.displayName === 'GLM-5.3');
      assert.ok(flagship, 'the fallback must expose the current curated GLM-5.3 entry');
      assert.equal(flagship.modelId, 'sonnet', 'candidate must keep the stable local catalog id');
      assert.equal(flagship.upstreamModelId, 'glm-5.3[1m]', 'wire id must stay separate from the DB id');
      assert.equal(flagship.alreadyAdded, false);
      assert.equal(flagship.existingHidden, false);
      assert.equal(flagship.existingModelId, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('upgrades a pristine GLM-5.2 snapshot before Add Model claims GLM-5.3 is already added', async () => {
    const provider = createProvider({
      name: `${TEST_PROVIDER_PREFIX}glm_stale_${Date.now()}`,
      provider_type: 'anthropic',
      protocol: 'anthropic',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      api_key: 'sk-test',
      extra_env: '{}',
    });
    upsertProviderModel({
      provider_id: provider.id,
      model_id: 'sonnet',
      upstream_model_id: 'sonnet',
      display_name: 'GLM-5.2',
      capabilities_json: JSON.stringify({
        supportsEffort: true,
        supportedEffortLevels: ['high', 'max'],
      }),
      sort_order: 0,
      enabled: 1,
      source: 'catalog',
      user_edited: 0,
      enable_source: 'catalog',
    });
    upsertProviderModel({
      provider_id: provider.id,
      model_id: 'haiku',
      upstream_model_id: 'haiku',
      display_name: 'GLM-4.5-Air',
      sort_order: 1,
      enabled: 1,
      source: 'catalog',
      user_edited: 0,
      enable_source: 'catalog',
    });
    upsertProviderModel({
      provider_id: provider.id,
      model_id: 'user/custom-model',
      upstream_model_id: 'user/custom-model',
      display_name: 'My custom GLM',
      sort_order: 99,
      enabled: 0,
      source: 'manual',
      user_edited: 1,
      enable_source: 'manual_hidden',
    });

    const modelsResponse = await providerModelsGET(
      new NextRequest(`http://localhost/api/providers/${provider.id}/models?all=1`),
      { params: Promise.resolve({ id: provider.id }) },
    );
    assert.equal(modelsResponse.status, 200);
    const modelsBody = await modelsResponse.json() as {
      models: Array<{
        model_id: string;
        upstream_model_id: string;
        display_name: string;
        enabled: number;
        user_edited: number;
        enable_source: string;
      }>;
    };
    const byId = new Map(modelsBody.models.map(model => [model.model_id, model]));
    assert.equal(byId.get('sonnet')?.display_name, 'GLM-5.3');
    assert.equal(byId.get('sonnet')?.upstream_model_id, 'glm-5.3[1m]');
    const persistedCapabilities = JSON.parse(
      getAllModelsForProvider(provider.id).find(model => model.model_id === 'sonnet')!.capabilities_json,
    );
    assert.equal(persistedCapabilities.supportsEffort, true);
    assert.deepEqual(persistedCapabilities.supportedEffortLevels, ['low', 'high', 'max']);
    assert.equal(persistedCapabilities.defaultEffortLevel, 'max');
    assert.equal(persistedCapabilities.effortNoteKey, 'messageInput.effort.note.glmCodePlan');
    assert.equal(byId.get('haiku')?.display_name, 'GLM-5.3-Flash');
    assert.equal(byId.get('haiku')?.upstream_model_id, 'glm-5.3-flash[1m]');
    const flashCapabilities = JSON.parse(
      getAllModelsForProvider(provider.id).find(model => model.model_id === 'haiku')!.capabilities_json,
    );
    assert.equal(flashCapabilities.vision, true);
    assert.deepEqual(flashCapabilities.supportedEffortLevels, ['low', 'high', 'max']);
    assert.equal(byId.get('user/custom-model')?.display_name, 'My custom GLM');
    assert.equal(byId.get('user/custom-model')?.enabled, 0, 'manual hidden choice must survive catalog merge');
    assert.equal(byId.get('user/custom-model')?.user_edited, 1);
    assert.equal(byId.get('user/custom-model')?.enable_source, 'manual_hidden');

    const searchResponse = await searchModelsPOST(
      new NextRequest(`http://localhost/api/providers/${provider.id}/search-models`, { method: 'POST' }),
      { params: Promise.resolve({ id: provider.id }) },
    );
    assert.equal(searchResponse.status, 200);
    const searchBody = await searchResponse.json() as {
      candidates: Array<{
        modelId: string;
        upstreamModelId?: string;
        displayName: string;
        alreadyAdded: boolean;
        existingHidden?: boolean;
        existingModelId?: string;
      }>;
    };
    const flagship = searchBody.candidates.find(candidate => candidate.displayName === 'GLM-5.3');
    assert.deepEqual(flagship, {
      modelId: 'sonnet',
      upstreamModelId: 'glm-5.3[1m]',
      displayName: 'GLM-5.3',
      alreadyAdded: true,
      existingHidden: false,
      presenceState: 'current_enabled',
      existingModelId: 'sonnet',
    });

    const changesBeforeRepeat = Number(
      (getDb().prepare('SELECT total_changes() AS count').get() as { count: number }).count,
    );
    const repeatedModelsResponse = await providerModelsGET(
      new NextRequest(`http://localhost/api/providers/${provider.id}/models?all=1`),
      { params: Promise.resolve({ id: provider.id }) },
    );
    assert.equal(repeatedModelsResponse.status, 200);
    const changesAfterRepeat = Number(
      (getDb().prepare('SELECT total_changes() AS count').get() as { count: number }).count,
    );
    assert.equal(
      changesAfterRepeat,
      changesBeforeRepeat,
      'a second Models GET against current catalog metadata must perform zero writes',
    );
  });

  it('classifies and repairs the pre-source-migration GLM-5-Turbo row across all consumer surfaces', async () => {
    const provider = createProvider({
      name: `${TEST_PROVIDER_PREFIX}glm_legacy_manual_${Date.now()}`,
      provider_type: 'anthropic',
      protocol: 'anthropic',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      api_key: 'sk-test',
      extra_env: '{}',
    });
    upsertProviderModel({
      provider_id: provider.id,
      model_id: 'sonnet',
      upstream_model_id: 'sonnet',
      display_name: 'GLM-5-Turbo',
      capabilities_json: '{}',
      sort_order: 0,
      enabled: 1,
      source: 'manual',
      user_edited: 0,
      enable_source: 'recommended',
    });

    const beforeSearch = await searchModelsPOST(
      new NextRequest(`http://localhost/api/providers/${provider.id}/search-models`, { method: 'POST' }),
      { params: Promise.resolve({ id: provider.id }) },
    );
    assert.equal(beforeSearch.status, 200);
    const beforeBody = await beforeSearch.json() as {
      candidates: Array<{
        modelId: string;
        alreadyAdded: boolean;
        presenceState: string;
      }>;
    };
    const beforeFlagship = beforeBody.candidates.find(candidate => candidate.modelId === 'sonnet')!;
    assert.equal(beforeFlagship.alreadyAdded, false,
      'a stable slot carrying an old wire must not be presented as the current SKU');
    assert.equal(beforeFlagship.presenceState, 'legacy_upgrade_available');

    const upgrade = await providerModelsPOST(
      new NextRequest(`http://localhost/api/providers/${provider.id}/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model_id: 'sonnet',
          upstream_model_id: 'glm-5.3[1m]',
          display_name: 'GLM-5.3',
        }),
      }),
      { params: Promise.resolve({ id: provider.id }) },
    );
    assert.equal(upgrade.status, 200);

    const settingsResponse = await providerModelsGET(
      new NextRequest(`http://localhost/api/providers/${provider.id}/models?all=1`),
      { params: Promise.resolve({ id: provider.id }) },
    );
    const settingsBody = await settingsResponse.json() as {
      models: Array<{ model_id: string; upstream_model_id: string; display_name: string }>;
    };
    const settingsFlagship = settingsBody.models.find(model => model.model_id === 'sonnet')!;
    assert.equal(settingsFlagship.upstream_model_id, 'glm-5.3[1m]');
    assert.equal(settingsFlagship.display_name, 'GLM-5.3');
    assert.ok(settingsBody.models.some(model =>
      model.model_id === 'haiku'
      && model.upstream_model_id === 'glm-5.3-flash[1m]'
      && model.display_name === 'GLM-5.3-Flash'));

    const groups = await getGroups();
    const composerGroup = groups.find(group => group.provider_id === provider.id)!;
    const composerFlagship = composerGroup.models.find(model => model.value === 'sonnet')!;
    assert.equal(composerFlagship.label, 'GLM-5.3');

    const afterSearch = await searchModelsPOST(
      new NextRequest(`http://localhost/api/providers/${provider.id}/search-models`, { method: 'POST' }),
      { params: Promise.resolve({ id: provider.id }) },
    );
    const afterBody = await afterSearch.json() as {
      candidates: Array<{ modelId: string; alreadyAdded: boolean; presenceState: string }>;
    };
    const afterFlagship = afterBody.candidates.find(candidate => candidate.modelId === 'sonnet')!;
    assert.equal(afterFlagship.alreadyAdded, true);
    assert.equal(afterFlagship.presenceState, 'current_enabled');
  });

  it('keeps a hidden upstream-id row actionable instead of claiming it is simply added', async () => {
    const provider = createProvider({
      name: `${TEST_PROVIDER_PREFIX}glm_hidden_${Date.now()}`,
      provider_type: 'anthropic',
      protocol: 'anthropic',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      api_key: 'sk-test',
      extra_env: '{}',
    });
    upsertProviderModel({
      provider_id: provider.id,
      model_id: 'glm-5.3[1m]',
      upstream_model_id: 'glm-5.3[1m]',
      display_name: 'My hidden GLM-5.3 route',
      capabilities_json: JSON.stringify({ private: true }),
      sort_order: 7,
      enabled: 0,
      source: 'manual',
      user_edited: 1,
      enable_source: 'manual_hidden',
    });

    const searchResponse = await searchModelsPOST(
      new NextRequest(`http://localhost/api/providers/${provider.id}/search-models`, { method: 'POST' }),
      { params: Promise.resolve({ id: provider.id }) },
    );
    assert.equal(searchResponse.status, 200);
    const searchBody = await searchResponse.json() as {
      candidates: Array<{
        modelId: string;
        upstreamModelId?: string;
        displayName: string;
        alreadyAdded: boolean;
        existingHidden?: boolean;
        existingModelId?: string;
      }>;
    };
    const flagship = searchBody.candidates.find(candidate => candidate.modelId === 'sonnet');
    assert.deepEqual(flagship, {
      modelId: 'sonnet',
      upstreamModelId: 'glm-5.3[1m]',
      displayName: 'GLM-5.3',
      alreadyAdded: true,
      existingHidden: true,
      presenceState: 'current_hidden',
      existingModelId: 'glm-5.3[1m]',
    });

    const enableResponse = await providerModelsPATCH(
      new NextRequest(`http://localhost/api/providers/${provider.id}/models`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model_id: flagship!.existingModelId, enabled: 1 }),
      }),
      { params: Promise.resolve({ id: provider.id }) },
    );
    assert.equal(enableResponse.status, 200);
    const restored = getAllModelsForProvider(provider.id).find(
      model => model.model_id === 'glm-5.3[1m]',
    )!;
    assert.equal(restored.enabled, 1);
    assert.equal(restored.enable_source, 'manual_enabled');
    assert.equal(restored.display_name, 'My hidden GLM-5.3 route');
    assert.deepEqual(JSON.parse(restored.capabilities_json), { private: true });
  });

  it('re-adding a deleted plan candidate restores catalog ownership and capabilities', async () => {
    const provider = createProvider({
      name: `${TEST_PROVIDER_PREFIX}glm_readd_${Date.now()}`,
      provider_type: 'anthropic',
      protocol: 'anthropic',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      api_key: 'sk-test',
      extra_env: '{}',
    });
    const firstModelsResponse = await providerModelsGET(
      new NextRequest(`http://localhost/api/providers/${provider.id}/models?all=1`),
      { params: Promise.resolve({ id: provider.id }) },
    );
    assert.equal(firstModelsResponse.status, 200);
    assert.equal(deleteProviderModel(provider.id, 'sonnet'), true);

    const addResponse = await providerModelsPOST(
      new NextRequest(`http://localhost/api/providers/${provider.id}/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // This is the exact body the search dialog sends. Catalog facts must
        // be recovered server-side rather than trusted from the renderer.
        body: JSON.stringify({
          model_id: 'sonnet',
          upstream_model_id: 'glm-5.3[1m]',
          display_name: 'GLM-5.3',
        }),
      }),
      { params: Promise.resolve({ id: provider.id }) },
    );
    assert.equal(addResponse.status, 200);
    const restored = getAllModelsForProvider(provider.id).find(model => model.model_id === 'sonnet')!;
    assert.equal(restored.source, 'catalog');
    assert.equal(restored.user_edited, 0);
    assert.equal(restored.enable_source, 'catalog');
    assert.equal(restored.upstream_model_id, 'glm-5.3[1m]');
    const caps = JSON.parse(restored.capabilities_json);
    assert.equal(caps.contextWindow, 1_000_000);
    assert.equal(caps.supportsEffort, true);
    assert.deepEqual(caps.supportedEffortLevels, ['low', 'high', 'max']);
  });

  it('does not run the catalog merge for a non-plan provider with starter defaults', async () => {
    const provider = createProvider({
      name: `${TEST_PROVIDER_PREFIX}anthropic_${Date.now()}`,
      provider_type: 'anthropic',
      protocol: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'sk-test',
      extra_env: '{}',
    });
    upsertProviderModel({
      provider_id: provider.id,
      model_id: 'sonnet',
      upstream_model_id: 'legacy-sonnet-wire',
      display_name: 'My untouched starter row',
      capabilities_json: JSON.stringify({ private: true }),
      sort_order: 9,
      enabled: 1,
      source: 'catalog',
      user_edited: 0,
      enable_source: 'catalog',
    });

    const response = await providerModelsGET(
      new NextRequest(`http://localhost/api/providers/${provider.id}/models?all=1`),
      { params: Promise.resolve({ id: provider.id }) },
    );
    assert.equal(response.status, 200);
    const rows = getAllModelsForProvider(provider.id);
    assert.equal(rows.length, 1, 'starter catalog providers must not receive plan-only inserts on read');
    assert.equal(rows[0].display_name, 'My untouched starter row');
    assert.equal(rows[0].upstream_model_id, 'legacy-sonnet-wire');
    assert.deepEqual(JSON.parse(rows[0].capabilities_json), { private: true });
  });
});

describe('U3b — new catalog-only K3 entries reach existing provider rows', () => {
  const cases = [
    {
      name: 'ClinePass',
      baseUrl: 'https://api.cline.bot/api/v1',
      existingId: 'cline-pass/glm-5.2',
      k3Id: 'cline-pass/kimi-k3',
    },
    {
      name: 'OpenCode Go (OpenAI)',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      existingId: 'glm-5.2',
      k3Id: 'kimi-k3',
    },
  ] as const;

  for (const testCase of cases) {
    it(`${testCase.name}: appends Kimi K3 without requiring a DB reseed`, async () => {
      const provider = createProvider({
        name: `${TEST_PROVIDER_PREFIX}${testCase.name}_${Date.now()}`,
        provider_type: 'openai-compatible',
        protocol: 'openai-compatible',
        base_url: testCase.baseUrl,
        api_key: 'sk-test',
        extra_env: '{}',
      });

      // Reproduce an existing installation whose provider_models table was
      // materialized before K3 entered the curated catalog. The final route
      // must append a genuinely new catalog identity; otherwise existing users
      // never see K3 until they manually realign/recreate the provider.
      upsertProviderModel({
        provider_id: provider.id,
        model_id: testCase.existingId,
        upstream_model_id: testCase.existingId,
        display_name: 'Existing catalog row',
        capabilities_json: '{}',
        variants_json: '{}',
        sort_order: 0,
        enabled: 1,
        source: 'catalog',
        last_refreshed_at: '2026-07-01 00:00:00',
        user_edited: 0,
        enable_source: 'recommended',
      });

      const groups = await getGroups();
      const group = groups.find(row => row.provider_id === provider.id);
      assert.ok(group, `${testCase.name} must remain in the final composer feed`);
      const k3 = group.models.find(row => row.value === testCase.k3Id);
      assert.ok(k3, `${testCase.k3Id} must be appended from the current catalog`);
      assert.equal(k3.label, 'Kimi K3');
      assert.equal(k3.supportsEffort, undefined,
        'do not show an effort selector until this gateway wire is verified');
    });
  }
});

describe('U2b — untouched catalog rows follow current Kimi capability', () => {
  it('upgrades a stale max-only catalog cache on the final read path without a DB reseed', async () => {
    const provider = createProvider({
      name: `${TEST_PROVIDER_PREFIX}KimiStaleCatalog_${Date.now()}`,
      provider_type: 'anthropic',
      protocol: 'anthropic',
      base_url: 'https://api.kimi.com/coding/',
      api_key: 'sk-test',
      extra_env: '{}',
    });
    upsertProviderModel({
      provider_id: provider.id,
      model_id: 'sonnet',
      upstream_model_id: 'kimi-for-coding',
      display_name: 'Kimi for Coding',
      capabilities_json: JSON.stringify({
        supportsEffort: true,
        supportedEffortLevels: ['max'],
        effortNoteKey: 'messageInput.effort.note.kimiAuto',
      }),
      variants_json: '{}',
      sort_order: 0,
      enabled: 1,
      source: 'catalog',
      user_edited: 0,
      enable_source: 'catalog',
    });

    const groups = await getGroups();
    const model = groups.find(group => group.provider_id === provider.id)?.models[0];
    assert.ok(model, 'Kimi catalog row must remain visible');
    assert.deepEqual(model.supportedEffortLevels, ['low', 'high', 'max'],
      'an untouched catalog cache is not a user override and must follow the current shipped capability');

    const stored = getAllModelsForProvider(provider.id)[0];
    assert.deepEqual(JSON.parse(stored.capabilities_json).supportedEffortLevels, ['max'],
      'the picker upgrade is read-only; it must not mutate provider_models during GET');
  });

  it('still preserves a user-edited max-only capability', async () => {
    const provider = createProvider({
      name: `${TEST_PROVIDER_PREFIX}KimiUserCaps_${Date.now()}`,
      provider_type: 'anthropic',
      protocol: 'anthropic',
      base_url: 'https://api.kimi.com/coding/',
      api_key: 'sk-test',
      extra_env: '{}',
    });
    upsertProviderModel({
      provider_id: provider.id,
      model_id: 'sonnet',
      upstream_model_id: 'kimi-for-coding',
      display_name: 'My Kimi',
      capabilities_json: JSON.stringify({
        supportsEffort: true,
        supportedEffortLevels: ['max'],
      }),
      variants_json: '{}',
      sort_order: 0,
      enabled: 1,
      source: 'catalog',
      user_edited: 1,
      enable_source: 'manual_enabled',
    });

    const groups = await getGroups();
    const model = groups.find(group => group.provider_id === provider.id)?.models[0];
    assert.equal(model?.label, 'My Kimi');
    assert.deepEqual(model?.supportedEffortLevels, ['max'],
      'an explicit user capability remains authoritative');
  });
});

describe('U4 — consolidated model controls share the compact composer contract', () => {
  it('keeps route and capability selectors compact, collision-aware, and sans-serif', () => {
    const capabilitySource = fs.readFileSync(
      path.join(SRC, 'components/chat/ModelCapabilityDropdown.tsx'),
      'utf8',
    );
    const modelSource = fs.readFileSync(
      path.join(SRC, 'components/chat/ModelSelectorDropdown.tsx'),
      'utf8',
    );

    assert.match(
      capabilitySource,
      /<span className="text-xs font-normal">/,
      'the combined effort/context trigger must use compact toolbar typography',
    );
    assert.match(
      modelSource,
      /<span className="[^"]*text-xs font-normal">\{currentModelOption\?\.label\}<\/span>/,
      'selected model must not use an oversized system-monospace fallback',
    );
    assert.doesNotMatch(
      modelSource,
      /font-mono[^\n]*\{(?:currentModelOption\?\.label|route\.modelName)\}/,
      'human-readable model names must never inherit the offline monospace fallback',
    );
    assert.match(
      capabilitySource,
      /\bCommandListItems\b/,
      'capability rows must use the shared command-list item container',
    );
    assert.match(
      modelSource,
      /w-\[42rem\] max-w-\[calc\(100vw-2rem\)\]/,
      'the provider/model route menu must preserve the two-lane layout while shrinking in narrow windows',
    );
    for (const [name, source] of [['capability', capabilitySource], ['model', modelSource]] as const) {
      assert.match(
        source,
        /max-w-\[calc\(100vw-2rem\)\]/,
        `${name} popover must shrink inside a narrow window instead of overflowing`,
      );
      assert.match(source, /<PopoverContent[\s\S]{0,220}collisionPadding=\{16\}/,
        `${name} popover must use collision-aware viewport placement, not only a max-width`);
    }
    assert.match(capabilitySource, /<CommandList positioning="inline"/,
      'the combined capability list must let the Radix popover own placement');
  });

  it('keeps auto-review in the same muted toolbar tier as mode and runtime', () => {
    const permissionSource = fs.readFileSync(
      path.join(SRC, 'components/chat/ChatPermissionSelector.tsx'),
      'utf8',
    );

    assert.match(
      permissionSource,
      /isAutoReview[\s\S]*\? 'text-xs font-normal text-muted-foreground'/,
      '替我审批 must not become darker or heavier than the adjacent toolbar selectors',
    );
  });

  it('keeps right-panel file names in compact UI typography', () => {
    const fileTreeSource = fs.readFileSync(
      path.join(SRC, 'components/ai-elements/file-tree.tsx'),
      'utf8',
    );

    assert.match(
      fileTreeSource,
      /"rounded-lg border bg-background text-xs font-normal"/,
      'file names must match the compact right-panel controls',
    );
    assert.doesNotMatch(
      fileTreeSource,
      /rounded-lg border bg-background font-mono text-sm/,
      'the entire tree must not inherit an oversized system-monospace fallback',
    );
  });

  it('keeps human-readable model labels sans outside the composer too', () => {
    const bridgeSource = fs.readFileSync(
      path.join(SRC, 'components/bridge/BridgeSection.tsx'),
      'utf8',
    );

    assert.match(
      bridgeSource,
      /<Select value=\{model\}[\s\S]*?<SelectTrigger className="w-full text-sm font-normal">/,
      'the bridge default-model selector must render display labels as UI text',
    );
    assert.doesNotMatch(
      bridgeSource,
      /<Select value=\{model\}[\s\S]*?<SelectTrigger className="w-full text-sm font-mono">/,
      'model display labels must not inherit the offline monospace fallback',
    );
  });
});

describe('U5 — product fonts are bundled and keep their semantic roles', () => {
  it('loads Geist Sans and Geist Mono locally instead of depending on Google Fonts', () => {
    const layoutSource = fs.readFileSync(path.join(SRC, 'app/layout.tsx'), 'utf8');
    const globalsSource = fs.readFileSync(path.join(SRC, 'app/globals.css'), 'utf8');
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(SRC, '../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    assert.match(layoutSource, /import \{ GeistSans \} from "geist\/font\/sans";/);
    assert.match(layoutSource, /import \{ GeistMono \} from "geist\/font\/mono";/);
    assert.doesNotMatch(
      layoutSource,
      /next\/font\/google/,
      'desktop startup must not need a Google Fonts request',
    );
    assert.match(
      layoutSource,
      /className=\{`\$\{GeistSans\.className\} \$\{GeistSans\.variable\} \$\{GeistMono\.variable\} antialiased`\}/,
      'the bundled sans face and both font variables must be installed at the application root',
    );
    assert.equal(packageJson.dependencies?.geist, '^1.7.2');
    assert.match(globalsSource, /--font-sans: var\(--font-geist-sans\);/);
    assert.match(globalsSource, /--font-mono: var\(--font-geist-mono\);/);
  });

  it('retains monospace only on code-oriented content', () => {
    const codeBlockSource = fs.readFileSync(
      path.join(SRC, 'components/ai-elements/code-block.tsx'),
      'utf8',
    );

    assert.match(codeBlockSource, /font-mono text-sm/);
  });
});
