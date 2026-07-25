import { NextRequest, NextResponse } from 'next/server';
import { getAllProviders, getDefaultProviderId, setDefaultProviderId, getProvider, getAllModelsForProvider, getSetting } from '@/lib/db';
import { getContextWindow } from '@/lib/model-context';
import { isFirstPartyAnthropicEndpoint } from '@/lib/ai-provider';
import { getDefaultModelsForProvider, getEffectiveProviderProtocol, findPresetForLegacy, ENV_CLAUDE_CODE_MODELS } from '@/lib/provider-catalog';
import type { Protocol } from '@/lib/provider-catalog';
import type { ErrorResponse, ProviderModelGroup } from '@/types';
import { getOAuthStatus } from '@/lib/openai-oauth-manager';
import { getXaiOAuthStatus } from '@/lib/xai-oauth-manager';
import {
  getProviderCompat,
  getModelCompat,
  isOpenRouterAnthropicSkinUrl,
} from '@/lib/runtime-compat';
import { isChatRuntimeParam, resolveChatRuntimeParam, type ChatRuntime } from '@/lib/chat-runtime';

// OpenAI models reachable through the legacy ChatGPT Plus/Pro OAuth login
// (`openai-oauth`, compat: codepilot_only).
//
// NOT the same thing as the `codex_account` group built by
// `@/lib/codex/models` further down (Phase 0, 2026-07-17):
//   - openai-oauth  — this STATIC, hand-maintained list. Reasoning effort is
//     fixed to 'medium' server-side and is NOT user-configurable, so these
//     entries deliberately carry no effort capability metadata and the
//     composer's effort selector stays hidden for them.
//   - codex_account — DYNAMIC, sourced from the Codex app-server's
//     `model/list`, per-model effort tiers, runtime `codex_runtime`.
//
// Because this list is static it necessarily LAGS upstream. Do not hand-add
// models (e.g. GPT-5.6) to make the picker look current: an entry here is a
// claim that THIS OAuth path can serve that model, which nothing verifies.
// New Codex models must arrive through the codex_account group instead.
const OPENAI_OAUTH_MODELS = [
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3-Codex' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark' },
];

// Default Claude model options (for the built-in 'env' provider).
// Capability metadata ensures `xhigh` appears in the effort dropdown even
// before SDK capability discovery populates getCachedModels('env').
// DERIVED from provider-catalog's ENV_CLAUDE_CODE_MODELS — the same single
// source the env resolver uses — so the picker, the resolver, and the
// client fallback can never drift again (Codex review P1, 2026-06-10:
// this hand-maintained copy was missing opus-4-8 and fable-5).
const DEFAULT_MODELS = ENV_CLAUDE_CODE_MODELS.map(m => ({
  value: m.modelId,
  label: m.displayName,
  ...(m.upstreamModelId ? { upstreamModelId: m.upstreamModelId } : {}),
  ...(m.capabilities?.supportsEffort ? { supportsEffort: true } : {}),
  ...(m.capabilities?.supportedEffortLevels
    ? { supportedEffortLevels: m.capabilities.supportedEffortLevels }
    : {}),
  ...(m.capabilities?.supportsAdaptiveThinking ? { supportsAdaptiveThinking: true } : {}),
}));

// Short alias → upstream ID map for cached SDK models that may only
// return bare aliases (sonnet/opus/haiku). Derived from the same source
// as DEFAULT_MODELS — keep it derived.
const ENV_ALIAS_TO_UPSTREAM: Record<string, string> = Object.fromEntries(
  ENV_CLAUDE_CODE_MODELS
    .filter(m => m.upstreamModelId)
    .map(m => [m.modelId, m.upstreamModelId as string]),
);

interface ModelEntry {
  value: string;
  label: string;
  upstreamModelId?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  effortNoteKey?: string;
  supportsAdaptiveThinking?: boolean;
  capabilities?: Record<string, unknown>;
  variants?: Record<string, unknown>;
}

interface DbModelEntry extends ModelEntry {
  /** True only for an untouched row originally materialized from the catalog. */
  catalogManaged: boolean;
}

