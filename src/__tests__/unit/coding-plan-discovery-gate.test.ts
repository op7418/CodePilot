/**
 * Coding Plan / Token Plan discovery gate.
 *
 * Background: vendors that sell access via a SKU whitelist (火山 Coding Plan,
 * 百炼 Coding Plan, GLM CN/Global, MiniMax CN/Global, Xiaomi MiMo Token Plan)
 * also expose a much larger inference catalogue at the same host's
 * `/v1/models`. Probing and writing that list silently surfaces non-plan
 * models on the Models page; users select one and get 4xx + potentially
 * extra billing. Gate trigger: `sdkProxyOnly && billingModel ∈ {coding_plan,
 * token_plan}` — pay-as-you-go anthropic-compat (kimi, moonshot, xiaomi-mimo,
 * deepseek) stays on `experimental` because their full catalogue is the
 * genuine offering.
 *
 * Source of truth: `src/lib/model-discovery.ts:classifyProvider` returns
 * `unsupported` for these presets and `discoverModels` short-circuits on
 * `unsupported` without firing a probe.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProvider, discoverModels } from '../../lib/model-discovery';
import { isCatalogOnlyPlanProvider, isCatalogOnlyPlanProviderRecord as isCatalogOnlyPlanProviderRecordResolved, getPreset } from '../../lib/provider-catalog';

const isCatalogOnlyPlanProviderRecord = (record: { provider_type: string; base_url: string; preset_key?: string }) =>
  isCatalogOnlyPlanProviderRecordResolved({
    preset_key: record.preset_key ?? '',
    protocol: record.provider_type,
    ...record,
  });

describe('classifyProvider — Coding Plan / Token Plan gate', () => {
  // ── Gate-affected presets — should classify as `unsupported` ──

  it('volcengine (coding_plan, sdkProxyOnly) → unsupported', () => {
    const r = classifyProvider({ protocol: 'anthropic', presetKey: 'volcengine' });
    assert.equal(r.classification, 'unsupported');
    assert.match(r.notes, /SKU whitelist|Coding\/Token Plan/i);
  });

  it('bailian (coding_plan, sdkProxyOnly) → unsupported', () => {
    const r = classifyProvider({ protocol: 'anthropic', presetKey: 'bailian' });
    assert.equal(r.classification, 'unsupported');
  });

  it('glm-cn (coding_plan, sdkProxyOnly) → unsupported', () => {
    const r = classifyProvider({ protocol: 'anthropic', presetKey: 'glm-cn' });
    assert.equal(r.classification, 'unsupported');
  });

  it('glm-global (coding_plan, sdkProxyOnly) → unsupported', () => {
    const r = classifyProvider({ protocol: 'anthropic', presetKey: 'glm-global' });
    assert.equal(r.classification, 'unsupported');
  });

  it('minimax-cn (token_plan, sdkProxyOnly) → unsupported', () => {
    const r = classifyProvider({ protocol: 'anthropic', presetKey: 'minimax-cn' });
    assert.equal(r.classification, 'unsupported');
  });

  it('minimax-global (token_plan, sdkProxyOnly) → unsupported', () => {
    const r = classifyProvider({ protocol: 'anthropic', presetKey: 'minimax-global' });
    assert.equal(r.classification, 'unsupported');
  });

  it('xiaomi-mimo-token-plan (token_plan, sdkProxyOnly) → unsupported', () => {
    const r = classifyProvider({ protocol: 'anthropic', presetKey: 'xiaomi-mimo-token-plan' });
    assert.equal(r.classification, 'unsupported');
  });

  // ── Pay-as-you-go anthropic-compat — gate must NOT trigger ──

  it('kimi (pay_as_you_go, sdkProxyOnly) → experimental, NOT gated', () => {
    const r = classifyProvider({ protocol: 'anthropic', presetKey: 'kimi' });
    assert.equal(r.classification, 'experimental');
    // Sanity: not the Coding Plan note
    assert.doesNotMatch(r.notes, /SKU whitelist/i);
  });

  it('moonshot (pay_as_you_go, sdkProxyOnly) → experimental', () => {
    const r = classifyProvider({ protocol: 'anthropic', presetKey: 'moonshot' });
    assert.equal(r.classification, 'experimental');
  });

  it('xiaomi-mimo (pay_as_you_go, sdkProxyOnly) → experimental', () => {
    const r = classifyProvider({ protocol: 'anthropic', presetKey: 'xiaomi-mimo' });
    assert.equal(r.classification, 'experimental');
  });

  it('deepseek (pay_as_you_go, sdkProxyOnly) → experimental', () => {
    // DeepSeek is sdkProxyOnly + fixed lineup, but its billingModel is
    // pay_as_you_go (not a subscription), so the Coding/Token Plan gate
    // does not catch it. Catalog refresh handles model accuracy
    // separately — the gate only governs probe-and-write behavior.
    const r = classifyProvider({ protocol: 'anthropic', presetKey: 'deepseek' });
    assert.equal(r.classification, 'experimental');
  });

  // ── Other classifications must remain unaffected ──

  it('openrouter is now gated by its own rule (not the Coding/Token Plan gate)', () => {
    // OpenRouter has its own dedicated `unsupported` branch in
    // classifyProvider — same `unsupported` classification but a different
    // note ("OpenRouter — full /v1/models materialization is no longer the
    // auto-discover path"). Used to be `api` before the OpenRouter
    // search-and-add round; the gate is separate from the Coding/Token
    // Plan one because the underlying problem is different (volume vs
    // SKU whitelist), even though the answer happens to be the same.
    const r = classifyProvider({ protocol: 'openrouter', presetKey: 'openrouter' });
    assert.equal(r.classification, 'unsupported');
    assert.match(r.notes, /OpenRouter/);
    // Sanity check: not the Coding/Token Plan note
    assert.doesNotMatch(r.notes, /SKU whitelist/i);
  });

  it('anthropic-official (pay_as_you_go) stays experimental', () => {
    const r = classifyProvider({ protocol: 'anthropic', presetKey: 'anthropic-official' });
    assert.equal(r.classification, 'experimental');
  });

  it('OAuth / env-driven entries still return early as unsupported', () => {
    // Pre-existing unsupported branches must not regress.
    const oauth = classifyProvider({ protocol: 'anthropic', presetKey: 'openai-oauth' });
    assert.equal(oauth.classification, 'unsupported');

    const env = classifyProvider({ protocol: 'anthropic', presetKey: 'claude-code-env' });
    assert.equal(env.classification, 'unsupported');
  });
});

describe('isCatalogOnlyPlanProvider — single source of truth helper', () => {
  // Same condition as the discovery gate, but exposed for UI sites
  // (ProviderManager Add-Service success path; ModelsSection
  // isSyncableProvider). Tests here lock the contract so a future
  // refactor can't make the gate and the UI drift apart.

  for (const key of [
    'volcengine',
    'bailian',
    'qwen-token-plan-personal-cn',
    'bailian-token-plan-cn',
    'glm-cn',
    'glm-global',
    'minimax-cn',
    'minimax-global',
    'xiaomi-mimo-token-plan',
  ]) {
    it(`${key} → true (gated)`, () => {
      assert.equal(isCatalogOnlyPlanProvider(key), true);
    });
  }

  for (const key of ['kimi', 'moonshot', 'xiaomi-mimo', 'deepseek']) {
    it(`${key} (pay_as_you_go) → false`, () => {
      assert.equal(isCatalogOnlyPlanProvider(key), false);
    });
  }

  it('openrouter → false (own tech-debt path, not gated)', () => {
    assert.equal(isCatalogOnlyPlanProvider('openrouter'), false);
  });

  it('null / undefined / empty / unknown → false', () => {
    assert.equal(isCatalogOnlyPlanProvider(null), false);
    assert.equal(isCatalogOnlyPlanProvider(undefined), false);
    assert.equal(isCatalogOnlyPlanProvider(''), false);
    assert.equal(isCatalogOnlyPlanProvider('not-a-real-preset-key'), false);
  });
});

describe('isCatalogOnlyPlanProviderRecord — UI-safe record-aware check', () => {
  // Regression for the bug where the by-key helper silently missed every
  // plan provider in the UI: brand-specific anthropic-compat presets
  // (Volcengine, Bailian, GLM, MiniMax, …) save `provider_type='anthropic'`,
  // not the preset key. Without going through `findMatchingPresetForRecord`
  // the gate is effectively a no-op for ProviderManager + ModelsSection.

  for (const key of [
    'volcengine',
    'bailian',
    'qwen-token-plan-personal-cn',
    'bailian-token-plan-cn',
    'glm-cn',
    'glm-global',
    'minimax-cn',
    'minimax-global',
    'xiaomi-mimo-token-plan',
  ]) {
    it(`{ provider_type: 'anthropic', base_url: ${key}.baseUrl } → true`, () => {
      const preset = getPreset(key);
      assert.ok(preset, `preset ${key} must exist for this test to be meaningful`);
      // This is the shape every brand-specific anthropic-compat preset
      // gets saved with — the matcher must recover the real preset via
      // base_url, not provider_type.
      assert.equal(
        isCatalogOnlyPlanProviderRecord({
          provider_type: 'anthropic',
          base_url: preset.baseUrl,
          preset_key: preset.key,
        }),
        true,
      );
    });
  }

  it('Custom anthropic-thirdparty (provider_type=anthropic, custom base_url) → false', () => {
    // No matching preset by base_url → falls back to anthropic-thirdparty,
    // which is pay_as_you_go, so gate must NOT trigger.
    assert.equal(
      isCatalogOnlyPlanProviderRecord({
        provider_type: 'anthropic',
        base_url: 'https://relay.example.com/anthropic',
      }),
      false,
    );
  });

  it('OpenRouter record → false (own tech-debt path)', () => {
    assert.equal(
      isCatalogOnlyPlanProviderRecord({ provider_type: 'openrouter', base_url: 'https://openrouter.ai/api' }),
      false,
    );
  });

  it('Empty / nonsense record → false', () => {
    assert.equal(isCatalogOnlyPlanProviderRecord({ provider_type: '', base_url: '' }), false);
    assert.equal(
      isCatalogOnlyPlanProviderRecord({ provider_type: 'whatever', base_url: 'https://nope.example.com' }),
      false,
    );
  });
});

describe('discoverModels — gate prevents network probe', () => {
  // Stub fetch so we can detect *any* network call. The gate must keep us
  // from ever reaching the fetch layer for these vendors.
  it('volcengine never fires a probe (no fetch call)', async () => {
    let fetchCalls = 0;
    const original = global.fetch;
    global.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('fetch should not be called for gated preset');
    }) as unknown as typeof fetch;

    try {
      const result = await discoverModels({
        protocol: 'anthropic',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
        apiKey: 'test-key',
        authStyle: 'auth_token',
        presetKey: 'volcengine',
      });
      assert.equal(result.classification, 'unsupported');
      assert.equal(result.ok, undefined);
      assert.equal(fetchCalls, 0, 'fetch must not be called for Coding Plan presets');
    } finally {
      global.fetch = original;
    }
  });
});
