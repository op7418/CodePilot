/**
 * Codex model fetch helpers — Phase 5 Phase 2 (2026-05-13).
 *
 * Wraps `model/list` and maps the upstream `Model` shape into both
 * the narrow internal `CodexModel` and CodePilot's existing
 * `ProviderModelGroup` so the chat picker can render Codex models
 * alongside other providers.
 *
 * Caching: short in-process TTL (30s) + manual refresh button on
 * the Codex Settings card. Account update / logout invalidates the
 * cache via `invalidateCodexModelsCache()`.
 */

import type { ProviderModelGroup } from '@/types';
import type { CodexModel } from './types';
import { getCodexAppServer } from './app-server-manager';
import { toGenericEffortLevels } from './effort';

type ProviderModelOption = ProviderModelGroup['models'][number];

const CACHE_TTL_MS = 30_000;
const DEFAULT_FETCH_TIMEOUT_MS = 2500;

interface CacheEntry {
  fetchedAt: number;
  models: readonly CodexModel[];
}

let cache: CacheEntry | null = null;

/**
 * P0.3 (2026-06-01) — Codex model discovery must never block the global
 * model feed. A broken/old Codex app-server (e.g. an old binary that
 * fatally rejects the user's effort config) was hanging
 * `/api/providers/models` for ~30s, which in turn froze Settings overview,
 * the chat composer ("正在准备运行环境"), and the runtime health card.
 *
 * - `cacheOnly`: never spawn — return a warm cache (even if past TTL, a
 *   slightly-stale list beats blocking) or [] when there's nothing cached.
 *   Used by the no-runtime full-catalog path.
 * - `timeoutMs`: hard ceiling on spawn+initialize+model/list. On timeout the
 *   call REJECTS so callers degrade to "no Codex group". Default 2500ms.
 * - `force`: bypass the TTL cache (explicit refresh).
 */
export interface CodexModelFetchOptions {
  force?: boolean;
  cacheOnly?: boolean;
  timeoutMs?: number;
}

/** Minimal shape of the cached app-server this module needs — a DI seam so
 *  tests can drive cacheOnly / timeout behavior without a real subprocess. */
type CodexAppServerLike = { client: { request: <T>(method: string, params?: unknown) => Promise<T> } };
type GetCodexAppServerFn = () => Promise<CodexAppServerLike>;

/** Race a promise against a timeout; clears the timer on settle (no leak). */
function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Codex model/list timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * One element of upstream `Model.supportedReasoningEfforts`.
 *
 * Schema drift (2026-07-17): codex-cli 0.144.2 emits
 * `{ reasoningEffort, description }`; older binaries emit `{ effort }`.
 * We read BOTH — reading only `effort` against a 0.144.x app-server yields
 * `undefined` for every element, which used to collapse the capability list
 * into `[undefined, ...]` and render fake tiers downstream. See the local
 * read-only POC in docs/research/foundation-experience-refresh-2026-07-17.md.
 */
interface UpstreamReasoningEffort {
  /** New shape (codex-cli ≥ 0.144). */
  reasoningEffort?: unknown;
  /** Legacy shape (older binaries). */
  effort?: unknown;
  description?: unknown;
}

/**
 * Reasoning-effort tokens CodePilot understands from `model/list`.
 *
 * `ultra` is included because GPT-5.6 Sol really does declare it — we parse
 * it honestly here, and exclude it from the GENERIC effort selector one layer
 * up (see {@link CODEX_GENERIC_EXCLUDED_EFFORTS}). Anything outside this set
 * is dropped fail-closed: an unrecognized upstream token must never reach the
 * picker as a selectable tier we can't explain or honor.
 */
const KNOWN_CODEX_EFFORTS: readonly string[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

/**
 * Normalize one `supportedReasoningEfforts` element across both schemas.
 * Returns undefined for empty / non-string / unrecognized values.
 */
function normalizeEffortElement(raw: UpstreamReasoningEffort | undefined | null): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  // New shape wins when both are present (a transitional binary emitting both
  // should be read as its current field, not its deprecated one).
  const value = raw.reasoningEffort ?? raw.effort;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!KNOWN_CODEX_EFFORTS.includes(trimmed)) return undefined;
  return trimmed;
}

/** Parse + de-dupe a model's declared efforts. Missing field → []. */
function normalizeSupportedEfforts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const el of raw as UpstreamReasoningEffort[]) {
    const level = normalizeEffortElement(el);
    if (level && !out.includes(level)) out.push(level);
  }
  return out;
}

