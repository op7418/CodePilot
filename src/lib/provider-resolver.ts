/**
 * Provider Resolver — unified provider/model resolution for all consumers.
 *
 * Every entry point (chat, bridge, onboarding, check-in, media plan) calls
 * this module instead of doing its own provider resolution. This guarantees
 * the same provider+model+protocol+env for the same inputs everywhere.
 */

import type { ApiProvider } from '@/types';
import {
  type Protocol,
  type AuthStyle,
  type CatalogModel,
  type RoleModels,
  inferProtocolFromLegacy,
  inferAuthStyleFromLegacy,
  getDefaultModelsForProvider,
  findPresetForLegacy,
} from './provider-catalog';
import {
  getProvider,
  getDefaultProviderId,
  getActiveProvider,
  getSetting,
  getModelsForProvider,
  getProviderOptions,
} from './db';
import { ensureTokenFresh } from './openai-oauth-manager';
import { CODEX_API_ENDPOINT } from './openai-oauth';

// ── Resolution result ───────────────────────────────────────────

export interface ResolvedProvider {
  /** The DB provider record (undefined = use env vars) */
  provider: ApiProvider | undefined;
  /** Wire protocol */
  protocol: Protocol;
  /** Auth style */
  authStyle: AuthStyle;
  /** Resolved model ID (internal/UI model ID) */
  model: string | undefined;
  /** Upstream model ID (what actually gets sent to the API — may differ from model) */
  upstreamModel: string | undefined;
  /** Display name for the model */
  modelDisplayName: string | undefined;
  /** Extra headers (parsed from headers_json or empty) */
  headers: Record<string, string>;
  /** Environment overrides (parsed from env_overrides_json / extra_env) */
  envOverrides: Record<string, string>;
  /** Role models mapping (parsed from role_models_json or inferred from catalog) */
  roleModels: RoleModels;
  /** Whether the provider has usable credentials */
  hasCredentials: boolean;
  /** Available models for this provider */
  availableModels: CatalogModel[];
  /** Settings sources for Claude Code SDK */
  settingSources: string[];
  /** Internal: true when resolved as OpenAI OAuth (Codex API) virtual provider */
  _openaiOAuth?: boolean;
}

// ── Public API ──────────────────────────────────────────────────

export interface ResolveOptions {
  /** Explicit provider ID from request (highest priority) */
  providerId?: string;
  /** Session's stored provider ID */
  sessionProviderId?: string;
  /** Requested model */
  model?: string;
  /** Session's stored model */
  sessionModel?: string;
  /** Use case — affects which role model to pick */
  useCase?: 'default' | 'reasoning' | 'small';
}

/**
 * Resolve a provider + model for any consumer.
 *
 * Priority chain (same everywhere):
 * 1. Explicit providerId in request
 * 2. Session's provider_id
 * 3. Global default_provider_id
 * 4. Environment variables (resolvedProvider = undefined)
 *
 * Special value 'env' = use environment variables (skip DB lookup).
 */
export function resolveProvider(opts: ResolveOptions = {}): ResolvedProvider {
  const effectiveProviderId = opts.providerId || opts.sessionProviderId || '';

  let provider: ApiProvider | undefined;

  // Determine if the ID came from an explicit request (providerId) or
  // from the session — only explicit requests should skip the inactive check.
  const isExplicitRequest = !!opts.providerId;

  // Special virtual provider: OpenAI OAuth (Codex API)
  if (effectiveProviderId === 'openai-oauth') {
    return buildOpenAIOAuthResolution(opts);
  }

  if (effectiveProviderId && effectiveProviderId !== 'env') {
    // Look up the requested provider
    provider = getProvider(effectiveProviderId);

    // For non-explicit sources (session provider, fallback chain), skip
    // inactive providers — a stale session may point to a deactivated
    // provider (e.g. Google Gemini Image that was turned off).
    if (provider && !provider.is_active && !isExplicitRequest) {
      console.warn(`[provider-resolver] Provider "${provider.name}" (${effectiveProviderId}) is inactive, falling back`);
      provider = undefined;
    }

    if (!provider) {
      // Requested provider not found (or inactive session provider),
      // fall back to default → any active
      const defaultId = getDefaultProviderId();
      if (defaultId && defaultId !== effectiveProviderId) {
        const defaultProvider = getProvider(defaultId);
        if (defaultProvider?.is_active) provider = defaultProvider;
      }
      if (!provider) {
        provider = getActiveProvider();
      }
    }
  } else if (!effectiveProviderId) {
    // No provider specified — use global default
    const defaultId = getDefaultProviderId();
    if (defaultId) {
      const defaultProvider = getProvider(defaultId);
      // Only use default if it's active
      if (defaultProvider?.is_active) {
        provider = defaultProvider;
      } else if (defaultProvider) {
        console.warn(`[provider-resolver] Default provider "${defaultProvider.name}" (${defaultId}) is inactive, falling back`);
      }
    }
    // If no active default, try any active provider
    if (!provider) {
      provider = getActiveProvider();
    }
  }
  // effectiveProviderId === 'env' → provider stays undefined

  return buildResolution(provider, opts);
}

