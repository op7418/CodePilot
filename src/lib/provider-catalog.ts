/**
 * Provider Catalog — vendor presets, protocol definitions, and default model catalogs.
 *
 * This is the single source of truth for:
 * - Which protocol a vendor uses (anthropic, openai-compatible, bedrock, vertex, etc.)
 * - Default env overrides each vendor needs for Claude Code SDK
 * - Default model catalogs (role → upstream model id mapping)
 * - Auth key injection style (ANTHROPIC_API_KEY vs ANTHROPIC_AUTH_TOKEN)
 */

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
  | 'gemini-image';       // Google Gemini image generation

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
  fields: ('name' | 'api_key' | 'base_url' | 'env_overrides' | 'model_names')[];
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
}

// ── Default Anthropic models ────────────────────────────────────

const ANTHROPIC_DEFAULT_MODELS: CatalogModel[] = [
  { modelId: 'sonnet', displayName: 'Sonnet 4.6', role: 'sonnet' },
  { modelId: 'opus', displayName: 'Opus 4.6', role: 'opus' },
  { modelId: 'haiku', displayName: 'Haiku 4.5', role: 'haiku' },
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
    defaultModels: ANTHROPIC_DEFAULT_MODELS,
    fields: ['api_key'],
    iconKey: 'anthropic',
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
    fields: ['name', 'api_key', 'base_url', 'env_overrides', 'model_names'],
    iconKey: 'anthropic',
  },

  // ── OpenRouter ──
  {
    key: 'openrouter',
    name: 'OpenRouter',
    description: 'Use OpenRouter to access multiple models',
    descriptionZh: '通过 OpenRouter 访问多种模型',
    protocol: 'openrouter',
    authStyle: 'api_key',
    baseUrl: 'https://openrouter.ai/api',
    defaultEnvOverrides: { ANTHROPIC_API_KEY: '' },
    defaultModels: ANTHROPIC_DEFAULT_MODELS,
    fields: ['api_key'],
    iconKey: 'openrouter',
  },

  // ── Zhipu GLM (China) ──
  {
    key: 'glm-cn',
    name: 'GLM (CN)',
    description: 'Zhipu GLM Code Plan — China region',
    descriptionZh: '智谱 GLM 编程套餐 — 中国区',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    defaultEnvOverrides: { API_TIMEOUT_MS: '3000000', ANTHROPIC_API_KEY: '', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5-turbo', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.1' },
    defaultModels: [
      { modelId: 'sonnet', upstreamModelId: 'sonnet', displayName: 'GLM-5-Turbo', role: 'sonnet' },
      { modelId: 'opus', upstreamModelId: 'opus', displayName: 'GLM-5.1', role: 'opus' },
      { modelId: 'haiku', upstreamModelId: 'haiku', displayName: 'GLM-4.5-Air', role: 'haiku' },
    ],
    fields: ['api_key'],
    iconKey: 'zhipu',
    sdkProxyOnly: true,
  },

  // ── Zhipu GLM (Global) ──
  {
    key: 'glm-global',
    name: 'GLM (Global)',
    description: 'Zhipu GLM Code Plan — Global region',
    descriptionZh: '智谱 GLM 编程套餐 — 国际区',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: 'https://api.z.ai/api/anthropic',
    defaultEnvOverrides: { API_TIMEOUT_MS: '3000000', ANTHROPIC_API_KEY: '', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5-turbo', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.1' },
    defaultModels: [
      { modelId: 'sonnet', upstreamModelId: 'sonnet', displayName: 'GLM-5-Turbo', role: 'sonnet' },
      { modelId: 'opus', upstreamModelId: 'opus', displayName: 'GLM-5.1', role: 'opus' },
      { modelId: 'haiku', upstreamModelId: 'haiku', displayName: 'GLM-4.5-Air', role: 'haiku' },
    ],
    fields: ['api_key'],
    iconKey: 'zhipu',
    sdkProxyOnly: true,
  },

  // ── Kimi ──
  {
    key: 'kimi',
    name: 'Kimi Coding Plan',
    description: 'Kimi Coding Plan API',
    descriptionZh: 'Kimi 编程计划 API',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.kimi.com/coding/',
    defaultEnvOverrides: { ANTHROPIC_AUTH_TOKEN: '' },
    defaultModels: [
      { modelId: 'sonnet', displayName: 'Kimi K2.5', role: 'default' },
    ],
    fields: ['api_key'],
    iconKey: 'kimi',
    sdkProxyOnly: true,
  },

  // ── Moonshot ──
  {
    key: 'moonshot',
    name: 'Moonshot',
    description: 'Moonshot AI API',
    descriptionZh: '月之暗面 API',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    defaultEnvOverrides: { ANTHROPIC_API_KEY: '' },
    defaultModels: [
      { modelId: 'sonnet', displayName: 'Kimi K2.5', role: 'default' },
    ],
    fields: ['api_key'],
    iconKey: 'moonshot',
    sdkProxyOnly: true,
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
      ANTHROPIC_AUTH_TOKEN: '',
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
      ANTHROPIC_AUTH_TOKEN: '',
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
    defaultEnvOverrides: { ANTHROPIC_AUTH_TOKEN: '' },
    defaultModels: [],  // User must specify model_names
    fields: ['api_key', 'model_names'],
    iconKey: 'volcengine',
    sdkProxyOnly: true,
  },

  // ── Xiaomi MiMo (按量付费) ──
  {
    key: 'xiaomi-mimo',
    name: 'Xiaomi MiMo',
    description: 'Xiaomi MiMo Pay-as-you-go API — MiMo-V2-Pro',
    descriptionZh: '小米 MiMo 按量付费 — MiMo-V2-Pro',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    defaultEnvOverrides: {
      ANTHROPIC_AUTH_TOKEN: '',
    },
    defaultModels: [
      { modelId: 'sonnet', upstreamModelId: 'mimo-v2-pro', displayName: 'MiMo-V2-Pro', role: 'default' },
    ],
    defaultRoleModels: {
      default: 'mimo-v2-pro',
      sonnet: 'mimo-v2-pro',
      opus: 'mimo-v2-pro',
      haiku: 'mimo-v2-pro',
    },
    fields: ['api_key'],
    iconKey: 'xiaomi-mimo',
    sdkProxyOnly: true,
  },

  // ── Xiaomi MiMo Token Plan (订阅套餐) ──
  {
    key: 'xiaomi-mimo-token-plan',
    name: 'Xiaomi MiMo Token Plan',
    description: 'Xiaomi MiMo Token Plan subscription — MiMo-V2-Pro',
    descriptionZh: '小米 MiMo Token Plan 订阅套餐 — MiMo-V2-Pro',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    defaultEnvOverrides: {
      ANTHROPIC_AUTH_TOKEN: '',
    },
    defaultModels: [
      { modelId: 'sonnet', upstreamModelId: 'mimo-v2-pro', displayName: 'MiMo-V2-Pro', role: 'default' },
    ],
    defaultRoleModels: {
      default: 'mimo-v2-pro',
      sonnet: 'mimo-v2-pro',
      opus: 'mimo-v2-pro',
      haiku: 'mimo-v2-pro',
    },
    fields: ['api_key'],
    iconKey: 'xiaomi-mimo',
    sdkProxyOnly: true,
  },

  // ── Aliyun Bailian ──
  {
    key: 'bailian',
    name: 'Aliyun Bailian',
    description: 'Aliyun Bailian Coding Plan — Qwen, GLM, Kimi, MiniMax',
    descriptionZh: '阿里云百炼 Coding Plan — 通义千问、GLM、Kimi、MiniMax',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    defaultEnvOverrides: { ANTHROPIC_API_KEY: '' },
    defaultModels: [
      { modelId: 'qwen3.5-plus', displayName: 'Qwen 3.5 Plus', role: 'default' },
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
    defaultModels: ANTHROPIC_DEFAULT_MODELS,
    fields: ['env_overrides'],
    iconKey: 'bedrock',
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
    defaultModels: ANTHROPIC_DEFAULT_MODELS,
    fields: ['env_overrides'],
    iconKey: 'google',
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
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      ANTHROPIC_API_KEY: '',
    },
    defaultModels: [],  // User must specify — depends on pulled models
    fields: ['base_url', 'model_names'],
    iconKey: 'ollama',
    sdkProxyOnly: true,
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
  },

];

