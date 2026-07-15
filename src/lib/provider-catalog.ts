/**
 * Provider Catalog — vendor presets, protocol definitions, and default model catalogs.
 *
 * This is the single source of truth for:
 * - Which protocol a vendor uses (anthropic, openai-compatible, bedrock, vertex, etc.)
 * - Default env overrides each vendor needs for Claude Code SDK
 * - Default model catalogs (role → upstream model id mapping)
 * - Auth key injection style (ANTHROPIC_API_KEY vs ANTHROPIC_AUTH_TOKEN)
 * - Provider meta info (API key URLs, docs, billing model, notes)
 */

import { z } from 'zod';

// ── Protocol types ──────────────────────────────────────────────

/**
 * Protocol describes how to talk to a provider's API.
 * This determines which SDK client to instantiate and which env vars to set.
 */
export type Protocol =
  | 'anthropic'           // Native Anthropic API (official + third-party compatible)
  | 'openai-compatible'   // OpenAI-compatible REST API
  | 'openrouter'          // OpenRouter (OpenAI-compatible with extra headers)
  | 'bedrock'             // AWS Bedrock (env-based auth, CLAUDE_CODE_USE_BEDROCK)
  | 'vertex'              // Google Vertex AI (env-based auth, CLAUDE_CODE_USE_VERTEX)
  | 'google'              // Google Generative AI (Gemini text)
  | 'gemini-image'        // Google Gemini image generation
  | 'openai-image';       // OpenAI GPT Image generation

/**
 * How the provider authenticates: which env var to inject the API key into.
 */
export type AuthStyle =
  | 'api_key'             // ANTHROPIC_API_KEY
  | 'auth_token'          // ANTHROPIC_AUTH_TOKEN
  | 'env_only'            // No API key; auth via extra env (bedrock/vertex)
  | 'custom_header';      // API key in custom header (future)

/**
 * Model role — semantic purpose, maps to ANTHROPIC_DEFAULT_*, ANTHROPIC_MODEL, etc.
 */
export type ModelRole = 'default' | 'reasoning' | 'small' | 'haiku' | 'sonnet' | 'opus';

/**
 * A model entry in the catalog.
 */
export interface CatalogModel {
  /** Internal/UI model ID (what the user sees and what we pass to Claude Code) */
  modelId: string;
  /** Actual upstream model ID (what gets sent to the API) — if different from modelId */
  upstreamModelId?: string;
  /** Human-readable display name */
  displayName: string;
  /** Role mapping for Claude Code env vars */
  role?: ModelRole;
  /** Capabilities */
  capabilities?: {
    reasoning?: boolean;
    toolUse?: boolean;
    vision?: boolean;
    pdf?: boolean;
    contextWindow?: number;
    /** Whether this model supports effort levels (reasoning effort) */
    supportsEffort?: boolean;
    /** Allowed effort levels for this model (Opus 4.7 adds 'xhigh') */
    supportedEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[];
    /** Whether this model supports adaptive thinking */
    supportsAdaptiveThinking?: boolean;
  };
}

/**
 * Role models map — maps semantic roles to model IDs.
 * Used to generate ANTHROPIC_MODEL, ANTHROPIC_REASONING_MODEL, ANTHROPIC_DEFAULT_* env vars.
 */
export interface RoleModels {
  default?: string;
  reasoning?: string;
  small?: string;
  haiku?: string;
  sonnet?: string;
  opus?: string;
}

// ── Vendor preset definition ────────────────────────────────────

export interface VendorPreset {
  /** Unique preset key (used as lookup key) */
  key: string;
  /** Human-readable name */
  name: string;
  /** Description (English) */
  description: string;
  /** Description (Chinese) */
  descriptionZh: string;
  /** Wire protocol */
  protocol: Protocol;
  /** Auth style */
  authStyle: AuthStyle;
  /** Default base URL (empty for bedrock/vertex) */
  baseUrl: string;
  /** Default env overrides for Claude Code SDK */
  defaultEnvOverrides: Record<string, string>;
  /** Default model catalog */
  defaultModels: CatalogModel[];
  /** Default role models mapping */
  defaultRoleModels?: RoleModels;
  /** Which fields the quick-connect form shows */
  fields: ('name' | 'api_key' | 'base_url' | 'env_overrides' | 'model_names' | 'model_mapping')[];
  /** Category: chat (default) or media */
  category?: 'chat' | 'media';
  /** Icon key for UI */
  iconKey: string;
  /**
   * True for providers that only support the Claude Code SDK wire protocol
   * (e.g. Kimi /coding/, GLM /api/anthropic).
   * These providers cannot be used with the Vercel AI SDK text generation path
   * (streamText / generateText) because they don't implement the standard
   * Anthropic Messages API.
   */
  sdkProxyOnly?: boolean;
  /** Provider meta info for user guidance and error recovery */
  meta?: {
    /** URL where user can obtain/manage API key */
    apiKeyUrl?: string;
    /** Official configuration documentation URL */
    docsUrl?: string;
    /** Pricing page URL */
    pricingUrl?: string;
    /** Service status page URL */
    statusPageUrl?: string;
    /** Billing model */
    billingModel: 'pay_as_you_go' | 'coding_plan' | 'token_plan' | 'free' | 'self_hosted';
    /** Notes/warnings shown during provider configuration */
    notes?: string[];
    /**
     * Whether this anthropic-compat preset has been verified end-to-end:
     * tool calling, thinking, model aliases, and `/v1/messages` quirks all
     * confirmed to work. Drives the `claude_code_verified` runtime compat
     * tier (info tone, "Claude Code 兼容") instead of the default
     * `claude_code_experimental` (warning tone, "Claude Code 实验").
     * Only meaningful for `protocol: 'anthropic'` presets.
     */
    claudeCodeVerified?: boolean;
    /**
     * Whether `defaultModels` is the authoritative lineup for this preset
     * — i.e. anything outside it counts as drift / off-list, not as a
     * legitimate user customization. Drives the "已不在当前推荐目录"
     * badge in the Models page.
     *
     * Plan providers (`sdkProxyOnly && billingModel ∈ {coding_plan,
     * token_plan}`) are inherently authoritative — the plan whitelist IS
     * the truth — so they don't need this flag set explicitly; the badge
     * gate ORs with `isCatalogOnlyPlanProviderRecord`.
     *
     * Set this only on pay-as-you-go presets where we deliberately curate
     * the lineup (e.g. DeepSeek's v4 family) and want catalog drift to
     * surface to the user. Do NOT set on starter / seed catalogs (Kimi /
     * Moonshot / Xiaomi MiMo PAYG / anthropic-thirdparty / OpenRouter)
     * where defaultModels is just a 1-3 alias bootstrap and user-added
     * SKUs are normal usage, not drift.
     */
    fixedCatalog?: boolean;
    /**
     * Model discovery posture. `'catalog_only'` = the shipped `defaultModels`
     * lineup is the ONLY truth: no `/v1/models` refresh, no search-and-add, and
     * `classifyProvider` returns `unsupported`. Used for subscription gateways
     * whose model endpoint either needs a key, mixes wire protocols, or returns
     * a superset of the plan whitelist (ClinePass, OpenCode Go). Distinct from
     * the `sdkProxyOnly && coding_plan` plan gate: those keep search-and-add ON
     * (their `/v1/models` is a clean per-vendor list), this turns it OFF.
     * Phase 2 may add a `'filtered_models_endpoint'` mode with allowlist/prefix.
     */
    modelDiscoveryMode?: 'catalog_only';
  };
}

// ── Zod Schema for preset validation ──────────────────────────────

const PresetMetaSchema = z.object({
  apiKeyUrl: z.string().optional(),
  docsUrl: z.string().optional(),
  pricingUrl: z.string().optional(),
  statusPageUrl: z.string().optional(),
  billingModel: z.enum(['pay_as_you_go', 'coding_plan', 'token_plan', 'free', 'self_hosted']),
  notes: z.array(z.string()).optional(),
  claudeCodeVerified: z.boolean().optional(),
  fixedCatalog: z.boolean().optional(),
  modelDiscoveryMode: z.enum(['catalog_only']).optional(),
});

export const PresetSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  descriptionZh: z.string(),
  protocol: z.enum(['anthropic', 'openai-compatible', 'openrouter', 'bedrock', 'vertex', 'google', 'gemini-image', 'openai-image']),
  authStyle: z.enum(['api_key', 'auth_token', 'env_only', 'custom_header']),
  baseUrl: z.string(),
  defaultEnvOverrides: z.record(z.string(), z.string()),
  defaultModels: z.array(z.object({
    modelId: z.string(),
    upstreamModelId: z.string().optional(),
    displayName: z.string(),
    role: z.enum(['default', 'reasoning', 'small', 'haiku', 'sonnet', 'opus']).optional(),
    capabilities: z.object({
      reasoning: z.boolean().optional(),
      toolUse: z.boolean().optional(),
      vision: z.boolean().optional(),
      pdf: z.boolean().optional(),
      contextWindow: z.number().optional(),
    }).optional(),
  })),
  fields: z.array(z.string()),
  iconKey: z.string(),
  sdkProxyOnly: z.boolean().optional(),
  category: z.enum(['chat', 'media']).optional(),
  defaultRoleModels: z.record(z.string(), z.string()).optional(),
  meta: PresetMetaSchema.optional(),
}).refine(data => {
  // auth_token presets must NOT have ANTHROPIC_API_KEY in envOverrides
  // (auth_token injection already clears API_KEY; envOverrides entry would be ignored by AUTH_ENV_KEYS skip)
  if (data.authStyle === 'auth_token' && data.defaultEnvOverrides.ANTHROPIC_API_KEY !== undefined) {
    return false;
  }
  // api_key presets must NOT have ANTHROPIC_AUTH_TOKEN in envOverrides
  if (data.authStyle === 'api_key' && data.defaultEnvOverrides.ANTHROPIC_AUTH_TOKEN !== undefined) {
    return false;
  }
  // Note: auth_token presets MAY have ANTHROPIC_AUTH_TOKEN with a fixed pseudo-value (e.g. Ollama uses 'ollama').
  // This is allowed because it's a preset default, not user input — though the AUTH_ENV_KEYS skip in
  // toClaudeCodeEnv() means it will only take effect if the user doesn't provide their own key.
  return true;
}, { message: 'authStyle conflicts with auth-related keys in defaultEnvOverrides' });

// ── Default Anthropic models ────────────────────────────────────

// Shared Anthropic catalog used by non-first-party providers
// (anthropic-thirdparty, openrouter, ollama, litellm) and the generic
// protocol fallback. Intentionally alias-only: third-party providers
// often require their own upstream model names (OpenRouter goes through
// the OpenAI SDK, LiteLLM expects user-configured names, etc.), and
// forcing claude-opus-4-7 here would break those pass-through paths.
// First-party Anthropic has its own catalog below.
const ANTHROPIC_DEFAULT_MODELS: CatalogModel[] = [
  {
    modelId: 'sonnet',
    displayName: 'Sonnet 4.6',
    role: 'sonnet',
    capabilities: {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'max'],
      supportsAdaptiveThinking: true,
    },
  },
  {
    modelId: 'opus',
    displayName: 'Opus 4.7',
    role: 'opus',
    capabilities: {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsAdaptiveThinking: true,
    },
  },
  {
    modelId: 'haiku',
    displayName: 'Haiku 4.5',
    role: 'haiku',
    capabilities: {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
    },
  },
];

