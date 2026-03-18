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
} from './db';

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

  if (effectiveProviderId && effectiveProviderId !== 'env') {
    // Explicit provider — look it up
    provider = getProvider(effectiveProviderId);
    if (!provider) {
      // Requested provider not found, fall back to default
      const defaultId = getDefaultProviderId();
      if (defaultId) provider = getProvider(defaultId);
    }
  } else if (!effectiveProviderId) {
    // No provider specified — use global default
    const defaultId = getDefaultProviderId();
    if (defaultId) provider = getProvider(defaultId);
    // Note: stale default (provider deleted but setting remains) is NOT
    // auto-healed here — resolver is a read path that may run during
    // diagnostics. Auto-heal happens in: DELETE /api/providers/[id],
    // POST /api/doctor/repair, and startup migration in chat/page.tsx.
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
  if (explicitProvider) {
    return buildResolution(explicitProvider, opts);
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
  sdkType: 'anthropic' | 'openai' | 'google' | 'bedrock' | 'vertex';
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
    const catalogEntry = resolved.availableModels.find(m => m.modelId === modelOverride);
    modelId = catalogEntry?.upstreamModelId || modelOverride;
  } else {
    modelId = resolved.upstreamModel || resolved.model || 'claude-sonnet-4-20250514';
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
      return {
        sdkType: 'anthropic',
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
    const model = opts.model || opts.sessionModel || getSetting('default_model') || undefined;

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

  // Resolve model — priority:
  //   1. Explicit request model (opts.model)
  //   2. Session's stored model (opts.sessionModel)
  //   3. Provider's roleModels.default (configured per-provider default, e.g. "ark-code-latest")
  //   4. Global default_model setting
  const requestedModel = opts.model || opts.sessionModel || roleModels.default || getSetting('default_model') || undefined;
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
  // Check preset match first
  const preset = findPresetForLegacy(provider.base_url, provider.provider_type);
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