/**
 * The composer consumes effort fields at the model row's top level, while
 * DB/catalog/Codex sources may carry them under `capabilities`. Normalize at
 * the final API boundary so virtual groups added after the DB-provider loop
 * (notably `codex_account`) cannot silently miss the selector contract.
 */
export function normalizeModelCapabilitySurface(model: ModelEntry): ModelEntry {
  const caps = model.capabilities ?? {};
  const {
    supportsEffort: directSupportsEffort,
    supportedEffortLevels: directEffortLevels,
    effortNoteKey: directEffortNoteKey,
    supportsAdaptiveThinking: directAdaptiveThinking,
    ...base
  } = model;
  const supportsEffort = typeof directSupportsEffort === 'boolean'
    ? directSupportsEffort
    : typeof caps.supportsEffort === 'boolean'
      ? caps.supportsEffort
      : undefined;
  const supportedEffortLevels = Array.isArray(directEffortLevels)
    && directEffortLevels.every((level): level is string => typeof level === 'string')
    ? directEffortLevels
    : Array.isArray(caps.supportedEffortLevels)
        && caps.supportedEffortLevels.every((level): level is string => typeof level === 'string')
      ? caps.supportedEffortLevels
      : undefined;
  const effortNoteKey = typeof directEffortNoteKey === 'string'
    ? directEffortNoteKey
    : typeof caps.effortNoteKey === 'string'
      ? caps.effortNoteKey
      : undefined;
  const supportsAdaptiveThinking = typeof directAdaptiveThinking === 'boolean'
    ? directAdaptiveThinking
    : typeof caps.supportsAdaptiveThinking === 'boolean'
      ? caps.supportsAdaptiveThinking
      : undefined;
  return {
    ...base,
    ...(supportsEffort !== undefined ? { supportsEffort } : {}),
    ...(supportedEffortLevels !== undefined ? { supportedEffortLevels } : {}),
    ...(effortNoteKey !== undefined ? { effortNoteKey } : {}),
    ...(supportsAdaptiveThinking !== undefined ? { supportsAdaptiveThinking } : {}),
  };
}

function sameModelIdentity(a: ModelEntry, b: ModelEntry): boolean {
  const aIds = new Set([a.value, a.upstreamModelId].filter((id): id is string => !!id));
  return [b.value, b.upstreamModelId].some(id => !!id && aIds.has(id));
}

/**
 * User-edited DB rows remain authoritative on disk. For the read-only picker
 * feed, fill only missing system metadata by matching the catalog's canonical
 * upstream id. This covers Kimi's real `kimi-for-coding` row shadowing its
 * legacy `sonnet` alias without overwriting a custom label or explicit false.
 */
function enrichDbModelForRead(model: DbModelEntry, catalog: ModelEntry[]): ModelEntry {
  const { catalogManaged, ...surface } = model;
  const matched = catalog.find(entry => sameModelIdentity(surface, entry));
  if (!matched) return surface;
  const labelIsRawId = surface.label === surface.value || surface.label === surface.upstreamModelId;

  // Catalog rows are a cache of shipped defaults, not user-authored facts.
  // When a release updates a capability (Kimi max-only → low/high/max), an
  // existing installation must see the current catalog without recreating
  // the provider or manually aligning the DB. User/API rows keep the old
  // merge direction below, so explicit false/custom allowlists still win.
  if (catalogManaged) {
    return {
      ...surface,
      label: matched.label,
      upstreamModelId: matched.upstreamModelId || surface.upstreamModelId,
      capabilities: matched.capabilities,
    };
  }
  return {
    ...matched,
    ...surface,
    label: labelIsRawId ? matched.label : surface.label,
    upstreamModelId: surface.upstreamModelId || matched.upstreamModelId,
    capabilities: {
      ...(matched.capabilities ?? {}),
      ...(surface.capabilities ?? {}),
    },
  };
}

/**
 * Deduplicate models: if multiple aliases map to the same label, keep only the first one.
 */
function deduplicateModels(models: ModelEntry[]): ModelEntry[] {
  const seen = new Set<string>();
  const result: ModelEntry[] = [];
  for (const m of models) {
    if (!seen.has(m.label)) {
      seen.add(m.label);
      result.push(m);
    }
  }
  return result;
}