// ── Lookup helpers ──────────────────────────────────────────────

/** Get a preset by key. */
export function getPreset(key: string): VendorPreset | undefined {
  return VENDOR_PRESETS.find(p => p.key === key);
}

/** Get all presets for a given category (defaults to 'chat'). */
export function getPresetsByCategory(category: 'chat' | 'media' = 'chat'): VendorPreset[] {
  return VENDOR_PRESETS.filter(p => (p.category || 'chat') === category);
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
  // Exact base_url match (most specific)
  if (baseUrl) {
    const match = VENDOR_PRESETS.find(p => p.baseUrl === baseUrl);
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
  if (providerType === 'gemini-image') return VENDOR_PRESETS.find(p => p.key === 'gemini-image');
  if (providerType === 'anthropic' && baseUrl === 'https://api.anthropic.com') {
    return VENDOR_PRESETS.find(p => p.key === 'anthropic-official');
  }

  return undefined;
}

/**
 * Get the default models for a provider based on its catalog preset.
 * If the provider has a matching preset, returns the preset's defaultModels.
 * Otherwise returns the Anthropic default models.
 */
export function getDefaultModelsForProvider(
  protocol: Protocol,
  baseUrl: string,
): CatalogModel[] {
  // Try to find a preset by exact base_url
  const preset = VENDOR_PRESETS.find(p => p.baseUrl && p.baseUrl === baseUrl);
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

  // Protocol-based defaults (only when no preset matched)
  if (protocol === 'anthropic' || protocol === 'openrouter' || protocol === 'bedrock' || protocol === 'vertex') {
    return ANTHROPIC_DEFAULT_MODELS;
  }

  return [];
}
