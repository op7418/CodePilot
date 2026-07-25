/**
 * Catalog → DB → resolver round-trip for model capabilities.
 *
 * Phase 1 review round 1 (2026-07-17) found the hole this file guards: the
 * GLM/Kimi effort capabilities lived only on the in-memory catalog object.
 * Both DB sync paths (`seedCatalogModelsIfEmpty`, `alignEnabledWithCatalog`)
 * hard-wrote `capabilities_json='{}'`, and both read paths (models GET route,
 * provider-resolver) let a same-id DB row shadow the catalog. So the moment a
 * provider's rows were materialized — which the Models page does on first GET —
 * `supportsEffort` / `supportedEffortLevels` / `effortNoteKey` were dropped and
 * the Auto/High/Max menu disappeared for exactly the providers Phase 1 added it
 * for. Catalog-object-only assertions (provider-resolver.test.ts) could not see
 * this; these tests drive the DB.
 *
 * Invariants, in the order the review demanded them:
 *   - fresh seed  → resolver still reports the catalog capabilities
 *   - legacy row  → system-managed metadata (display/upstream/caps) realigns,
 *                   but model_id stays put so session pins never strand
 *   - user_edited / manual_* rows → untouched, capabilities included
 *   - catalog silent about capabilities → DB value preserved, never erased
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  alignEnabledWithCatalog,
  seedCatalogModelsIfEmpty,
  upsertProviderModel,
  getAllModelsForProvider,
  createProvider,
  deleteProvider,
  getAllProviders,
} from '../../lib/db';
import { resolveProvider } from '../../lib/provider-resolver';
import { getCatalogDefaultModelsForRecord as getCatalogDefaultModelsForRecordResolved } from '../../lib/provider-catalog';

const TEST_PROVIDER_PREFIX = '__test_caps_rt_';

function cleanup() {
  for (const p of getAllProviders()) {
    if (p.name.startsWith(TEST_PROVIDER_PREFIX)) deleteProvider(p.id);
  }
}

/** A provider record shaped like the real vendor preset so the catalog matches. */
function createScratchProvider(baseUrl: string): string {
  const p = createProvider({
    name: `${TEST_PROVIDER_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    provider_type: 'anthropic',
    protocol: 'anthropic',
    base_url: baseUrl,
    api_key: 'sk-test',
    extra_env: '{}',
  });
  return p.id;
}

const GLM_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
const KIMI_BASE_URL = 'https://api.kimi.com/coding/';
const getCatalogDefaultModelsForRecord = (record: { provider_type: string; base_url: string }) =>
  getCatalogDefaultModelsForRecordResolved({
    preset_key: '',
    protocol: record.provider_type,
    ...record,
  });

function resolvedModel(providerId: string, modelId: string) {
  const resolution = resolveProvider({ providerId, model: modelId });
  const entry = resolution.availableModels.find(m => m.modelId === modelId);
  return { resolution, entry };
}

describe('catalog capabilities survive the DB round-trip — GLM', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('fresh seed: resolver still sees the two real GLM tiers + the mapping note', () => {
    const providerId = createScratchProvider(GLM_BASE_URL);
    const catalog = getCatalogDefaultModelsForRecord({
      provider_type: 'anthropic',
      base_url: GLM_BASE_URL,
    });
    assert.ok(catalog.length > 0, 'GLM catalog defaults must match this base_url');

    // This is what `GET /api/providers/[id]/models` does on first open.
    seedCatalogModelsIfEmpty(providerId, catalog);

    const { entry } = resolvedModel(providerId, 'sonnet');
    assert.ok(entry, 'materialized GLM row vanished from the resolver');
    assert.equal(entry.capabilities?.supportsEffort, true,
      'DB row shadowed the catalog and dropped supportsEffort — effort menu would not render');
    assert.deepEqual(entry.capabilities?.supportedEffortLevels, ['high', 'max']);
    assert.equal(entry.capabilities?.effortNoteKey, 'messageInput.effort.note.glmTwoTier');
  });

  it('seeded rows carry capabilities in the DB column, not a placeholder {}', () => {
    const providerId = createScratchProvider(GLM_BASE_URL);
    const catalog = getCatalogDefaultModelsForRecord({
      provider_type: 'anthropic',
      base_url: GLM_BASE_URL,
    });
    seedCatalogModelsIfEmpty(providerId, catalog);

    const row = getAllModelsForProvider(providerId).find(r => r.model_id === 'sonnet')!;
    const caps = JSON.parse(row.capabilities_json || '{}');
    assert.deepEqual(caps.supportedEffortLevels, ['high', 'max'],
      'capabilities_json is the source breadcrumb the picker reads');
  });
});

describe('catalog capabilities survive the DB round-trip — Kimi for Coding', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('legacy `Kimi K2.5` row realigns to the channel name, id and upstream', () => {
    const providerId = createScratchProvider(KIMI_BASE_URL);
    // Exactly the shape a pre-Phase-1 install has on disk: stale display name,
    // self-referential upstream (which shipped the bare `sonnet` string to
    // Kimi), and no capabilities.
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'sonnet',
      upstream_model_id: 'sonnet',
      display_name: 'Kimi K2.5',
      capabilities_json: '{}',
      variants_json: '{}',
      sort_order: 0,
      enabled: 1,
      source: 'catalog',
      last_refreshed_at: '2026-01-01 00:00:00',
      user_edited: 0,
      enable_source: 'recommended',
    });

    const catalog = getCatalogDefaultModelsForRecord({
      provider_type: 'anthropic',
      base_url: KIMI_BASE_URL,
    });
    alignEnabledWithCatalog(providerId, catalog);

    const row = getAllModelsForProvider(providerId).find(r => r.model_id === 'sonnet')!;
    assert.equal(row.display_name, 'Kimi for Coding',
      'legacy row kept showing an underlying version the catalog no longer claims');
    assert.equal(row.upstream_model_id, 'kimi-for-coding',
      'legacy row would keep sending the bare `sonnet` alias upstream');
    assert.equal(row.model_id, 'sonnet',
      'model_id is the session/DB pin — realignment must never move it');

    const { resolution, entry } = resolvedModel(providerId, 'sonnet');
    assert.equal(resolution.upstreamModel, 'kimi-for-coding');
    assert.deepEqual(entry?.capabilities?.supportedEffortLevels, ['low', 'high', 'max'],
      'Kimi menu is Auto + Low/High/Max; without caps on the row it renders nothing');
    assert.equal(entry?.capabilities?.effortNoteKey, 'messageInput.effort.note.kimiAuto');
  });

  it('preserves documented tiers and omits unsupported ones after the round-trip', () => {
    const providerId = createScratchProvider(KIMI_BASE_URL);
    const catalog = getCatalogDefaultModelsForRecord({
      provider_type: 'anthropic',
      base_url: KIMI_BASE_URL,
    });
    seedCatalogModelsIfEmpty(providerId, catalog);

    const { entry } = resolvedModel(providerId, 'sonnet');
    const levels = entry?.capabilities?.supportedEffortLevels ?? [];
    assert.deepEqual(levels, ['low', 'high', 'max']);
    for (const fake of ['medium', 'xhigh']) {
      assert.ok(!levels.includes(fake as 'low'),
        `Kimi advertises unsupported tier ${fake}`);
    }
  });
});

describe('capability realignment respects user ownership', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('user_edited row keeps its display name AND its capabilities', () => {
    const providerId = createScratchProvider(KIMI_BASE_URL);
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'sonnet',
      upstream_model_id: 'my-own-pin',
      display_name: 'My Kimi',
      capabilities_json: JSON.stringify({ supportsEffort: false }),
      variants_json: '{}',
      sort_order: 0,
      enabled: 1,
      source: 'catalog',
      last_refreshed_at: '2026-01-01 00:00:00',
      user_edited: 1,               // the user has chosen for this row
      enable_source: 'recommended',
    });

    const catalog = getCatalogDefaultModelsForRecord({
      provider_type: 'anthropic',
      base_url: KIMI_BASE_URL,
    });
    alignEnabledWithCatalog(providerId, catalog);

    const row = getAllModelsForProvider(providerId).find(r => r.model_id === 'sonnet')!;
    assert.equal(row.display_name, 'My Kimi', 'user_edited display_name was overwritten');
    assert.equal(row.upstream_model_id, 'my-own-pin', 'user_edited upstream was overwritten');
    assert.deepEqual(JSON.parse(row.capabilities_json || '{}'), { supportsEffort: false },
      'user_edited capabilities were overwritten by the catalog');
  });

  it('manual_hidden row is not resurrected by the capability sync', () => {
    const providerId = createScratchProvider(KIMI_BASE_URL);
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'sonnet',
      upstream_model_id: 'sonnet',
      display_name: 'Kimi K2.5',
      capabilities_json: '{}',
      variants_json: '{}',
      sort_order: 0,
      enabled: 0,
      source: 'catalog',
      last_refreshed_at: '2026-01-01 00:00:00',
      user_edited: 0,
      enable_source: 'manual_hidden',
    });

    const catalog = getCatalogDefaultModelsForRecord({
      provider_type: 'anthropic',
      base_url: KIMI_BASE_URL,
    });
    alignEnabledWithCatalog(providerId, catalog);

    const row = getAllModelsForProvider(providerId).find(r => r.model_id === 'sonnet')!;
    assert.equal(row.enabled, 0, 'manual_hidden row must stay hidden');
    assert.equal(row.enable_source, 'manual_hidden');
    assert.equal(row.capabilities_json, '{}',
      'hidden rows are the user\'s call — sync must not write to them at all');
  });

  it('a catalog entry with no capabilities does not erase discovered ones', () => {
    // GLM's haiku row declares no effort capability. If the sync wrote `{}`
    // unconditionally it would clobber whatever model discovery found.
    const providerId = createScratchProvider(GLM_BASE_URL);
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'haiku',
      upstream_model_id: 'haiku',
      display_name: 'stale',
      capabilities_json: JSON.stringify({ contextWindow: 128000 }),
      variants_json: '{}',
      sort_order: 0,
      enabled: 1,
      source: 'api',
      last_refreshed_at: '2026-01-01 00:00:00',
      user_edited: 0,
      enable_source: 'recommended',
    });

    const catalog = getCatalogDefaultModelsForRecord({
      provider_type: 'anthropic',
      base_url: GLM_BASE_URL,
    });
    alignEnabledWithCatalog(providerId, catalog);

    const row = getAllModelsForProvider(providerId).find(r => r.model_id === 'haiku')!;
    assert.equal(row.display_name, 'GLM-4.5-Air', 'system-managed display name should realign');
    assert.deepEqual(JSON.parse(row.capabilities_json || '{}'), { contextWindow: 128000 },
      'a catalog that is merely silent about capabilities must not erase the column');
  });
});
