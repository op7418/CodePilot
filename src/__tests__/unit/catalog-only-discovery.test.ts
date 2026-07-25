/**
 * Catalog-only discovery gateways — ClinePass + OpenCode Go.
 *
 * These three presets are `billingModel: 'coding_plan'` but deliberately NOT
 * `sdkProxyOnly` (ClinePass / OpenCode Go OpenAI are OpenAI-compatible; OpenCode
 * Go Anthropic is standard Anthropic Messages). They therefore escape the
 * existing `sdkProxyOnly && coding_plan` plan gate, so a new explicit flag
 * `meta.modelDiscoveryMode: 'catalog_only'` drives their discovery posture:
 *   - classifyProvider → unsupported (no probe / no auto-write)
 *   - canReliablyFetchModels → false (no refresh button)
 *   - canSearchUpstreamModels → false (no search-and-add in Phase 1)
 *
 * URL contract (regression guard for the double-/v1 bug, verified 2026-06-30):
 * the Claude Code SDK ALWAYS appends `/v1/messages` to an anthropic base (the
 * native compat adapter resolves a non-/v1 base the same way), so OpenCode Go's
 * Anthropic half is stored as `.../zen/go` (NOT `.../zen/go/v1`) — otherwise the
 * SDK POSTs to `.../zen/go/v1/v1/messages` (404 → "model doesn't exist"). The
 * OpenAI half stays `.../zen/go/v1` because the OpenAI SDK appends
 * `/chat/completions`. The two bases are therefore distinct (no preset
 * collision).
 *
 * Research: docs/research/clinepass-opencode-go-integration-2026-06-30.md
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProvider, discoverModels } from '../../lib/model-discovery';
import {
  getPreset,
  isCatalogOnlyDiscoveryProvider,
  isCatalogOnlyDiscoveryRecord as isCatalogOnlyDiscoveryRecordResolved,
  isCatalogOnlyPlanProvider,
  canReliablyFetchModels as canReliablyFetchModelsResolved,
  canSearchUpstreamModels as canSearchUpstreamModelsResolved,
  findMatchingPresetForRecord as findMatchingPresetForRecordResolved,
  getDefaultModelsForProvider,
  PresetSchema,
} from '../../lib/provider-catalog';
import { getProviderCompat as getProviderCompatResolved } from '../../lib/runtime-compat';

const CLINE_PASS_URL = 'https://api.cline.bot/api/v1';
const OPENCODE_OPENAI_URL = 'https://opencode.ai/zen/go/v1';
const OPENCODE_ANTHROPIC_URL = 'https://opencode.ai/zen/go';
const NEW_KEYS = ['cline-pass', 'opencode-go-openai', 'opencode-go-anthropic'] as const;
type LegacyRecord = { provider_type: string; base_url: string; preset_key?: string; protocol?: string };
const identity = (record: LegacyRecord) => ({
  preset_key: record.preset_key ?? '',
  protocol: record.protocol ?? record.provider_type,
  provider_type: record.provider_type,
  base_url: record.base_url,
});
const isCatalogOnlyDiscoveryRecord = (record: LegacyRecord) => isCatalogOnlyDiscoveryRecordResolved(identity(record));
const canReliablyFetchModels = (record: LegacyRecord) => canReliablyFetchModelsResolved(identity(record));
const canSearchUpstreamModels = (record: LegacyRecord) => canSearchUpstreamModelsResolved(identity(record));
const findMatchingPresetForRecord = (record: LegacyRecord) => findMatchingPresetForRecordResolved(identity(record));
const getProviderCompat = (record: LegacyRecord) => getProviderCompatResolved(identity(record));

describe('catalog-only presets — shape', () => {
  for (const key of NEW_KEYS) {
    it(`${key} passes PresetSchema`, () => {
      const preset = getPreset(key);
      assert.ok(preset, `preset ${key} must exist`);
      const result = PresetSchema.safeParse(preset);
      assert.ok(result.success, `schema failed for ${key}: ${result.success ? '' : result.error.message}`);
    });

    it(`${key} is coding_plan + catalog_only, NOT sdkProxyOnly`, () => {
      const preset = getPreset(key)!;
      assert.equal(preset.meta?.billingModel, 'coding_plan');
      assert.equal(preset.meta?.modelDiscoveryMode, 'catalog_only');
      assert.notEqual(preset.sdkProxyOnly, true, `${key} must not abuse sdkProxyOnly`);
      assert.equal(preset.authStyle, 'api_key');
      assert.ok(preset.defaultModels.length > 0, `${key} must ship a catalog`);
    });
  }

  it('ClinePass: openai-compatible, cline-pass/* model ids (id == upstream)', () => {
    const p = getPreset('cline-pass')!;
    assert.equal(p.protocol, 'openai-compatible');
    assert.equal(p.baseUrl, CLINE_PASS_URL);
    assert.ok(p.baseUrl.endsWith('/v1'), 'OpenAI SDK appends /chat/completions, so base ends in /v1');
    assert.equal(p.defaultModels.length, 11);
    const k3 = p.defaultModels.find(m => m.modelId === 'cline-pass/kimi-k3');
    assert.ok(k3 && k3.displayName === 'Kimi K3',
      'ClinePass must expose Kimi K3 with the provider/model-name wire id');
    assert.equal(k3.capabilities?.supportsEffort, undefined,
      'the gateway effort request field is unverified, so the selector must stay hidden');
    for (const m of p.defaultModels) {
      assert.ok(m.modelId.startsWith('cline-pass/'), `model ${m.modelId} must carry the cline-pass/ slug`);
      // The slug IS what the API expects, so no upstream alias.
      assert.equal(m.upstreamModelId, undefined);
    }
  });

  it('OpenCode Go OpenAI: openai-compatible, base ends /v1, 9 bare model ids', () => {
    const p = getPreset('opencode-go-openai')!;
    assert.equal(p.protocol, 'openai-compatible');
    assert.equal(p.baseUrl, OPENCODE_OPENAI_URL);
    assert.ok(p.baseUrl.endsWith('/v1'), 'OpenAI SDK appends /chat/completions, so base ends in /v1');
    assert.equal(p.defaultModels.length, 9);
    const k3 = p.defaultModels.find(m => m.modelId === 'kimi-k3');
    assert.ok(k3 && k3.displayName === 'Kimi K3',
      'OpenCode Go direct API must use the documented bare kimi-k3 id');
    assert.equal(k3.capabilities?.supportsEffort, undefined,
      'Kimi model capability alone does not prove this gateway accepts an effort field');
    for (const m of p.defaultModels) {
      assert.ok(!m.modelId.includes('/'), `OpenCode Go uses bare model ids (got ${m.modelId})`);
    }
  });

  it('OpenCode Go Anthropic: anthropic protocol, base does NOT end /v1 (double-/v1 guard)', () => {
    const p = getPreset('opencode-go-anthropic')!;
    assert.equal(p.protocol, 'anthropic');
    assert.equal(p.baseUrl, OPENCODE_ANTHROPIC_URL);
    // Regression: SDK + ClaudeCodeCompatModel append /v1/messages. A /v1-ending
    // base would POST to .../zen/go/v1/v1/messages → 404. Keep base sans /v1.
    assert.ok(!p.baseUrl.endsWith('/v1'), 'anthropic base must NOT end in /v1');
    assert.equal(`${p.baseUrl}/v1/messages`, 'https://opencode.ai/zen/go/v1/messages',
      'base + /v1/messages must resolve to the real endpoint');
    assert.equal(p.defaultModels.length, 6);
    // Must NOT claim verified before a real-key smoke — drives the experimental
    // (warning) tone rather than the verified tone.
    assert.notEqual(p.meta?.claudeCodeVerified, true);
  });

  it('the two OpenCode Go bases are distinct → no preset collision', () => {
    assert.notEqual(getPreset('opencode-go-openai')!.baseUrl, getPreset('opencode-go-anthropic')!.baseUrl);
  });

  it('OpenCode Go OpenAI vs Anthropic catalogs do not overlap (no cross-protocol leak)', () => {
    const openai = new Set(getPreset('opencode-go-openai')!.defaultModels.map(m => m.modelId));
    const anthropic = new Set(getPreset('opencode-go-anthropic')!.defaultModels.map(m => m.modelId));
    for (const id of anthropic) {
      assert.ok(!openai.has(id), `${id} must not appear in both protocol halves`);
    }
    assert.ok(openai.has('kimi-k3'), 'Kimi K3 belongs on /chat/completions');
    assert.ok(!anthropic.has('kimi-k3'), 'Kimi K3 must not leak onto /messages');
  });
});

describe('isCatalogOnlyDiscoveryProvider — by key', () => {
  for (const key of NEW_KEYS) {
    it(`${key} → true`, () => assert.equal(isCatalogOnlyDiscoveryProvider(key), true));
  }
  it('plan provider (glm-cn) → false (catalog_only is distinct from the plan gate)', () => {
    assert.equal(isCatalogOnlyDiscoveryProvider('glm-cn'), false);
  });
  it('generic openai-compatible → false', () => {
    assert.equal(isCatalogOnlyDiscoveryProvider('openai-compatible'), false);
  });
  it('null / undefined / unknown → false', () => {
    assert.equal(isCatalogOnlyDiscoveryProvider(null), false);
    assert.equal(isCatalogOnlyDiscoveryProvider(undefined), false);
    assert.equal(isCatalogOnlyDiscoveryProvider('not-a-key'), false);
  });
  it('the new presets are NOT caught by the plan gate (would need sdkProxyOnly)', () => {
    for (const key of NEW_KEYS) {
      assert.equal(isCatalogOnlyPlanProvider(key), false, `${key} must not be a plan-gate provider`);
    }
  });
});

describe('classifyProvider — catalog_only gateways → unsupported', () => {
  it('cline-pass (openai-compatible) → unsupported', () => {
    const r = classifyProvider({ protocol: 'openai-compatible', presetKey: 'cline-pass' });
    assert.equal(r.classification, 'unsupported');
    assert.match(r.notes, /catalog_only|whitelist|key-gated/i);
  });
  it('opencode-go-openai → unsupported', () => {
    const r = classifyProvider({ protocol: 'openai-compatible', presetKey: 'opencode-go-openai' });
    assert.equal(r.classification, 'unsupported');
  });
  it('opencode-go-anthropic → unsupported', () => {
    const r = classifyProvider({ protocol: 'anthropic', presetKey: 'opencode-go-anthropic' });
    assert.equal(r.classification, 'unsupported');
  });
  // 反例: a generic openai-compatible gateway WITHOUT the flag still probes.
  it('generic openai-compatible (no flag) → api (regression guard)', () => {
    const r = classifyProvider({ protocol: 'openai-compatible', presetKey: 'openai-compatible' });
    assert.equal(r.classification, 'api');
  });
});

describe('discovery gates — refresh + search both off', () => {
  const records = {
    'cline-pass': { provider_type: 'openai-compatible', base_url: CLINE_PASS_URL },
    'opencode-go-openai': { provider_type: 'openai-compatible', base_url: OPENCODE_OPENAI_URL },
    'opencode-go-anthropic': { provider_type: 'anthropic', base_url: OPENCODE_ANTHROPIC_URL },
  };

  for (const [key, record] of Object.entries(records)) {
    it(`${key}: isCatalogOnlyDiscoveryRecord → true`, () => {
      assert.equal(isCatalogOnlyDiscoveryRecord(record), true);
    });
    it(`${key}: canReliablyFetchModels → false`, () => {
      assert.equal(canReliablyFetchModels(record).reliable, false);
    });
    it(`${key}: canSearchUpstreamModels → false`, () => {
      assert.equal(canSearchUpstreamModels(record).reliable, false);
    });
  }

  // 反例: plan providers (GLM) keep search-and-add ON — their /v1/models is a
  // clean per-vendor list. Proves catalog_only is stricter, not a rename.
  it('GLM plan provider keeps canSearchUpstreamModels → true', () => {
    const glm = getPreset('glm-cn')!;
    assert.equal(
      canSearchUpstreamModels({ provider_type: 'anthropic', base_url: glm.baseUrl }).reliable,
      true,
    );
  });
});

describe('preset resolution + runtime-compat — both halves resolve correctly', () => {
  it('anthropic base → opencode-go-anthropic preset', () => {
    const p = findMatchingPresetForRecord({ provider_type: 'anthropic', base_url: OPENCODE_ANTHROPIC_URL });
    assert.equal(p?.key, 'opencode-go-anthropic');
  });
  it('openai base → opencode-go-openai preset', () => {
    const p = findMatchingPresetForRecord({ provider_type: 'openai-compatible', base_url: OPENCODE_OPENAI_URL });
    assert.equal(p?.key, 'opencode-go-openai');
  });

  it('OpenAI half badge → codepilot_only (CodePilot + Codex, not Claude Code)', () => {
    assert.equal(
      getProviderCompat({ provider_type: 'openai-compatible', base_url: OPENCODE_OPENAI_URL }),
      'codepilot_only',
    );
  });
  it('Anthropic half badge → claude_code_experimental (unverified)', () => {
    assert.equal(
      getProviderCompat({ provider_type: 'anthropic', base_url: OPENCODE_ANTHROPIC_URL }),
      'claude_code_experimental',
    );
  });
  it('ClinePass badge → codepilot_only', () => {
    assert.equal(
      getProviderCompat({ provider_type: 'openai-compatible', base_url: CLINE_PASS_URL }),
      'codepilot_only',
    );
  });

  // Seeding path (getDefaultModelsForProvider) keys on protocol + base_url, so a
  // newly-saved provider gets only its own half — never the other protocol's.
  it('getDefaultModelsForProvider seeds only the OpenAI half (9 bare ids)', () => {
    const models = getDefaultModelsForProvider('openai-compatible', OPENCODE_OPENAI_URL);
    assert.equal(models.length, 9);
    assert.ok(models.every(m => !m.modelId.includes('/')));
    assert.ok(models.some(m => m.modelId === 'glm-5.2'));
    assert.ok(models.some(m => m.modelId === 'kimi-k3'));
  });
  it('getDefaultModelsForProvider seeds only the Anthropic half (6 ids)', () => {
    const models = getDefaultModelsForProvider('anthropic', OPENCODE_ANTHROPIC_URL);
    assert.equal(models.length, 6);
    assert.ok(models.some(m => m.modelId === 'minimax-m3'));
    assert.ok(!models.some(m => m.modelId === 'glm-5.2'), 'must not leak the OpenAI half');
  });
});

describe('legacy OpenCode Go Anthropic record (pre-de-/v1) is not mis-bucketed', () => {
  // Before the Anthropic base was de-/v1'd, a saved Anthropic provider carried
  // base https://opencode.ai/zen/go/v1 — which is NOW the OpenAI half's base.
  // The protocol-aware matcher must not resolve such a record to the OpenAI
  // half (wrong bucket / runtime badge / discovery class).
  const legacy = { provider_type: 'anthropic', base_url: OPENCODE_OPENAI_URL };

  it('does NOT match opencode-go-openai', () => {
    assert.notEqual(findMatchingPresetForRecord(legacy)?.key, 'opencode-go-openai');
  });
  it('falls through to anthropic-thirdparty (correct protocol family)', () => {
    assert.equal(findMatchingPresetForRecord(legacy)?.key, 'anthropic-thirdparty');
  });
  it('runtime badge → claude_code_experimental, NOT codepilot_only', () => {
    assert.equal(getProviderCompat(legacy), 'claude_code_experimental');
  });
  // Regression: a correct OpenAI record at the same base still resolves right.
  it('current openai record at the same base still → opencode-go-openai', () => {
    assert.equal(
      findMatchingPresetForRecord({ provider_type: 'openai-compatible', base_url: OPENCODE_OPENAI_URL })?.key,
      'opencode-go-openai',
    );
  });
});

describe('discoverModels — catalog_only gate prevents any network probe', () => {
  it('opencode-go-openai never fires a probe (no fetch call)', async () => {
    let fetchCalls = 0;
    const original = global.fetch;
    global.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('fetch should not be called for catalog_only preset');
    }) as unknown as typeof fetch;

    try {
      const result = await discoverModels({
        protocol: 'openai-compatible',
        baseUrl: OPENCODE_OPENAI_URL,
        apiKey: 'test-key',
        authStyle: 'api_key',
        presetKey: 'opencode-go-openai',
      });
      assert.equal(result.classification, 'unsupported');
      assert.equal(fetchCalls, 0, 'fetch must not be called for catalog_only presets');
    } finally {
      global.fetch = original;
    }
  });
});
