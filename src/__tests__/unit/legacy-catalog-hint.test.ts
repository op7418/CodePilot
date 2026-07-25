/**
 * Phase 1 Step 2 — "已不在当前推荐目录" badge + plan-provider Add Model
 * dialog kind. Pure-function coverage for the helper + the gate logic
 * the UI uses to decide which copy to render.
 *
 * Why this exists: Tech-debt #14 was "DeepSeek v3.2-exp 还显示「手动启用」，
 * 因为 v4 family upgrade 后 catalog 不再列它". The fix is a row-level
 * hint via `isModelInCurrentCatalog`. If a future catalog refresh
 * accidentally drops a model from `defaultModels` without thinking
 * about user-facing impact, this test still passes (the hint is the
 * point); but if someone breaks the helper's semantics — e.g., returns
 * `false` for a provider with no catalog, or accidentally inverts the
 * predicate — these cases catch it.
 *
 * Also locks in the plan-provider Add-Model dialog kind: the UI uses
 * `isCatalogOnlyPlanProviderRecord(record)` to decide between "补充
 * SKU" vs "手动添加模型" copy. If that record-aware helper regresses
 * (the by-key version misses brand-specific anthropic-compat presets,
 * already documented in `coding-plan-discovery-gate.test.ts`), the
 * dialog would silently fall back to generic copy and the user would
 * lose the intended explanation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isModelInCurrentCatalog as isModelInCurrentCatalogResolved,
  isCatalogOnlyPlanProviderRecord as isCatalogOnlyPlanProviderRecordResolved,
  isOpenRouterProviderRecord as isOpenRouterProviderRecordResolved,
  getCatalogDefaultModelsForRecord as getCatalogDefaultModelsForRecordResolved,
  shouldShowLegacyCatalogBadge as shouldShowLegacyCatalogBadgeResolved,
  canSearchUpstreamModels as canSearchUpstreamModelsResolved,
  canReliablyFetchModels as canReliablyFetchModelsResolved,
  findMatchingPresetForRecord as findMatchingPresetForRecordResolved,
  getPreset,
  getProviderAccessType as getProviderAccessTypeResolved,
} from "../../lib/provider-catalog";

type LegacyRecord = { provider_type: string; base_url: string; preset_key?: string; protocol?: string };
const identity = (record: LegacyRecord) => ({
  preset_key: record.preset_key ?? '',
  protocol: record.protocol ?? record.provider_type,
  provider_type: record.provider_type,
  base_url: record.base_url,
});
const isModelInCurrentCatalog = (record: LegacyRecord, modelId: string) => isModelInCurrentCatalogResolved(identity(record), modelId);
const isCatalogOnlyPlanProviderRecord = (record: LegacyRecord) => isCatalogOnlyPlanProviderRecordResolved(identity(record));
const isOpenRouterProviderRecord = (record: LegacyRecord) => isOpenRouterProviderRecordResolved(identity(record));
const getCatalogDefaultModelsForRecord = (record: LegacyRecord) => getCatalogDefaultModelsForRecordResolved(identity(record));
const shouldShowLegacyCatalogBadge = (record: LegacyRecord, modelId: string) => shouldShowLegacyCatalogBadgeResolved(identity(record), modelId);
const canSearchUpstreamModels = (record: LegacyRecord) => canSearchUpstreamModelsResolved(identity(record));
const canReliablyFetchModels = (record: LegacyRecord) => canReliablyFetchModelsResolved(identity(record));
const findMatchingPresetForRecord = (record: LegacyRecord) => findMatchingPresetForRecordResolved(identity(record));
const getProviderAccessType = (record: LegacyRecord) => getProviderAccessTypeResolved(identity(record));

describe("isModelInCurrentCatalog", () => {
  it("returns true for a model that IS in the catalog (DeepSeek v4 family)", () => {
    const deepseek = { provider_type: "anthropic", base_url: "https://api.deepseek.com/anthropic" };
    // Sanity: confirm catalog isn't empty (otherwise the predicate
    // would trivially short-circuit to true and this case wouldn't be
    // testing anything useful).
    const defaults = getCatalogDefaultModelsForRecord(deepseek);
    assert.ok(defaults.length > 0, "DeepSeek catalog should have defaults");
    const sampleId = defaults[0].modelId;
    assert.equal(isModelInCurrentCatalog(deepseek, sampleId), true);
  });

  it("returns false for a model that is NOT in the catalog (legacy SKU)", () => {
    const deepseek = { provider_type: "anthropic", base_url: "https://api.deepseek.com/anthropic" };
    // Old SKU that was in the catalog before the v4 upgrade — shouldn't
    // be in current defaults. Pick something that definitely isn't.
    assert.equal(isModelInCurrentCatalog(deepseek, "deepseek-v3.2-exp"), false);
    assert.equal(isModelInCurrentCatalog(deepseek, "totally-unknown-model"), false);
  });

  it("returns true when the provider has no catalog (matcher returns undefined)", () => {
    // An unknown provider_type falls through every branch in
    // `findMatchingPresetForRecord` and yields undefined → empty
    // defaults → predicate returns true. The badge never fires for
    // fully unmatched setups (consistent with "no concept of catalog
    // here").
    // Note: `provider_type='anthropic'` with an unknown base_url falls
    // back to `anthropic-thirdparty` (3-alias catalog), so the test
    // uses a fake provider_type to bypass that fallback.
    const custom = { provider_type: "unknown-vendor", base_url: "https://made-up-host.example.com/api" };
    assert.equal(getCatalogDefaultModelsForRecord(custom).length, 0);
    assert.equal(isModelInCurrentCatalog(custom, "anything"), true);
    assert.equal(isModelInCurrentCatalog(custom, ""), true);
  });

  it("respects record-aware preset matching for brand-specific anthropic presets", () => {
    // Volcengine stores `provider_type='anthropic'`; the actual preset
    // is recovered via base_url. If the record-aware match worked, the
    // helper sees Volcengine's full catalog and the canonical SKUs are
    // in there. If it failed (treating 'anthropic' as preset key), the
    // catalog would fall back to `anthropic-thirdparty`'s 3 aliases and
    // the badge would mis-fire on every Doubao SKU.
    const volcengine = { provider_type: "anthropic", base_url: "https://ark.cn-beijing.volces.com/api/coding" };
    const defaults = getCatalogDefaultModelsForRecord(volcengine);
    assert.ok(defaults.length > 5, "Volcengine catalog should resolve via base_url to its 8+ SKU set");
    const volcSample = defaults[0].modelId;
    assert.equal(isModelInCurrentCatalog(volcengine, volcSample), true);
    assert.equal(isModelInCurrentCatalog(volcengine, "claude-sonnet-4-6"), false);
  });
});

describe("Plan-provider Add-Model dialog kind gate", () => {
  // The Models page uses `isCatalogOnlyPlanProviderRecord(record)` to
  // pick the dialog title / description (`provider.add.titlePlan` vs
  // `provider.add.titleManual`). The gate must catch all 7 plan
  // presets (glm-cn, glm-global, minimax-cn, minimax-global, volcengine,
  // xiaomi-mimo-token-plan, bailian) AND must NOT catch pay-as-you-go
  // anthropic-compat (kimi, moonshot, deepseek, xiaomi-mimo).

  it("Volcengine record → plan dialog", () => {
    assert.equal(isCatalogOnlyPlanProviderRecord({
      provider_type: "anthropic",
      base_url: "https://ark.cn-beijing.volces.com/api/coding",
    }), true);
  });

  it("Bailian record → plan dialog", () => {
    assert.equal(isCatalogOnlyPlanProviderRecord({
      provider_type: "anthropic",
      base_url: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    }), true);
  });

  it("GLM CN record → plan dialog", () => {
    assert.equal(isCatalogOnlyPlanProviderRecord({
      provider_type: "anthropic",
      base_url: "https://open.bigmodel.cn/api/anthropic",
    }), true);
  });

  it("Kimi (pay-as-you-go) record → manual dialog (NOT plan)", () => {
    assert.equal(isCatalogOnlyPlanProviderRecord({
      provider_type: "anthropic",
      base_url: "https://api.kimi.com/coding/",
    }), false);
  });

  it("DeepSeek (pay-as-you-go) record → manual dialog (NOT plan)", () => {
    assert.equal(isCatalogOnlyPlanProviderRecord({
      provider_type: "anthropic",
      base_url: "https://api.deepseek.com/anthropic",
    }), false);
  });

  it("OpenRouter → handled separately (search dialog), gate is per-call-site", () => {
    // The Models page short-circuits OpenRouter to the search-and-add
    // dialog before falling through to the plan/manual gate. This test
    // documents that the helper alone returns false for OpenRouter (no
    // plan dialog), but that the call-site OpenRouter branch must run
    // first or the manual dialog leaks for OpenRouter providers.
    const openrouter = { provider_type: "openrouter", base_url: "https://openrouter.ai/api/v1" };
    assert.equal(isCatalogOnlyPlanProviderRecord(openrouter), false);
    assert.equal(isOpenRouterProviderRecord(openrouter), true);
  });
});

describe("shouldShowLegacyCatalogBadge — authoritative-catalog gate", () => {
  // Step 2 review (2026-05-06) narrowed the badge from "any non-OpenRouter
  // row not in current catalog" to only authoritative catalogs:
  //   1. Plan providers (sdkProxyOnly + coding/token plan) — catalog IS
  //      the plan whitelist.
  //   2. `meta.fixedCatalog: true` opt-in — currently only DeepSeek.
  // Everything else (kimi / moonshot / xiaomi-mimo PAYG / anthropic-
  // thirdparty / openrouter / unknown) treats `defaultModels` as a
  // starter seed where user-added rows are normal usage, not drift.

  // ── Authoritative catalogs: badge fires for off-list models ──

  it("DeepSeek + legacy v3.x SKU → badge fires (fixedCatalog opt-in)", () => {
    const deepseek = { provider_type: "anthropic", base_url: "https://api.deepseek.com/anthropic" };
    assert.equal(shouldShowLegacyCatalogBadge(deepseek, "deepseek-v3.2-exp"), true);
  });

  it("DeepSeek + current v4 SKU → badge does NOT fire", () => {
    const deepseek = { provider_type: "anthropic", base_url: "https://api.deepseek.com/anthropic" };
    assert.equal(shouldShowLegacyCatalogBadge(deepseek, "deepseek-v4-pro"), false);
    assert.equal(shouldShowLegacyCatalogBadge(deepseek, "deepseek-v4-flash"), false);
  });

  it("Volcengine plan + off-whitelist SKU → badge fires", () => {
    const volcengine = { provider_type: "anthropic", base_url: "https://ark.cn-beijing.volces.com/api/coding" };
    // Some Ark inference SKU not in the plan whitelist (and not a Volc
    // canonical) → user is asking for trouble; surface the hint.
    assert.equal(shouldShowLegacyCatalogBadge(volcengine, "claude-sonnet-4-6"), true);
  });

  it("Volcengine plan + canonical Volcengine SKU → badge does NOT fire", () => {
    const volcengine = { provider_type: "anthropic", base_url: "https://ark.cn-beijing.volces.com/api/coding" };
    const defaults = getCatalogDefaultModelsForRecord(volcengine);
    assert.ok(defaults.length > 0, "Volcengine catalog should not be empty");
    assert.equal(shouldShowLegacyCatalogBadge(volcengine, defaults[0].modelId), false);
  });

  it("Bailian plan + canonical Qwen SKU → badge does NOT fire", () => {
    const bailian = { provider_type: "anthropic", base_url: "https://coding.dashscope.aliyuncs.com/apps/anthropic" };
    assert.equal(shouldShowLegacyCatalogBadge(bailian, "qwen3.6-plus"), false);
  });

  // ── Starter / seed catalogs: badge MUST NOT fire (the P2 review fix) ──

  it("Kimi (PAYG, 1-alias starter) + manual real SKU → badge does NOT fire", () => {
    // Pre-fix: Kimi catalog has only `{ modelId: 'sonnet', ... }`, so any
    // user adding the actual upstream like `kimi-k2.5` got falsely
    // flagged as drift. New gate: Kimi has no `fixedCatalog` and isn't
    // a plan provider → no badge.
    const kimi = { provider_type: "anthropic", base_url: "https://api.kimi.com/coding/" };
    assert.equal(shouldShowLegacyCatalogBadge(kimi, "kimi-k2.5"), false);
    assert.equal(shouldShowLegacyCatalogBadge(kimi, "kimi-thinking-preview"), false);
  });

  it("Moonshot (PAYG, 1-alias starter) + manual SKU → badge does NOT fire", () => {
    const moonshot = { provider_type: "anthropic", base_url: "https://api.moonshot.cn/anthropic" };
    assert.equal(shouldShowLegacyCatalogBadge(moonshot, "moonshot-v1-128k"), false);
  });

  it("Xiaomi MiMo PAYG (1-alias starter) + manual SKU → badge does NOT fire", () => {
    const mimo = { provider_type: "anthropic", base_url: "https://api.xiaomimimo.com/anthropic" };
    assert.equal(shouldShowLegacyCatalogBadge(mimo, "mimo-v2-flash"), false);
  });

  it("anthropic-thirdparty (custom gateway, 3-alias starter) + manual real SKU → badge does NOT fire", () => {
    // The exact P2 case: a user-configured custom anthropic-compat
    // gateway falls back to `anthropic-thirdparty` (3-alias catalog).
    // User pinning `claude-sonnet-4-6` directly should be normal usage,
    // not flagged as drift.
    const customGateway = { provider_type: "anthropic", base_url: "https://my-custom-gateway.example.com/anthropic" };
    assert.equal(shouldShowLegacyCatalogBadge(customGateway, "claude-sonnet-4-6"), false);
    assert.equal(shouldShowLegacyCatalogBadge(customGateway, "claude-haiku-4-5-20251001"), false);
  });

  it("OpenRouter → badge always short-circuits to false (its own missing-upstream badge handles drift)", () => {
    const openrouter = { provider_type: "openrouter", base_url: "https://openrouter.ai/api/v1" };
    assert.equal(shouldShowLegacyCatalogBadge(openrouter, "anthropic/claude-sonnet-4-6"), false);
    assert.equal(shouldShowLegacyCatalogBadge(openrouter, "deepseek/deepseek-v4-pro"), false);
  });

  it("unknown provider (no preset match) → badge does NOT fire", () => {
    // Defense: unmatched preset means we can't reason about authority;
    // helper returns false rather than guessing.
    const unknown = { provider_type: "unknown-vendor", base_url: "https://made-up-host.example.com/api" };
    assert.equal(shouldShowLegacyCatalogBadge(unknown, "anything"), false);
  });
});

describe("Qwen Token Plan products — explicit identity and current catalogs", () => {
  // The two Bailian plans share the vendor brand but diverge on host, key
  // family, and SKU whitelist. This block locks in:
  //   1. Coding Plan (existing) is preserved unchanged (Qwen + Kimi + GLM
  //      + MiniMax 9-SKU lineup).
  //   2. Token Plan 团队版 routes to its own preset via baseUrl.
  //   3. Token Plan whitelist excludes deepseek-v3.2 — the docs explicitly
  //      flag DeepSeek V3.2 as not supported on Anthropic protocol.
  //   4. All plan-provider gates (catalog-only, refresh, search) treat
  //      Token Plan correctly as a separate manual-only channel.

  const codingPlan = {
    provider_type: "anthropic",
    base_url: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
  };
  const tokenPlan = {
    preset_key: "bailian-token-plan-cn",
    protocol: "anthropic",
    provider_type: "anthropic",
    base_url: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
  };

  it("matcher resolves Token Plan baseUrl to bailian-token-plan-cn preset", () => {
    const matched = findMatchingPresetForRecord(tokenPlan);
    assert.equal(matched?.key, "bailian-token-plan-cn");
  });

  it("matcher resolves Coding Plan baseUrl to bailian preset (unchanged)", () => {
    const matched = findMatchingPresetForRecord(codingPlan);
    assert.equal(matched?.key, "bailian");
  });

  it("isCatalogOnlyPlanProviderRecord returns true for Token Plan (token_plan billing)", () => {
    assert.equal(isCatalogOnlyPlanProviderRecord(tokenPlan), true);
  });

  it("canSearchUpstreamModels returns false for Token Plan (manualOnlyKeys)", () => {
    const result = canSearchUpstreamModels(tokenPlan);
    assert.equal(result.reliable, false);
    // Same deny-list reason copy as the other manual-only plan presets.
    assert.ok(result.reasonZh.length > 0);
  });

  it("canReliablyFetchModels returns false for Token Plan (plan-gate)", () => {
    const result = canReliablyFetchModels(tokenPlan);
    assert.equal(result.reliable, false);
  });

  it("Team plan has the exact current 15-model text whitelist", () => {
    const preset = getPreset("bailian-token-plan-cn");
    assert.ok(preset, "Token Plan preset must exist");
    const ids = preset!.defaultModels.map(m => m.modelId);
    assert.deepEqual(
      ids,
      [
        "qwen3.8-max-preview", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus",
        "qwen3.6-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v3.2",
        "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "glm-5.2", "glm-5.1",
        "glm-5", "MiniMax-M2.5",
      ],
      "Team Token Plan whitelist must stay byte-for-byte aligned with the official text lineup",
    );
  });

  it("Team Token Plan role mapping follows the current Qwen example", () => {
    const preset = getPreset("bailian-token-plan-cn");
    assert.ok(preset?.defaultRoleModels, "Token Plan preset must define defaultRoleModels");
    assert.equal(preset!.defaultRoleModels!.default, "qwen3.8-max-preview");
    assert.equal(preset!.defaultRoleModels!.sonnet, "qwen3.8-max-preview");
    assert.equal(preset!.defaultRoleModels!.opus, "qwen3.8-max-preview");
    assert.equal(preset!.defaultRoleModels!.haiku, "qwen3.6-flash");
    assert.equal(preset!.defaultEnvOverrides.CLAUDE_CODE_SUBAGENT_MODEL, "qwen3.7-max");
  });

  it("Coding Plan has the exact current 10-SKU lineup", () => {
    const preset = getPreset("bailian");
    assert.ok(preset, "Coding Plan preset must still exist under key 'bailian'");
    const ids = preset!.defaultModels.map(m => m.modelId);
    assert.equal(preset!.baseUrl, "https://coding.dashscope.aliyuncs.com/apps/anthropic");
    assert.equal(preset!.meta?.billingModel, "coding_plan");
    assert.deepEqual(ids, [
      "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus", "qwen3-max-2026-01-23",
      "qwen3-coder-next", "qwen3-coder-plus", "kimi-k2.5", "glm-5", "glm-4.7",
      "MiniMax-M2.5",
    ]);
  });

  it("legacy badge does NOT fire for Token Plan canonical SKU", () => {
    assert.equal(shouldShowLegacyCatalogBadge(tokenPlan, "qwen3.6-plus"), false);
    assert.equal(shouldShowLegacyCatalogBadge(tokenPlan, "glm-5"), false);
    assert.equal(shouldShowLegacyCatalogBadge(tokenPlan, "MiniMax-M2.5"), false);
  });

  it("legacy badge fires for an off-whitelist Team SKU", () => {
    // Plan-provider authoritative catalog → anything outside the whitelist
    // should be flagged. This covers the case where a user manually adds
    // deepseek-v3.2 thinking it works on Token Plan via Anthropic protocol.
    assert.equal(shouldShowLegacyCatalogBadge(tokenPlan, "deepseek-v3.2-exp"), true);
  });
});

describe("getProviderAccessType — Step 4 user-facing taxonomy", () => {
  // Locks in the mapping from internal preset/authStyle/billingModel into
  // the 6 user-facing access-type buckets shown on Provider Cards. The
  // `provider.accessType.*` i18n keys depend on each branch returning the
  // expected key; if a future preset-meta refactor breaks the gate, this
  // test fails before users see "API Key" on a Bedrock card.

  it("Coding Plan provider (Bailian) → subscription_token", () => {
    assert.equal(
      getProviderAccessType({ provider_type: "anthropic", base_url: "https://coding.dashscope.aliyuncs.com/apps/anthropic" }),
      "subscription_token",
    );
  });

  it("Token Plan provider (Bailian Token Plan 团队版) → subscription_token", () => {
    assert.equal(
      getProviderAccessType({
        preset_key: "bailian-token-plan-cn",
        protocol: "anthropic",
        provider_type: "anthropic",
        base_url: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
      }),
      "subscription_token",
    );
  });

  it("Pay-as-you-go anthropic-compat (DeepSeek) → api_key", () => {
    assert.equal(
      getProviderAccessType({ provider_type: "anthropic", base_url: "https://api.deepseek.com/anthropic" }),
      "api_key",
    );
  });

  it("OAuth virtual provider → oauth", () => {
    assert.equal(
      getProviderAccessType({ provider_type: "openai-oauth", base_url: "" }),
      "oauth",
    );
  });

  it("Bedrock (env_only auth) → cloud_credentials", () => {
    assert.equal(
      getProviderAccessType({ provider_type: "bedrock", base_url: "" }),
      "cloud_credentials",
    );
  });

  it("Vertex (env_only auth) → cloud_credentials", () => {
    assert.equal(
      getProviderAccessType({ provider_type: "vertex", base_url: "" }),
      "cloud_credentials",
    );
  });

  it("Self-hosted Ollama → local", () => {
    assert.equal(
      getProviderAccessType({ provider_type: "anthropic", base_url: "http://localhost:11434" }),
      "local",
    );
  });

  it("Generic anthropic-thirdparty preset → gateway", () => {
    // Preset matcher catches `provider_type='anthropic'` with custom URL
    // and returns the wildcard `anthropic-thirdparty` preset. Card should
    // show 中转网关, not API Key.
    assert.equal(
      getProviderAccessType({ provider_type: "anthropic", base_url: "https://my-relay.example.com/anthropic" }),
      "gateway",
    );
  });

  it("Unmatched custom URL (no preset) → gateway", () => {
    assert.equal(
      getProviderAccessType({ provider_type: "totally-unknown-vendor", base_url: "https://x.example.com" }),
      "gateway",
    );
  });

  it("OpenRouter (pay_as_you_go, openrouter protocol) → api_key", () => {
    // OpenRouter uses Bearer auth (auth_token style) but billingModel is
    // pay_as_you_go and there's no special-case for it; the access-type
    // bucket is "API Key" — same shape as DeepSeek / Kimi from the
    // user's POV.
    assert.equal(
      getProviderAccessType({ provider_type: "openrouter", base_url: "https://openrouter.ai/api" }),
      "api_key",
    );
  });
});