/**
 * Resolve provider for the Claude Code SDK subprocess (used by claude-client.ts).
 * Uses the same resolution chain but also checks getActiveProvider() for backwards compat.
 *
 * Important: if resolveProvider() intentionally returned provider=undefined (e.g. user
 * selected 'env'), we respect that and do NOT fall back to getActiveProvider().
 */
export function resolveForClaudeCode(
  explicitProvider?: ApiProvider,
  opts: ResolveOptions = {},
): ResolvedProvider {
  if (explicitProvider && explicitProvider.is_active) {
    return buildResolution(explicitProvider, opts);
  }
  if (explicitProvider && !explicitProvider.is_active) {
    console.warn(`[provider-resolver] Explicit provider "${explicitProvider.name}" is inactive, re-resolving`);
  }
  const resolved = resolveProvider(opts);
  // Only fall back to getActiveProvider() when NO provider resolution was attempted
  // (i.e. no explicit ID, no session ID, no global default). If the resolver ran and
  // returned provider=undefined (env mode), respect that decision.
  if (!resolved.provider && !opts.providerId && !opts.sessionProviderId) {
    const defaultId = getDefaultProviderId();
    if (!defaultId) {
      // No default configured either — last resort backwards compat
      const active = getActiveProvider();
      if (active) return buildResolution(active, opts);
    }
  }
  return resolved;
}

// ── Claude Code env builder ─────────────────────────────────────

/**
 * Build environment variables for a Claude Code SDK subprocess.
 * Replaces the inline env-building logic in claude-client.ts.
 *
 * @param baseEnv - Process environment (usually { ...process.env })
 * @param resolved - Output from resolveProvider/resolveForClaudeCode
 * @returns Clean env suitable for the SDK subprocess
 */
