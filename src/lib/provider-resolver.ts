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
  getEffectiveProviderProtocol,
  findPresetForLegacy,
  ENV_CLAUDE_CODE_MODELS,
} from './provider-catalog';
import {
  getProvider,
  getDefaultProviderId,
  getActiveProvider,
  getAllProviders,
  getSetting,
  getAllModelsForProvider,
  getProviderOptions,
} from './db';
import { ensureTokenFresh } from './openai-oauth-manager';
import { CODEX_API_ENDPOINT } from './openai-oauth';
import { hasClaudeSettingsCredentials } from './claude-settings';
import {
  getProviderCompat,
  getModelCompat,
  isOpenRouterAnthropicSkinUrl,
} from './runtime-compat';
import type { ChatRuntime } from './chat-runtime';
import {
  assertProviderCallAllowed,
  getProviderUsagePolicy,
  isInteractiveSceneAllowed,
  type ProviderCallScene,
} from './provider-call-policy';

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
  /** Internal: true when resolved as the xAI OAuth virtual provider. */
  _xaiOAuth?: boolean;
  /**
   * Phase 5 review round 4 (2026-05-13) — true when resolved as the
   * Codex Account virtual provider. CodexRuntime takes over the
   * upstream call via its own app-server thread/turn flow; resolvers
   * downstream of this point MUST NOT try to build a transport
   * against this provider.
   */
  _codexAccount?: boolean;
  /**
   * Phase 2 Step 2 — invalid-session signal. Set ONLY by
   * `resolveProviderForSession` when the session's stored
   * `provider_id` is non-empty but no longer points at a real DB
   * provider (deleted by the user, lost in import, etc.). The send
   * route must check this field and refuse to send rather than
   * silently routing through the env fallback the resolver picks
   * for the same input shape today. Frontend already has the
   * matching gate via `RunCheckpoint`; this is the resolver-side
   * surface so the route can't be reached with a stale session.
   *
   * Other callers (`resolveProvider` directly, anything not session-
   * scoped) do NOT set this — they keep the legacy "fall through to
   * env" behaviour, because they don't have a session intent to
   * compare against.
   */
  invalidReason?: 'provider-missing' | 'model-missing' | 'runtime-incompatible';
}

// ── Public API ──────────────────────────────────────────────────

export interface ResolveOptions {
  /** Required by every credential-bearing call; inspection-only callers may omit. */
  callScene?: ProviderCallScene;
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
  /**
   * Active chat-side runtime. When set, the default-model fallback chain
   * (globalDefault → roleModels.default → setting → availableModels[0])
   * skips models whose `getModelCompat()` flag doesn't match this runtime,
   * alongside the existing hidden-id guard.
   *
   * Explicit `opts.model` / `opts.sessionModel` are still honored even when
   * incompatible — the caller asked for them by name. Mismatches surface
   * downstream (route layer, SDK error) rather than being silently rewritten.
   *
   * Omit (or leave undefined) to keep the legacy behavior of considering
   * every enabled model — used by Settings > Providers' global default-model
   * picker which surfaces the full catalog regardless of current runtime.
   */
  runtime?: ChatRuntime;
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
/**
 * Phase 5b round-9 (2026-05-18) — alias-row canonicalization for
 * OpenRouter Anthropic-skin providers.
 *
 * Pre-round-8 the preset's `defaultModels` was alias-only
 * (`ANTHROPIC_DEFAULT_MODELS` — no `upstreamModelId`). Provider
 * records created in that window have `provider_models` rows whose
 * `upstream_model_id` is either NULL or equal to the alias itself
 * (`'haiku' → 'haiku'`). Round 8 added the upstream slugs to the
 * preset (`OPENROUTER_ANTHROPIC_MODELS`), but `resolveProvider`'s
 * DB-wins merge shadowed them — so the resolver kept handing the
 * bare alias to upstream, which OpenRouter rejects with "is not a
 * valid model ID".
 *
 * Fix: after the DB merge, take any alias entry whose upstream is
 * missing or self-referential and fill it from the preset slug.
 * Don't override a user-configured full slug (`anthropic/...`) —
 * customization wins. Exported so `/api/providers/models` route
 * can apply the same shape so chat send + picker + resolver agree.
 */
export function normalizeOpenRouterAnthropicAlias(
  model: CatalogModel,
  presetModels: readonly CatalogModel[],
): CatalogModel {
  if (model.modelId !== 'sonnet' && model.modelId !== 'opus' && model.modelId !== 'haiku') {
    return model;
  }
  const preset = presetModels.find(m => m.modelId === model.modelId);
  const presetUpstream = preset?.upstreamModelId;
  if (!presetUpstream) return model;
  // Override only when the DB row carries no upstream (NULL) or
  // points at the alias itself (legacy shape). A user who set
  // `anthropic/claude-haiku-4.6` manually should keep that.
  if (!model.upstreamModelId || model.upstreamModelId === model.modelId) {
    return { ...model, upstreamModelId: presetUpstream };
  }
  return model;
}

/**
 * Canonical upstream IDs for the bare Anthropic UI aliases. Mirrors the env
 * provider's model table (`envModels` below) + route.ts `DEFAULT_MODELS`.
 */
export const ANTHROPIC_ALIAS_UPSTREAM: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
  haiku: 'claude-haiku-4-5-20251001',
};

/**
 * P0.5 (2026-06-01) — map a bare Anthropic alias (`sonnet` / `opus` / `haiku`)
 * to its real upstream id; returns undefined for anything else.
 *
 * This is DETERMINISTIC (a fixed alias→upstream table), unlike the
 * single-model "first model in list" fallback — so it's safe to apply even
 * for multi-model Claude-compat gateways. Without it, a legacy DB row
 * `model_id='sonnet'` with a NULL / self upstream reaches a New-API /
 * Claude-compat gateway verbatim as `sonnet` → "分组 auto 下模型 sonnet 无可用
 * 渠道" 503 (observed 2026-06-01; tech-debt #23).
 */
export function canonicalAnthropicAliasUpstream(modelId: string | undefined | null): string | undefined {
  if (!modelId) return undefined;
  return ANTHROPIC_ALIAS_UPSTREAM[modelId];
}

function finishResolution(resolved: ResolvedProvider, callScene: ProviderCallScene | undefined): ResolvedProvider {
  if (callScene) assertProviderCallAllowed(resolved.provider, callScene);
  return resolved;
}