// Phase 5b round-8 fix (2026-05-18) — OpenRouter's Anthropic skin
// (https://openrouter.ai/api) rejects the bare aliases `sonnet` /
// `opus` / `haiku` with "is not a valid model ID". Real-credential
// smoke confirmed that switching `haiku` to the upstream slug
// `anthropic/claude-haiku-4.5` returns the prompted string. The
// version-tagged slugs follow OpenRouter's documented naming
// convention (verified for haiku in smoke; sonnet/opus follow the
// same `<vendor>/claude-<role>-<major.minor>` shape — if a version
// is unavailable on OpenRouter, the API returns the same
// "not a valid model ID" error pointing at the canonical name, so
// users can fix locally via the model picker).
//
// First-party Anthropic uses a different upstream slug shape (dash
// separators, e.g. `claude-haiku-4-5-20251001`) so it stays in its
// own ANTHROPIC_FIRST_PARTY_MODELS catalog below. OpenRouter is the
// only preset that re-uses the alias trio but with its own
// upstream surface, so we keep the array OpenRouter-specific.
const OPENROUTER_ANTHROPIC_MODELS: CatalogModel[] = [
  {
    modelId: 'sonnet',
    upstreamModelId: 'anthropic/claude-sonnet-4.6',
    displayName: 'Sonnet 4.6',
    role: 'sonnet',
    capabilities: {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'max'],
      supportsAdaptiveThinking: true,
    },
  },
  {
    modelId: 'opus',
    upstreamModelId: 'anthropic/claude-opus-4.7',
    displayName: 'Opus 4.7',
    role: 'opus',
    capabilities: {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsAdaptiveThinking: true,
    },
  },
  {
    modelId: 'opus-4-8',
    // OpenRouter slug confirmed by Codex (2026-05-29) — explicit fixture,
    // not inferred from the 4.7 naming pattern.
    upstreamModelId: 'anthropic/claude-opus-4.8',
    displayName: 'Opus 4.8',
    // No `role` — explicit pick; `opus` alias stays 4.7 (Phase A safe default).
    capabilities: {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsAdaptiveThinking: true,
    },
  },
  {
    modelId: 'haiku',
    upstreamModelId: 'anthropic/claude-haiku-4.5',
    displayName: 'Haiku 4.5',
    role: 'haiku',
    capabilities: {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
    },
  },
];

// First-party Anthropic API (anthropic-official preset) — pins opus to
// the explicit upstream ID so resolved.upstreamModel carries a concrete
// model name downstream. This unblocks the Opus 4.7 sanitizer regex
// in claude-model-options.ts (which matches upstream IDs, not aliases)
// and guarantees the native path doesn't forward the bare "opus"
// alias to @ai-sdk/anthropic.
const ANTHROPIC_FIRST_PARTY_MODELS: CatalogModel[] = [
  {
    modelId: 'sonnet',
    upstreamModelId: 'claude-sonnet-4-6',
    displayName: 'Sonnet 4.6',
    role: 'sonnet',
    capabilities: {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'max'],
      supportsAdaptiveThinking: true,
    },
  },
  {
    modelId: 'opus',
    upstreamModelId: 'claude-opus-4-7',
    displayName: 'Opus 4.7',
    role: 'opus',
    capabilities: {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsAdaptiveThinking: true,
    },
  },
  {
    modelId: 'opus-4-8',
    upstreamModelId: 'claude-opus-4-8',
    displayName: 'Opus 4.8',
    // No `role`: Opus 4.8 is an explicit pick, NOT the default `opus` role
    // target. roleModels.opus / ANTHROPIC_DEFAULT_OPUS_MODEL stays
    // claude-opus-4-7 until the user opts to switch (Phase A safe default).
    capabilities: {
      supportsEffort: true,
      // Same levels as 4.7; the effort DEFAULT (high) is applied by the
      // Claude Code CLI/SDK when effort is unset, not here.
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsAdaptiveThinking: true,
    },
  },
  {
    modelId: 'fable-5',
    upstreamModelId: 'claude-fable-5',
    displayName: 'Fable 5',
    // No `role`: Fable 5 (2026-06 launch, the tier above Opus) is an
    // explicit pick, same policy as Opus 4.8 — no silent default switch.
    // Request contract = Opus 4.7/4.8 family (adaptive thinking only,
    // 1M context) with one extra guard handled in claude-model-options.ts
    // (explicit thinking:disabled returns 400 — omitted instead).
    capabilities: {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsAdaptiveThinking: true,
    },
  },
  {
    modelId: 'haiku',
    upstreamModelId: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku 4.5',
    role: 'haiku',
    capabilities: {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
    },
  },
];

// Single source of truth for the built-in "Claude Code" (env) provider's
// model list — same aliases + concrete upstream IDs as the first-party
// catalog, minus `role` (env mode has no role-mapping semantics).
//
// Consumers must DERIVE from this export, never re-hardcode (Codex review
// P1, 2026-06-10: three hand-maintained copies had drifted — the model
// picker's env group and the client fallback were missing opus-4-8 AND
// fable-5 while the resolver had both):
//   - provider-resolver.ts            envModels (alias → upstream resolution)
//   - app/api/providers/models/route.ts  DEFAULT_MODELS + ENV_ALIAS_TO_UPSTREAM
//   - hooks/useProviderModels.ts      DEFAULT_MODEL_OPTIONS (client fallback)
export const ENV_CLAUDE_CODE_MODELS: CatalogModel[] = ANTHROPIC_FIRST_PARTY_MODELS.map(
  ({ role: _role, ...model }) => model,
);

// Bedrock / Vertex: per Claude Code docs, the `opus` alias still resolves
// to Opus 4.6 on these platforms (unlike first-party Anthropic). Users who
// want Opus 4.7 on Bedrock/Vertex must pass the full model name or set
// ANTHROPIC_DEFAULT_OPUS_MODEL explicitly. We surface this in the label to
// avoid promising 4.7 capabilities (xhigh) on an alias that actually runs 4.6.
const BEDROCK_VERTEX_DEFAULT_MODELS: CatalogModel[] = [
  {
    modelId: 'sonnet',
    displayName: 'Sonnet 4.6',
    role: 'sonnet',
    capabilities: {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'max'],
      supportsAdaptiveThinking: true,
    },
  },
  {
    modelId: 'opus',
    displayName: 'Opus 4.6 (alias)',
    role: 'opus',
    capabilities: {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'max'],
      supportsAdaptiveThinking: true,
    },
  },
  {
    modelId: 'haiku',
    displayName: 'Haiku 4.5',
    role: 'haiku',
    capabilities: {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
    },
  },
];

// ── Vendor presets ──────────────────────────────────────────────