export function toClaudeCodeEnv(
  baseEnv: Record<string, string>,
  resolved: ResolvedProvider,
): Record<string, string> {
  const env = { ...baseEnv };

  // Managed env vars that must be cleaned when switching providers to prevent leaks
  const MANAGED_ENV_KEYS = new Set([
    'API_TIMEOUT_MS',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
    'CLAUDE_CODE_SKIP_VERTEX_AUTH',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'ENABLE_TOOL_SEARCH',
    'AWS_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'CLOUD_ML_REGION',
    'ANTHROPIC_PROJECT_ID',
    'GEMINI_API_KEY',
  ]);

  if (resolved.provider && resolved.hasCredentials) {
    // Clear all ANTHROPIC_* variables AND managed env vars to prevent cross-provider leaks
    for (const key of Object.keys(env)) {
      if (key.startsWith('ANTHROPIC_') || MANAGED_ENV_KEYS.has(key)) {
        delete env[key];
      }
    }

    // Inject auth based on style
    const apiKey = resolved.provider.api_key;
    if (apiKey) {
      switch (resolved.authStyle) {
        case 'auth_token':
          env.ANTHROPIC_AUTH_TOKEN = apiKey;
          env.ANTHROPIC_API_KEY = '';  // Explicitly empty — required by Ollama and other auth_token providers
          break;
        case 'api_key':
        default:
          env.ANTHROPIC_AUTH_TOKEN = apiKey;
          env.ANTHROPIC_API_KEY = apiKey;
          break;
      }
    }

    // Inject base URL
    if (resolved.provider.base_url) {
      env.ANTHROPIC_BASE_URL = resolved.provider.base_url;
    }

    // Inject role models as env vars
    if (resolved.roleModels.default) {
      env.ANTHROPIC_MODEL = resolved.roleModels.default;
    }
    if (resolved.roleModels.reasoning) {
      env.ANTHROPIC_REASONING_MODEL = resolved.roleModels.reasoning;
    }
    if (resolved.roleModels.small) {
      env.ANTHROPIC_SMALL_FAST_MODEL = resolved.roleModels.small;
    }
    if (resolved.roleModels.haiku) {
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = resolved.roleModels.haiku;
    }
    if (resolved.roleModels.sonnet) {
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = resolved.roleModels.sonnet;
    }
    if (resolved.roleModels.opus) {
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = resolved.roleModels.opus;
    }

    // Inject extra headers
    for (const [k, v] of Object.entries(resolved.headers)) {
      if (v) env[k] = v;
    }

    // Inject env overrides (empty string = delete).
    // Skip auth-related keys — they were already correctly injected above based on authStyle.
    // Legacy extra_env often contains placeholder entries like {"ANTHROPIC_AUTH_TOKEN":""} or
    // {"ANTHROPIC_API_KEY":""} that would delete the freshly-injected credentials.
    const AUTH_ENV_KEYS = new Set([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
    ]);
    for (const [key, value] of Object.entries(resolved.envOverrides)) {
      if (AUTH_ENV_KEYS.has(key)) continue; // already handled by auth injection
      if (typeof value === 'string') {
        if (value === '') {
          delete env[key];
        } else {
          env[key] = value;
        }
      }
    }
  } else if (!resolved.provider) {
    // No provider — check legacy DB settings, then fall back to existing env
    const appToken = getSetting('anthropic_auth_token');
    const appBaseUrl = getSetting('anthropic_base_url');
    if (appToken) env.ANTHROPIC_AUTH_TOKEN = appToken;
    if (appBaseUrl) env.ANTHROPIC_BASE_URL = appBaseUrl;
  }

  return env;
}

// ── AI SDK config builder ───────────────────────────────────────

export interface AiSdkConfig {
  /** Which AI SDK factory to use */
  sdkType: 'anthropic' | 'openai' | 'google' | 'bedrock' | 'vertex' | 'claude-code-compat';
  /** API key to pass to the SDK (mutually exclusive with authToken for Anthropic) */
  apiKey: string | undefined;
  /** Auth token (Bearer) for Anthropic auth_token providers (mutually exclusive with apiKey) */
  authToken: string | undefined;
  /** Base URL to pass to the SDK */
  baseUrl: string | undefined;
  /** The model ID to request (upstream/API model ID) */
  modelId: string;
  /** Extra headers to pass to the SDK client */
  headers: Record<string, string>;
  /** Extra env vars to inject into process.env before SDK call */
  processEnvInjections: Record<string, string>;
  /** Use OpenAI Responses API instead of Chat Completions (for Codex API) */
  useResponsesApi?: boolean;
}

/**
 * Build configuration for the Vercel AI SDK (used by text-generator.ts).
 * Replaces the inline provider-type branching in text-generator.ts.
 */