export function resolveProvider(opts: ResolveOptions = {}): ResolvedProvider {
  const effectiveProviderId = opts.providerId || opts.sessionProviderId || '';

  let provider: ApiProvider | undefined;

  // Determine if the ID came from an explicit request (providerId) or
  // from the session — only explicit requests should skip the inactive check.
  const isExplicitRequest = !!opts.providerId;

  // Special virtual provider: OpenAI OAuth (Codex API)
  if (effectiveProviderId === 'openai-oauth') {
    return finishResolution(buildOpenAIOAuthResolution(opts), opts.callScene);
  }
  if (effectiveProviderId === 'xai-oauth') {
    return finishResolution(buildXaiOAuthResolution(opts), opts.callScene);
  }

  // Phase 5 review round 4 (2026-05-13) — Codex Account is a virtual
  // provider produced by `src/lib/codex/models.ts:buildCodexProviderModelGroup`
  // when the user is logged into Codex. It's NOT a DB row, so it needs
  // the same virtual-provider exemption as `env` and `openai-oauth`.
  // Codex Runtime takes over the actual upstream call via its own
  // app-server thread/turn flow; this resolver just needs to NOT 409.
  if (effectiveProviderId === 'codex_account') {
    return finishResolution(buildCodexAccountResolution(opts), opts.callScene);
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
      // fall back to default → any active.
      //
      // NOTE: We intentionally do NOT check default_provider's is_active here.
      // is_active is a "currently selected" marker (see activateProvider in
      // db.ts — radio-button style, only one provider can have is_active=1),
      // NOT an enabled/disabled flag. A user setting default_provider_id is
      // an explicit choice that must be honored regardless of is_active.
      // Ignoring it here is the root cause of "Default provider X is inactive,
      // falling back" warnings that surface as "No provider credentials" for
      // users who set a default but never clicked Activate.
      const defaultId = getDefaultProviderId();
      if (defaultId && defaultId !== effectiveProviderId) {
        const defaultProvider = getProvider(defaultId);
        if (defaultProvider) provider = defaultProvider;
      }
      if (!provider) {
        provider = getActiveProvider();
      }
    }
  } else if (!effectiveProviderId) {
    // No provider specified — use global default.
    // See NOTE above: is_active is a UI selection marker, not an enable flag.
    // The user's default_provider_id is an explicit choice; honor it even if
    // the provider isn't currently the "active" one.
    const defaultId = getDefaultProviderId();
    if (defaultId) {
      const defaultProvider = getProvider(defaultId);
      if (defaultProvider) {
        provider = defaultProvider;
      }
    }
    // If no default configured, fall back to any provider that happens to be
    // marked active (backwards compat with pre-default_provider_id installs)
    if (!provider) {
      provider = getActiveProvider();
    }
  }
  // effectiveProviderId === 'env' → provider stays undefined

  return finishResolution(buildResolution(provider, opts), opts.callScene);
}

/**
 * Fail-closed resolution: return the resolution for EXACTLY this provider id, or
 * `null`. Never falls back to the default / active provider.
 *
 * `resolveProvider` is deliberately forgiving — a stale or deleted session
 * provider silently becomes the user's default one, which is right for "answer
 * the user's question" but WRONG for any call that carries the user's text to a
 * vendor of its own accord. If the provider a session was pinned to is gone,
 * a background caller must do nothing, not quietly re-target another vendor:
 * title generation must not ship the first user message to a different company
 * than the one the chat was started with.
 *
 * Virtual providers ('env', 'openai-oauth', 'xai-oauth', 'codex_account') are matched on the
 * marker the resolver sets for them, since they have no DB row to compare ids
 * against.
 *
 * @returns the resolution whose identity is provably the requested one, else null.
 */
export function resolveExactProvider(
  providerId: string,
  callScene?: ProviderCallScene,
): ResolvedProvider | null {
  if (!providerId) return null;
  const resolved = resolveProvider({ providerId, callScene });
  if (providerId === 'openai-oauth') return resolved._openaiOAuth ? resolved : null;
  if (providerId === 'xai-oauth') return resolved._xaiOAuth ? resolved : null;
  if (providerId === 'codex_account') return resolved._codexAccount ? resolved : null;
  if (providerId === 'env') return resolved.provider === undefined ? resolved : null;
  return resolved.provider?.id === providerId ? resolved : null;
}

/**
 * Resolve provider for the Claude Code SDK subprocess (used by claude-client.ts).
 * Uses the same resolution chain but also checks getActiveProvider() for backwards compat.
 *
 * Important: if resolveProvider() intentionally returned provider=undefined (e.g. user
 * selected 'env'), we respect that and do NOT fall back to getActiveProvider().
 *
 * NOTE: When the caller already resolved a provider upstream and hands it to
 * us, we trust it unconditionally. `is_active` is a radio-button "currently
 * selected" marker in the DB (see activateProvider in db.ts), not an
 * enable/disable flag — second-guessing the caller here would undo the
 * upstream resolution and surface false-positive "inactive, re-resolving"
 * warnings in doctor logs. Stale-session defense lives in resolveProvider()'s
 * session-provider branch, not here.
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
  const roleModelForEnv = (modelId: string | undefined): string | undefined => {
    if (!modelId) return undefined;
    const catalogEntry = resolved.availableModels.find(model => model.modelId === modelId);
    const resolvedId = catalogEntry?.upstreamModelId
      || (modelId === resolved.model ? resolved.upstreamModel : undefined)
      || modelId;
    // P0.5 — this builds the Claude Code (Anthropic) env. When the provider
    // LISTS this alias as a model (catalogEntry) but the resolved id is still a
    // bare alias (legacy self-referential / NULL upstream), canonicalize it so
    // it can't ship to the gateway as `sonnet`/`opus`/`haiku` → 503 "no channel".
    // If the alias isn't a listed model, preserve it (let upstream surface the
    // real error — the existing multi-model contract).
    if (catalogEntry) return canonicalAnthropicAliasUpstream(resolvedId) ?? resolvedId;
    return resolvedId;
  };

  // Managed env vars that must be cleaned when switching providers to prevent leaks
  const MANAGED_ENV_KEYS = new Set([
    'API_TIMEOUT_MS',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
    'CLAUDE_CODE_SKIP_VERTEX_AUTH',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
    'CLAUDE_CODE_EFFORT_LEVEL',
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
          // Only set ANTHROPIC_API_KEY (X-Api-Key header).
          // Do NOT set ANTHROPIC_AUTH_TOKEN — upstream Claude Code adds
          // Authorization: Bearer when it sees AUTH_TOKEN, which conflicts
          // with providers that expect API-key-only auth (e.g. Kimi).
          env.ANTHROPIC_API_KEY = apiKey;
          break;
      }
    }

    // Inject base URL
    if (resolved.provider.base_url) {
      env.ANTHROPIC_BASE_URL = resolved.provider.base_url;
    }

    // Inject role models as env vars
    const defaultModel = roleModelForEnv(resolved.roleModels.default);
    const reasoningModel = roleModelForEnv(resolved.roleModels.reasoning);
    const smallModel = roleModelForEnv(resolved.roleModels.small);
    const haikuModel = roleModelForEnv(resolved.roleModels.haiku);
    const sonnetModel = roleModelForEnv(resolved.roleModels.sonnet);
    const opusModel = roleModelForEnv(resolved.roleModels.opus);
    if (defaultModel) {
      env.ANTHROPIC_MODEL = defaultModel;
    }
    if (reasoningModel) {
      env.ANTHROPIC_REASONING_MODEL = reasoningModel;
    }
    if (smallModel) {
      env.ANTHROPIC_SMALL_FAST_MODEL = smallModel;
    }
    if (haikuModel) {
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel;
    }
    if (sonnetModel) {
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel;
    }
    if (opusModel) {
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel;
    }

    // Inject extra headers
    for (const [k, v] of Object.entries(resolved.headers)) {
      if (v) env[k] = v;
    }

    // Inject env overrides (empty string = delete).
    // Skip provider-owned Anthropic keys — they were already correctly
    // injected above based on authStyle + role model resolution. Legacy
    // extra_env often contains placeholder auth entries, and older gateway
    // configs may carry bare UI aliases like ANTHROPIC_MODEL=sonnet; letting
    // either override this resolver reintroduces stale-model failures.
    const HOST_MANAGED_ANTHROPIC_ENV_KEYS = new Set([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_REASONING_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
    ]);
    for (const [key, value] of Object.entries(resolved.envOverrides)) {
      if (HOST_MANAGED_ANTHROPIC_ENV_KEYS.has(key)) continue; // already handled above
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

  // NOTE: We previously set CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1 here in an attempt
  // to tell the Agent SDK to strip ~/.claude/settings.json env overrides. That flag
  // does not exist in the current SDK (@anthropic-ai/claude-agent-sdk 0.2.62) — it
  // was either aspirational or came from an older SDK spec. Removing it avoids
  // shipping misleading dead code. The SDK already filters its own env blocklist
  // (model aliases, AWS/OTEL/Bedrock keys — see rG6 in cli.js), and when CodePilot
  // has an active provider, toClaudeCodeEnv() already deletes all ANTHROPIC_* keys
  // from baseEnv above before injecting the provider's values, so settings.json
  // env cannot override the provider's auth/baseUrl for authenticated users.
  // For env-mode (no active provider) users, we intentionally let settings.json
  // provide credentials — that's how cc-switch integration works.

  return env;
}

/**
 * The Anthropic base URL the Claude Code SDK subprocess will actually talk to,
 * computed by mirroring `toClaudeCodeEnv`'s THREE states exactly so the two
 * never drift (the gate that consumes this must reflect the real send target):
 *
 *   - DB provider WITH credentials (`provider && hasCredentials`): toClaudeCodeEnv
 *     clears every ANTHROPIC_* var then injects this provider's base_url. An empty
 *     base_url leaves it unset → SDK falls back to official api.anthropic.com
 *     (return undefined).
 *   - DB provider WITHOUT credentials (`provider && !hasCredentials`): toClaudeCodeEnv
 *     runs NEITHER branch — its provider branch is gated on `hasCredentials`, its
 *     env branch on `!provider` — so it neither clears nor injects ANTHROPIC_*. The
 *     SDK inherits ONLY the ambient `process.env.ANTHROPIC_BASE_URL`; provider.base_url
 *     is NOT injected and settings is NOT consulted. Mirror that (a third-party env
 *     override here must still untrust the window — Codex P2, 2026-06-20).
 *   - env / legacy / cc-switch (`!provider`): SDK inherits the ambient base URL —
 *     `settings.anthropic_base_url` first (mirrors the `!resolved.provider` branch),
 *     then `process.env.ANTHROPIC_BASE_URL`.
 *
 * Returning undefined means "official first-party endpoint". Callers gate the
 * TRUST of the SDK-reported `modelUsage.contextWindow` on this (#632): a third
 * party proxy reaching here reports the SDK's generic ~200K default, which must
 * NOT be shown as a real capacity. See `isFirstPartyAnthropicEndpoint`.
 */
