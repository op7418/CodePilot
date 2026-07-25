import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { ProviderModelGroup } from '@/types';
// `chat-runtime-shared` (not `chat-runtime`) — even type-only imports
// from the server-side module muddy the boundary; keeping all hook /
// component imports pointed at the shared module makes "client-safe"
// the local rule for this hook too.
import type { ChatRuntimeParam } from '@/lib/chat-runtime-shared';
import { isRuntimeId, type RuntimeId } from '@/lib/runtime/runtime-id';
// Canonical-aware model matcher (tech-debt #37) — pure helper shared by the
// composer (picker / auto-correct / run-status / context upstream) so every
// surface resolves a saved canonical id the same way. Re-exported below for
// existing importers of this hook.
import { findModelOption } from '@/lib/model-option-match';
// provider-catalog is client-safe (zod only; already imported by
// provider-presets.tsx) — the env default model list must DERIVE from this
// single source, not be re-hardcoded (Codex review P1, 2026-06-10: this
// fallback copy was missing opus-4-8 and fable-5).
import { ENV_CLAUDE_CODE_MODELS } from '@/lib/provider-catalog';

export { findModelOption };

// Default Claude model options — used as fallback when API is unavailable
export interface DefaultModelOption {
  value: string;
  label: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  /** i18n key for the effort menu's mapping note (GLM two-tier / Kimi Auto). */
  effortNoteKey?: string;
}

export const DEFAULT_MODEL_OPTIONS: DefaultModelOption[] = ENV_CLAUDE_CODE_MODELS.map(m => ({
  value: m.modelId,
  label: m.displayName,
  ...(m.capabilities?.supportsEffort ? { supportsEffort: true } : {}),
  ...(m.capabilities?.supportedEffortLevels
    ? { supportedEffortLevels: m.capabilities.supportedEffortLevels as string[] }
    : {}),
}));

/**
 * Should the chat composer show "正在准备运行环境…"?
 *
 * P0.4 (2026-06-01): only during the GENUINE first load — i.e. while the
 * feed is in-flight AND no sendable model has resolved yet. Once a model is
 * resolved, a background refetch (provider-changed / runtime switch resets
 * `fetchState` to 'idle' but keeps the prior `providerGroups`) must NOT
 * re-flash the placeholder. Previously the composer keyed purely on
 * `fetchState === 'idle'`, so every refetch — including the full-catalog
 * background load that a broken Codex used to stall — froze the input on
 * "正在准备运行环境…" even though a perfectly sendable model was already known.
 */
export function isComposerProviderLoading(
  fetchState: 'idle' | 'loaded' | 'failed',
  hasResolvedModel: boolean,
): boolean {
  return fetchState === 'idle' && !hasResolvedModel;
}