export function toAiSdkConfig(
  resolved: ResolvedProvider,
  modelOverride?: string,
): AiSdkConfig {
  // Resolve the upstream model ID (the actual API model name).
  // If modelOverride is given (from caller), check if it maps to a different upstream ID
  // in the provider's available models. This prevents callers from accidentally passing
  // the internal/UI model ID when the upstream API expects a different name.
  let modelId: string;
  if (modelOverride) {
    // 1. Try availableModels catalog (upstreamModelId)
    const catalogEntry = resolved.availableModels.find(m => m.modelId === modelOverride);
    modelId = catalogEntry?.upstreamModelId || modelOverride;

    // 2. If still a short alias, try roleModels (user-configured model mapping)
    const SHORT_ALIASES = new Set(['sonnet', 'opus', 'haiku']);
    if (SHORT_ALIASES.has(modelId)) {
      const roleMap: Record<string, string | undefined> = {
        sonnet: resolved.roleModels.sonnet,
        opus: resolved.roleModels.opus,
        haiku: resolved.roleModels.haiku,
      };
      const mapped = roleMap[modelId];
      if (mapped && !SHORT_ALIASES.has(mapped)) {
        modelId = mapped;
      }
    }
  } else {
    modelId = resolved.upstreamModel || resolved.model || 'claude-sonnet-4-5-20250929';
  }
  const provider = resolved.provider;
  const protocol = resolved.protocol;
  const processEnvInjections: Record<string, string> = {};

  // For bedrock/vertex, inject env overrides into process.env
  if (protocol === 'bedrock' || protocol === 'vertex') {
    for (const [k, v] of Object.entries(resolved.envOverrides)) {
      if (typeof v === 'string' && v !== '') {
        processEnvInjections[k] = v;
      }
    }
  }

  const headers = resolved.headers;

  // OpenAI OAuth (Codex API) — special path using OAuth Bearer token.
  // The actual OAuth token is resolved in ai-provider.ts at model creation time
  // (via getOAuthCredentialsSync) because token refresh is async.
  if (resolved._openaiOAuth) {
    // Derive base URL: CODEX_API_ENDPOINT is the full /responses URL,
    // but @ai-sdk/openai appends /responses itself, so strip it.
    const codexBase = CODEX_API_ENDPOINT.replace(/\/responses\/?$/, '');
    return {
      sdkType: 'openai',
      apiKey: undefined,  // resolved at call time in ai-provider.ts
      authToken: undefined,
      baseUrl: codexBase,
      modelId,
      headers,
      processEnvInjections,
      useResponsesApi: true,
    };
  }

  // Resolve Anthropic auth credentials.
  // @ai-sdk/anthropic supports apiKey (x-api-key header) and authToken (Bearer header),
  // and they are mutually exclusive. We must pick the right one based on authStyle.
  const resolveAnthropicAuth = (): { apiKey: string | undefined; authToken: string | undefined } => {
    if (provider) {
      // Configured provider — use authStyle to decide
      if (resolved.authStyle === 'auth_token') {
        return { apiKey: undefined, authToken: provider.api_key || undefined };
      }
      return { apiKey: provider.api_key || undefined, authToken: undefined };
    }
    // Env mode — check env vars and legacy DB settings.
    // ANTHROPIC_AUTH_TOKEN takes precedence (it's the Claude Code SDK auth path).
    const envAuthToken = process.env.ANTHROPIC_AUTH_TOKEN || getSetting('anthropic_auth_token');
    if (envAuthToken) {
      // If we also have an API key, prefer auth_token (matches Claude Code SDK behavior)
      return { apiKey: undefined, authToken: envAuthToken };
    }
    const envApiKey = process.env.ANTHROPIC_API_KEY;
    return { apiKey: envApiKey || undefined, authToken: undefined };
  };

  // @ai-sdk/anthropic builds request URLs as `${baseURL}/messages`.
  // Its default is 'https://api.anthropic.com/v1', so if we pass
  // 'https://api.anthropic.com' (without /v1) the request goes to
  // /messages instead of /v1/messages and 404s.
  // Normalise here so callers don't need to know about the SDK's URL scheme.
  const normaliseAnthropicBaseUrl = (url: string | undefined): string | undefined => {
    if (!url) return undefined;
    const cleaned = url.replace(/\/+$/, '');
    if (cleaned === 'https://api.anthropic.com') return 'https://api.anthropic.com/v1';
    return cleaned;
  };

  switch (protocol) {
    case 'anthropic': {
      const auth = resolveAnthropicAuth();
      const rawBaseUrl = provider?.base_url || process.env.ANTHROPIC_BASE_URL || getSetting('anthropic_base_url') || undefined;

      // Route third-party Anthropic proxies through ClaudeCodeCompatAdapter.
      // Only official api.anthropic.com uses @ai-sdk/anthropic directly.
      // All others go through the adapter because:
      // 1. sdkProxyOnly proxies (Zhipu, Kimi, etc.) require Claude Code wire format
      // 2. Unknown proxies are safer with the adapter (it's a superset of standard Messages API)
      // 3. @ai-sdk/anthropic has subtle incompatibilities with many proxies (URL handling, beta headers)
      let sdkType: AiSdkConfig['sdkType'] = 'anthropic';
      const effectiveBaseUrl = provider?.base_url || process.env.ANTHROPIC_BASE_URL;
      if (effectiveBaseUrl) {
        try {
          const hostname = new URL(effectiveBaseUrl).hostname;
          const isOfficial = hostname === 'api.anthropic.com' || hostname.endsWith('.anthropic.com');
          if (!isOfficial) {
            sdkType = 'claude-code-compat';
          }
        } catch {
          sdkType = 'claude-code-compat'; // malformed URL → safer with adapter
        }
      }

      return {
        sdkType,
        ...auth,
        baseUrl: normaliseAnthropicBaseUrl(rawBaseUrl),
        modelId,
        headers,
        processEnvInjections,
      };
    }

    case 'openrouter':
      return {
        sdkType: 'openai',
        apiKey: provider?.api_key || undefined,
        authToken: undefined,
        baseUrl: provider?.base_url || 'https://openrouter.ai/api/v1',
        modelId,
        headers,
        processEnvInjections,
      };

    case 'openai-compatible':
      return {
        sdkType: 'openai',
        apiKey: provider?.api_key || undefined,
        authToken: undefined,
        baseUrl: provider?.base_url || undefined,
        modelId,
        headers,
        processEnvInjections,
      };

    case 'bedrock':
      // If base_url is set, route through OpenAI-compatible proxy; otherwise use native SDK
      if (provider?.base_url) {
        return {
          sdkType: 'openai',
          apiKey: provider.api_key || 'dummy',
          authToken: undefined,
          baseUrl: provider.base_url,
          modelId,
          headers,
          processEnvInjections,
        };
      }
      return {
        sdkType: 'bedrock',
        apiKey: undefined,
        authToken: undefined,
        baseUrl: undefined,
        modelId,
        headers,
        processEnvInjections,
      };

    case 'vertex':
      // If base_url is set, route through OpenAI-compatible proxy; otherwise use native SDK
      if (provider?.base_url) {
        return {
          sdkType: 'openai',
          apiKey: provider.api_key || 'dummy',
          authToken: undefined,
          baseUrl: provider.base_url,
          modelId,
          headers,
          processEnvInjections,
        };
      }
      return {
        sdkType: 'vertex',
        apiKey: undefined,
        authToken: undefined,
        baseUrl: undefined,
        modelId,
        headers,
        processEnvInjections,
      };

    case 'google':
    case 'gemini-image':
      return {
        sdkType: 'google',
        apiKey: provider?.api_key || undefined,
        authToken: undefined,
        baseUrl: provider?.base_url || undefined,
        modelId,
        headers,
        processEnvInjections,
      };

    default: {
      const auth = resolveAnthropicAuth();
      return {
        sdkType: 'anthropic',
        ...auth,
        baseUrl: normaliseAnthropicBaseUrl(provider?.base_url),
        modelId,
        headers,
        processEnvInjections,
      };
    }
  }
}