/** Media-only provider protocols — skip in chat model selector */
const MEDIA_PROTOCOLS = new Set<string>(['gemini-image', 'openai-image']);
const MEDIA_PROVIDER_TYPES = new Set(['gemini-image', 'openai-image']);

export async function GET(request: NextRequest) {
  try {
    // Optional `?runtime=` query — when present, every group has its model
    // list filtered down to entries compatible with the specified runtime.
    // Accepts `claude_code` / `codepilot_runtime` (explicit) or `auto` (let
    // the server resolve via `agent_runtime` setting + CLI binary check).
    // No param at all = no filtering — used by Settings > Providers' global
    // default-model selector that needs to see the full catalog.
    const runtimeParam = request.nextUrl.searchParams.get('runtime');
    const runtimeFilter: ChatRuntime | null = (runtimeParam && isChatRuntimeParam(runtimeParam))
      ? resolveChatRuntimeParam(runtimeParam)
      : null;

    const providers = getAllProviders();
    const groups: ProviderModelGroup[] = [];

    // Show the built-in Claude Code provider group unless user explicitly chose AI SDK only.
    // Auto and Claude Code modes both need Claude Code models visible.
    const runtimeSetting = getSetting('agent_runtime') || 'auto';
    const cliEnabled = runtimeSetting !== 'native';

    if (cliEnabled) {
      // Mark as sdkProxyOnly if no direct API credentials exist — in that case
      // the env provider only works through the Claude Code SDK subprocess.
      const envHasDirectCredentials = !!(
        process.env.ANTHROPIC_API_KEY ||
        process.env.ANTHROPIC_AUTH_TOKEN ||
        getSetting('anthropic_auth_token')
      );
      groups.push({
        provider_id: 'env',
        provider_name: 'Claude Code',
        provider_type: 'anthropic',
        preset_key: '',
        protocol: 'anthropic',
        compat: 'claude_code_ready',
        // #632 item 1 — env is the Claude Code (Anthropic) group, but it can
        // route through a third-party proxy via settings.anthropic_base_url /
        // process.env.ANTHROPIC_BASE_URL (same precedence as
        // resolveEffectiveAnthropicBaseUrl). Trust the SDK-reported
        // context_window only when that effective endpoint is first-party.
        reportedContextWindowTrusted: isFirstPartyAnthropicEndpoint(
          getSetting('anthropic_base_url') || process.env.ANTHROPIC_BASE_URL || undefined,
        ),
        ...(!envHasDirectCredentials ? { sdkProxyOnly: true } : {}),
        // Use upstreamModelId for context-window lookup so the bare `opus`
        // alias doesn't get clamped to the 200K Bedrock/Vertex value.
        models: DEFAULT_MODELS.map(m => {
          const cw = getContextWindow(m.value, { upstream: m.upstreamModelId });
          return cw != null ? { ...m, contextWindow: cw } : m;
        }),
      });
    }

    // If SDK has discovered models, use them for the env group
    const envGroup = groups.find(g => g.provider_id === 'env');
    if (envGroup) {
      try {
        const { getCachedModels } = await import('@/lib/agent-sdk-capabilities');
        const sdkModels = getCachedModels('env');
        if (sdkModels.length > 0) {
          envGroup.models = sdkModels.map(m => {
            // SDK sometimes returns short aliases (e.g. 'opus') — map to
            // the concrete upstream so context window and downstream
            // sanitizer checks agree with the env provider's resolver.
            const upstream = ENV_ALIAS_TO_UPSTREAM[m.value];
            const cw = getContextWindow(m.value, { upstream });
            return {
              value: m.value,
              label: m.displayName,
              description: m.description,
              supportsEffort: m.supportsEffort,
              supportedEffortLevels: m.supportedEffortLevels,
              supportsAdaptiveThinking: m.supportsAdaptiveThinking,
              ...(upstream ? { upstreamModelId: upstream } : {}),
              ...(cw != null ? { contextWindow: cw } : {}),
            };
          });
        }
      } catch {
        // SDK capabilities not available, keep defaults
      }
    }

    // Build a group for each configured provider
    for (const provider of providers) {
      // Determine protocol — use new field if present, otherwise infer from legacy
      const protocol: Protocol = getEffectiveProviderProtocol(
        provider.provider_type,
        provider.protocol,
        provider.base_url,
        provider.preset_key,
      );

      // Skip media-only providers in chat model selector
      if (MEDIA_PROTOCOLS.has(protocol) || MEDIA_PROVIDER_TYPES.has(provider.provider_type)) continue;

      // Get models: DB provider_models first, then catalog defaults, then env fallback
      let rawModels: ModelEntry[];

      // 1) Read provider_models — the *enabled* rows feed the picker, but we
      //    also need the *full* row set as a suppression list so disabled
      //    rows aren't re-added by the catalog fallback below.
      const dbModels: DbModelEntry[] = [];
      const dbHiddenIds = new Set<string>();
      let dbHasAnyRow = false;
      // Track the most-recent `last_refreshed_at` across rows so the Provider
      // card can show "刷新于 N 分钟前" — the user needs to tell whether a
      // surprising picker reflects a stale catalog vs an actual upstream change.
      let lastRefreshedAt: string | null = null;
      try {
        const provModelsAll = getAllModelsForProvider(provider.id);
        dbHasAnyRow = provModelsAll.length > 0;
        for (const m of provModelsAll) {
          if (m.last_refreshed_at && (!lastRefreshedAt || m.last_refreshed_at > lastRefreshedAt)) {
            lastRefreshedAt = m.last_refreshed_at;
          }
          if (m.enabled === 0) {
            dbHiddenIds.add(m.model_id);
            continue;
          }
          let caps: Record<string, unknown> | undefined;
          let vars: Record<string, unknown> | undefined;
          try { const p = JSON.parse(m.capabilities_json || '{}'); if (Object.keys(p).length > 0) caps = p; } catch { /* ignore */ }
          try { const v = JSON.parse(m.variants_json || '{}'); if (Object.keys(v).length > 0) vars = v; } catch { /* ignore */ }
          dbModels.push({
            value: m.model_id,
            label: m.display_name || m.model_id,
            upstreamModelId: m.upstream_model_id || undefined,
            capabilities: caps,
            variants: vars,
            catalogManaged: m.source === 'catalog'
              && m.user_edited === 0
              && m.enable_source !== 'manual_enabled'
              && m.enable_source !== 'manual_hidden',
          });
        }
      } catch { /* table may not exist in old DBs */ }

      // 2) Catalog defaults — but skip any id the user has explicitly hidden
      //    in the Models page, otherwise the picker silently re-adds them.
      const catalogModels = getDefaultModelsForProvider(protocol, provider.base_url, provider.provider_type);
      const catalogAllRaw = catalogModels
        .map(m => ({
          value: m.modelId,
          label: m.displayName,
          upstreamModelId: m.upstreamModelId,
          capabilities: m.capabilities as Record<string, unknown> | undefined,
        }));
      const catalogRaw = catalogAllRaw.filter(m => !dbHiddenIds.has(m.value));

      if (dbHasAnyRow) {
        // User has materialized rows for this provider — DB enabled set is
        // authoritative. Enrich the read surface by canonical/upstream
        // identity, then append only genuinely new catalog models. Exact-id
        // hidden rows still suppress the catalog tail; enrichment never
        // mutates provider_models.
        const enrichedDbModels = dbModels.map(m => enrichDbModelForRead(m, catalogAllRaw));
        rawModels = [
          ...enrichedDbModels,
          ...catalogRaw.filter(catalogModel => !dbModels.some(dbModel => sameModelIdentity(dbModel, catalogModel))),
        ];
      } else {
        rawModels = [...catalogRaw];
      }

      // Round 9 (2026-05-18) — OpenRouter Anthropic-skin alias-row
      // canonicalization. Mirrors `normalizeOpenRouterAnthropicAlias`
      // in provider-resolver.ts so the picker / Models page / chat
      // send all read the same upstream slug. Pre-fix this surface
      // also handed back `haiku → haiku` for legacy DB rows that
      // pre-date the round-8 preset upstreams.
      // Use the locally-inferred `protocol` (line 169) — `provider.protocol`
      // is the raw DB column which may be NULL for legacy rows; the resolver
      // applies the same normalize against the inferred protocol.
      if (
        protocol === 'openrouter' &&
        provider.base_url &&
        isOpenRouterAnthropicSkinUrl(provider.base_url)
      ) {
        const presetByAlias = new Map(catalogModels.map(m => [m.modelId, m]));
        rawModels = rawModels.map(m => {
          if (m.value !== 'sonnet' && m.value !== 'opus' && m.value !== 'haiku') {
            return m;
          }
          const presetUpstream = presetByAlias.get(m.value)?.upstreamModelId;
          if (!presetUpstream) return m;
          // Same override gate as the resolver: only fill missing or
          // self-referential upstreams; preserve full slugs.
          if (!m.upstreamModelId || m.upstreamModelId === m.value) {
            return { ...m, upstreamModelId: presetUpstream };
          }
          return m;
        });
      }

      // Inject models from role_models_json into the list if not already
      // present — but skip ids the user has explicitly hidden in Settings >
      // Models. Without this guard, hiding a role/default model on the
      // Models page wouldn't actually remove it from the chat picker.
      try {
        const rm = JSON.parse(provider.role_models_json || '{}');
        const roleEntries: { id: string; role: string }[] = [];
        for (const role of ['default', 'reasoning', 'small', 'haiku', 'sonnet', 'opus'] as const) {
          if (rm[role] && !roleEntries.some(e => e.id === rm[role])) {
            roleEntries.push({ id: rm[role], role });
          }
        }
        for (const entry of roleEntries) {
          if (dbHiddenIds.has(entry.id)) continue;
          if (!rawModels.some(m => m.value === entry.id || m.upstreamModelId === entry.id)) {
            const label = entry.role === 'default' ? entry.id : `${entry.id} (${entry.role})`;
            rawModels.unshift({ value: entry.id, label });
          }
        }
      } catch { /* ignore */ }

      // Legacy: inject ANTHROPIC_MODEL from env overrides — same hidden-set
      // guard, same reasoning (dedup also checks upstreamModelId, e.g. catalog
      // modelId='sonnet' upstreamModelId='mimo-v2.5-pro' vs env ANTHROPIC_MODEL).
      try {
        const envOverrides = provider.env_overrides_json || provider.extra_env || '{}';
        const envObj = JSON.parse(envOverrides);
        const envModelId = envObj.ANTHROPIC_MODEL;
        if (envModelId && !dbHiddenIds.has(envModelId) && !rawModels.some(m => m.value === envModelId || m.upstreamModelId === envModelId)) {
          rawModels.unshift({ value: envModelId, label: envModelId });
        }
      } catch { /* ignore */ }

      const models = deduplicateModels(rawModels).map(m => {
        // Pass upstream so alias windows resolve per provider:
        // first-party opus → 1M (Opus 4.7) vs Bedrock/Vertex opus → 200K
        // (Opus 4.6). The model API is per-provider, so the correct
        // upstream is whatever catalog declared for this provider group.
        const cw = getContextWindow(m.value, { upstream: m.upstreamModelId });
        // Lift effort/thinking capability flags from nested `capabilities` to top-level
        // so MessageInput / EffortSelectorDropdown can read them without unwrapping.
        const caps = (m.capabilities || {}) as Record<string, unknown>;
        const effortLift = {
          ...(caps.supportsEffort != null ? { supportsEffort: caps.supportsEffort as boolean } : {}),
          ...(caps.supportedEffortLevels != null ? { supportedEffortLevels: caps.supportedEffortLevels as string[] } : {}),
          ...(caps.effortNoteKey != null ? { effortNoteKey: caps.effortNoteKey as string } : {}),
          ...(caps.supportsAdaptiveThinking != null ? { supportsAdaptiveThinking: caps.supportsAdaptiveThinking as boolean } : {}),
        };
        return {
          ...m,
          ...effortLift,
          ...(cw != null ? { contextWindow: cw } : {}),
        };
      });

      // Detect SDK-proxy-only providers via preset match
      const preset = findPresetForLegacy(provider.base_url, provider.provider_type, protocol, provider.preset_key);
      const sdkProxyOnly = preset?.sdkProxyOnly === true;

      // total_count is the user-visible "synced model count" on Provider cards.
      // Counts everything in provider_models for this provider (enabled +
      // hidden), or the catalog size when the table is empty (e.g. a fresh
      // catalog-only provider whose seed already ran for the picker).
      const totalCount = dbHasAnyRow
        ? (dbModels.length + dbHiddenIds.size)
        : catalogModels.length;

      groups.push({
        provider_id: provider.id,
        provider_name: provider.name,
        provider_type: provider.provider_type,
        preset_key: provider.preset_key,
        protocol: provider.protocol,
        ...(sdkProxyOnly ? { sdkProxyOnly: true } : {}),
        total_count: totalCount,
        last_refreshed_at: lastRefreshedAt,
        compat: getProviderCompat(provider),
        // #632 item 1 — only an anthropic-protocol provider on a third-party
        // base_url reports the Claude SDK's bogus ~200K default context_window.
        // Non-anthropic protocols (Codex's real modelContextWindow, etc.) report
        // their own window, so leave those trusted.
        reportedContextWindowTrusted:
          protocol !== 'anthropic' || isFirstPartyAnthropicEndpoint(provider.base_url || undefined),
        models,
      });
    }

    // Add OpenAI OAuth virtual provider when authenticated
    try {
      const oauthStatus = getOAuthStatus();
      if (oauthStatus.authenticated) {
        groups.push({
          provider_id: 'openai-oauth',
          provider_name: `OpenAI${oauthStatus.plan ? ` (${oauthStatus.plan})` : ''}`,
          provider_type: 'openai-oauth',
          preset_key: 'openai-oauth',
          protocol: 'openai-compatible',
          compat: 'codepilot_only',
          models: OPENAI_OAUTH_MODELS,
        });
      }
    } catch { /* OpenAI OAuth module not available */ }

    try {
      const xaiStatus = getXaiOAuthStatus();
      if (xaiStatus.enabled && xaiStatus.authenticated) {
        groups.push({
          provider_id: 'xai-oauth',
          provider_name: 'xAI Grok OAuth',
          provider_type: 'xai-oauth',
          preset_key: 'xai-oauth',
          protocol: 'xai',
          compat: 'codepilot_only',
          models: [{ value: 'grok-4.5', label: 'Grok 4.5' }],
        });
      }
    } catch { /* xAI OAuth module not available */ }

    // Phase 5 Phase 2 (2026-05-13) — Codex Account virtual provider.
    //
    // P0.3 (2026-06-01) — Codex model discovery is an OPTIONAL enhancement
    // and must NEVER block the global model feed. A broken/old Codex
    // app-server was hanging this route ~30s, freezing Settings overview,
    // the chat composer ("正在准备运行环境"), and the runtime health card.
    // So the spawn policy now depends on the requested runtime:
    //
    //   - `codex_runtime` (explicit): allowed to spawn, but bounded by a
    //     short timeout so a slow/broken app-server degrades to "no Codex
    //     group" instead of hanging the response.
    //   - no runtime (full catalog — Settings global selector / chat feed):
    //     MUST NOT implicitly spawn. Serve a warm cache only; no cache →
    //     skip the codex_account group this round.
    //   - any other runtime filter (claude_code / codepilot_runtime): skip
    //     Codex entirely — saves an unnecessary RPC.
    if (runtimeFilter === 'codex_runtime') {
      try {
        const { buildCodexProviderModelGroup } = await import('@/lib/codex/models');
        const codexGroup = await buildCodexProviderModelGroup({ timeoutMs: 2500 });
        if (codexGroup) groups.push(codexGroup);
      } catch {
        /* degraded: Codex unreachable / timed out — no Codex group. */
      }
    } else if (!runtimeFilter) {
      try {
        const { buildCodexProviderModelGroup } = await import('@/lib/codex/models');
        // cacheOnly — never spawn from the full-catalog path.
        const codexGroup = await buildCodexProviderModelGroup({ cacheOnly: true });
        if (codexGroup) groups.push(codexGroup);
      } catch {
        /* Codex module not available; ignore. */
      }
    }

    // Phase 6 UI收口 P2 (2026-05-14) — every model row carries its
    // canonical compat annotations (`supportedRuntimes` +
    // `unsupportedReasonByRuntime`). Pickers render the full catalog
    // and use these per-row fields to disable + tooltip incompatible
    // rows, instead of hiding them server-side. This kills three
    // long-standing UX problems:
    //
    //   1. Users couldn't tell where models went when they switched
    //      runtimes — the picker silently dropped them.
    //   2. The chat banner had to use a prominent red disclosure to
    //      explain what the server filter had already done invisibly.
    //   3. Settings models page (which already showed everything with
    //      a separate runtime-tier filter) and the chat picker
    //      diverged on whose responsibility it was to filter.
    //
    // The `?runtime=X` URL param is preserved for backward compat
    // (Settings > Providers' global default selector uses it) and
    // still scopes the visible rows when explicitly requested. The
    // canonical chat picker now omits it and renders disabled rows
    // for compat.
    //
    // Media rows (image / video / embedding) are still dropped at
    // the row layer regardless of runtime — those don't belong in
    // chat pickers period.
    let outGroups = groups.map(g => {
      const providerCompat = g.compat ?? 'unknown';
      // Phase 5b (2026-05-15) — the built-in `env` Claude Code default
      // provider is explicitly excluded from Codex Runtime parity. It
      // routes through the Claude Code subprocess (or direct API via
      // ANTHROPIC_API_KEY env), not through any DB-configured provider
      // record that the Codex proxy could resolve. Keeping it in
      // `supportedRuntimes` would surface it in the Codex Runtime
      // picker, where selecting it would fail to send (the runtime
      // can't translate "env" into a `x-codepilot-target-provider`
      // header). Strip codex_runtime here so the picker can render
      // the row disabled with a clear reason.
      const isEnvProvider = g.provider_id === 'env';
      const annotatedModels = g.models
        .map(m => {
          const normalized = normalizeModelCapabilitySurface(m);
          const cap = getModelCompat({
            modelId: normalized.value,
            upstreamModelId: normalized.upstreamModelId,
            providerCompat,
            capabilities: normalized.capabilities as Parameters<typeof getModelCompat>[0]['capabilities'],
          });
          if (cap.media) return null;
          let supportedRuntimes = cap.supportedRuntimes;
          let unsupportedReasonByRuntime = cap.unsupportedReasonByRuntime;
          if (isEnvProvider && supportedRuntimes?.includes('codex_runtime')) {
            supportedRuntimes = supportedRuntimes.filter(r => r !== 'codex_runtime');
            unsupportedReasonByRuntime = {
              ...(unsupportedReasonByRuntime ?? {}),
              codex_runtime:
                'Claude Code 默认 / env provider 不接入 Codex Runtime；改用配置好的 CodePilot provider 或 Codex Account',
            };
          }
          return {
            ...normalized,
            supportedRuntimes,
            unsupportedReasonByRuntime,
          };
        })
        .filter((m): m is NonNullable<typeof m> => m !== null);
      return { ...g, models: annotatedModels };
    });
    if (runtimeFilter) {
      outGroups = outGroups.map(g => {
        const filteredModels = g.models.filter(
          m => m.supportedRuntimes?.includes(runtimeFilter) ?? false,
        );
        return { ...g, models: filteredModels };
      }).filter(g => g.models.length > 0);
    } else {
      // Even when no runtime filter is requested, drop providers with
      // zero usable models so the picker doesn't render an empty
      // section header (e.g. a freshly-created provider with no
      // enabled models).
      outGroups = outGroups.filter(g => g.models.length > 0);
    }

    // Determine default provider — auto-heal stale references on read
    let defaultProviderId = getDefaultProviderId();
    if (defaultProviderId && !getProvider(defaultProviderId)) {
      // Stale default (provider was deleted). Fix it now.
      const firstValid = outGroups.find(g => g.provider_id !== 'env');
      defaultProviderId = firstValid?.provider_id || '';
      setDefaultProviderId(defaultProviderId);
    }
    defaultProviderId = defaultProviderId || outGroups[0]?.provider_id || '';

    return NextResponse.json({
      groups: outGroups,
      default_provider_id: defaultProviderId,
      // Echo back which runtime the server actually used to filter so
      // the chat picker can surface "showing models for Claude Code
      // Runtime" without recomputing the resolution client-side. Only
      // populated when caller asked for filtering — Settings's global
      // default selector (no ?runtime=) gets undefined here.
      runtime_applied: runtimeFilter ?? undefined,
    });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to get models' },
      { status: 500 }
    );
  }
}