async function fetchModelsFromAppServer(getAppServer: GetCodexAppServerFn): Promise<CodexModel[]> {
  const { client } = await getAppServer();
  const result = await client.request<{
    data: Array<{
      id: string;
      model: string;
      displayName: string;
      description: string;
      hidden: boolean;
      isDefault: boolean;
      /** Dual-schema — see {@link UpstreamReasoningEffort}. */
      supportedReasoningEfforts?: UpstreamReasoningEffort[];
      defaultReasoningEffort?: string;
      inputModalities: string[];
      serviceTiers?: Array<{ id?: string; name?: string }>;
    }>;
    nextCursor: string | null;
  }>('model/list', { includeHidden: false });

  return (result?.data ?? [])
    .filter((m) => !m.hidden)
    .map((m) => {
      const supportedReasoningEfforts = normalizeSupportedEfforts(m.supportedReasoningEfforts);
      // Keep the upstream default only when it survives the same filter — a
      // default we can't map is worse than no default (it would seed the
      // picker with a tier absent from the list).
      const defaultReasoningEffort =
        typeof m.defaultReasoningEffort === 'string' &&
        supportedReasoningEfforts.includes(m.defaultReasoningEffort.trim())
          ? m.defaultReasoningEffort.trim()
          : '';
      return {
        id: m.id,
        model: m.model,
        displayName: m.displayName,
        description: m.description,
        hidden: m.hidden,
        isDefault: m.isDefault,
        supportedReasoningEfforts,
        defaultReasoningEffort,
        inputModalities: m.inputModalities,
        serviceTiers: m.serviceTiers?.map((t) => t.name ?? t.id ?? ''),
      };
    });
}

/**
 * Fetch model/list and narrow to `CodexModel[]`. Honors the cache and the
 * P0.3 spawn-decoupling options (see {@link CodexModelFetchOptions}).
 *
 * @param getAppServer DI seam (defaults to the real shared app-server) so
 *   tests can exercise cacheOnly / timeout without spawning a subprocess.
 */
export async function listCodexModels(
  opts: CodexModelFetchOptions = {},
  getAppServer: GetCodexAppServerFn = getCodexAppServer,
): Promise<readonly CodexModel[]> {
  const { force = false, cacheOnly = false, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = opts;
  // cacheOnly: never spawn — serve a warm cache (ignoring TTL) or nothing.
  if (cacheOnly) return cache?.models ?? [];
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }
  const models = await withTimeout(timeoutMs, fetchModelsFromAppServer(getAppServer));
  cache = { fetchedAt: Date.now(), models };
  return models;
}

/** Drop the in-memory model cache. Call on account change / logout. */
export function invalidateCodexModelsCache(): void {
  cache = null;
}

/**
 * The effort tiers a specific Codex model DECLARES, read from the warm
 * model/list cache. Powers the per-model allowlist on the `turn/start` path
 * (`resolveCodexEffort`) so a model that really supports `xhigh` / `max` is no
 * longer silently clamped to `high`.
 *
 * `cacheOnly` on purpose: turn/start is latency-critical and must never spawn
 * an app-server or block on a probe (P0.3). A cold cache returns undefined,
 * which the caller reads as "no capability info" → conservative clamp.
 */
export async function getCachedCodexEffortLevels(
  modelId: string | undefined,
): Promise<readonly string[] | undefined> {
  if (!modelId) return undefined;
  const models = await listCodexModels({ cacheOnly: true });
  // model/list keys by `id`; turn/start may carry either id or wire `model`.
  const match = models.find((m) => m.id === modelId || m.model === modelId);
  if (!match || match.supportedReasoningEfforts.length === 0) return undefined;
  return match.supportedReasoningEfforts;
}

/**
 * Build the CodePilot ProviderModelGroup that surfaces Codex Account
 * models inside `/api/providers/models`. Returns null when no models
 * are available (account not logged in or list call failed).
 *
 * The group claims `compat: 'codex_account'` so `getModelCompat`
 * marks each model with `supportedRuntimes: ['codex_runtime']`.
 */
export async function buildCodexProviderModelGroup(
  opts: CodexModelFetchOptions = {},
  getAppServer?: GetCodexAppServerFn,
): Promise<ProviderModelGroup | null> {
  let models: readonly CodexModel[];
  try {
    models = getAppServer ? await listCodexModels(opts, getAppServer) : await listCodexModels(opts);
  } catch {
    // Spawn / timeout / login / RPC error — surface as no group rather than
    // throw. The route degrades to "no Codex group" (P0.3); the Settings
    // status card reads /api/codex/status separately to explain WHY.
    return null;
  }

  if (models.length === 0) return null;

  const modelOptions: ProviderModelOption[] = models.map((m) => {
    // `ultra` is a Codex-only product tier, not a Responses API reasoning
    // effort — it does NOT enter the generic effort selector this round (see
    // toGenericEffortLevels). Modeling it properly is a separate decision;
    // offering it in the shared menu would promise semantics we don't wire.
    const genericLevels = toGenericEffortLevels(m.supportedReasoningEfforts);
    return {
      value: m.id,
      label: m.displayName,
      upstreamModelId: m.model,
      source: 'api',
      capabilities: {
        reasoning: genericLevels.length > 1,
        supportsEffort: genericLevels.length > 1,
        // Omit entirely (rather than send []) when the app-server declared
        // nothing we recognize — an absent field makes the selector hide
        // rather than render a tier list we can't source. Fail-closed.
        ...(genericLevels.length > 0 ? { supportedEffortLevels: genericLevels } : {}),
        // We don't have an authoritative tool-use signal from
        // `model/list` — Codex routes tool-calling through its own
        // app-server thread rather than per-model capability. Default
        // true so the picker doesn't surface a misleading "no tools"
        // badge; the actual tool inventory is per-thread.
        toolUse: true,
      },
    };
  });

  return {
    provider_id: 'codex_account',
    provider_name: 'Codex Account',
    provider_type: 'codex',
    preset_key: 'codex-account',
    protocol: 'openai-compatible',
    compat: 'codex_account',
    models: modelOptions,
  };
}