// ── Internal helpers ────────────────────────────────────────────

// OpenAI Codex API models available through ChatGPT Plus/Pro OAuth
const OPENAI_CODEX_MODELS: CatalogModel[] = [
  { modelId: 'gpt-5.4', displayName: 'GPT-5.4' },
  { modelId: 'gpt-5.4-mini', displayName: 'GPT-5.4-Mini' },
  { modelId: 'gpt-5.3-codex', displayName: 'GPT-5.3-Codex' },
  { modelId: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3-Codex-Spark' },
];

/**
 * Build resolution for the virtual OpenAI OAuth provider.
 * Uses OAuth Bearer token + Codex API endpoint.
 */
function buildOpenAIOAuthResolution(opts: ResolveOptions): ResolvedProvider {
  const model = opts.model || opts.sessionModel || 'gpt-5.4';

  const catalogEntry = OPENAI_CODEX_MODELS.find(m => m.modelId === model);

  return {
    provider: undefined,
    protocol: 'openai-compatible',
    authStyle: 'api_key',
    model,
    upstreamModel: model,
    modelDisplayName: catalogEntry?.displayName || model,
    headers: {},
    envOverrides: {},
    roleModels: { default: model },
    hasCredentials: true, // OAuth token checked at call time
    availableModels: OPENAI_CODEX_MODELS,
    settingSources: [],
    _openaiOAuth: true, // marker for toAiSdkConfig
  } as ResolvedProvider;
}

function buildResolution(
  provider: ApiProvider | undefined,
  opts: ResolveOptions,
): ResolvedProvider {
  if (!provider) {
    // Environment-based provider (no DB record) — credentials come from shell env or legacy DB settings
    const envHasCredentials = !!(
      process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      getSetting('anthropic_auth_token')
    );
    // Read user-configured global default model — only use it if it's an env-provider model
    const globalDefaultModel = getSetting('global_default_model') || undefined;
    const globalDefaultProvider = getSetting('global_default_model_provider') || undefined;
    // Only apply global default when it belongs to the env provider (or no provider is specified)
    const applicableGlobalDefault = (globalDefaultModel && (!globalDefaultProvider || globalDefaultProvider === 'env'))
      ? globalDefaultModel : undefined;
    const model = opts.model || opts.sessionModel || applicableGlobalDefault || getSetting('default_model') || undefined;

    // Env mode uses short aliases (sonnet/opus/haiku) in the UI.
    // Map them to full Anthropic model IDs so toAiSdkConfig can resolve correctly.
    const envModels: CatalogModel[] = [
      { modelId: 'sonnet', upstreamModelId: 'claude-sonnet-4-20250514', displayName: 'Sonnet 4.6' },
      { modelId: 'opus', upstreamModelId: 'claude-opus-4-20250514', displayName: 'Opus 4.6' },
      { modelId: 'haiku', upstreamModelId: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
    ];

    // Resolve upstream model from the alias table
    const catalogEntry = model ? envModels.find(m => m.modelId === model) : undefined;

    return {
      provider: undefined,
      protocol: 'anthropic',
      authStyle: 'api_key',
      model,
      upstreamModel: catalogEntry?.upstreamModelId || model,
      modelDisplayName: catalogEntry?.displayName,
      headers: {},
      envOverrides: {},
      roleModels: {},
      hasCredentials: envHasCredentials,
      availableModels: envModels,
      settingSources: ['user', 'project', 'local'],
    };
  }

  // Determine protocol (new field or infer from legacy)
  const protocol = inferProtocolFromProvider(provider);
  const authStyle = inferAuthStyleFromProvider(provider);

  // Parse JSON fields
  const headers = safeParseJson(provider.headers_json);
  const envOverrides = safeParseJson(provider.env_overrides_json || provider.extra_env);
  let roleModels = safeParseJson(provider.role_models_json) as RoleModels;

  // Fall back to catalog preset's defaultRoleModels when DB has no role mappings.
  // This ensures sdkProxyOnly providers (MiniMax, Xiaomi MiMo, etc.) get correct
  // ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL env vars even when role_models_json
  // was saved as '{}' by the preset connect dialog.
  if (!roleModels.default && !roleModels.sonnet) {
    const preset = findPresetForLegacy(provider.base_url, provider.provider_type, protocol);
    if (preset?.defaultRoleModels) {
      roleModels = { ...preset.defaultRoleModels, ...roleModels };
    }
  }

  // Get available models: DB provider_models take priority, then catalog defaults
  let availableModels = getDefaultModelsForProvider(protocol, provider.base_url);
  try {
    const dbModels = getModelsForProvider(provider.id);
    if (dbModels.length > 0) {
      // Convert DB rows to CatalogModel and merge (DB models override catalog by modelId)
      const dbCatalog: CatalogModel[] = dbModels.map(m => ({
        modelId: m.model_id,
        upstreamModelId: m.upstream_model_id || undefined,
        displayName: m.display_name || m.model_id,
        capabilities: safeParseCapabilities(m.capabilities_json),
      }));
      // Merge: DB models first, then catalog models not already in DB
      const dbIds = new Set(dbCatalog.map(m => m.modelId));
      availableModels = [...dbCatalog, ...availableModels.filter(m => !dbIds.has(m.modelId))];
    }
  } catch { /* provider_models table may not exist in old DBs */ }

  // Read per-provider options
  const providerOpts = getProviderOptions(provider.id);

  // Read global default model — only use it if it belongs to THIS provider
  const globalDefaultModel = getSetting('global_default_model') || undefined;
  const globalDefaultProvider = getSetting('global_default_model_provider') || undefined;
  const applicableGlobalDefault = (globalDefaultModel && globalDefaultProvider === provider.id)
    ? globalDefaultModel : undefined;

  // Resolve model — priority:
  //   1. Explicit request model (opts.model)
  //   2. Session's stored model (opts.sessionModel)
  //   3. Global default model (only if it belongs to this provider)
  //   4. Provider's roleModels.default (preset default, e.g. "ark-code-latest")
  //   5. Global default_model setting (legacy)
  const requestedModel = opts.model || opts.sessionModel || applicableGlobalDefault || roleModels.default || getSetting('default_model') || undefined;
  let model = requestedModel;
  let upstreamModel: string | undefined;
  let modelDisplayName: string | undefined;

  // If a use case is specified, check role models for that use case
  if (opts.useCase && opts.useCase !== 'default' && roleModels[opts.useCase]) {
    model = roleModels[opts.useCase];
  }

  // Find display name and upstream model ID from catalog
  if (model && availableModels.length > 0) {
    const catalogEntry = availableModels.find(m => m.modelId === model);
    if (catalogEntry) {
      modelDisplayName = catalogEntry.displayName;
      // upstreamModelId is what actually gets sent to the API (may differ from the UI model ID)
      upstreamModel = catalogEntry.upstreamModelId || model;
    }
  }
  // If no catalog entry, upstream = model (identity mapping)
  if (!upstreamModel && model) {
    upstreamModel = model;
  }

  // Ensure roleModels.default reflects the upstream model for the current request,
  // so toClaudeCodeEnv() sets ANTHROPIC_MODEL to the correct upstream ID.
  // Only override when the request explicitly specifies a model (opts.model) and
  // we found a different upstream ID via catalog lookup.
  if (upstreamModel && opts.model && upstreamModel !== roleModels.default) {
    roleModels = { ...roleModels, default: upstreamModel };
  }

  // Has credentials?
  const hasCredentials = !!(provider.api_key) || authStyle === 'env_only';

  // Settings sources — always include 'user' so SDK can load skills from
  // ~/.claude/skills/. Env override conflicts are handled by envOverrides.
  const settingSources = ['user', 'project', 'local'];

  return {
    provider,
    protocol,
    authStyle,
    model,
    upstreamModel,
    modelDisplayName,
    headers,
    envOverrides,
    roleModels,
    hasCredentials,
    availableModels,
    settingSources,
  };
}

/**
 * Determine protocol from a provider record.
 * Uses the new `protocol` field if present, otherwise infers from legacy fields.
 */
function inferProtocolFromProvider(provider: ApiProvider): Protocol {
  // New field takes precedence
  if (provider.protocol) {
    return provider.protocol as Protocol;
  }
  // Legacy inference
  return inferProtocolFromLegacy(provider.provider_type, provider.base_url);
}

function inferAuthStyleFromProvider(provider: ApiProvider): AuthStyle {
  // Check preset match first — pass protocol to avoid cross-protocol fuzzy mismatches
  const protocol = inferProtocolFromProvider(provider);
  const preset = findPresetForLegacy(provider.base_url, provider.provider_type, protocol);
  if (preset) return preset.authStyle;

  return inferAuthStyleFromLegacy(provider.provider_type, provider.extra_env);
}

function safeParseJson(json: string | undefined | null): Record<string, string> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch { /* ignore */ }
  return {};
}

function safeParseCapabilities(json: string | undefined | null): CatalogModel['capabilities'] {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch { /* ignore */ }
  return undefined;
}

// ApiProvider now includes protocol, headers_json, env_overrides_json, role_models_json
// directly — no type augmentation needed.