export interface UseProviderModelsReturn {
  providerGroups: ProviderModelGroup[];
  /**
   * The runtime the server actually filtered against, when the hook
   * was called with `runtime: 'auto'`. UI uses this to surface
   * "showing models for X runtime" in the picker. Undefined when
   * caller passed `runtime: null` (Settings full-catalog mode).
   *
   * Typed as the canonical `RuntimeId` from runtime-id.ts — adding a
   * new runtime (Codex etc.) flows through automatically without
   * touching this hook.
   */
  runtimeApplied?: RuntimeId;
  currentProviderIdValue: string;
  modelOptions: typeof DEFAULT_MODEL_OPTIONS;
  currentModelOption: (typeof DEFAULT_MODEL_OPTIONS)[number];
  /** Global default model (model value) */
  globalDefaultModel: string | undefined;
  /** Global default model's provider ID */
  globalDefaultProvider: string | undefined;
  /**
   * True when the runtime-filtered API succeeded but returned an empty
   * group list — user has providers configured but none are compatible
   * with the active runtime. Distinct from "API is unreachable" (the
   * catch branch synthesises an `env` group, so providerGroups.length
   * stays 1 in that case). Callers (chat picker / send-gate) use this
   * to block sends so the saved-session model+provider combo can't reach
   * /api/chat where it would be silently re-resolved against env defaults.
   */
  noCompatibleProvider: boolean;
  /**
   * Load tracking. `loaded` after the first successful response (even
   * with `groups: []`); `failed` after network/parse error (catch branch
   * already synthesised an `env` fallback group); `idle` until the first
   * fetch settles. Callers use this to avoid auto-rewriting saved
   * session state during the load window or when the API is down.
   */
  fetchState: 'idle' | 'loaded' | 'failed';
  /**
   * The provider id the picker / send path SHOULD use right now. Equal
   * to `currentProviderIdValue`; surfaced under a clearer name so
   * consumers don't accidentally use the raw caller-supplied prop when
   * the runtime filter has rerouted to a fallback group. Empty
   * `providerId` is normalised to `'env'` so historic env-mode sessions
   * (provider_id='') flow through the same code path as everyone else.
   */
  resolvedProviderId: string;
  /**
   * The model id the picker / send path SHOULD use. If the caller's
   * `modelName` exists in `modelOptions` it passes through unchanged;
   * otherwise we drop to `modelOptions[0]?.value` so we never send a
   * model the resolved provider doesn't actually expose. Empty when
   * `noCompatibleProvider` (caller must gate before sending).
   */
  resolvedModel: string;
  /**
   * True when the caller-supplied `providerId` was non-empty AND not
   * present in the runtime-filtered groups, i.e. the session's saved
   * provider was filtered out and we substituted a different one.
   * Caller should PATCH /api/chat/sessions/:id with the resolved pair
   * to keep DB / UI / wire-format consistent.
   *
   * Only meaningful after `fetchState === 'loaded'` — during loading
   * and on API failure we don't want to silently rewrite saved state.
   */
  providerWasFilteredOut: boolean;
}

/**
 * @param runtime  Runtime gate for the picker feed. **Required as of
 * Phase 2 Step 3b** — the previous `'auto'` default made every chat-side
 * caller silently re-filter on global `agent_runtime` change, so any
 * open chat could "lose" its provider when the user flipped Settings.
 * Callers must now choose deliberately:
 *   - `'auto'`: server resolves the active runtime via global setting
 *     and filters. **Only** appropriate for new-chat / Settings flows
 *     where there is no session intent yet.
 *   - `'claude_code'` / `'codepilot_runtime'`: explicit pin. The chat
 *     view computes this from the session's `runtime_pin` via
 *     `chatRuntimeParamForSession()`, so the picker reflects what THIS
 *     session can actually reach — global flips don't cascade.
 *   - `null`: skip the filter entirely — full catalog (e.g. Settings >
 *     Providers' global default-model selector).
 */