export const VENDOR_PRESETS: VendorPreset[] = [
  // ── Official Anthropic ──
  {
    key: 'anthropic-official',
    name: 'Anthropic',
    description: 'Official Anthropic API',
    descriptionZh: 'Anthropic 官方 API',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: 'https://api.anthropic.com',
    defaultEnvOverrides: {},
    defaultModels: ANTHROPIC_FIRST_PARTY_MODELS,
    fields: ['api_key'],
    iconKey: 'anthropic',
    meta: {
      apiKeyUrl: 'https://platform.claude.com/settings/keys',
      docsUrl: 'https://platform.claude.com/docs/en/api/overview',
      billingModel: 'pay_as_you_go',
    },
  },

  // ── Anthropic Third-party (generic) ──
  {
    key: 'anthropic-thirdparty',
    name: 'Anthropic Third-party API',
    description: 'Anthropic-compatible API — provide URL and Key',
    descriptionZh: 'Anthropic 兼容第三方 API — 填写地址和密钥',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: '',
    defaultEnvOverrides: { ANTHROPIC_API_KEY: '' },
    defaultModels: ANTHROPIC_DEFAULT_MODELS,
    fields: ['name', 'api_key', 'base_url', 'model_mapping', 'env_overrides'],
    iconKey: 'anthropic',
  },

  // ── OpenAI-Compatible Third-party (generic) ──
  // Generic OpenAI-compatible chat gateway: user supplies base_url + key +
  // model. Routes through @ai-sdk/openai's chat-completions wire, so it's
  // reachable from CodePilot Runtime and Codex Runtime but NOT Claude Code
  // (Anthropic wire). runtime-compat maps protocol 'openai-compatible' to the
  // `codepilot_only` tier; getProviderCompat reaches that tier only when this
  // preset is matched (see findMatchingPresetForRecord / findMatchingPreset).
  // NOT sdkProxyOnly (that flag means "Claude Code subprocess only" — the
  // opposite of this). NOT claudeCodeVerified (only meaningful for anthropic).
  // No default model catalog — the user names their own model; never fabricate
  // an official-OpenAI lineup for an arbitrary third-party gateway.
  {
    key: 'openai-compatible',
    name: 'OpenAI-Compatible API',
    description: 'OpenAI-compatible chat API — provide URL, key and model (CodePilot / Codex runtimes)',
    descriptionZh: 'OpenAI 兼容第三方 API — 填写地址、密钥和模型（用于 CodePilot / Codex 运行时）',
    protocol: 'openai-compatible',
    authStyle: 'api_key',
    baseUrl: '',
    defaultEnvOverrides: {},
    defaultModels: [],
    fields: ['name', 'api_key', 'base_url', 'model_names'],
    iconKey: 'openai',
    meta: {
      billingModel: 'pay_as_you_go',
    },
  },

  // ── OpenRouter ──
  {
    key: 'openrouter',
    name: 'OpenRouter',
    description: 'Use OpenRouter to access multiple models',
    descriptionZh: '通过 OpenRouter 访问多种模型',
    protocol: 'openrouter',
    authStyle: 'auth_token',
    baseUrl: 'https://openrouter.ai/api',
    defaultEnvOverrides: {},
    // Round 8 (2026-05-18) — was ANTHROPIC_DEFAULT_MODELS (bare
    // sonnet/opus/haiku aliases). OpenRouter rejected the aliases
    // with "is not a valid model ID"; we now ship the fully-
    // qualified `anthropic/claude-<role>-<version>` slugs via
    // upstreamModelId. The resolver reads catalogEntry.upstreamModelId
    // (provider-resolver.ts:424) so existing role-based pickers keep
    // working with the short aliases on the UI side.
    defaultModels: OPENROUTER_ANTHROPIC_MODELS,
    fields: ['api_key'],
    iconKey: 'openrouter',
    meta: {
      apiKeyUrl: 'https://openrouter.ai/workspaces/default/keys',
      docsUrl: 'https://openrouter.ai/docs/guides/coding-agents/claude-code-integration',
      billingModel: 'pay_as_you_go',
    },
  },

  // ── Zhipu GLM (China) ──
  {
    key: 'glm-cn',
    name: 'GLM (CN)',
    description: 'Zhipu GLM Code Plan — China region',
    descriptionZh: '智谱 GLM 编程套餐 — 中国区',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    defaultEnvOverrides: { API_TIMEOUT_MS: '3000000', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5-turbo', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.1' },
    defaultModels: [
      { modelId: 'sonnet', upstreamModelId: 'sonnet', displayName: 'GLM-5-Turbo', role: 'sonnet' },
      { modelId: 'opus', upstreamModelId: 'opus', displayName: 'GLM-5.1', role: 'opus' },
      { modelId: 'haiku', upstreamModelId: 'haiku', displayName: 'GLM-4.5-Air', role: 'haiku' },
    ],
    fields: ['api_key'],
    iconKey: 'zhipu',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
      docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/tool/claude',
      billingModel: 'coding_plan',
      notes: ['高峰时段（14:00-18:00 UTC+8）消耗 3 倍积分'],
      claudeCodeVerified: true,
    },
  },

  // ── Zhipu GLM (Global) ──
  {
    key: 'glm-global',
    name: 'GLM (Global)',
    description: 'Zhipu GLM Code Plan — Global region',
    descriptionZh: '智谱 GLM 编程套餐 — 国际区',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.z.ai/api/anthropic',
    defaultEnvOverrides: { API_TIMEOUT_MS: '3000000', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5-turbo', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.1' },
    defaultModels: [
      { modelId: 'sonnet', upstreamModelId: 'sonnet', displayName: 'GLM-5-Turbo', role: 'sonnet' },
      { modelId: 'opus', upstreamModelId: 'opus', displayName: 'GLM-5.1', role: 'opus' },
      { modelId: 'haiku', upstreamModelId: 'haiku', displayName: 'GLM-4.5-Air', role: 'haiku' },
    ],
    fields: ['api_key'],
    iconKey: 'zhipu',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
      docsUrl: 'https://docs.z.ai/devpack/tool/claude',
      billingModel: 'coding_plan',
      notes: ['高峰时段（14:00-18:00 UTC+8）消耗 3 倍积分'],
      claudeCodeVerified: true,
    },
  },

  // ── Kimi ──
  {
    key: 'kimi',
    name: 'Kimi Coding Plan',
    description: 'Kimi Coding Plan API',
    descriptionZh: 'Kimi 编程计划 API',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: 'https://api.kimi.com/coding/',
    defaultEnvOverrides: { ENABLE_TOOL_SEARCH: 'false' },
    defaultModels: [
      { modelId: 'sonnet', displayName: 'Kimi K2.5', role: 'default' },
    ],
    fields: ['api_key'],
    iconKey: 'kimi',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://www.kimi.com/code/console',
      docsUrl: 'https://www.kimi.com/code/docs/more/third-party-agents.html',
      billingModel: 'pay_as_you_go',
      notes: [],
      claudeCodeVerified: true,
    },
  },

  // ── Moonshot ──
  {
    key: 'moonshot',
    name: 'Moonshot',
    description: 'Moonshot AI API',
    descriptionZh: '月之暗面 API',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    defaultEnvOverrides: { ENABLE_TOOL_SEARCH: 'false' },
    defaultModels: [
      { modelId: 'sonnet', displayName: 'Kimi K2.5', role: 'default' },
    ],
    fields: ['api_key'],
    iconKey: 'moonshot',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
      docsUrl: 'https://platform.moonshot.cn/docs/guide/agent-support',
      billingModel: 'pay_as_you_go',
      notes: ['建议设置每日消费上限，防止 agentic 循环快速消耗 token'],
      claudeCodeVerified: true,
    },
  },

  // ── MiniMax (China) ──
  {
    key: 'minimax-cn',
    name: 'MiniMax (CN)',
    description: 'MiniMax Code Plan — China region',
    descriptionZh: 'MiniMax 编程套餐 — 中国区',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    defaultEnvOverrides: {
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    defaultModels: [
      { modelId: 'sonnet', upstreamModelId: 'MiniMax-M2.7', displayName: 'MiniMax-M2.7', role: 'default' },
    ],
    defaultRoleModels: {
      default: 'MiniMax-M2.7',
      sonnet: 'MiniMax-M2.7',
      opus: 'MiniMax-M2.7',
      haiku: 'MiniMax-M2.7',
    },
    fields: ['api_key'],
    iconKey: 'minimax',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.minimaxi.com/user-center/payment/token-plan',
      docsUrl: 'https://platform.minimaxi.com/docs/token-plan/claude-code',
      billingModel: 'token_plan',
      claudeCodeVerified: true,
    },
  },

  // ── MiniMax (Global) ──
  {
    key: 'minimax-global',
    name: 'MiniMax (Global)',
    description: 'MiniMax Code Plan — Global region',
    descriptionZh: 'MiniMax 编程套餐 — 国际区',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.minimax.io/anthropic',
    defaultEnvOverrides: {
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    defaultModels: [
      { modelId: 'sonnet', upstreamModelId: 'MiniMax-M2.7', displayName: 'MiniMax-M2.7', role: 'default' },
    ],
    defaultRoleModels: {
      default: 'MiniMax-M2.7',
      sonnet: 'MiniMax-M2.7',
      opus: 'MiniMax-M2.7',
      haiku: 'MiniMax-M2.7',
    },
    fields: ['api_key'],
    iconKey: 'minimax',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.minimax.io/user-center/payment/token-plan',
      docsUrl: 'https://platform.minimax.io/docs/token-plan/opencode',
      billingModel: 'token_plan',
      claudeCodeVerified: true,
    },
  },

  // ── Volcengine Ark ──
  {
    key: 'volcengine',
    name: 'Volcengine Ark',
    description: 'Volcengine Ark Coding Plan — Doubao, GLM, DeepSeek, Kimi',
    descriptionZh: '字节火山方舟 Coding Plan — 豆包、GLM、DeepSeek、Kimi',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    defaultEnvOverrides: {},
    // Volcengine Ark Coding Plan whitelist. Volcengine's docs explicitly
    // separate "Coding Plan Model Name" (what users put in ANTHROPIC_MODEL)
    // from the much larger online-inference Model ID space served by
    // Ark — never auto-probe that endpoint for a Coding Plan provider
    // (handled by the Coding/Token Plan gate in model-discovery.ts).
    // The eight standard SKUs cover the Doubao + cross-vendor lineup;
    // `ark-code-latest` is a special console-managed entry where the
    // actual model is selected by Volcengine's Ark console (Auto mode)
    // — flagged in the displayName so users know it's not a stable
    // pinned model.
    defaultModels: [
      { modelId: 'doubao-seed-2.0-code', displayName: 'Doubao Seed 2.0 Code', role: 'default' },
      { modelId: 'doubao-seed-2.0-pro', displayName: 'Doubao Seed 2.0 Pro' },
      { modelId: 'doubao-seed-2.0-lite', displayName: 'Doubao Seed 2.0 Lite' },
      { modelId: 'doubao-seed-code', displayName: 'Doubao Seed Code' },
      { modelId: 'minimax-m2.5', displayName: 'MiniMax M2.5' },
      { modelId: 'glm-4.7', displayName: 'GLM-4.7' },
      { modelId: 'deepseek-v3.2', displayName: 'DeepSeek V3.2' },
      { modelId: 'kimi-k2.5', displayName: 'Kimi K2.5' },
      { modelId: 'ark-code-latest', displayName: 'ark-code-latest (Console-managed / Auto)' },
    ],
    fields: ['api_key', 'model_names'],
    iconKey: 'volcengine',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement',
      docsUrl: 'https://www.volcengine.com/docs/82379/1928262',
      billingModel: 'coding_plan',
      notes: ['需先在控制台激活 Endpoint', 'API Key 为临时凭证'],
      claudeCodeVerified: true,
    },
  },

  // ── Xiaomi MiMo (按量付费) ──
  {
    key: 'xiaomi-mimo',
    name: 'Xiaomi MiMo',
    description: 'Xiaomi MiMo Pay-as-you-go API — MiMo-V2.5-Pro',
    descriptionZh: '小米 MiMo 按量付费 — MiMo-V2.5-Pro',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    defaultEnvOverrides: {},
    defaultModels: [
      { modelId: 'sonnet', upstreamModelId: 'mimo-v2.5-pro', displayName: 'MiMo-V2.5-Pro', role: 'default' },
      // UltraSpeed — high-throughput experience mode of MiMo-V2.5-Pro.
      // Optional + approval-gated by Xiaomi, so NOT the default. The official
      // model page lists Anthropic-protocol access on this same .../anthropic
      // channel with model="mimo-v2.5-pro-ultraspeed" (streaming + thinking) —
      // verified against the page's Anthropic-protocol sample 2026-06-09.
      // Capabilities limited to what the doc states; no unsourced contextWindow.
      { modelId: 'mimo-v2.5-pro-ultraspeed', upstreamModelId: 'mimo-v2.5-pro-ultraspeed', displayName: 'MiMo-V2.5-Pro-UltraSpeed', capabilities: { toolUse: true, reasoning: true } },
    ],
    defaultRoleModels: {
      default: 'mimo-v2.5-pro',
      sonnet: 'mimo-v2.5-pro',
      opus: 'mimo-v2.5-pro',
      haiku: 'mimo-v2.5-pro',
    },
    // model_names: MiMo has no /v1/models discovery (sdkProxyOnly) and ships
    // new model ids (v2.5 / v2.5pro) over time. Without a model field the
    // connect dialog saved role_models_json:'{}', so the resolver back-filled
    // the stale `mimo-v2-pro` default every send (#577). Exposing model_names
    // lets the user set their actual model, which the resolver then honors.
    fields: ['api_key', 'model_names'],
    iconKey: 'xiaomi-mimo',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
      docsUrl: 'https://platform.xiaomimimo.com/#/docs/integration/claudecode',
      billingModel: 'pay_as_you_go',
      notes: [],
      claudeCodeVerified: true,
    },
  },

  // ── Xiaomi MiMo Token Plan (订阅套餐) ──
  {
    key: 'xiaomi-mimo-token-plan',
    name: 'Xiaomi MiMo Token Plan',
    description: 'Xiaomi MiMo Token Plan subscription — MiMo-V2.5-Pro',
    descriptionZh: '小米 MiMo Token Plan 订阅套餐 — MiMo-V2.5-Pro',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    defaultEnvOverrides: {},
    defaultModels: [
      { modelId: 'sonnet', upstreamModelId: 'mimo-v2.5-pro', displayName: 'MiMo-V2.5-Pro', role: 'default' },
    ],
    defaultRoleModels: {
      default: 'mimo-v2.5-pro',
      sonnet: 'mimo-v2.5-pro',
      opus: 'mimo-v2.5-pro',
      haiku: 'mimo-v2.5-pro',
    },
    // model_names: same as the pay-as-you-go preset above — lets Token Plan
    // users set their actual MiMo model instead of being pinned to the stale
    // `mimo-v2-pro` default (#577).
    fields: ['api_key', 'model_names'],
    iconKey: 'xiaomi-mimo',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.xiaomimimo.com/#/console/plan-manage',
      docsUrl: 'https://platform.xiaomimimo.com/#/docs/integration/claudecode',
      billingModel: 'token_plan',
      notes: [],
      claudeCodeVerified: true,
    },
  },

  // ── Aliyun Bailian ──
  {
    key: 'bailian',
    name: 'Aliyun Bailian',
    description: 'Aliyun Bailian Coding Plan — Qwen, GLM, Kimi, MiniMax',
    descriptionZh: '阿里云百炼 Coding Plan — 通义千问、GLM、Kimi、MiniMax',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    defaultEnvOverrides: {},
    // Bailian Coding Plan whitelist — verified against
    // https://help.aliyun.com/zh/model-studio/coding-plan (2026-05-06).
    // Page splits models into "推荐" (qwen3.6-plus, kimi-k2.5, glm-5,
    // MiniMax-M2.5) and "更多模型" (qwen3.5-plus, qwen3-max-2026-01-23,
    // qwen3-coder-next, qwen3-coder-plus, glm-4.7). MiniMax stays at M2.5
    // here even though standalone minimax-cn/global have moved to M2.7
    // — Bailian's own page still lists M2.5 and that's what their plan
    // accepts. Don't infer from the standalone provider.
    defaultModels: [
      { modelId: 'qwen3.6-plus', displayName: 'Qwen 3.6 Plus', role: 'default' },
      { modelId: 'qwen3.5-plus', displayName: 'Qwen 3.5 Plus' },
      { modelId: 'qwen3-max-2026-01-23', displayName: 'Qwen 3 Max (2026-01-23)' },
      { modelId: 'qwen3-coder-next', displayName: 'Qwen 3 Coder Next' },
      { modelId: 'qwen3-coder-plus', displayName: 'Qwen 3 Coder Plus' },
      { modelId: 'kimi-k2.5', displayName: 'Kimi K2.5' },
      { modelId: 'glm-5', displayName: 'GLM-5' },
      { modelId: 'glm-4.7', displayName: 'GLM-4.7' },
      { modelId: 'MiniMax-M2.5', displayName: 'MiniMax-M2.5' },
    ],
    fields: ['api_key'],
    iconKey: 'bailian',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://bailian.console.aliyun.com',
      docsUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan',
      billingModel: 'coding_plan',
      notes: ['必须使用 Coding Plan 专用 Key（以 sk-sp- 开头）', '普通 DashScope Key 无法使用', '禁止用于自动化脚本'],
      claudeCodeVerified: true,
    },
  },

  // ── Aliyun Bailian Token Plan 团队版 ──
  // Separate channel from Coding Plan: different host
  // (`token-plan.cn-beijing.maas.aliyuncs.com`), different Key family (Token
  // Plan team-tier keys are not interchangeable with Coding Plan sk-sp-…),
  // and a narrower whitelist. DeepSeek V3.2 is intentionally NOT included:
  // the Bailian docs explicitly state DeepSeek V3.2 isn't served via the
  // Anthropic protocol on Token Plan and must use OpenCode instead — listing
  // it here would silently mismatch when Claude Code resolves the alias.
  {
    key: 'bailian-token-plan-cn',
    name: 'Aliyun Bailian Token Plan',
    description: 'Aliyun Bailian Token Plan team tier — Qwen / GLM / MiniMax (cn-beijing only)',
    descriptionZh: '阿里云百炼 Token Plan 团队版 — 通义千问 / GLM / MiniMax（仅华北2北京）',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    defaultEnvOverrides: {},
    // Token Plan 团队版 whitelist — sourced from
    // 《阿里云-百炼-Token Plan 团队版.md》(2026-05-06):
    //   - qwen3.6-plus（推荐，Token Plan 默认配置全角色都用它）
    //   - glm-5
    //   - MiniMax-M2.5
    // Plan docs also list deepseek-v3.2 as a Token Plan model BUT
    // explicitly note "不支持 Anthropic 协议，仅可在 OpenCode 中使用"。
    // We're an Anthropic / Claude Code preset, so deepseek-v3.2 is
    // omitted on purpose — adding it would silently mis-route.
    defaultModels: [
      { modelId: 'qwen3.6-plus', displayName: 'Qwen 3.6 Plus', role: 'default' },
      { modelId: 'glm-5', displayName: 'GLM-5' },
      { modelId: 'MiniMax-M2.5', displayName: 'MiniMax-M2.5' },
    ],
    // Token Plan 团队版 文档示例配置：所有角色（default/sonnet/opus/haiku）
    // 都默认指向 qwen3.6-plus。用户可以在前端自行切换其他白名单 SKU。
    defaultRoleModels: {
      default: 'qwen3.6-plus',
      sonnet: 'qwen3.6-plus',
      opus: 'qwen3.6-plus',
      haiku: 'qwen3.6-plus',
    },
    fields: ['api_key'],
    iconKey: 'bailian',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://bailian.console.aliyun.com',
      docsUrl: 'https://help.aliyun.com/zh/model-studio/token-plan',
      billingModel: 'token_plan',
      notes: [
        '团队版 Key 与 Coding Plan / 普通 DashScope Key 不通用',
        '仅华北2（北京）地域提供服务',
        'DeepSeek V3.2 不支持 Anthropic 协议，需切换 OpenCode 使用',
      ],
      claudeCodeVerified: true,
    },
  },

  // ── ClinePass ──
  // ClinePass subscription accessed through the Cline API (OpenAI-compatible
  // Chat Completions). Models use the `cline-pass/<id>` slug — that IS the
  // value sent to the API, so modelId == upstream (no alias). The Cline API
  // is a multi-provider aggregator; its `/v1/models` returns far more than the
  // ClinePass whitelist AND needs a key, so discovery is `catalog_only`:
  // ship the 10-model whitelist as truth, no refresh / no search-and-add.
  // NOT sdkProxyOnly — OpenAI-compatible reaches CodePilot + Codex runtimes
  // via the AI SDK chat path, never the Claude Code subprocess.
  {
    key: 'cline-pass',
    name: 'ClinePass',
    description: 'ClinePass subscription — open coding models via the Cline API (CodePilot / Codex runtimes)',
    descriptionZh: 'ClinePass 订阅 — 通过 Cline API 访问开源编程模型（用于 CodePilot / Codex 运行时）',
    protocol: 'openai-compatible',
    authStyle: 'api_key',
    baseUrl: 'https://api.cline.bot/api/v1',
    defaultEnvOverrides: {},
    // ClinePass whitelist — https://docs.cline.bot/getting-started/clinepass
    // (verified 2026-06-30). The cline-pass/ prefix is part of the model id
    // sent to /chat/completions, so no upstreamModelId alias is needed.
    defaultModels: [
      { modelId: 'cline-pass/glm-5.2', displayName: 'GLM-5.2', capabilities: { toolUse: true } },
      { modelId: 'cline-pass/kimi-k2.7-code', displayName: 'Kimi K2.7 Code', capabilities: { toolUse: true } },
      { modelId: 'cline-pass/kimi-k2.6', displayName: 'Kimi K2.6', capabilities: { toolUse: true } },
      { modelId: 'cline-pass/deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', capabilities: { toolUse: true } },
      { modelId: 'cline-pass/deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', capabilities: { toolUse: true } },
      { modelId: 'cline-pass/mimo-v2.5', displayName: 'MiMo-V2.5', capabilities: { toolUse: true } },
      { modelId: 'cline-pass/mimo-v2.5-pro', displayName: 'MiMo-V2.5-Pro', capabilities: { toolUse: true } },
      { modelId: 'cline-pass/minimax-m3', displayName: 'MiniMax M3', capabilities: { toolUse: true } },
      { modelId: 'cline-pass/qwen3.7-max', displayName: 'Qwen3.7 Max', capabilities: { toolUse: true } },
      { modelId: 'cline-pass/qwen3.7-plus', displayName: 'Qwen3.7 Plus', capabilities: { toolUse: true } },
    ],
    fields: ['api_key'],
    iconKey: 'cline',
    meta: {
      apiKeyUrl: 'https://app.cline.bot',
      docsUrl: 'https://docs.cline.bot/getting-started/clinepass',
      billingModel: 'coding_plan',
      modelDiscoveryMode: 'catalog_only',
      notes: ['模型使用 cline-pass/<model-id> 形式；由订阅白名单定义，不做在线刷新。'],
    },
  },

  // ── OpenCode Go (OpenAI-compatible) ──
  // OpenCode Zen "Go" subscription, OpenAI-compatible half. Same host + key as
  // the Anthropic half below; split into two presets because protocol lives at
  // the provider layer (no per-model wire dispatch). `/zen/go/v1/models` is a
  // single MIXED catalog (both wire protocols) and a superset of this plan's
  // lineup, so discovery is `catalog_only` — auto-import would put `/messages`-
  // only models on the `/chat/completions` path. Models use bare ids (the
  // `opencode-go/` prefix is OpenCode-config-only, not the API model field).
  {
    key: 'opencode-go-openai',
    name: 'OpenCode Go (OpenAI)',
    description: 'OpenCode Zen Go subscription — OpenAI-compatible models (CodePilot / Codex runtimes)',
    descriptionZh: 'OpenCode Zen Go 订阅 — OpenAI 兼容模型（用于 CodePilot / Codex 运行时）',
    protocol: 'openai-compatible',
    authStyle: 'api_key',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    defaultEnvOverrides: {},
    // OpenAI-compatible half of the official endpoint table —
    // https://opencode.ai/docs/zh-cn/go/ (verified 2026-06-30).
    defaultModels: [
      { modelId: 'glm-5.2', displayName: 'GLM-5.2', capabilities: { toolUse: true } },
      { modelId: 'glm-5.1', displayName: 'GLM-5.1', capabilities: { toolUse: true } },
      { modelId: 'kimi-k2.7-code', displayName: 'Kimi K2.7 Code', capabilities: { toolUse: true } },
      { modelId: 'kimi-k2.6', displayName: 'Kimi K2.6', capabilities: { toolUse: true } },
      { modelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', capabilities: { toolUse: true } },
      { modelId: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', capabilities: { toolUse: true } },
      { modelId: 'mimo-v2.5', displayName: 'MiMo-V2.5', capabilities: { toolUse: true } },
      { modelId: 'mimo-v2.5-pro', displayName: 'MiMo-V2.5-Pro', capabilities: { toolUse: true } },
    ],
    fields: ['api_key'],
    iconKey: 'opencode',
    meta: {
      apiKeyUrl: 'https://opencode.ai/auth',
      docsUrl: 'https://opencode.ai/docs/zh-cn/go/',
      billingModel: 'coding_plan',
      modelDiscoveryMode: 'catalog_only',
      notes: ['与「OpenCode Go (Anthropic)」共用同一订阅 Key；模型由套餐白名单定义。'],
    },
  },

  // ── OpenCode Go (Anthropic Messages) ──
  // Anthropic-Messages half of the same OpenCode Go subscription. The real
  // endpoint is https://opencode.ai/zen/go/v1/messages, but the base is stored
  // WITHOUT the trailing /v1 on purpose. The Claude Code SDK ALWAYS appends
  // `/v1/messages` to ANTHROPIC_BASE_URL, so a `.../zen/go/v1` base makes the
  // SDK POST to `.../zen/go/v1/v1/messages` → 404 HTML → surfaced as "model
  // (minimax-m3) doesn't exist" (verified 2026-06-30). (The native
  // ClaudeCodeCompatModel.buildMessagesUrl() actually handles a /v1-ending base
  // fine — it appends only `/messages` in that case — so the CodePilot path was
  // already correct; the SDK path was the broken one.) Storing `.../zen/go`
  // makes all three transports converge on the right URL: the SDK appends
  // `/v1/messages`, the adapter's deep-path branch also yields
  // `.../zen/go/v1/messages`, and the Codex provider proxy reuses the adapter.
  // (Every other anthropic preset's base ends in /api/anthropic etc. for the
  // same SDK reason.) Bonus: this base differs from the OpenAI half
  // (`.../zen/go/v1`), so no preset collision. authStyle: api_key → x-api-key
  // (probe confirmed x-api-key, not Bearer; the endpoint does not require
  // anthropic-version). NOT claudeCodeVerified: ships experimental until a
  // real-key smoke.
  {
    key: 'opencode-go-anthropic',
    name: 'OpenCode Go (Anthropic)',
    description: 'OpenCode Zen Go subscription — Anthropic Messages models (experimental on Claude Code)',
    descriptionZh: 'OpenCode Zen Go 订阅 — Anthropic Messages 模型（Claude Code 兼容性实验中）',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: 'https://opencode.ai/zen/go',
    defaultEnvOverrides: {},
    // Anthropic-Messages half of the official endpoint table —
    // https://opencode.ai/docs/zh-cn/go/ (verified 2026-06-30).
    defaultModels: [
      { modelId: 'minimax-m3', displayName: 'MiniMax M3', capabilities: { toolUse: true } },
      { modelId: 'minimax-m2.7', displayName: 'MiniMax M2.7', capabilities: { toolUse: true } },
      { modelId: 'minimax-m2.5', displayName: 'MiniMax M2.5', capabilities: { toolUse: true } },
      { modelId: 'qwen3.7-max', displayName: 'Qwen3.7 Max', capabilities: { toolUse: true } },
      { modelId: 'qwen3.7-plus', displayName: 'Qwen3.7 Plus', capabilities: { toolUse: true } },
      { modelId: 'qwen3.6-plus', displayName: 'Qwen3.6 Plus', capabilities: { toolUse: true } },
    ],
    fields: ['api_key'],
    iconKey: 'opencode',
    meta: {
      apiKeyUrl: 'https://opencode.ai/auth',
      docsUrl: 'https://opencode.ai/docs/zh-cn/go/',
      billingModel: 'coding_plan',
      modelDiscoveryMode: 'catalog_only',
      notes: [
        '与「OpenCode Go (OpenAI)」共用同一订阅 Key；模型由套餐白名单定义。',
        'Anthropic Messages 协议；Claude Code Runtime 兼容性未经真实凭据验证，先以实验态提供。',
      ],
    },
  },

  // ── DeepSeek ──
  {
    key: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek Anthropic-compatible API — fixed model lineup',
    descriptionZh: 'DeepSeek Anthropic 兼容 API — 模型清单固定',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.deepseek.com/anthropic',
    defaultEnvOverrides: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    },
    // DeepSeek catalog — verified against
    // https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code
    // and the pricing page (2026-05-06). The legacy aliases deepseek-chat
    // and deepseek-reasoner will be deprecated 2026-07-24 and currently
    // map to non-thinking / thinking modes of deepseek-v4-flash, so they
    // are not surfaced as defaults — users still get them by manual add.
    // The `[1m]` suffix is a Claude Code convention DeepSeek's docs use
    // verbatim to select the 1M-context variant; both v4-pro and v4-flash
    // also have a non-suffixed default-context variant.
    defaultModels: [
      { modelId: 'deepseek-v4-pro[1m]', upstreamModelId: 'deepseek-v4-pro[1m]', displayName: 'DeepSeek V4 Pro (1M)', role: 'opus' },
      { modelId: 'deepseek-v4-pro', upstreamModelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', role: 'default' },
      { modelId: 'deepseek-v4-flash', upstreamModelId: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', role: 'haiku' },
    ],
    defaultRoleModels: {
      default: 'deepseek-v4-pro[1m]',
      opus: 'deepseek-v4-pro[1m]',
      sonnet: 'deepseek-v4-pro[1m]',
      haiku: 'deepseek-v4-flash',
    },
    fields: ['api_key'],
    iconKey: 'deepseek',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.deepseek.com/api_keys',
      docsUrl: 'https://api-docs.deepseek.com',
      billingModel: 'pay_as_you_go',
      claudeCodeVerified: true,
      // Catalog is the official lineup, not a starter seed — when users
      // see e.g. deepseek-v3.2-exp from a previous catalog version still
      // sitting in their list, that's drift, not legitimate custom add.
      // Surfacing the "已不在当前推荐目录" badge for those rows is the
      // intended behavior. (Plan providers are caught by
      // `isCatalogOnlyPlanProviderRecord`; DeepSeek isn't a plan
      // provider but has the same authoritative-catalog property.)
      fixedCatalog: true,
    },
  },

  // ── StepFun (阶跃星辰) ──
  {
    key: 'stepfun',
    name: 'StepFun',
    description: 'StepFun Step Plan — Anthropic-compatible reasoning API',
    descriptionZh: '阶跃星辰 Step Plan — Anthropic 兼容推理 API',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: 'https://api.stepfun.com/step_plan',
    defaultEnvOverrides: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    defaultModels: [
      {
        modelId: 'step-3.7-flash',
        upstreamModelId: 'step-3.7-flash',
        displayName: 'Step 3.7 Flash',
        role: 'default',
        capabilities: {
          reasoning: true,
          toolUse: true,
          vision: true,
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high'],
        },
      },
      {
        modelId: 'step-3.5-flash-2603',
        upstreamModelId: 'step-3.5-flash-2603',
        displayName: 'Step 3.5 Flash 2603',
        role: 'sonnet',
        capabilities: {
          reasoning: true,
          toolUse: true,
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high'],
        },
      },
      {
        modelId: 'step-3.5-flash',
        upstreamModelId: 'step-3.5-flash',
        displayName: 'Step 3.5 Flash',
        role: 'haiku',
        capabilities: {
          reasoning: true,
          toolUse: true,
        },
      },
      {
        modelId: 'step-router-v1',
        upstreamModelId: 'step-router-v1',
        displayName: 'Step Router V1',
        capabilities: {
          reasoning: true,
          toolUse: true,
        },
      },
    ],
    defaultRoleModels: {
      default: 'step-3.7-flash',
      opus: 'step-3.7-flash',
      sonnet: 'step-3.5-flash-2603',
      haiku: 'step-3.5-flash',
    },
    fields: ['api_key'],
    iconKey: 'stepfun',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.stepfun.com/interface-key',
      docsUrl: 'https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api',
      billingModel: 'token_plan',
      notes: [
        '需订阅 Step Plan 套餐并获取 API Key',
        'Anthropic SDK 会自动拼接 /v1/messages，base_url 不带 /v1',
      ],
    },
  },

  // ── AWS Bedrock ──
  {
    key: 'bedrock',
    name: 'AWS Bedrock',
    description: 'Amazon Bedrock — requires AWS credentials',
    descriptionZh: 'Amazon Bedrock — 需要 AWS 凭证',
    protocol: 'bedrock',
    authStyle: 'env_only',
    baseUrl: '',
    defaultEnvOverrides: {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'us-east-1',
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
    },
    defaultModels: BEDROCK_VERTEX_DEFAULT_MODELS,
    fields: ['env_overrides'],
    iconKey: 'bedrock',
    meta: {
      apiKeyUrl: 'https://console.aws.amazon.com',
      docsUrl: 'https://aws.amazon.com/cn/bedrock/anthropic/',
      billingModel: 'pay_as_you_go',
      notes: ['需在 AWS Console 订阅 Claude 模型'],
    },
  },

  // ── Google Vertex AI ──
  {
    key: 'vertex',
    name: 'Google Vertex',
    description: 'Google Vertex AI — requires GCP credentials',
    descriptionZh: 'Google Vertex AI — 需要 GCP 凭证',
    protocol: 'vertex',
    authStyle: 'env_only',
    baseUrl: '',
    defaultEnvOverrides: {
      CLAUDE_CODE_USE_VERTEX: '1',
      CLOUD_ML_REGION: 'us-east5',
      CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
    },
    defaultModels: BEDROCK_VERTEX_DEFAULT_MODELS,
    fields: ['env_overrides'],
    iconKey: 'google',
    meta: {
      docsUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude',
      billingModel: 'pay_as_you_go',
      notes: ['需启用 Vertex AI 并在 Model Garden 订阅 Claude 模型'],
    },
  },

  // ── Ollama ──
  {
    key: 'ollama',
    name: 'Ollama',
    description: 'Ollama — run local models with Anthropic-compatible API',
    descriptionZh: 'Ollama — 本地运行模型，Anthropic 兼容 API',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'http://localhost:11434',
    defaultEnvOverrides: {
      ANTHROPIC_AUTH_TOKEN: 'ollama',  // Fixed pseudo-token for Ollama (no real auth needed)
    },
    defaultModels: [],  // User must specify — depends on pulled models
    fields: ['base_url', 'model_names'],
    iconKey: 'ollama',
    sdkProxyOnly: true,
    meta: {
      docsUrl: 'https://docs.ollama.com/integrations/claude-code',
      billingModel: 'free',
      notes: ['需要本地安装 Ollama 并拉取模型'],
    },
  },

  // ── LiteLLM ──
  {
    key: 'litellm',
    name: 'LiteLLM',
    description: 'LiteLLM proxy — local or remote',
    descriptionZh: 'LiteLLM 代理 — 本地或远程',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: 'http://localhost:4000',
    defaultEnvOverrides: {},
    defaultModels: ANTHROPIC_DEFAULT_MODELS,
    fields: ['api_key', 'base_url'],
    iconKey: 'server',
    meta: {
      docsUrl: 'https://docs.litellm.ai/docs/',
      billingModel: 'self_hosted',
    },
  },

  // ── Google Gemini (Image) ──
  {
    key: 'gemini-image',
    name: 'Google Gemini (Image)',
    description: 'Nano Banana Pro — AI image generation by Google Gemini',
    descriptionZh: 'Nano Banana Pro — Google Gemini AI 图片生成',
    protocol: 'gemini-image',
    authStyle: 'api_key',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultEnvOverrides: { GEMINI_API_KEY: '' },
    defaultModels: [
      { modelId: 'gemini-3.1-flash-image-preview', displayName: 'Nano Banana 2' },
      { modelId: 'gemini-3-pro-image-preview', displayName: 'Nano Banana Pro' },
      { modelId: 'gemini-2.5-flash-image', displayName: 'Nano Banana' },
    ],
    fields: ['api_key'],
    category: 'media',
    iconKey: 'google',
    meta: {
      apiKeyUrl: 'https://aistudio.google.com/api-keys',
      docsUrl: 'https://ai.google.dev/gemini-api/docs/image-generation',
      billingModel: 'pay_as_you_go',
    },
  },

  // ── Google Gemini (Image) Third-party ──
  // Same protocol & SDK as the official preset; only the base URL differs so
  // users can route through a compatible proxy (e.g. custom relay, CN mirror).
  {
    key: 'gemini-image-thirdparty',
    name: 'Gemini Image Third-party',
    description: 'Nano Banana via compatible proxy — provide URL and Key',
    descriptionZh: 'Nano Banana 兼容第三方 API — 填写地址和密钥',
    protocol: 'gemini-image',
    authStyle: 'api_key',
    baseUrl: '',
    defaultEnvOverrides: { GEMINI_API_KEY: '' },
    defaultModels: [
      { modelId: 'gemini-3.1-flash-image-preview', displayName: 'Nano Banana 2' },
      { modelId: 'gemini-3-pro-image-preview', displayName: 'Nano Banana Pro' },
      { modelId: 'gemini-2.5-flash-image', displayName: 'Nano Banana' },
    ],
    fields: ['name', 'api_key', 'base_url'],
    category: 'media',
    iconKey: 'google',
  },

  // ── OpenAI (Image) ──
  {
    key: 'openai-image',
    name: 'OpenAI (Image)',
    description: 'GPT Image 2 — AI image generation by OpenAI',
    descriptionZh: 'GPT Image 2 — OpenAI AI 图片生成',
    protocol: 'openai-image',
    authStyle: 'api_key',
    baseUrl: 'https://api.openai.com/v1',
    defaultEnvOverrides: { OPENAI_API_KEY: '' },
    defaultModels: [
      { modelId: 'gpt-image-2', displayName: 'GPT Image 2' },
      { modelId: 'gpt-image-1.5', displayName: 'GPT Image 1.5' },
      { modelId: 'gpt-image-1', displayName: 'GPT Image 1' },
      { modelId: 'gpt-image-1-mini', displayName: 'GPT Image 1 Mini' },
    ],
    fields: ['api_key'],
    category: 'media',
    iconKey: 'openai',
    meta: {
      apiKeyUrl: 'https://platform.openai.com/api-keys',
      docsUrl: 'https://platform.openai.com/docs/guides/image-generation',
      billingModel: 'pay_as_you_go',
    },
  },

  // ── OpenAI (Image) Third-party ──
  {
    key: 'openai-image-thirdparty',
    name: 'OpenAI Image Third-party',
    description: 'GPT Image via compatible proxy — provide URL and Key',
    descriptionZh: 'GPT Image 兼容第三方 API — 填写地址和密钥',
    protocol: 'openai-image',
    authStyle: 'api_key',
    baseUrl: '',
    defaultEnvOverrides: { OPENAI_API_KEY: '' },
    defaultModels: [
      { modelId: 'gpt-image-2', displayName: 'GPT Image 2' },
      { modelId: 'gpt-image-1.5', displayName: 'GPT Image 1.5' },
      { modelId: 'gpt-image-1', displayName: 'GPT Image 1' },
      { modelId: 'gpt-image-1-mini', displayName: 'GPT Image 1 Mini' },
    ],
    fields: ['name', 'api_key', 'base_url'],
    category: 'media',
    iconKey: 'openai',
  },

];

