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
    displayName: 'Opus',
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

// First-party Anthropic API (anthropic-official preset) — pins opus to
// the explicit upstream ID so resolved.upstreamModel carries a concrete
// model name downstream. This unblocks the Opus 4.7 sanitizer regex
// in claude-model-options.ts (which matches upstream IDs, not aliases)
// and guarantees the native path doesn't forward the bare "opus"
// alias to @ai-sdk/anthropic.
const ANTHROPIC_FIRST_PARTY_MODELS: CatalogModel[] = [
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
    modelId: 'haiku',
    displayName: 'Haiku 4.5',
    role: 'haiku',
    capabilities: {
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
    },
  },
];

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
    defaultModels: ANTHROPIC_DEFAULT_MODELS,
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
      { modelId: 'MiniMax-M3', upstreamModelId: 'MiniMax-M3', displayName: 'MiniMax-M3', role: 'default' },
      { modelId: 'MiniMax-M2.7', upstreamModelId: 'MiniMax-M2.7', displayName: 'MiniMax-M2.7' },
    ],
    defaultRoleModels: {
      default: 'MiniMax-M3',
      sonnet: 'MiniMax-M3',
      opus: 'MiniMax-M3',
      haiku: 'MiniMax-M2.7',
    },
    fields: ['api_key'],
    iconKey: 'minimax',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.minimaxi.com/user-center/payment/token-plan',
      docsUrl: 'https://platform.minimaxi.com/docs/token-plan/claude-code',
      billingModel: 'token_plan',
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
      { modelId: 'MiniMax-M3', upstreamModelId: 'MiniMax-M3', displayName: 'MiniMax-M3', role: 'default' },
      { modelId: 'MiniMax-M2.7', upstreamModelId: 'MiniMax-M2.7', displayName: 'MiniMax-M2.7' },
    ],
    defaultRoleModels: {
      default: 'MiniMax-M3',
      sonnet: 'MiniMax-M3',
      opus: 'MiniMax-M3',
      haiku: 'MiniMax-M2.7',
    },
    fields: ['api_key'],
    iconKey: 'minimax',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.minimax.io/user-center/payment/token-plan',
      docsUrl: 'https://platform.minimax.io/docs/token-plan/opencode',
      billingModel: 'token_plan',
    },
  },

  // ── DeepSeek ──
  {
    key: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek Anthropic-compatible API — V4 Pro / V4 Flash',
    descriptionZh: 'DeepSeek Anthropic 兼容 API — V4 Pro / V4 Flash',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.deepseek.com/anthropic',
    defaultEnvOverrides: {
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-pro',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
    },
    defaultModels: [
      { modelId: 'sonnet', upstreamModelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', role: 'default' },
      { modelId: 'opus', upstreamModelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', role: 'opus' },
      { modelId: 'haiku', upstreamModelId: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', role: 'haiku' },
    ],
    defaultRoleModels: {
      default: 'deepseek-v4-pro',
      sonnet: 'deepseek-v4-pro',
      opus: 'deepseek-v4-pro',
      haiku: 'deepseek-v4-flash',
    },
    fields: ['api_key'],
    iconKey: 'deepseek',
    meta: {
      apiKeyUrl: 'https://platform.deepseek.com/api_keys',
      docsUrl: 'https://platform.deepseek.com/docs',
      billingModel: 'pay_as_you_go',
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
    defaultModels: [],  // User must specify model_names
    fields: ['api_key', 'model_names'],
    iconKey: 'volcengine',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement',
      docsUrl: 'https://www.volcengine.com/docs/82379/1928262',
      billingModel: 'coding_plan',
      notes: ['需先在控制台激活 Endpoint', 'API Key 为临时凭证'],
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
    ],
    defaultRoleModels: {
      default: 'mimo-v2.5-pro',
      sonnet: 'mimo-v2.5-pro',
      opus: 'mimo-v2.5-pro',
      haiku: 'mimo-v2.5-pro',
    },
    fields: ['api_key'],
    iconKey: 'xiaomi-mimo',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
      docsUrl: 'https://platform.xiaomimimo.com/#/docs/integration/claudecode',
      billingModel: 'pay_as_you_go',
      notes: [],
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
    fields: ['api_key'],
    iconKey: 'xiaomi-mimo',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.xiaomimimo.com/#/console/plan-manage',
      docsUrl: 'https://platform.xiaomimimo.com/#/docs/integration/claudecode',
      billingModel: 'token_plan',
      notes: [],
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
    defaultModels: [
      { modelId: 'qwen3.6-plus', displayName: 'Qwen 3.6 Plus', role: 'default' },
      { modelId: 'qwen3-coder-next', displayName: 'Qwen 3 Coder Next' },
      { modelId: 'qwen3-coder-plus', displayName: 'Qwen 3 Coder Plus' },
      { modelId: 'kimi-k2.5', displayName: 'Kimi K2.5' },
      { modelId: 'glm-5', displayName: 'GLM-5' },
      { modelId: 'glm-4.7', displayName: 'GLM-4.7' },
    ],
    fields: ['api_key'],
    iconKey: 'bailian',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://bailian.console.aliyun.com',
      docsUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan',
      billingModel: 'coding_plan',
      notes: ['必须使用 Coding Plan 专用 Key（以 sk-sp- 开头）', '普通 DashScope Key 无法使用', '禁止用于自动化脚本'],
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

/** Get all presets for a given category (defaults to 'chat'). */
export function getPresetsByCategory(category: 'chat' | 'media' = 'chat'): VendorPreset[] {
  return VENDOR_PRESETS.filter(p => (p.category || 'chat') === category);
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
      'dashscope.aliyuncs.com',         // Bailian
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