export function useProviderModels(
  providerId: string | undefined,
  modelName: string | undefined,
  runtime: ChatRuntimeParam | null,
): UseProviderModelsReturn {
  const [providerGroups, setProviderGroups] = useState<ProviderModelGroup[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState<string>('');
  const [globalDefaultModel, setGlobalDefaultModel] = useState<string | undefined>();
  const [globalDefaultProvider, setGlobalDefaultProvider] = useState<string | undefined>();
  const [runtimeApplied, setRuntimeApplied] = useState<RuntimeId | undefined>(undefined);
  // Tri-state load tracking. `noCompatibleProvider` is meaningful only
  // after a successful response — the initial empty `providerGroups`
  // array is NOT a "no compatible provider" signal, it's just "fetch
  // hasn't returned yet". Without this, mounting a chat session would
  // briefly disable the composer (and let auto-trigger / retry paths
  // swallow sends) before the runtime-filtered feed even arrives.
  const [fetchState, setFetchState] = useState<'idle' | 'loaded' | 'failed'>('idle');
  // Tracks the in-flight provider/options fetch so a later refetch
  // (provider-changed event, runtime switch) can abort the previous
  // pair before starting its own. Without this, a slow earlier
  // response could land after a newer one and silently re-open the
  // runtime gate against stale groups.
  const fetchControllerRef = useRef<AbortController | null>(null);

  const fetchAll = useCallback(() => {
    // Abort any in-flight pair from a previous fetchAll() so its late
    // response can't land after we've moved on. Each call gets its own
    // controller; only the most recent call's resolved/failed branches
    // are allowed to mutate state.
    fetchControllerRef.current?.abort();
    const controller = new AbortController();
    fetchControllerRef.current = controller;
    const signal = controller.signal;

    // Phase 6 UI收口 P2 (2026-05-14): always fetch the FULL catalog —
    // server side annotates each model row with `supportedRuntimes`
    // and `unsupportedReasonByRuntime`, and the picker uses those
    // per-row fields to render disabled+tooltip for incompatible
    // models instead of hiding them. Resolution / send logic in this
    // hook still derives a runtime-compatible subset client-side
    // (see `compatibleProviderGroups` below), so existing
    // `noCompatibleProvider` / `providerWasFilteredOut` / auto-fallback
    // semantics are preserved.
    const url = '/api/providers/models';
    setFetchState('idle');
    fetch(url, { signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (signal.aborted) return; // superseded by newer fetchAll
        if (data && Array.isArray(data.groups)) {
          setProviderGroups(data.groups);
          setDefaultProviderId(data.default_provider_id || '');
          // Without server-side filtering, `runtime_applied` is no
          // longer authoritative — derive from the caller's runtime
          // param so the picker can still surface which runtime context
          // its disabled-state checks are evaluated against. `'auto'`
          // means "no session pin"; the picker treats it as "no per-row
          // gating" until the global resolver lands a concrete value.
          const fromParam = runtime && runtime !== 'auto' && isRuntimeId(runtime)
            ? runtime
            : (isRuntimeId(data.runtime_applied) ? data.runtime_applied : undefined);
          setRuntimeApplied(fromParam);
          setFetchState('loaded');
        } else {
          // Malformed response — same handling as a network failure.
          throw new Error('Malformed /api/providers/models response');
        }
      })
      .catch((err) => {
        // Aborted by a newer fetchAll — leave state alone, the newer
        // call owns the next setProviderGroups / setFetchState write.
        if (err?.name === 'AbortError' || signal.aborted) return;
        setProviderGroups([{
          provider_id: 'env',
          provider_name: 'Anthropic',
          provider_type: 'anthropic',
          preset_key: '',
          protocol: 'anthropic',
          models: DEFAULT_MODEL_OPTIONS,
        }]);
        setDefaultProviderId('');
        setFetchState('failed');
      });

    // Fetch global default model — same abort discipline so its late
    // response doesn't bleed into a subsequent fetchAll's window.
    fetch('/api/providers/options?providerId=__global__', { signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (signal.aborted) return;
        setGlobalDefaultModel(data?.options?.default_model || undefined);
        setGlobalDefaultProvider(data?.options?.default_model_provider || undefined);
      })
      .catch(() => { /* aborted or network — silent best-effort */ });
  }, [runtime]);

  // Load on mount and listen for provider changes.
  // fetchAll's first line is `setFetchState('idle')` to gate refetches —
  // a lint rule flags the synchronous setState as a potential cascading
  // render, but the set is intentional: mount/refetch must reset the
  // load gate before the new request resolves. The follow-up setState
  // calls happen inside async then/catch (off the render path), so
  // there's no actual cascade.
  /* eslint-disable */
  useEffect(() => {
    fetchAll();
    const handler = () => fetchAll();
    window.addEventListener('provider-changed', handler);
    return () => {
      window.removeEventListener('provider-changed', handler);
      // Abort any in-flight request when the consumer unmounts so it
      // can't try to setState on a torn-down component.
      fetchControllerRef.current?.abort();
      fetchControllerRef.current = null;
    };
  }, [fetchAll]);
  /* eslint-enable */

  // Phase 6 UI收口 P2 (2026-05-14) — runtime-compatible projection of
  // the full catalog. The hook fetches everything unfiltered (so the
  // picker can render disabled rows for incompatible models with a
  // tooltip explaining why); resolution logic below still wants a
  // "what can this session actually send?" view, which is what this
  // memo provides.
  //
  // Annotation contract: each model row carries `supportedRuntimes:
  // RuntimeId[]`. Rows without an annotation are treated as universally
  // supported (legacy fallback — Settings models page and the env
  // synthetic group don't carry per-row annotations and we don't want
  // to silently hide them).
  //
  // When `runtime` is null or 'auto', the picker has no session-level
  // pin to filter against; we pass the full catalog through.
  const compatibleProviderGroups = useMemo(() => {
    if (!runtime || runtime === 'auto') return providerGroups;
    return providerGroups
      .map(g => ({
        ...g,
        models: g.models.filter(
          m => !m.supportedRuntimes || m.supportedRuntimes.includes(runtime),
        ),
      }))
      .filter(g => g.models.length > 0);
  }, [providerGroups, runtime]);

  // Two layers of provider id resolution:
  //
  // requestedProviderId — the *semantic* id the caller actually wants
  //   us to route to. Preserves "user picked env" intent even when env
  //   isn't in the current runtime feed. Used by `providerWasFilteredOut`
  //   so a session whose desired provider got replaced by a fallback
  //   gets PATCHed back to a consistent state.
  //
  // preferredProviderId — what we look up in `compatibleProviderGroups`
  //   for the group / model-options derivation. May resolve to
  //   `groups[0]` when the requested id can't be served by the current
  //   runtime (env filtered out under CodePilot Runtime, etc.).
  //
  // Both layers keep `undefined` and `''` distinct: undefined means
  // "caller didn't supply — use the global default chain"; '' is the
  // historic env-mode session value that must NOT be hijacked by
  // globalDefaultProvider.
  let requestedProviderId: string | undefined;
  let preferredProviderId: string;
  if (providerId === undefined) {
    requestedProviderId = undefined;
    preferredProviderId =
      globalDefaultProvider || defaultProviderId || (compatibleProviderGroups[0]?.provider_id ?? '');
  } else if (providerId === '') {
    // Historic env-mode session: provider_id stored as '' in DB.
    // Semantically the user wants 'env'; surface that as the request
    // even when the env group is filtered out, so the comparison
    // against `resolvedProviderId` correctly flags substitution.
    requestedProviderId = 'env';
    preferredProviderId = compatibleProviderGroups.some(g => g.provider_id === 'env')
      ? 'env'
      : (compatibleProviderGroups[0]?.provider_id ?? '');
  } else {
    requestedProviderId = providerId;
    preferredProviderId = providerId;
  }
  // Resolve provider id and group atomically against the runtime-
  // compatible projection. The preferred id may be missing under the
  // active runtime (e.g. user pinned GLM globally but the session
  // routes through Codex Runtime); when that happens we MUST report a
  // provider id that actually exists in compatibleProviderGroups — if
  // we returned the now-missing preferred id alongside `modelOptions`
  // from the fallback group, MessageInput's auto-correct would write
  // back `(stale provider, fallback model)` and re-introduce the
  // cross-wire we just spent the day fixing.
  const matchedGroup = compatibleProviderGroups.find(g => g.provider_id === preferredProviderId);
  const currentGroup = matchedGroup ?? compatibleProviderGroups[0];
  // currentProviderIdValue tracks currentGroup. If the preferred id was
  // filtered out, this surfaces a runtime-compatible fallback id so the
  // picker has *something* live to render. **The hook does NOT persist
  // this back to the session** — Phase 2 Step 3b removed the silent
  // PATCH effect in ChatView that used to do that. Persistence now
  // requires an explicit user action through `onProviderModelChange`
  // (model picker), which is why the caller pairs this value with the
  // `providerWasFilteredOut` signal below to surface an inline notice
  // and gate send.
  const currentProviderIdValue = currentGroup?.provider_id ?? preferredProviderId;
  // DEFAULT_MODEL_OPTIONS (the canonical env aliases, derived from
  // ENV_CLAUDE_CODE_MODELS) is reserved for the env provider only — when
  // the user is genuinely on the built-in Claude Code path, the picker
  // shows the canonical short aliases.
  //
  // We deliberately do NOT fall back to defaults on `providerGroups.length === 0`
  // anymore: with the API-failure path now synthesizing an `env` group in
  // the catch branch above, an *empty* providerGroups array reaching here
  // means the runtime filter legitimately matched nothing. Synthesising
  // Claude defaults would re-introduce the cross-wire (e.g. CodePilot
  // Runtime user with no compatible provider sees `sonnet` and sends a
  // chat request that the server then resolves against `env` defaults,
  // bypassing the runtime gate the API just enforced).
  const allowDefaultFallback = currentProviderIdValue === 'env';
  // NOTE: do NOT wrap this in useMemo — this is a React Compiler project and a
  // manual useMemo here triggers "Existing memoization could not be preserved"
  // (the compiler infers `currentGroup` as the dep, coarser than a hand-written
  // [currentGroup?.models, ...]). The compiler auto-memoizes; leave it plain.
  // The residual exhaustive-deps warning on the downstream useMemo is benign.
  const modelOptions = (currentGroup?.models && currentGroup.models.length > 0)
    ? currentGroup.models
    : (allowDefaultFallback ? DEFAULT_MODEL_OPTIONS : []);

  const currentModelValue = modelName || 'sonnet';
  const currentModelOption = useMemo(
    () => findModelOption(modelOptions, currentModelValue) || modelOptions[0],
    [modelOptions, currentModelValue],
  );

  // Resolved pair contract — single source of truth for "what should the
  // picker / send path actually use right now".
  //
  // resolvedModel: resolve the caller's modelName to a row by alias `value` OR
  //   canonical `upstreamModelId` (tech-debt #37 — a saved canonical id like
  //   `claude-opus-4-7` must round-trip to its `opus` row instead of silently
  //   dropping to the group's first model and SENDING that). Resolve to the
  //   matched row's `value` (the alias the backend re-canonicalizes on send);
  //   drop to the group's first model only when nothing matches. Empty when the
  //   group has zero models (caller gates via noCompatibleProvider before sending).
  const resolvedProviderId = currentProviderIdValue;
  const resolvedModel = findModelOption(modelOptions, modelName)?.value ?? (modelOptions[0]?.value ?? '');
  // providerWasFilteredOut: did the runtime-filtered feed force us to
  // route somewhere different from what the caller semantically
  // requested? Compare requestedProviderId (semantic intent) NOT
  // preferredProviderId (which already absorbs the env→groups[0]
  // fallback). The flag is purely informational — the hook does not
  // act on it. Phase 2 Step 3b: the consumer (ChatView) reads this to
  // render an inline notice and disable send until the user picks a
  // new provider via the picker; persistence to the session row is
  // gated behind that explicit user action, never silent. Skipped
  // during load / failure so consumers don't act on an unreliable view.
  const providerWasFilteredOut = fetchState === 'loaded'
    && requestedProviderId !== undefined
    && requestedProviderId !== resolvedProviderId;

  return {
    providerGroups,
    runtimeApplied,
    currentProviderIdValue,
    modelOptions,
    currentModelOption,
    globalDefaultModel,
    globalDefaultProvider,
    // Phase 6 UI收口 P2 (2026-05-14) — derived from the runtime-
    // compatible projection, not the raw full-catalog state. The
    // server now always returns the full catalog with annotations, so
    // `providerGroups.length === 0` would only ever fire on a totally
    // empty CodePilot install. The user-visible meaning we care about
    // is "no model is compatible with the active runtime", which is
    // what `compatibleProviderGroups.length === 0` measures.
    noCompatibleProvider: fetchState === 'loaded' && compatibleProviderGroups.length === 0,
    fetchState,
    resolvedProviderId,
    resolvedModel,
    providerWasFilteredOut,
  };
}