// ── Runtime preset validation (fails fast on invalid presets) ───

for (const p of VENDOR_PRESETS) {
  PresetSchema.parse(p);
}

// ── Lookup helpers ──────────────────────────────────────────────

/** Get a preset by key. */
export function getPreset(key: string): VendorPreset | undefined {
  return VENDOR_PRESETS.find(p => p.key === key);
}

/**
 * True for presets where the available model list is a subscription SKU
 * whitelist (Coding Plan / Token Plan), not the full upstream inference
 * catalogue. These vendors must NOT be auto-probed:
 *   - their /v1/models endpoint at the same host returns the wider Ark /
 *     DashScope / etc. catalogue (text + image + embedding + deprecated
 *     variants);
 *   - probing-and-writing it surfaces non-plan SKUs that 4xx on use and
 *     can incur out-of-plan billing.
 *
 * Trigger: `sdkProxyOnly && billingModel ∈ {coding_plan, token_plan}`.
 * Pay-as-you-go anthropic-compat (kimi, moonshot, xiaomi-mimo, deepseek)
 * is NOT caught — their full inference catalogue is the genuine offering.
 *
 * **Caller contract**: this function takes a *verified preset key*. Most
 * stored providers carry `provider_type='anthropic'` even when they came
 * from a brand-specific preset (Volcengine, Bailian, GLM, MiniMax, …) —
 * the actual preset is recovered via `findMatchingPresetForRecord` using
 * `base_url`. UI sites that only have a provider record must use
 * `isCatalogOnlyPlanProviderRecord()` instead, otherwise the check
 * silently misses every plan provider. Only call this directly when
 * upstream code (e.g. an API route) already ran the matcher and has a
 * confirmed key (`model-discovery.ts:classifyProvider` is one such caller).
 */
