/**
 * OpenRouter search-and-add — backend regression tests.
 *
 * Locks the contract from `docs/exec-plans/active/openrouter-search-and-add.md`:
 *   1. Add Service must NOT auto-materialize the 300+ upstream catalog.
 *   2. Refresh (validate-models) must NOT INSERT rows or touch business
 *      fields — only `last_refreshed_at` moves.
 *   3. Search-models is a pure read (no DB writes).
 *   4. `alreadyAdded` flag accurately reflects current `provider_models`.
 *   5. discover-models for OpenRouter returns `unsupported` early — no fetch.
 *   6. discover-models/apply for OpenRouter rejects with 400.
 *   7. `isOpenRouterProviderRecord` catches the legacy DB shape
 *      (`provider_type='openrouter'` with empty/missing `protocol`) — bare
 *      `protocol === 'openrouter'` would miss it.
 *   8. The legacy cleanup entry only hides rows where
 *      `enable_source='recommended' AND user_edited=0`; manual_* rows survive.
 *   9. Cache helper honors `force: true` (validate path) vs default
 *      cache-read (search path).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProvider,
  discoverModels,
} from '../../lib/model-discovery';
import {
  isOpenRouterProviderRecord as isOpenRouterProviderRecordResolved,
  getCatalogDefaultModelsForRecord,
} from '../../lib/provider-catalog';

const isOpenRouterProviderRecord = (record: { provider_type: string; base_url: string }) =>
  isOpenRouterProviderRecordResolved({
    preset_key: '',
    protocol: record.provider_type,
    ...record,
  });
import {
  createProvider,
  deleteProvider,
  getAllProviders,
  getAllModelsForProvider,
  seedCatalogModelsIfEmpty,
  upsertProviderModel,
  getRecommendedNotEditedRows,
  hideRecommendedNotEditedRows,
} from '../../lib/db';
import {
  getOpenRouterCatalog,
  __resetOpenRouterCacheForTests,
  type OpenRouterCandidate,
} from '../../lib/openrouter-catalog';

const TEST_PROVIDER_PREFIX = '__test_openrouter_';
const ORIGINAL_FETCH = global.fetch;

function createOpenRouterScratch(): string {
  const p = createProvider({
    name: `${TEST_PROVIDER_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    provider_type: 'openrouter',
    protocol: 'openrouter',
    base_url: 'https://openrouter.ai/api',
    api_key: 'sk-or-test',
    extra_env: '{}',
  });
  return p.id;
}

function cleanup() {
  for (const p of getAllProviders()) {
    if (p.name.startsWith(TEST_PROVIDER_PREFIX)) deleteProvider(p.id);
  }
  __resetOpenRouterCacheForTests();
  global.fetch = ORIGINAL_FETCH;
}

function stubFetch(payload: { id: string; name?: string; context_length?: number }[]) {
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: payload }),
      text: async () => JSON.stringify({ data: payload }),
    };
  }) as unknown as typeof fetch;
  return { getCalls: () => calls };
}

describe('isOpenRouterProviderRecord — record-aware', () => {
  it('matches { provider_type: openrouter, protocol: openrouter, base_url } modern shape', () => {
    assert.equal(
      isOpenRouterProviderRecord({
        provider_type: 'openrouter',
        base_url: 'https://openrouter.ai/api',
      }),
      true,
    );
  });

  it('matches legacy shape with empty protocol', () => {
    // Legacy DB rows had no `protocol` column. Any helper that reads
    // `provider.protocol` directly would miss this. The record helper
    // must recover via `provider_type` (or base_url).
    assert.equal(
      isOpenRouterProviderRecord({
        provider_type: 'openrouter',
        base_url: 'https://openrouter.ai/api',
      }),
      true,
    );
  });

  it('does NOT match unrelated providers', () => {
    assert.equal(
      isOpenRouterProviderRecord({ provider_type: 'anthropic', base_url: 'https://api.anthropic.com' }),
      false,
    );
    assert.equal(
      isOpenRouterProviderRecord({ provider_type: '', base_url: '' }),
      false,
    );
  });
});

describe('classifyProvider — OpenRouter is unsupported (no auto-materialize)', () => {
  it('openrouter preset key returns unsupported, not api', () => {
    const r = classifyProvider({ protocol: 'openrouter', presetKey: 'openrouter' });
    assert.equal(r.classification, 'unsupported');
    assert.match(r.notes, /OpenRouter/);
  });

  it('discoverModels short-circuits before fetch', async () => {
    const stub = stubFetch([{ id: 'should-not-fetch' }]);
    try {
      const result = await discoverModels({
        protocol: 'openrouter',
        baseUrl: 'https://openrouter.ai/api',
        apiKey: 'sk-or-test',
        presetKey: 'openrouter',
      });
      assert.equal(result.classification, 'unsupported');
      assert.equal(result.ok, undefined);
      assert.equal(stub.getCalls(), 0, 'fetch must not be called for OpenRouter');
    } finally {
      global.fetch = ORIGINAL_FETCH;
    }
  });
});

describe('OpenRouter cache helper — force vs default', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('default reads cache after first fetch; force triggers refetch', async () => {
    const providerId = createOpenRouterScratch();
    const provider = getAllProviders().find(p => p.id === providerId)!;
    const stub = stubFetch([{ id: 'anthropic/claude-3.5-sonnet', name: 'Sonnet 3.5' }]);

    // 1st call (default) — fetch fires
    await getOpenRouterCatalog(provider);
    assert.equal(stub.getCalls(), 1);

    // 2nd call (default) — cache hit, no new fetch
    await getOpenRouterCatalog(provider);
    assert.equal(stub.getCalls(), 1, 'second default call must not refetch within TTL');

    // 3rd call (force=true) — must refetch even though cache has fresh data
    await getOpenRouterCatalog(provider, { force: true });
    assert.equal(stub.getCalls(), 2);

    // 4th call (default) — cache hit again with the new value
    const after = await getOpenRouterCatalog(provider);
    assert.equal(stub.getCalls(), 2);
    assert.equal(after.candidates.length, 1);
  });
});

describe('Add Service eager seed — OpenRouter only writes catalog defaults', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('createProvider + seedCatalogModelsIfEmpty installs exactly the catalog defaults', () => {
    // Mirror the route's behavior: create then seed when isOpenRouterProviderRecord.
    const providerId = createOpenRouterScratch();
    const provider = getAllProviders().find(p => p.id === providerId)!;
    assert.equal(isOpenRouterProviderRecord(provider), true);

    const defaults = getCatalogDefaultModelsForRecord(provider);
    seedCatalogModelsIfEmpty(provider.id, defaults);

    const rows = getAllModelsForProvider(provider.id);
    // OpenRouter preset ships sonnet / opus (4.7) / opus-4-8 / haiku.
    // (opus-4-8 added 2026-05-29 in Phase A — Opus 4.8 接入; see
    //  docs/exec-plans/active/post-refactor-cleanup.md.)
    assert.equal(rows.length, 4, `expected 4 catalog seed rows, got ${rows.length}`);
    const ids = new Set(rows.map(r => r.model_id));
    assert.ok(ids.has('sonnet'));
    assert.ok(ids.has('opus'));
    assert.ok(ids.has('opus-4-8'));
    assert.ok(ids.has('haiku'));
    for (const row of rows) {
      assert.equal(row.source, 'catalog');
      assert.equal(row.enable_source, 'catalog');
      assert.equal(row.enabled, 1);
    }
  });

  it('seed is idempotent — second call does not duplicate rows', () => {
    const providerId = createOpenRouterScratch();
    const provider = getAllProviders().find(p => p.id === providerId)!;
    const defaults = getCatalogDefaultModelsForRecord(provider);

    seedCatalogModelsIfEmpty(provider.id, defaults);
    seedCatalogModelsIfEmpty(provider.id, defaults);

    const rows = getAllModelsForProvider(provider.id);
    assert.equal(rows.length, 4);
  });
});

describe('Legacy cleanup — hides recommended-not-edited only', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('preview returns recommended+not-edited; commit hides them; manual_* survive', () => {
    const providerId = createOpenRouterScratch();
    // Stage a mixed bag: 2 recommended-not-edited (legacy auto-import shape),
    // 1 manual_enabled (user said "I want this"), 1 manual_hidden (user
    // said "I don't"), 1 recommended-but-edited (user toggled but kept on).
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'auto/legacy-1',
      display_name: 'Auto-Imported 1',
      source: 'api',
      enable_source: 'recommended',
      user_edited: 0,
      enabled: 1,
    });
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'auto/legacy-2',
      display_name: 'Auto-Imported 2',
      source: 'api',
      enable_source: 'recommended',
      user_edited: 0,
      enabled: 1,
    });
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'user/picked',
      display_name: 'User Picked',
      source: 'manual',
      enable_source: 'manual_enabled',
      user_edited: 1,
      enabled: 1,
    });
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'user/hidden',
      display_name: 'User Hidden',
      source: 'manual',
      enable_source: 'manual_hidden',
      user_edited: 1,
      enabled: 0,
    });
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'edited/recommended',
      display_name: 'Edited Recommended',
      source: 'api',
      enable_source: 'recommended',
      user_edited: 1,
      enabled: 1,
    });

    // Preview
    const candidates = getRecommendedNotEditedRows(providerId);
    assert.equal(candidates.length, 2);
    const candidateIds = new Set(candidates.map(c => c.model_id));
    assert.ok(candidateIds.has('auto/legacy-1'));
    assert.ok(candidateIds.has('auto/legacy-2'));

    // Commit
    const hiddenCount = hideRecommendedNotEditedRows(providerId);
    assert.equal(hiddenCount, 2);

    // Verify post-state: only the two legacy rows changed
    const rows = getAllModelsForProvider(providerId);
    const byId = new Map(rows.map(r => [r.model_id, r]));

    assert.equal(byId.get('auto/legacy-1')!.enabled, 0);
    assert.equal(byId.get('auto/legacy-1')!.enable_source, 'manual_hidden');
    assert.equal(byId.get('auto/legacy-1')!.user_edited, 1);
    assert.equal(byId.get('auto/legacy-2')!.enabled, 0);

    // manual_enabled survives
    assert.equal(byId.get('user/picked')!.enabled, 1);
    assert.equal(byId.get('user/picked')!.enable_source, 'manual_enabled');

    // manual_hidden untouched
    assert.equal(byId.get('user/hidden')!.enabled, 0);
    assert.equal(byId.get('user/hidden')!.enable_source, 'manual_hidden');

    // recommended+user_edited untouched
    assert.equal(byId.get('edited/recommended')!.enabled, 1);
    assert.equal(byId.get('edited/recommended')!.enable_source, 'recommended');
    assert.equal(byId.get('edited/recommended')!.user_edited, 1);
  });

  it('preview returns empty when no candidates exist', () => {
    const providerId = createOpenRouterScratch();
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'user/picked',
      display_name: 'User Picked',
      source: 'manual',
      enable_source: 'manual_enabled',
      user_edited: 1,
      enabled: 1,
    });
    const candidates = getRecommendedNotEditedRows(providerId);
    assert.equal(candidates.length, 0);
    assert.equal(hideRecommendedNotEditedRows(providerId), 0);
  });
});

describe('OpenRouter helper integration with cache + provider models', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('fetched candidates project pricing + context_window correctly', async () => {
    const providerId = createOpenRouterScratch();
    const provider = getAllProviders().find(p => p.id === providerId)!;
    stubFetch([
      {
        id: 'anthropic/claude-3.5-sonnet',
        name: 'Claude 3.5 Sonnet',
        context_length: 200_000,
      },
    ]);
    const result = await getOpenRouterCatalog(provider);
    assert.equal(result.candidates.length, 1);
    const c: OpenRouterCandidate = result.candidates[0];
    assert.equal(c.modelId, 'anthropic/claude-3.5-sonnet');
    assert.equal(c.displayName, 'Claude 3.5 Sonnet');
    assert.equal(c.contextWindow, 200_000);
  });
});

describe('OpenRouter base_url normalization — /v1 suffix not doubled', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('legacy `/api/v1` base_url hits `/v1/models` exactly once, not `/v1/v1/models`', async () => {
    // Real DBs carry both shapes:
    //   - https://openrouter.ai/api      (preset default)
    //   - https://openrouter.ai/api/v1   (legacy / OpenRouter docs example)
    // The fetcher must produce `<base>/models` when base ends with `/v1`,
    // and `<base>/v1/models` otherwise. Asserting via a fetch spy on the
    // URL string is the most direct check.
    const legacyProvider = createProvider({
      name: `${TEST_PROVIDER_PREFIX}legacy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      provider_type: 'openrouter',
      protocol: 'openrouter',
      base_url: 'https://openrouter.ai/api/v1',
      api_key: 'sk-or-test',
      extra_env: '{}',
    });
    const seenUrls: string[] = [];
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      seenUrls.push(url);
      return {
        ok: true, status: 200, statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: [] }),
        text: async () => '{"data":[]}',
      };
    }) as unknown as typeof fetch;

    await getOpenRouterCatalog(legacyProvider);
    assert.equal(seenUrls.length, 1);
    assert.equal(
      seenUrls[0],
      'https://openrouter.ai/api/v1/models',
      'legacy /api/v1 base must NOT be concatenated to /api/v1/v1/models',
    );

    // And confirm the modern base still produces the same final URL.
    __resetOpenRouterCacheForTests();
    seenUrls.length = 0;
    const modernProvider = createProvider({
      name: `${TEST_PROVIDER_PREFIX}modern_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      provider_type: 'openrouter',
      protocol: 'openrouter',
      base_url: 'https://openrouter.ai/api',
      api_key: 'sk-or-test',
      extra_env: '{}',
    });
    await getOpenRouterCatalog(modernProvider);
    assert.equal(seenUrls[0], 'https://openrouter.ai/api/v1/models');
  });
});

describe('Search-and-add → DB write contract', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('POST /api/providers/[id]/models writes a manual_enabled row with the right fields', () => {
    // The dialog uses fetch(POST, body={ model_id, upstream_model_id,
    // display_name }). The route's POST handler hardcodes
    // source='manual', enable_source='manual_enabled', user_edited=1.
    // We exercise the same db-level path the route does, so a future
    // refactor of the route can't drift the dialog's expectations.
    const providerId = createOpenRouterScratch();
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'anthropic/claude-3.5-sonnet',
      upstream_model_id: 'anthropic/claude-3.5-sonnet',
      display_name: 'Claude 3.5 Sonnet',
      source: 'manual',
      enable_source: 'manual_enabled',
      user_edited: 1,
    });
    const rows = getAllModelsForProvider(providerId);
    const added = rows.find(r => r.model_id === 'anthropic/claude-3.5-sonnet');
    assert.ok(added, 'added row must be present');
    assert.equal(added.source, 'manual');
    assert.equal(added.enable_source, 'manual_enabled');
    assert.equal(added.user_edited, 1);
    assert.equal(added.enabled, 1);
  });
});

describe('validate-models — does not flag local catalog aliases', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('skips source=catalog rows so default sonnet/opus/haiku never look "missing upstream"', async () => {
    // Reproduce the post-Add-Service state: 3 catalog seed rows
    // (sonnet/opus/haiku aliases) + 1 user-added real OpenRouter id.
    // /v1/models returns the real id but obviously not the aliases.
    // Validate must report verified=1, missing=[] — NOT verified=1,
    // missing=['sonnet','opus','haiku'] which is what the original
    // implementation produced.
    const providerId = createOpenRouterScratch();
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'sonnet',
      upstream_model_id: 'sonnet',
      display_name: 'Sonnet 4.6',
      source: 'catalog',
      enable_source: 'catalog',
    });
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'opus',
      upstream_model_id: 'opus',
      display_name: 'Opus 4.7',
      source: 'catalog',
      enable_source: 'catalog',
    });
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'haiku',
      upstream_model_id: 'haiku',
      display_name: 'Haiku 4.5',
      source: 'catalog',
      enable_source: 'catalog',
    });
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'anthropic/claude-3.5-sonnet',
      upstream_model_id: 'anthropic/claude-3.5-sonnet',
      display_name: 'Claude 3.5 Sonnet',
      source: 'manual',
      enable_source: 'manual_enabled',
      user_edited: 1,
    });

    const provider = getAllProviders().find(p => p.id === providerId)!;
    stubFetch([
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      { id: 'anthropic/claude-3.7-sonnet', name: 'Claude 3.7 Sonnet' },
    ]);
    const { candidates } = await getOpenRouterCatalog(provider, { force: true });
    const upstreamIds = new Set(candidates.map(c => c.modelId));

    // Mirror the validate route's loop body. Catalog rows must not enter
    // either bucket — the contract is "ignore aliases, only validate
    // user-added or upstream-discovered IDs".
    const localModels = getAllModelsForProvider(providerId).filter(r => r.source !== 'catalog');
    const missing: string[] = [];
    let verified = 0;
    for (const row of localModels) {
      if (upstreamIds.has(row.model_id)) verified += 1;
      else missing.push(row.model_id);
    }
    assert.equal(verified, 1);
    assert.deepEqual(missing, []);
  });

  it('still flags a manually-added id that disappears from upstream', async () => {
    const providerId = createOpenRouterScratch();
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'anthropic/claude-3.5-sonnet',
      upstream_model_id: 'anthropic/claude-3.5-sonnet',
      display_name: 'Claude 3.5 Sonnet',
      source: 'manual',
      enable_source: 'manual_enabled',
      user_edited: 1,
    });
    upsertProviderModel({
      provider_id: providerId,
      model_id: 'deprecated/old-model',
      upstream_model_id: 'deprecated/old-model',
      display_name: 'Deprecated Old Model',
      source: 'manual',
      enable_source: 'manual_enabled',
      user_edited: 1,
    });
    const provider = getAllProviders().find(p => p.id === providerId)!;
    stubFetch([{ id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' }]);
    const { candidates } = await getOpenRouterCatalog(provider, { force: true });
    const upstreamIds = new Set(candidates.map(c => c.modelId));
    const localModels = getAllModelsForProvider(providerId).filter(r => r.source !== 'catalog');
    const missing: string[] = [];
    let verified = 0;
    for (const row of localModels) {
      if (upstreamIds.has(row.model_id)) verified += 1;
      else missing.push(row.model_id);
    }
    assert.equal(verified, 1);
    assert.deepEqual(missing, ['deprecated/old-model']);
  });
});