export function resolveEffectiveAnthropicBaseUrl(
  resolved: ResolvedProvider,
): string | undefined {
  if (resolved.provider && resolved.hasCredentials) {
    return resolved.provider.base_url || undefined;
  }
  if (resolved.provider) {
    // provider selected but no credentials → SDK inherits ambient env only.
    return process.env.ANTHROPIC_BASE_URL || undefined;
  }
  return getSetting('anthropic_base_url') || process.env.ANTHROPIC_BASE_URL || undefined;
}

// ── AI SDK config builder ───────────────────────────────────────

export interface AiSdkConfig {
  /** Which AI SDK factory to use */
  sdkType: 'anthropic' | 'openai' | 'xai' | 'google' | 'bedrock' | 'vertex' | 'claude-code-compat';
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
  /** Resolve bearer credentials per request from the atomic xAI OAuth bundle. */
  useXaiOAuth?: boolean;
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

    // 3. Last resort for SINGLE-MODEL third-party providers: short alias →
    //    that single model. Third-party proxies (Kimi, GLM, OpenRouter relays,
    //    custom enterprise endpoints) usually do NOT accept bare "sonnet" /
    //    "opus" / "haiku" — they want fully-qualified model IDs. Sending the
    //    alias produces "model 'sonnet' not found" errors from the upstream
    //    (Sentry: HTTP 400/404/502 across multiple fingerprints, 310+ events
    //    over 14d).
    //
    //    IMPORTANT: We only fall back when the provider has EXACTLY ONE model
    //    in its catalog. Multi-model providers (e.g. OpenRouter with dozens
    //    of models) must NOT silently rewrite the user's chosen alias to
    //    "first model in list" — that's a hard-to-diagnose behavior change
    //    affecting both correctness and cost. For multi-model providers
    //    without a role mapping, we keep the alias and let upstream return
    //    its real "model not found" error so the user can see the problem
    //    and configure role_models_json properly.
    if (
      resolved.provider &&
      SHORT_ALIASES.has(modelId) &&
      resolved.availableModels.length === 1
    ) {
      const only = resolved.availableModels[0];
      const onlyUpstream = only.upstreamModelId || only.modelId;
      if (onlyUpstream && !SHORT_ALIASES.has(onlyUpstream)) {
        modelId = onlyUpstream;
      }
    }