export function isCatalogOnlyPlanProvider(presetKey: string | undefined | null): boolean {
  if (!presetKey) return false;
  const preset = getPreset(presetKey);
  if (!preset) return false;
  return Boolean(
    preset.sdkProxyOnly &&
    (preset.meta?.billingModel === 'coding_plan' || preset.meta?.billingModel === 'token_plan')
  );
}

/**
 * Record-aware version of `isCatalogOnlyPlanProvider` — the safe choice
 * for any UI site that holds a provider record (or an Add-Service draft
 * record) but not yet a verified preset key.
 *
 * Why this exists: brand-specific anthropic-compat presets (Volcengine /
 * Bailian / GLM CN+Global / MiniMax CN+Global / Xiaomi MiMo Token Plan)
 * are all stored with `provider_type='anthropic'`. Looking up the preset
 * by `provider_type` alone always misses them — the matcher needs
 * `base_url` to recover the real preset. Routing through
 * `findMatchingPresetForRecord` here keeps every UI caller honest and
 * keeps both UI sites and the discovery gate on the same answer.
 */
export function isCatalogOnlyPlanProviderRecord(record: {
  provider_type: string;
  base_url: string;
}): boolean {
  const matched = findMatchingPresetForRecord(record);
  return isCatalogOnlyPlanProvider(matched?.key);
}

/**
 * True for presets that ship `meta.modelDiscoveryMode: 'catalog_only'` — the
 * strictest discovery posture: no `/v1/models` refresh, no search-and-add, and
 * `classifyProvider` returns `unsupported`. The shipped `defaultModels` lineup
 * is the only truth.
 *
 * This is intentionally NOT folded into `isCatalogOnlyPlanProvider`: plan
 * providers (GLM / MiniMax) keep search-and-add ON because their `/v1/models`
 * is a clean per-vendor list, whereas these gateways (ClinePass, OpenCode Go)
 * expose a key-gated, mixed-protocol, or superset endpoint that must never be
 * auto-imported. By-key variant for callers that already resolved a preset
 * (e.g. `model-discovery.ts:classifyProvider`); use the record variant from any
 * UI/route site that only holds a provider record.
 */
export function isCatalogOnlyDiscoveryProvider(presetKey: string | undefined | null): boolean {
  if (!presetKey) return false;
  return getPreset(presetKey)?.meta?.modelDiscoveryMode === 'catalog_only';
}

/** Record-aware version of `isCatalogOnlyDiscoveryProvider`. */
export function isCatalogOnlyDiscoveryRecord(record: {
  provider_type: string;
  base_url: string;
}): boolean {
  return isCatalogOnlyDiscoveryProvider(findMatchingPresetForRecord(record)?.key);
}

/**
 * True for OpenRouter provider records — the aggregator that ships 300+
 * model entries through `/v1/models`. OpenRouter is *not* a Coding/Token
 * Plan vendor (every model is genuinely usable on pay-as-you-go), but
 * full materialization of its catalogue into `provider_models` is the
 * wrong UX: users want to search-and-add a few, not reverse-trim 300.
 *
 * Goes through `findMatchingPresetForRecord` so legacy DB rows with empty
 * `protocol` field still classify correctly via `provider_type='openrouter'`
 * or `base_url` exact match. UI sites and routes must NOT read
 * `provider.protocol` directly for this gate — the helper is the contract.
 *
 * Used by:
 *   - `POST /api/providers` route — eager seed via `seedCatalogModelsIfEmpty`
 *     instead of relying on lazy GET-time seed
 *   - `POST /api/providers/[id]/search-models` route — auth gate
 *   - `POST /api/providers/[id]/validate-models` route — auth gate
 *   - `model-discovery.ts:classifyProvider` — return `unsupported` for
 *     OpenRouter so the discover/apply path never auto-materializes
 *   - `POST /api/providers/[id]/discover-models/apply` — 400 reject
 *   - `ProviderManager` Add-Service success path — show search-add toast
 *   - `ModelsSection` per-card refresh — route to validate-models
 */
export function isOpenRouterProviderRecord(record: {
  provider_type: string;
  base_url: string;
}): boolean {
  return findMatchingPresetForRecord(record)?.key === 'openrouter';
}

/** Get all presets for a given category (defaults to 'chat'). */
export function getPresetsByCategory(category: 'chat' | 'media' = 'chat'): VendorPreset[] {
  return VENDOR_PRESETS.filter(p => (p.category || 'chat') === category);
}

/**
 * Catalog defaults for a provider. Used by the Models page as a fallback
 * when discovery isn't possible (404 on /v1/models, OAuth/SDK-only families,
 * etc.) — the curated list is shipped in VENDOR_PRESETS.
 *
 * Returns [] if no preset matches; the caller should treat that as
 * "manual entry only" (user must add models themselves).
 */
export function getCatalogDefaultModelsForRecord(record: {
  provider_type: string;
  base_url: string;
}): CatalogModel[] {
  const matched = findMatchingPresetForRecord(record);
  return matched?.defaultModels ?? [];
}

/**
 * Step 4 文案收口（2026-05-06）—— 用户语言的「接入方式」分类。
 *
 * Provider Card 之前直接展示 `authStyle` 工程枚举值（"Auth Token" /
 * "API Key"），缺乏对用户的解释力：套餐 vs 按量、登录 vs 输 Key、本地
 * vs 远端这几条用户真正关心的轴都被压进了一个底层布尔。
 *
 * 这个 helper 把 preset + provider record 映射成下面 6 类用户面文案：
 *   - subscription_token  套餐 Token：Coding/Token Plan，billingModel 命中
 *   - api_key             API Key：按量付费、anthropic 官方
 *   - oauth               授权登录：openai-oauth、anthropic-oauth 等
 *   - local               本地服务：ollama / litellm / 其它 self_hosted
 *   - cloud_credentials   云账号凭证：bedrock / vertex（authStyle env_only）
 *   - gateway             中转网关：anthropic-thirdparty / 没匹配任何 preset
 *                         的自定义 URL
 *
 * UI 自己拿到 `AccessType` 后再走 i18n（`provider.accessType.*`）—— 这个
 * 文件不包含任何用户文案，只负责分类。
 */
export type AccessType =
  | 'subscription_token'
  | 'api_key'
  | 'oauth'
  | 'local'
  | 'cloud_credentials'
  | 'gateway';

export function getProviderAccessType(record: {
  provider_type: string;
  base_url: string;
}): AccessType {
  // OAuth-shaped provider_type values — these are virtual providers that
  // don't carry an api_key field (auth is in a side channel) so the
  // billingModel check below would miss them.
  if (record.provider_type === 'openai-oauth' || record.provider_type === 'anthropic-oauth') {
    return 'oauth';
  }
  const preset = findMatchingPresetForRecord(record);
  if (!preset) {
    // Unmatched preset = user-configured custom URL, conventionally a
    // 中转网关. Same wording as `anthropic-thirdparty` below.
    return 'gateway';
  }
  // Cloud-managed presets use SDK-side env credentials, not an
  // app-managed key. Calling them "API Key" misled users into looking
  // for a key field that isn't there.
  if (preset.authStyle === 'env_only') return 'cloud_credentials';
  // Local services. Ollama uses `billingModel: 'free'` (no charging
  // concept), LiteLLM uses `'self_hosted'` (user-deployed proxy);
  // both are the same user-facing bucket — 本地服务.
  if (preset.meta?.billingModel === 'self_hosted' || preset.meta?.billingModel === 'free') {
    return 'local';
  }
  // Subscription-style billing — the canonical "套餐 Token" bucket.
  if (preset.meta?.billingModel === 'coding_plan' || preset.meta?.billingModel === 'token_plan') {
    return 'subscription_token';
  }
  // Generic anthropic-compatible relay / custom gateway preset.
  if (preset.key === 'anthropic-thirdparty') return 'gateway';
  // Fall through: pay-as-you-go API key / free-tier (treated the same
  // here — user puts a key in the form field).
  return 'api_key';
}

/**
 * Phase 1 Step 2 — "已不在当前推荐目录" badge support.
 *
 * Returns `false` when the provider has a non-empty curated catalog AND
 * `modelId` isn't one of its `defaultModels[].modelId`. The Models page
 * uses this to surface a row-level hint:
 *   - DeepSeek catalog upgraded from v3.x to v4 family → user's row of
 *     `deepseek-v3.2-exp` survives (manual_* protection at apply time)
 *     but the row no longer maps to a current recommendation. Without
 *     this badge, the user sees "manual_enabled" and assumes they had
 *     enabled it themselves; the badge clarifies "the catalog moved
 *     under you, not the other way around".
 *   - Volcengine catalog change → same shape.
 *
 * Returns `true` (= "in catalog" or "no concept of catalog") when:
 *   - The model_id IS in the current catalog. No badge needed.
 *   - The provider has no preset / no catalog defaults. Custom-only
 *     provider; "out of catalog" doesn't mean anything here.
 *
 * **Why OpenRouter is intentionally out of scope at the call site (not
 * here)**: OpenRouter ships a 3-alias catalog (sonnet / opus / haiku)
 * but every additional row is *expected* to be search-and-add. Showing
 * "not in catalog" on every search-added row would be noise. The UI
 * caller short-circuits via `isOpenRouterProviderRecord` before asking
 * this function. Keeping the OpenRouter exception at the call site
 * means this helper stays a pure catalog-membership check, which is
 * easier to reason about and test.
 */
export function isModelInCurrentCatalog(
  record: { provider_type: string; base_url: string },
  modelId: string,
): boolean {
  const defaults = getCatalogDefaultModelsForRecord(record);
  if (defaults.length === 0) return true;
  return defaults.some(m => m.modelId === modelId);
}

/**
 * Phase 1 Step 2 — gate for the "已不在当前推荐目录" row badge.
 *
 * The badge fires only when **all three** hold:
 *   1. The provider's catalog is authoritative — i.e. plan whitelist or
 *      curator-fixed lineup. Outside this set, `defaultModels` is just a
 *      starter seed (Kimi 1-alias, Moonshot 1-alias, Xiaomi MiMo PAYG
 *      1-alias, anthropic-thirdparty 3-alias, OpenRouter 3-alias) where
 *      user-added rows are normal usage, not drift.
 *   2. The provider is not OpenRouter — its 3-alias catalog is a search-
 *      and-add bootstrap and every search-added row is *expected* to be
 *      outside it. (Already excluded by rule 1, but the explicit guard
 *      documents the intent for future readers.)
 *   3. The model_id is not in the current `defaultModels` for this
 *      provider — i.e. the row genuinely sits outside our authoritative
 *      list.
 *
 * Authoritative catalog = `isCatalogOnlyPlanProviderRecord` (any plan
 * provider) OR `meta.fixedCatalog === true` (declared opt-in for
 * curator-fixed pay-as-you-go presets, currently only DeepSeek).
 *
 * Lifted to a single helper so the call site (Models page row renderer)
 * gets one boolean and the test surface stays narrow — see
 * `legacy-catalog-hint.test.ts` for the case matrix.
 */
export function shouldShowLegacyCatalogBadge(
  record: { provider_type: string; base_url: string },
  modelId: string,
): boolean {
  if (isOpenRouterProviderRecord(record)) return false;
  const preset = findMatchingPresetForRecord(record);
  if (!preset) return false;
  const isAuthoritative =
    isCatalogOnlyPlanProviderRecord(record) ||
    isCatalogOnlyDiscoveryRecord(record) ||
    preset.meta?.fixedCatalog === true;
  if (!isAuthoritative) return false;
  return !isModelInCurrentCatalog(record, modelId);
}