    // 4. P0.5 — a bare Anthropic alias that the provider LISTS as a model
    //    (legacy materialized row with NULL/self upstream) on an anthropic
    //    protocol provider: canonicalize to the real upstream id. Gated on
    //    "alias is in availableModels" so we DON'T rewrite an alias the
    //    provider doesn't offer (that stays bare → upstream surfaces the real
    //    error, preserving the multi-model contract in step 3's note). Unlike
    //    step 3 this is a fixed alias→upstream map, not "first model in list".
    if (
      SHORT_ALIASES.has(modelId) &&
      resolved.protocol === 'anthropic' &&
      resolved.availableModels.some(m => m.modelId === modelId)
    ) {
      const canon = canonicalAnthropicAliasUpstream(modelId);
      if (canon) modelId = canon;
    }
  } else {
    modelId = resolved.upstreamModel || resolved.model || 'claude-sonnet-4-6';
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

  if (resolved._xaiOAuth) {
    return {
      sdkType: 'xai',
      apiKey: undefined,
      authToken: undefined,
      baseUrl: 'https://api.x.ai/v1',
      modelId,
      headers,
      processEnvInjections,
      useXaiOAuth: true,
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

    case 'openrouter': {
      // Phase 5b round-7 fix (2026-05-18) — OpenRouter exposes TWO
      // skin endpoints under the same `openrouter` preset:
      //   - `https://openrouter.ai/api/v1` — OpenAI Chat Completions skin
      //   - `https://openrouter.ai/api`    — Anthropic Messages skin
      // Pre-fix this case hardcoded `sdkType: 'openai'` for both,
      // which meant Anthropic-skin requests (e.g. `anthropic/claude-haiku`)
      // were sent in OpenAI Chat Completions wire format against the
      // Messages endpoint. Result on real smoke: HTTP 200 but only
      // `response.created → response.completed` with empty text;
      // non-stream returned "Invalid JSON response". `runtime-compat.ts`
      // already classifies this as `openrouter_anthropic_skin` (the
      // detection predicate is `isOpenRouterAnthropicSkinUrl` — exported
      // for reuse here), but the resolver never read the same predicate.
      // Fix: branch on the same predicate. Anthropic skin → route through
      // `claude-code-compat` (third-party Anthropic-compatible adapter
      // we already use for sdkProxyOnly proxies like Zhipu/Kimi —
      // same wire format, just a different base URL).
      const baseUrl = provider?.base_url || 'https://openrouter.ai/api/v1';
      if (provider?.base_url && isOpenRouterAnthropicSkinUrl(provider.base_url)) {
        return {
          sdkType: 'claude-code-compat',
          apiKey: provider?.api_key || undefined,
          authToken: undefined,
          baseUrl,
          modelId,
          headers,
          processEnvInjections,
        };
      }
      return {
        sdkType: 'openai',
        apiKey: provider?.api_key || undefined,
        authToken: undefined,
        baseUrl,
        modelId,
        headers,
        processEnvInjections,
      };
    }

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

    case 'xai':
      return {
        sdkType: 'xai',
        apiKey: provider?.api_key || undefined,
        authToken: undefined,
        baseUrl: provider?.base_url || 'https://api.x.ai/v1',
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

    case 'openai-image':
      return {
        sdkType: 'openai',
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
  { modelId: 'gpt-5.5', displayName: 'GPT-5.5' },
  { modelId: 'gpt-5.4', displayName: 'GPT-5.4' },
  { modelId: 'gpt-5.4-mini', displayName: 'GPT-5.4-Mini' },
  { modelId: 'gpt-5.3-codex', displayName: 'GPT-5.3-Codex' },
  { modelId: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3-Codex-Spark' },
];

/**
 * Build resolution for the virtual OpenAI OAuth provider.
 * Uses OAuth Bearer token + Codex API endpoint.
 */
/**
 * Phase 5 review round 4 (2026-05-13) — Codex Account virtual provider
 * resolution. Returns a minimal ResolvedProvider so callers that
 * destructure it don't crash; the actual upstream call goes through
 * Codex Runtime's app-server thread/turn flow, NOT through this
 * resolver's transport. We populate `hasCredentials: true` because
 * Codex's account/read endpoint is the real gate — by the time the
 * picker shows a codex_account model, the account is already logged
 * in (codex-models.ts:buildCodexProviderModelGroup returns null
 * otherwise).
 */
function buildCodexAccountResolution(opts: ResolveOptions): ResolvedProvider {
  const model = opts.model || opts.sessionModel || '';
  return {
    provider: undefined,
    protocol: 'openai-compatible',
    authStyle: 'api_key',
    model,
    upstreamModel: model,
    modelDisplayName: model,
    headers: {},
    envOverrides: {},
    roleModels: { default: model },
    // Account-managed: Codex app-server owns credentials. The resolver
    // never makes the upstream call for this provider — CodexRuntime
    // bypasses provider-transport entirely.
    hasCredentials: true,
    availableModels: [],
    settingSources: [],
    _codexAccount: true,
  } as ResolvedProvider;
}

function buildOpenAIOAuthResolution(opts: ResolveOptions): ResolvedProvider {
  const model = opts.model || opts.sessionModel || 'gpt-5.5';

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

function buildXaiOAuthResolution(opts: ResolveOptions): ResolvedProvider {
  const model = opts.model || opts.sessionModel || 'grok-4.5';
  const availableModels: CatalogModel[] = [{ modelId: 'grok-4.5', displayName: 'Grok 4.5' }];
  return {
    provider: undefined,
    protocol: 'xai',
    authStyle: 'api_key',
    model,
    upstreamModel: model,
    modelDisplayName: availableModels.find(item => item.modelId === model)?.displayName || model,
    headers: {},
    envOverrides: {},
    roleModels: { default: 'grok-4.5' },
    hasCredentials: true,
    availableModels,
    settingSources: [],
    _xaiOAuth: true,
  };
}

function buildResolution(
  provider: ApiProvider | undefined,
  opts: ResolveOptions,
): ResolvedProvider {
  if (!provider) {
    // Environment-based provider (no DB record) — credentials come from shell env,
    // legacy DB settings, or ~/.claude/settings.json (managed by cc-switch etc.).
    // When only settings.json has creds, we must still flag hasCredentials=true so
    // ai-provider.ts's guard doesn't preemptively abort before the SDK runtime has
    // a chance to load the file via settingSources.
    const envHasCredentials = !!(
      process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      getSetting('anthropic_auth_token') ||
      hasClaudeSettingsCredentials()
    );
    // Read user-configured global default model — only use it if it's an env-provider model
    const globalDefaultModel = getSetting('global_default_model') || undefined;
    const globalDefaultProvider = getSetting('global_default_model_provider') || undefined;
    // Only apply global default when it belongs to the env provider (or no provider is specified)
    const applicableGlobalDefault = (globalDefaultModel && (!globalDefaultProvider || globalDefaultProvider === 'env'))
      ? globalDefaultModel : undefined;
    const model = opts.model || opts.sessionModel || applicableGlobalDefault || getSetting('default_model') || undefined;

    // Env mode uses short aliases (sonnet/opus/haiku/...) in the UI.
    // Map them to full Anthropic model IDs so toAiSdkConfig can resolve
    // correctly. Single source of truth lives in provider-catalog.ts —
    // do NOT re-inline a copy here (three copies drifted before; Codex
    // review P1, 2026-06-10).
    const envModels: CatalogModel[] = ENV_CLAUDE_CODE_MODELS;

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
    const preset = findPresetForLegacy(provider.base_url, provider.provider_type, protocol, provider.preset_key);
    if (preset?.defaultRoleModels) {
      roleModels = { ...preset.defaultRoleModels, ...roleModels };
    }
  }

  // Get available models: DB provider_models is authoritative when populated.
  // The user's hidden ids (enabled=0 rows) MUST suppress the catalog fallback,
  // otherwise the runtime sees models the user explicitly hid in Settings >
  // Models. We fetch all rows and partition into enabled-set + hidden-set.
  // `dbHiddenIds` is also used downstream to guard the role-default fallback.
  //
  // Round 9 (2026-05-18): capture the preset catalog BEFORE the DB merge so
  // we can canonicalize alias rows that pre-date the round-8 catalog
  // update. Detail: round 8 added OpenRouter upstream slugs to the preset
  // (anthropic/claude-haiku-4.5 etc.), but a provider record created
  // BEFORE that change had `provider_models` rows with
  // upstream_model_id='haiku' (or NULL). The DB-wins merge below then
  // shadowed the preset slug. The normalize step below fills the missing
  // upstream from the preset for OpenRouter Anthropic-skin only — never
  // overrides a user-configured full slug.
  const presetModels = getDefaultModelsForProvider(protocol, provider.base_url, provider.provider_type);
  let availableModels: CatalogModel[] = [...presetModels];
  let dbHiddenIds = new Set<string>();
  try {
    const dbAll = getAllModelsForProvider(provider.id);
    if (dbAll.length > 0) {
      dbHiddenIds = new Set(dbAll.filter(m => m.enabled === 0).map(m => m.model_id));
      const dbEnabled = dbAll.filter(m => m.enabled === 1);
      const dbCatalog: CatalogModel[] = dbEnabled.map(m => ({
        modelId: m.model_id,
        upstreamModelId: m.upstream_model_id || undefined,
        displayName: m.display_name || m.model_id,
        capabilities: safeParseCapabilities(m.capabilities_json),
      }));
      const dbIds = new Set(dbCatalog.map(m => m.modelId));
      availableModels = [
        ...dbCatalog,
        ...availableModels.filter(m => !dbIds.has(m.modelId) && !dbHiddenIds.has(m.modelId)),
      ];
    }
  } catch { /* provider_models table may not exist in old DBs */ }

  // Round 9 (2026-05-18): historical-data canonicalization for OpenRouter
  // Anthropic-skin. Apply preset upstream slugs to any alias rows whose
  // upstream is missing or equals the alias itself (legacy DB shape).
  // Gates strictly:
  //   - inferred `protocol === 'openrouter'` (the LOCAL var computed at
  //     line 894 above, NOT `provider.protocol` — that DB column may be
  //     NULL on legacy rows and is normalized via inferProtocolFromProvider)
  //   - base_url passes `isOpenRouterAnthropicSkinUrl` (i.e. ends with `/api`,
  //     not `/api/v1` — runtime-compat.ts:49 owns the predicate)
  //   - modelId is one of the three aliases
  //   - upstreamModelId is undefined OR === modelId (alias self-reference)
  // User-configured full slugs (anything else, e.g. `anthropic/claude-haiku-4.6`)
  // are preserved. Same normalize is applied by `/api/providers/models` so
  // chat send + picker + resolver all see the same shape.
  if (
    protocol === 'openrouter' &&
    provider.base_url &&
    isOpenRouterAnthropicSkinUrl(provider.base_url)
  ) {
    availableModels = availableModels.map(m =>
      normalizeOpenRouterAnthropicAlias(m, presetModels),
    );
  }

  // Read per-provider options
  const providerOpts = getProviderOptions(provider.id);

  // Read global default model — only use it if it belongs to THIS provider
  const globalDefaultModel = getSetting('global_default_model') || undefined;
  const globalDefaultProvider = getSetting('global_default_model_provider') || undefined;
  const applicableGlobalDefault = (globalDefaultModel && globalDefaultProvider === provider.id)
    ? globalDefaultModel : undefined;

  // Pre-compute provider compat + a model-id index so the runtime guard
  // below can check capabilities in O(1). Only built when a runtime is
  // requested — keeps the no-runtime path the same shape as before.
  const providerCompat = getProviderCompat(provider);
  const modelIndex: Map<string, CatalogModel> = opts.runtime
    ? new Map(availableModels.map(m => [m.modelId, m]))
    : new Map();
  /** Runtime-compat guard for default-model fallback selection.
   *  - No runtime requested → always pass (legacy behavior).
   *  - Unknown id → fall back to the upstream defaults of the runtime
   *    (resolved via `getModelCompat({ providerCompat })`); this matters
   *    for ids that are referenced from `roleModels` / settings but
   *    haven't materialized into `availableModels` yet (e.g. preset
   *    role default before discovery has been run). */
  const runtimeOk = (id: string | undefined): boolean => {
    if (!opts.runtime) return true;
    if (!id) return false;
    const entry = modelIndex.get(id);
    const cap = getModelCompat({
      modelId: id,
      upstreamModelId: entry?.upstreamModelId,
      providerCompat,
      capabilities: entry?.capabilities,
    });
    if (cap.media) return false;
    // Phase 0.5 Slice E.1 (2026-05-13) — filter by the canonical
    // `supportedRuntimes` array. Adding Codex Runtime later requires
    // zero changes here: `getModelCompat` populates supportedRuntimes
    // for every provider tier, and Codex's adapter / catalog entry
    // adds 'codex_runtime' to the array. The legacy boolean branch
    // hard-coded a two-runtime world.
    return cap.supportedRuntimes?.includes(opts.runtime) ?? false;
  };
  // For the final fallback `availableModels[0]?.modelId` step we want the
  // first model that is both enabled (already encoded in `availableModels`,
  // which excludes `dbHiddenIds`) AND compatible with the active runtime.
  const runtimeFilteredAvailable = opts.runtime
    ? availableModels.filter(m => runtimeOk(m.modelId))
    : availableModels;

  // Resolve model — priority:
  //   1. Explicit request model (opts.model)        ← honored even if hidden /
  //                                                   runtime-incompatible;
  //                                                   user asked for it explicitly
  //   2. Session's stored model (opts.sessionModel) ← stored at the session level,
  //                                                   trust it
  //   3. Global default model (only if it belongs to this provider)
  //   4. Provider's roleModels.default (preset default, e.g. "ark-code-latest")
  //   5. Global default_model setting (legacy)
  //
  // Steps 3-5 fall through to the next entry when the candidate is in
  // `dbHiddenIds` OR is incompatible with `opts.runtime` — a hidden model
  // must never be silently selected as a default, and a model the active
  // runtime can't reach should not be picked as the default either (it
  // would fail at the route / SDK layer with a confusing error). Final
  // fallback: the first enabled+compatible entry in `availableModels`,
  // and only if that filter yields nothing do we fall back to the first
  // enabled model regardless of runtime — that lets us still produce a
  // resolution for users with no compatible model configured.
  const visibleOrUndef = (id: string | undefined) =>
    (!id || dbHiddenIds.has(id) || !runtimeOk(id)) ? undefined : id;
  const requestedModel = opts.model
    || opts.sessionModel
    || visibleOrUndef(applicableGlobalDefault)
    || visibleOrUndef(roleModels.default)
    || visibleOrUndef(getSetting('default_model') || undefined)
    || runtimeFilteredAvailable[0]?.modelId
    || availableModels[0]?.modelId
    || undefined;
  let model = requestedModel;
  let upstreamModel: string | undefined;
  let modelDisplayName: string | undefined;

  // If a use case is specified, check role models for that use case — but
  // skip if that role's mapped model is hidden or runtime-incompatible
  // (fall back to the request model). Same precedence as the default chain
  // above; useCase routing must not bypass the runtime gate.
  if (opts.useCase && opts.useCase !== 'default' && roleModels[opts.useCase]) {
    const roleModel = roleModels[opts.useCase];
    if (roleModel && !dbHiddenIds.has(roleModel) && runtimeOk(roleModel)) {
      model = roleModel;
    }
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

  // Strip role slots that would leak the wrong model into the SDK subprocess
  // env via `toClaudeCodeEnv()`. Two gates apply, both targeting
  // `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL` / `ANTHROPIC_REASONING_MODEL`
  // / `ANTHROPIC_SMALL_FAST_MODEL`:
  //   - Hidden:  user explicitly turned the model off in Settings > Models;
  //              honoring it in the subprocess violates that intent.
  //   - Runtime: when the active chat-side runtime is requested, slots that
  //              point at runtime-incompatible models can't be served by the
  //              Claude Code subprocess (e.g. a `codepilot_only` row used as
  //              `roleModels.default` would set `ANTHROPIC_MODEL` to a model
  //              that Claude Code can't reach).
  // `runtimeOk` returns `true` when no `opts.runtime` was given, so the
  // legacy no-runtime caller path keeps the hidden-only behavior.
  if (dbHiddenIds.size > 0 || opts.runtime) {
    let dirty = false;
    const cleaned: RoleModels = { ...roleModels };
    for (const key of Object.keys(cleaned) as Array<keyof RoleModels>) {
      const v = cleaned[key];
      if (!v) continue;
      if (dbHiddenIds.has(v) || !runtimeOk(v)) {
        cleaned[key] = undefined;
        dirty = true;
      }
    }
    if (dirty) roleModels = cleaned;
  }

  // Ensure roleModels.default points at a model the user actually wants:
  //   1. Explicit override path: caller passed opts.model and catalog mapped
  //      it to a different upstream id (existing behaviour).
  //   2. Fill-stripped path: the original default was just stripped as hidden
  //      above, so default is now empty — fill it with the picked fallback
  //      so toClaudeCodeEnv() still sets ANTHROPIC_MODEL. Without this,
  //      ANTHROPIC_MODEL would be unset and the Claude Code subprocess would
  //      fall back to its own internal default, which may not match what
  //      the chat picker actually surfaces to the user.
  if (upstreamModel) {
    const explicitOverride = !!opts.model && upstreamModel !== roleModels.default;
    const fillStrippedDefault = !roleModels.default;
    if (explicitOverride || fillStrippedDefault) {
      roleModels = { ...roleModels, default: upstreamModel };
    }
  }

  // Has credentials?
  const hasCredentials = !!(provider.api_key) || authStyle === 'env_only';

  // Settings sources for DB-backed providers — KEEP 'user', DROP 'project'+'local'.
  //
  // Why 'user' stays: the SDK relies on `settingSources: ['user']` to
  // automatically discover user-scoped features that CodePilot does NOT
  // pass explicitly:
  //   - User-level MCP servers from ~/.claude.json / ~/.claude/settings.json
  //   - User-level plugins via `enabledPlugins` in settings.json
  //   - User-level skills from ~/.claude/skills/
  //   - User-level hooks, permissions, CLAUDE.md
  // Dropping 'user' silently disables all of the above. The cc-switch-style
  // env-bleed concern at the user layer is handled by per-request shadow
  // HOME in `claude-home-shadow.ts` — settings.json is materialized with
  // ANTHROPIC_* keys stripped while everything else is preserved.
  //
  // Why 'project' and 'local' are dropped:
  // The SDK's `qZq()` settings loader applies env from EVERY settingSource
  // layer. Shadow HOME only sanitizes user-level files. Project / local
  // settings (`<cwd>/.claude/settings.json`, `<cwd>/.claude/settings.local.json`)
  // can theoretically contain `env: { ANTHROPIC_BASE_URL, ... }` which would
  // override the explicitly selected DB provider's auth. We considered
  // shadowing cwd too, but file-creation tools (Edit/Write) operate on
  // relative paths, so a shadow cwd would silently make new files vanish.
  // Cleaner: stop exposing project/local layers and explicitly preserve
  // the non-auth project features we actually need:
  //   - Project CLAUDE.md / AGENTS.md → loaded via context-assembler.ts:89
  //     (workspacePrompt) AND agent-system-prompt.ts:119 (discoverProject-
  //     Instructions). Both run without going through SDK settingSources.
  //   - Project `<cwd>/.mcp.json` → explicitly injected into the SDK's
  //     `mcpServers` Option in claude-client.ts (~line 647) via
  //     `loadProjectMcpServers(resolvedWorkingDirectory.path)`. We can't
  //     rely on SDK auto-loading because that's gated by 'project'
  //     settingSource, AND mcp-loader.ts:48 reads `process.cwd()` which on
  //     the desktop app is the Next.js server's working dir (wrong).
  // Lost (rare): `<cwd>/.claude/settings.json` mcpServers / hooks / plugins
  // / permissions and `<cwd>/.claude/settings.local.json` overrides. Most
  // users don't author project-level Claude Code config, and CodePilot has
  // its own permission system, so this is an acceptable trade-off.
  //
  // Env mode (no DB provider) keeps all 3 sources — see buildResolution()
  // around line 640 — so cc-switch users without a configured DB provider
  // get the full Claude Code config experience.
  const settingSources = ['user'];

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
 * Delegates to the shared getEffectiveProviderProtocol() so raw values that
 * aren't valid Protocol union members (legacy garbage, future unknown
 * strings) fall back to legacy inference instead of silently poisoning
 * downstream capability lookups.
 */
function inferProtocolFromProvider(provider: ApiProvider): Protocol {
  return getEffectiveProviderProtocol(
    provider.provider_type,
    provider.protocol,
    provider.base_url,
    provider.preset_key,
  );
}

function inferAuthStyleFromProvider(provider: ApiProvider): AuthStyle {
  // Check preset match first — pass protocol to avoid cross-protocol fuzzy mismatches
  const protocol = inferProtocolFromProvider(provider);
  const preset = findPresetForLegacy(provider.base_url, provider.provider_type, protocol, provider.preset_key);
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

// ── Auxiliary model routing ─────────────────────────────────────
//
// Auxiliary tasks (context compression, short summaries, vision,
// web extract, etc.) should use a small/fast model to save cost.
// This section implements the 5-step resolution chain documented in
// docs/research/hermes-agent-analysis.md §3.2:
//
//   1. Per-task env override (AUXILIARY_<TASK>_PROVIDER + _MODEL)
//   2. Main provider's roleModels.small (if not sdkProxyOnly)
//   3. Main provider's roleModels.haiku (if not sdkProxyOnly)
//   4. First other non-sdkProxyOnly provider with .small or .haiku
//   5. Main provider + main model (ultimate floor — never returns null)
//
// CodePilot background: provider preset's roleModels.small slot is
// already populated for many providers (see provider-catalog.ts) and
// already consumed by toClaudeCodeEnv() to set ANTHROPIC_SMALL_FAST_MODEL
// for the SDK path. This routing extends the same slot to Native Runtime
// auxiliary tasks without hardcoding provider-specific model names.

export type AuxiliaryTask = 'compact' | 'vision' | 'summarize' | 'web_extract';

export type AuxiliaryResolutionSource =
  | 'env_override'
  | 'main_small'
  | 'main_haiku'
  | 'fallback_provider_small'
  | 'fallback_provider_haiku'
  | 'main_floor';

export interface AuxiliaryModelResolution {
  /** Provider ID — 'env' when no DB provider is configured (environment mode). */
  providerId: string;
  /** Upstream model ID to send to the API. May be empty string if nothing is configured. */
  modelId: string;
  /** Which resolution tier produced this result — for telemetry / debugging. */
  source: AuxiliaryResolutionSource;
}

/**
 * Context required by the pure routing function.
 * Everything is pre-fetched by resolveAuxiliaryModel() so the routing logic
 * itself performs no IO and is trivial to unit test.
 */
export interface AuxiliaryRoutingContext {
  /** Result of resolveProvider() — may have provider=undefined in env mode. */
  main: ResolvedProvider;
  /** Whether main provider is flagged sdkProxyOnly via its preset. */
  isMainSdkProxyOnly: boolean;
  /** Other configured providers with their roleModels and sdkProxyOnly flag. */
  others: ReadonlyArray<{
    id: string;
    roleModels: RoleModels;
    isSdkProxyOnly: boolean;
    isInteractiveOnly: boolean;
  }>;
  /** Per-task env override — env_override tier only applies when BOTH are set. */
  envOverride?: { providerId?: string; modelId?: string };
}

/**
 * Pure routing function — implements the 5-step resolution chain.
 *
 * Separated from the live wrapper so unit tests can feed in fixtures
 * without mocking DB / env. All dependencies come in via `ctx`.
 */
export function routeAuxiliaryModel(
  task: AuxiliaryTask,
  ctx: AuxiliaryRoutingContext,
): AuxiliaryModelResolution {
  void task; // per-task logic currently limited to env var name (handled in wrapper)

  // Tier 1: Per-task env override — requires both provider and model set.
  const env = ctx.envOverride;
  if (env?.providerId && env?.modelId) {
    return {
      providerId: env.providerId,
      modelId: env.modelId,
      source: 'env_override',
    };
  }

  const main = ctx.main;
  const mainId = main.provider?.id ?? 'env';

  // Tier 2: Main provider's small slot (if not sdkProxyOnly).
  if (!ctx.isMainSdkProxyOnly && main.roleModels.small) {
    return {
      providerId: mainId,
      modelId: main.roleModels.small,
      source: 'main_small',
    };
  }

  // Tier 3: Main provider's haiku slot (if not sdkProxyOnly).
  if (!ctx.isMainSdkProxyOnly && main.roleModels.haiku) {
    return {
      providerId: mainId,
      modelId: main.roleModels.haiku,
      source: 'main_haiku',
    };
  }

  // Tier 4: Scan other providers for first non-sdkProxyOnly with small or haiku.
  for (const other of ctx.others) {
    if (other.isSdkProxyOnly || other.isInteractiveOnly) continue;
    if (other.roleModels.small) {
      return {
        providerId: other.id,
        modelId: other.roleModels.small,
        source: 'fallback_provider_small',
      };
    }
    if (other.roleModels.haiku) {
      return {
        providerId: other.id,
        modelId: other.roleModels.haiku,
        source: 'fallback_provider_haiku',
      };
    }
  }

  // Tier 5: Ultimate floor — main provider + main model.
  // This is the "never return null" guarantee: if no cheap model is available,
  // the auxiliary task simply uses the same model as the main conversation.
  // Callers treat this as "auxiliary optimization unavailable, run on primary".
  return {
    providerId: mainId,
    modelId: main.upstreamModel || main.model || '',
    source: 'main_floor',
  };
}

/**
 * Live entry point — fetches the main provider, enumerates other configured
 * providers, reads per-task env overrides, and delegates to routeAuxiliaryModel.
 *
 * **Never returns null.** When no cheap auxiliary model is available, falls
 * back to the main provider + main model (source: 'main_floor') so callers
 * can always make a valid model call — even if it doesn't save cost.
 *
 * **Session context**: callers MUST pass the session's provider context
 * (providerId / sessionProviderId / sessionModel) so that "main" means
 * "the provider backing this chat session", not "the global default".
 * Without this, an auxiliary task from a session that overrides the
 * default provider would compress against unrelated credentials/models.
 * See exec plan decision log 2026-04-12 ~04:00 for the Codex review
 * that caught this.
 *
 * @param task The auxiliary task type (compact, vision, summarize, web_extract)
 * @param opts Session context forwarded to `resolveProvider()`. Omitting
 *   this falls back to the global default provider — intentionally kept
 *   for callers that don't have a session (e.g. background jobs).
 */
export function resolveAuxiliaryModel(
  task: AuxiliaryTask,
  opts: ResolveOptions = {},
): AuxiliaryModelResolution {
  // Resolve the main provider with session context. Passing opts through
  // is critical — otherwise auxiliary routing targets the global default
  // instead of the session's active provider.
  const main = resolveProvider(opts);

  // Determine if main provider is sdkProxyOnly via preset lookup.
  let isMainSdkProxyOnly = false;
  if (main.provider) {
    const preset = findPresetForLegacy(
      main.provider.base_url,
      main.provider.provider_type,
      main.protocol,
      main.provider.preset_key,
    );
    isMainSdkProxyOnly = preset?.sdkProxyOnly ?? false;
  }

  // Enumerate other providers and compute their roleModels + sdkProxyOnly.
  const others: Array<{ id: string; roleModels: RoleModels; isSdkProxyOnly: boolean; isInteractiveOnly: boolean }> = [];
  if (main.provider) {
    try {
      const allProviders = getAllProviders();
      for (const p of allProviders) {
        if (p.id === main.provider.id) continue;
        // Match the main-path resolver: fall back through legacy inference
        // whenever raw protocol isn't a valid Protocol union member, so a
        // stray 'random-garbage' row can't silently drive preset / role-model
        // lookup into a different code path than the main provider got.
        const protocol = getEffectiveProviderProtocol(p.provider_type, p.protocol, p.base_url, p.preset_key);
        const preset = findPresetForLegacy(p.base_url, p.provider_type, protocol, p.preset_key);
        others.push({
          id: p.id,
          roleModels: computeEffectiveRoleModels(p, preset, protocol),
          isSdkProxyOnly: preset?.sdkProxyOnly ?? false,
          isInteractiveOnly: preset?.usagePolicy === 'interactive_only',
        });
      }
    } catch (err) {
      // getAllProviders may fail in test environments or on fresh DBs.
      // Degrade gracefully — the routing still returns a usable result via
      // the main_floor tier.
      console.warn('[resolveAuxiliaryModel] getAllProviders failed:', err);
    }
  }

  // Per-task env override — read e.g. AUXILIARY_COMPACT_PROVIDER + _MODEL.
  const envKey = task.toUpperCase();
  const envProvider = process.env[`AUXILIARY_${envKey}_PROVIDER`];
  const envModel = process.env[`AUXILIARY_${envKey}_MODEL`];
  const envOverrideProvider = envProvider ? getProvider(envProvider) : undefined;
  const envOverrideAllowed = !envOverrideProvider
    || getProviderUsagePolicy(envOverrideProvider) !== 'interactive_only'
    || (!!opts.callScene && isInteractiveSceneAllowed(opts.callScene));

  return routeAuxiliaryModel(task, {
    main,
    isMainSdkProxyOnly,
    others,
    envOverride: {
      providerId: envOverrideAllowed ? envProvider : undefined,
      modelId: envOverrideAllowed ? envModel : undefined,
    },
  });
}

/**
 * Merge a provider's persisted `role_models_json` with its catalog
 * preset's `defaultRoleModels`, matching the same "fallback when no
 * default/sonnet is set" rule used by `buildResolution()` (see :664-675).
 *
 * Extracting this ensures the tier-4 auxiliary fallback sees the same
 * effective role models as the main provider resolution — without it,
 * providers that rely on preset defaults (instead of user-persisted JSON)
 * would appear to have no small/haiku slot, silently downgrading the
 * auxiliary fallback chain to `main_floor`.
 *
 * **Exported for unit testing.** The merge rule is simple but the logic
 * is load-bearing — the pre-fix auxiliary path diverged from the main
 * path by skipping this merge, and a direct unit test is the cheapest
 * way to lock the contract down. Callers inside this file use this
 * helper at the tier-4 scan site; external callers should prefer the
 * higher-level `resolveAuxiliaryModel()` unless they specifically need
 * to replicate the merge.
 */
export function computeEffectiveRoleModels(
  provider: ApiProvider,
  preset: ReturnType<typeof findPresetForLegacy>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _protocol: Protocol,
): RoleModels {
  let roleModels = safeParseRoleModels(provider.role_models_json);
  // Same fallback condition as buildResolution(): only pull preset defaults
  // when the user hasn't persisted a default or sonnet slot. Avoids
  // overriding user customizations while still giving preset-backed
  // providers their documented slots.
  if (!roleModels.default && !roleModels.sonnet && preset?.defaultRoleModels) {
    roleModels = { ...preset.defaultRoleModels, ...roleModels };
  }
  return roleModels;
}

function safeParseRoleModels(json: string | undefined | null): RoleModels {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null) return parsed as RoleModels;
  } catch { /* ignore */ }
  return {};
}

// ── Phase 2 Step 2 — session-aware wrapper ───────────────────────────

/**
 * Minimal shape consumed from a `ChatSession`. Avoids importing the
 * full DB type so the wrapper stays callable from anywhere a session
 * record is in scope (route handlers, resolver tests, future bridge
 * adapters) without dragging the DB module into client bundles.
 */
export interface SessionRuntimeIntent {
  /** Stored session provider id ('' = "no commitment yet, follow global"). */
  provider_id: string;
  /** Stored session model id ('' = "no commitment yet, follow global"). */
  model: string;
  /**
   * Per-message provider from the request body.
   *
   * **Important**: this can be either (a) a *real* user override (the
   * user just picked a different provider in the composer) or (b) just
   * the session's current provider echoed back through the wire — the
   * default `ChatView` send path includes `provider_id` on every
   * request. The wrapper does NOT use this field to decide "skip
   * validation"; it validates whichever provider will actually be sent
   * to (override if it differs from session, otherwise the session
   * value). See the `effectiveProviderId` logic below.
   *
   * If a future caller wants to explicitly mark "user just clicked
   * switch", surface that intent through a separate flag — don't piggy-
   * back on the request body, because the request body looks the same
   * for "user override" and "normal echo".
   */
  requestProviderId?: string;
  /** Per-message model override (same caveat as `requestProviderId`). */
  requestModel?: string;
}

/**
 * Phase 2 Step 2: session-aware provider resolver.
 *
 * Wraps `resolveProvider` and adds **one** behavior on top: when the
 * session committed to a specific provider id but that provider no
 * longer exists in the DB (deleted, lost in import, never created),
 * the wrapper returns a `ResolvedProvider` carrying
 * `invalidReason: 'provider-missing'`. Callers (chat send route,
 * future RunCheckpoint signal) can then refuse to send instead of
 * silently falling through to the env provider — which is what the
 * raw `resolveProvider` does today and what the user is afraid of.
 *
 * Everything else delegates straight to `resolveProvider` with the
 * session's data plumbed in: per-message request overrides win, then
 * session.model / session.provider_id, then global defaults. This is
 * the same priority chain the existing resolver enforces — we are
 * not changing it, just labelling the missing-provider case.
 *
 * Caller contract:
 *   - Pass the session's stored fields explicitly. The wrapper does
 *     NOT call `getSession()` — keeps the function pure and testable,
 *     and avoids accidental coupling to DB mocks.
 *   - To opt out of the invalid-session check (e.g. legacy paths
 *     that still want silent env fallback), call `resolveProvider`
 *     directly. Phase 2 Step 3 will progressively migrate callers.
 */
export function resolveProviderForSession(
  intent: SessionRuntimeIntent,
  extras: Pick<ResolveOptions, 'useCase' | 'runtime' | 'callScene'> = {},
): ResolvedProvider {
  const sessionProviderId = intent.provider_id;
  const requestProviderId = intent.requestProviderId;
  // Validate whichever provider id will *actually* be sent to. We
  // can't use the request body's mere presence as a "user explicitly
  // overrode, so trust it" signal — the chat composer wires the
  // session's current provider id into every send, so `requestProviderId
  // === sessionProviderId === <ghost id>` is a perfectly normal echo,
  // and gating on `!requestProviderId` would let a deleted session
  // provider quietly slip past this check (Step 2 review caught this).
  //
  // Effective id rule (matches `resolveProvider`'s own priority):
  //   - request override differs from session → override is the real
  //     destination; validate THAT one.
  //   - request matches session OR no request → session value is the
  //     destination; validate it.
  // Either way, if the destination doesn't resolve to a DB row, surface
  // `invalidReason: 'provider-missing'` so the send route can refuse
  // instead of silently rerouting through env.
  const isExplicitOverride = !!requestProviderId && requestProviderId !== sessionProviderId;
  const effectiveProviderId = isExplicitOverride ? requestProviderId : sessionProviderId;
  if (
    effectiveProviderId
    && effectiveProviderId !== 'env'
    && effectiveProviderId !== 'openai-oauth'
    && effectiveProviderId !== 'xai-oauth'
    && effectiveProviderId !== 'codex_account'
    && !getProvider(effectiveProviderId)
  ) {
    // Still produce a ResolvedProvider shape so destructuring callers
    // don't crash; the env-fallback fields are populated so a route
    // that forgets to check `invalidReason` at least doesn't behave
    // worse than the resolver did pre-Step-2.
    const fallback = resolveProvider({
      providerId: undefined,
      sessionProviderId: undefined,
      model: intent.requestModel,
      sessionModel: intent.model || undefined,
      useCase: extras.useCase,
      runtime: extras.runtime,
      callScene: extras.callScene,
    });
    return { ...fallback, invalidReason: 'provider-missing' };
  }
  // Healthy path — same priority chain as the legacy resolver.
  return resolveProvider({
    providerId: requestProviderId || undefined,
    sessionProviderId: sessionProviderId || undefined,
    model: intent.requestModel,
    sessionModel: intent.model || undefined,
    useCase: extras.useCase,
    runtime: extras.runtime,
    callScene: extras.callScene,
  });
}