/**
 * Phase 1 Step 2 收敛 — 单一真相源：这个 provider 是否应该展示「刷新模型」按钮？
 *
 * 来自 Codex「Models / Providers 体验收敛」原则：
 *   "如果服务商本身不支持可靠拉取模型，就不要显示「刷新模型」按钮。"
 *
 * 全 preset 决策表见 `docs/research/provider-model-discovery.md` 的
 * "全 preset 拉取可靠性审计" 段。摘要：
 *   - **可靠**：ollama（公开 /api/tags）、litellm（标准 /v1/models）、
 *     anthropic-thirdparty（多数自定义网关支持 /v1/models —— 仅作为
 *     "首次配置后试一次" 入口）。
 *   - **不可靠 / 不应该拉**：套餐型（白名单 ≠ 上游全量）、OpenRouter
 *     （走独立 search/validate）、image providers（混 text/audio/embedding）、
 *     bedrock/vertex（SDK only）、anthropic-official（/v1/models 分页绑 org
 *     billing，catalog 是 truth）、PAYG anthropic-compat（kimi/moonshot/
 *     xiaomi-mimo/deepseek，catalog 都是 1-3 个固定 alias，拉取行为未实测，
 *     按 Codex 4-category 框架归套餐型）。
 *
 * UI 调用点（ModelsSection 行级 / ProviderCard / Refresh All）必须用这个
 * helper 决定按钮可见性，不要各自判断。
 */
export function canReliablyFetchModels(
  record: { provider_type: string; base_url: string },
): { reliable: boolean; reasonZh: string; reasonEn: string } {
  // Plan providers stay blocked from the *write* refresh path:
  // probe-and-apply would replace plan-curated catalog rows with raw
  // upstream ids (e.g. GLM auto-refresh would overwrite our `sonnet →
  // GLM-5-Turbo` alias mapping with a plain `glm-5-turbo` row). Even
  // though some plan providers (GLM, MiniMax) have a clean readable
  // /v1/models, the search-and-add path has its own helper
  // `canSearchUpstreamModels` for that — it's read-only and doesn't
  // need the same protection.
  if (isCatalogOnlyPlanProviderRecord(record)) {
    return {
      reliable: false,
      reasonZh: '套餐型服务，模型由套餐白名单定义；如需补 SKU 请用「添加模型」',
      reasonEn: 'Plan-based provider — model list is defined by your subscription whitelist. Use "Add model" to add SKUs.',
    };
  }
  // Catalog-only discovery gateways (ClinePass, OpenCode Go): the shipped
  // whitelist is the only truth — their model endpoint is key-gated /
  // mixed-protocol / a superset, so neither refresh nor search-and-add is safe.
  if (isCatalogOnlyDiscoveryRecord(record)) {
    return {
      reliable: false,
      reasonZh: '套餐型服务，模型由内置白名单定义，暂不支持在线刷新',
      reasonEn: 'Subscription provider — models are defined by a built-in whitelist; online refresh is disabled.',
    };
  }
  // OpenRouter: search-and-add is the canonical add path; validate is the
  // canonical refresh path. Don't surface a generic /v1/models refresh.
  if (isOpenRouterProviderRecord(record)) {
    return {
      reliable: false,
      reasonZh: 'OpenRouter 通过搜索添加模型，不需要全量刷新',
      reasonEn: 'OpenRouter uses search-and-add for new models — no bulk refresh needed.',
    };
  }
  const preset = findMatchingPresetForRecord(record);
  // No preset match — assume custom; allow refresh attempt (the route will
  // either succeed or fall through to "no models"). This matches the
  // anthropic-thirdparty experimental classification at the route layer.
  if (!preset) {
    return { reliable: true, reasonZh: '', reasonEn: '' };
  }
  // Phase 1 Step 2 收敛 round 6 (2026-05-06): empirical probe results
  // against the dev DB drove this list:
  //
  //   - kimi (`https://api.kimi.com/coding/v1/models`): returns 1 model
  //     (`kimi-for-coding`). Search-add UX is meaningful even with 1
  //     candidate — saves the user typing.
  //   - moonshot / xiaomi-mimo: similar PAYG anthropic-compat shape, not
  //     individually probed but presumed-reliable on the same logic.
  //     If their /v1/models 404s, the search dialog surfaces the error
  //     and the manual-fallback link still gets the user there.
  //   - deepseek (`https://api.deepseek.com/anthropic/v1/models`): 404.
  //     Block from search-add so the user lands on manual immediately
  //     instead of seeing a broken search dialog. DeepSeek's catalog is
  //     the v4 family `meta.fixedCatalog: true` — manual-add is the
  //     intended path for any additional SKUs.
  if (preset.key === 'deepseek') {
    return {
      reliable: false,
      reasonZh: 'DeepSeek 不支持通过 /v1/models 拉取列表，请在「添加模型」里手动输入 model id',
      reasonEn: "DeepSeek does not expose /v1/models — use manual entry in Add model.",
    };
  }
  if (preset.key === 'stepfun') {
    return {
      reliable: false,
      reasonZh: '阶跃星辰 Step Plan 不支持通过 /v1/models 拉取列表，请在「添加模型」里手动输入 model id',
      reasonEn: "StepFun Step Plan does not expose /v1/models — use manual entry in Add model.",
    };
  }
  // Image providers: catalog-only.
  if (preset.protocol === 'gemini-image' || preset.protocol === 'openai-image') {
    return {
      reliable: false,
      reasonZh: '图像服务商使用内置模型列表',
      reasonEn: 'Image providers use the built-in catalog.',
    };
  }
  // Cloud direct (Bedrock / Vertex): SDK-only, no plain HTTP probe.
  if (preset.key === 'bedrock' || preset.key === 'vertex') {
    return {
      reliable: false,
      reasonZh: '该服务商需要云 SDK 才能拉取模型列表',
      reasonEn: 'This provider needs the cloud SDK to fetch models.',
    };
  }
  // Anthropic-official: /v1/models is paginated + tied to org billing
  // scope; catalog (sonnet/opus/haiku) is the truth.
  if (preset.key === 'anthropic-official') {
    return {
      reliable: false,
      reasonZh: '官方 API 使用内置模型列表',
      reasonEn: 'Official API uses the built-in catalog.',
    };
  }
  // OAuth: no model list endpoint at all.
  if (preset.key === 'openai-oauth') {
    return {
      reliable: false,
      reasonZh: 'OAuth 登录方式没有模型列表接口',
      reasonEn: 'OAuth login does not expose a model list endpoint.',
    };
  }
  // ollama / litellm / anthropic-thirdparty / openai-compatible — reliable
  // (or at least: a refresh attempt is meaningful).
  return { reliable: true, reasonZh: '', reasonEn: '' };
}

/**
 * Phase 1 Step 2 收敛 round 7 (2026-05-06) — gate for the search-and-add
 * dialog. **Read-only**: opens upstream `/v1/models`, lets the user pick,
 * writes only the chosen rows via the existing manual-add route. Never
 * triggers a bulk apply, so the same protections as
 * `canReliablyFetchModels` (which guards the auto-write path) don't
 * apply.
 *
 * Empirical findings (2026-05-06, against the dev DB):
 *   - GLM (`https://open.bigmodel.cn/api/anthropic/v1/models`): returns
 *     ~6 GLM-family SKUs cleanly. Search-add is meaningful.
 *   - MiniMax (`https://api.minimax.io/anthropic/v1/models`): returns
 *     ~5 MiniMax-M2.x SKUs cleanly. Search-add is meaningful.
 *   - Kimi (`https://api.kimi.com/coding/v1/models`): returns 1 SKU
 *     (`kimi-for-coding`). Marginal but better than typing.
 *   - Volcengine (Ark): returns 100+ mixed text/audio/embedding/image —
 *     user explicitly excluded. Stays manual.
 *   - Bailian (DashScope): same shape as Volcengine.
 *   - Xiaomi MiMo Token Plan: empirically 404.
 *   - DeepSeek: empirically 404.
 *
 * Anything else is delegated to `canReliablyFetchModels` so we don't
 * duplicate the per-protocol case analysis. Image / cloud-direct / OAuth
 * etc. all fall through that helper's negative branches.
 */
export function canSearchUpstreamModels(
  record: { provider_type: string; base_url: string },
): { reliable: boolean; reasonZh: string; reasonEn: string } {
  // Catalog-only discovery gateways (ClinePass, OpenCode Go): unlike the plan
  // providers below (whose /v1/models is a clean per-vendor list), their model
  // endpoint is key-gated / mixed-protocol / a superset of the plan lineup, so
  // search-and-add is disabled in Phase 1. Checked before the
  // `isCatalogOnlyPlanProviderRecord` branch (which returns true) so these
  // override it to false.
  if (isCatalogOnlyDiscoveryRecord(record)) {
    return {
      reliable: false,
      reasonZh: '套餐型服务，模型由内置白名单定义，暂不支持在线搜索添加',
      reasonEn: 'Subscription provider — models come from a built-in whitelist; online search-and-add is disabled.',
    };
  }
  if (isOpenRouterProviderRecord(record)) {
    return { reliable: true, reasonZh: '', reasonEn: '' };
  }
  const preset = findMatchingPresetForRecord(record);
  // Explicit deny-list — empirically known to fail or return garbage.
  // Other plan presets (glm-cn / glm-global / minimax-cn / minimax-global)
  // fall through to reliable=true.
  // Empirical (2026-05-06):
  //   - volcengine: Ark mixed 100+ catalog (text/audio/image/embedding/
  //     deprecated) — clean SKU set untestable per Codex's call
  //   - bailian: `/v1/models` 404s on the Coding Plan host
  //     (`coding.dashscope.aliyuncs.com/apps/anthropic`); only
  //     `/v1/messages` exists. 401-vs-404 confirms not auth-gated.
  //   - bailian-token-plan-cn: same vendor / different host
  //     (`token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic`).
  //     Treated as manual-only by user policy: Token Plan 团队版 key
  //     is team-tier and not safe to probe with /v1/models from a
  //     shared client. Add SKUs via the manual dialog only.
  //   - xiaomi-mimo-token-plan: 404 on /v1/models
  //   - deepseek: 404 on /v1/models
  const manualOnlyKeys = new Set([
    'volcengine',
    'bailian',
    'bailian-token-plan-cn',
    'xiaomi-mimo-token-plan',
    'deepseek',
    'stepfun',
  ]);
  if (preset && manualOnlyKeys.has(preset.key)) {
    return {
      reliable: false,
      reasonZh: '该服务商的模型列表接口返回结果不适合作搜索来源，请用「添加模型」手动输入',
      reasonEn: "This provider's /v1/models output isn't suitable as a search source — use Add model to type the id manually.",
    };
  }
  // Plan providers not in the deny-list above (GLM, MiniMax, Xiaomi MiMo
  // PAYG): fall through and return reliable=true. The search-models
  // route passes `bypassUnsupportedGate: true` so the prober runs even
  // though `classifyProvider` would otherwise mark plan presets as
  // 'unsupported' for the write path.
  if (isCatalogOnlyPlanProviderRecord(record)) {
    return { reliable: true, reasonZh: '', reasonEn: '' };
  }
  // Everything else: defer to `canReliablyFetchModels` so categories
  // like image / cloud-direct / Anthropic official / OAuth get the
  // same negative answer they'd get for the refresh button.
  return canReliablyFetchModels(record);
}

/**
 * Server-safe preset matcher — equivalent to the renderer's
 * `findMatchingPreset` (in `components/settings/provider-presets.tsx`)
 * but operates on a plain {provider_type, base_url} record so it can be
 * called from API routes without React imports.
 */
export function findMatchingPresetForRecord(record: {
  provider_type: string;
  base_url: string;
}): VendorPreset | undefined {
  if (record.base_url) {
    const byBase = VENDOR_PRESETS.filter(p => p.baseUrl && p.baseUrl === record.base_url);
    // Prefer a base match whose protocol agrees with the record. Without this,
    // a legacy OpenCode Go Anthropic record (saved at the OpenAI half's base
    // `https://opencode.ai/zen/go/v1` before the Anthropic base was de-/v1'd)
    // would match `opencode-go-openai` and get the wrong bucket / runtime badge
    // / discovery class. A record whose provider_type isn't a real Protocol
    // (legacy / blank rows) can't be disambiguated, so it keeps the plain base
    // match; a known-but-mismatched protocol falls through to the type rules.
    const exact = byBase.find(p => p.protocol === record.provider_type)
      ?? (isValidProtocol(record.provider_type) ? undefined : byBase[0]);
    if (exact) return exact;
  }
  if (record.provider_type === 'bedrock') return getPreset('bedrock');
  if (record.provider_type === 'vertex') return getPreset('vertex');
  if (record.provider_type === 'openrouter') return getPreset('openrouter');
  if (record.provider_type === 'gemini-image') {
    const official = getPreset('gemini-image');
    if (official && record.base_url && record.base_url !== official.baseUrl) {
      return getPreset('gemini-image-thirdparty');
    }
    return official;
  }
  if (record.provider_type === 'openai-image') {
    const official = getPreset('openai-image');
    if (official && record.base_url && record.base_url !== official.baseUrl) {
      return getPreset('openai-image-thirdparty');
    }
    return official;
  }
  // Generic OpenAI-compatible third-party gateway with a user-supplied URL —
  // fall back to the generic `openai-compatible` preset so getProviderCompat
  // classifies it as `codepilot_only` (CodePilot + Codex runtimes), not
  // `unknown` (which would wrongly expose it to Claude Code and gate Codex).
  if (record.provider_type === 'openai-compatible') {
    return getPreset('openai-compatible');
  }
  // Generic Anthropic-compat with a custom URL (PipeLLM / Aiberm / DeepSeek
  // /anthropic / etc.) — fall back to the `anthropic-thirdparty` preset so
  // they pick up its defaults (sonnet/opus/haiku as enabled baseline).
  if (record.provider_type === 'anthropic') {
    return getPreset('anthropic-thirdparty');
  }
  return undefined;
}

/** All valid Protocol union values — used for raw-field validation. */
export const VALID_PROTOCOLS = new Set<Protocol>([
  'anthropic',
  'openai-compatible',
  'openrouter',
  'bedrock',
  'vertex',
  'google',
  'gemini-image',
  'openai-image',
]);

/** Type guard for raw protocol strings coming from API bodies or legacy DB. */
export function isValidProtocol(value: unknown): value is Protocol {
  return typeof value === 'string' && VALID_PROTOCOLS.has(value as Protocol);
}

/**
 * Compute the effective protocol for a provider — prefer the raw protocol
 * field if it's a known Protocol value, otherwise fall back to
 * inferProtocolFromLegacy(provider_type, base_url). Use this everywhere
 * a write path, resolver, or diagnostic needs the "real" protocol: raw
 * provider.protocol can legitimately be '' on legacy rows, and the POST
 * API can see body.protocol === undefined from older clients.
 */
export function getEffectiveProviderProtocol(
  providerType: string,
  protocol: string | undefined,
  baseUrl: string,
): Protocol {
  if (protocol && VALID_PROTOCOLS.has(protocol as Protocol)) {
    return protocol as Protocol;
  }
  return inferProtocolFromLegacy(providerType, baseUrl);
}

/**
 * Infer the protocol from a legacy provider_type.
 * Used during migration from the old system.
 */
export function inferProtocolFromLegacy(
  providerType: string,
  baseUrl: string,
): Protocol {
  // Direct type mappings
  if (providerType === 'anthropic') return 'anthropic';
  if (providerType === 'openai-compatible') return 'openai-compatible';
  if (providerType === 'openrouter') return 'openrouter';
  if (providerType === 'bedrock') return 'bedrock';
  if (providerType === 'vertex') return 'vertex';
  if (providerType === 'gemini-image') return 'gemini-image';
  if (providerType === 'openai-image') return 'openai-image';

  // For 'custom' type, check if the base_url matches a known Anthropic-compatible vendor
  if (providerType === 'custom') {
    const anthropicUrls = [
      'bigmodel.cn', 'z.ai',            // GLM
      'kimi.com', 'moonshot.cn', 'moonshot.ai',  // Kimi/Moonshot
      'minimaxi.com', 'minimax.io',     // MiniMax
      'volces.com', 'volcengine.com',   // Volcengine
      'dashscope.aliyuncs.com',         // Bailian Coding Plan
      'maas.aliyuncs.com',              // Bailian Token Plan 团队版
      'xiaomimimo.com',                 // Xiaomi MiMo
      'localhost:11434',                // Ollama
    ];
    const urlLower = baseUrl.toLowerCase();
    if (anthropicUrls.some(u => urlLower.includes(u))) {
      return 'anthropic';
    }
    // Check if URL contains 'anthropic' in the path
    if (urlLower.includes('/anthropic')) {
      return 'anthropic';
    }
    // Default custom → anthropic (SDK only supports Anthropic-compatible endpoints)
    return 'anthropic';
  }

  return 'anthropic';
}

/**
 * Infer the auth style from a legacy provider.
 * Checks extra_env to determine if it uses AUTH_TOKEN vs API_KEY.
 */
export function inferAuthStyleFromLegacy(
  providerType: string,
  extraEnv: string,
): AuthStyle {
  if (providerType === 'bedrock' || providerType === 'vertex') return 'env_only';

  try {
    const env = JSON.parse(extraEnv || '{}');
    if ('ANTHROPIC_AUTH_TOKEN' in env) return 'auth_token';
  } catch { /* fallthrough */ }

  return 'api_key';
}

/**
 * Find a matching vendor preset for a legacy provider.
 * Matches by base_url first, then by provider_type.
 * When `protocol` is provided, fuzzy (hostname) matching is restricted to
 * presets with the same protocol to avoid misclassifying cross-protocol
 * providers that share the same host (e.g. dashscope OpenAI-compatible vs Bailian Anthropic).
 */
export function findPresetForLegacy(baseUrl: string, providerType: string, protocol?: Protocol): VendorPreset | undefined {
  // Exact base_url match (most specific). When a protocol is supplied, the
  // match must agree with it — otherwise an openai-compatible chat provider
  // configured with https://api.openai.com/v1 would land on the openai-image
  // preset and inherit the GPT Image catalog for chat model selection.
  // Fuzzy match (below) already applies this guard; the exact branch must
  // too, now that multiple presets share the same canonical URL.
  if (baseUrl) {
    const match = VENDOR_PRESETS.find(p => {
      if (p.baseUrl !== baseUrl) return false;
      if (protocol && p.protocol !== protocol) return false;
      return true;
    });
    if (match) return match;

    // Fuzzy match: legacy entries may have old URLs (e.g. minimaxi.com/anthropic
    // before /v1 suffix was added). Match by domain substring against presets.
    const urlLower = baseUrl.toLowerCase();
    const fuzzy = VENDOR_PRESETS.find(p => {
      if (!p.baseUrl) return false;
      if (protocol && p.protocol !== protocol) return false;
      try {
        const presetHost = new URL(p.baseUrl).hostname;
        return urlLower.includes(presetHost);
      } catch { return false; }
    });
    if (fuzzy) return fuzzy;
  }

  // Type-based fallback
  if (providerType === 'bedrock') return VENDOR_PRESETS.find(p => p.key === 'bedrock');
  if (providerType === 'vertex') return VENDOR_PRESETS.find(p => p.key === 'vertex');
  if (providerType === 'openrouter') return VENDOR_PRESETS.find(p => p.key === 'openrouter');
  // Media provider fallbacks: prefer the third-party preset when baseUrl was
  // provided but didn't match the official host (the exact-match branch above
  // already returned the official preset when baseUrl === official).
  if (providerType === 'gemini-image') {
    if (baseUrl) return VENDOR_PRESETS.find(p => p.key === 'gemini-image-thirdparty');
    return VENDOR_PRESETS.find(p => p.key === 'gemini-image');
  }
  if (providerType === 'openai-image') {
    if (baseUrl) return VENDOR_PRESETS.find(p => p.key === 'openai-image-thirdparty');
    return VENDOR_PRESETS.find(p => p.key === 'openai-image');
  }
  if (providerType === 'anthropic' && baseUrl === 'https://api.anthropic.com') {
    return VENDOR_PRESETS.find(p => p.key === 'anthropic-official');
  }

  return undefined;
}

/**
 * Get the default models for a provider based on its catalog preset.
 * If the provider has a matching preset, returns the preset's defaultModels.
 * Otherwise returns a protocol-appropriate fallback catalog.
 *
 * @param providerType — legacy provider_type string from DB (e.g. 'anthropic',
 *   'bedrock'). Used to disambiguate baseUrl='' cases: a legacy
 *   anthropic-typed provider with an empty baseUrl migrated from older
 *   settings is treated as the official Anthropic endpoint (first-party
 *   catalog), not a generic third-party proxy.
 */
export function getDefaultModelsForProvider(
  protocol: Protocol,
  baseUrl: string,
  providerType?: string,
): CatalogModel[] {
  // Try to find a preset by exact base_url. Protocol must agree — otherwise
  // an openai-compatible chat provider configured with
  // https://api.openai.com/v1 would match the openai-image preset and
  // inherit the GPT Image catalog for chat model selection.
  const preset = VENDOR_PRESETS.find(
    p => p.baseUrl && p.baseUrl === baseUrl && p.protocol === protocol,
  );
  if (preset) {
    // Preset matched — return its models even if empty (e.g. Volcengine
    // requires users to specify their own model names, so defaultModels is []).
    return preset.defaultModels;
  }

  // Fuzzy match: legacy providers may have old URLs (e.g. minimaxi.com/anthropic/v1
  // before the /v1 suffix was removed). Match by domain substring against presets,
  // but only when the protocol matches to avoid misclassifying custom OpenAI-compatible
  // providers that share the same host (e.g. dashscope.aliyuncs.com/compatible-mode/v1).
  if (baseUrl) {
    const urlLower = baseUrl.toLowerCase();
    const fuzzy = VENDOR_PRESETS.find(p => {
      if (!p.baseUrl || p.protocol !== protocol) return false;
      try {
        const presetHost = new URL(p.baseUrl).hostname;
        return urlLower.includes(presetHost);
      } catch { return false; }
    });
    if (fuzzy) return fuzzy.defaultModels;
  }

  // Legacy first-party Anthropic: migrated Default providers have
  // provider_type='anthropic' with base_url=''. The native runtime
  // treats them as the official @ai-sdk/anthropic endpoint, so they
  // must resolve opus to the concrete claude-opus-4-7 upstream (same
  // as the anthropic-official preset). Without this branch they'd
  // fall through to the alias-only catalog and bypass the 4.7
  // sanitizer, 1M context, and xhigh metadata.
  if (protocol === 'anthropic' && !baseUrl && providerType === 'anthropic') {
    return ANTHROPIC_FIRST_PARTY_MODELS;
  }

  // Protocol-based defaults (only when no preset matched).
  // Bedrock/Vertex get the alias-only catalog with Opus 4.6 labels because
  // their DB-backed provider has baseUrl='' and the preset match above
  // never fires. Without this branch, they'd fall through to the shared
  // Anthropic catalog and mis-resolve opus as first-party Opus 4.7.
  if (protocol === 'bedrock' || protocol === 'vertex') {
    return BEDROCK_VERTEX_DEFAULT_MODELS;
  }
  if (protocol === 'anthropic' || protocol === 'openrouter') {
    return ANTHROPIC_DEFAULT_MODELS;
  }
  // Media protocols: a third-party provider pointing at a custom proxy URL
  // won't match an exact or fuzzy host, so fall back to the third-party
  // preset's default catalog to surface the standard GPT Image / Nano Banana
  // model list in the settings UI.
  if (protocol === 'gemini-image') {
    const p = VENDOR_PRESETS.find(x => x.key === 'gemini-image-thirdparty');
    return p?.defaultModels ?? [];
  }
  if (protocol === 'openai-image') {
    const p = VENDOR_PRESETS.find(x => x.key === 'openai-image-thirdparty');
    return p?.defaultModels ?? [];
  }

  return [];
}
