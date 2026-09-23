/** ChatGPT OAuth catalog. Account discovery is separate from Codex app-server. */
import type { CatalogModel, ProviderEffortLevel } from './provider-catalog';
import { ensureTokenFresh, getOAuthStatus, getOpenAIOAuthGeneration } from './openai-oauth-manager';
import { extractComputeResidency } from './openai-oauth';
import { ModelSelectionError } from './model-selection-error';

const EFFORTS: ProviderEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
// Compatibility baseline verified against openai/codex 459a79eb (2026-09-05).
// These are catalog candidates, never proof of an individual account's entitlement.
export const OPENAI_OAUTH_CATALOG_MODELS: CatalogModel[] = [
  ...['gpt-5.5', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'].map(modelId => ({
    modelId, displayName: modelId.replace('gpt-', 'GPT-'),
    capabilities: {
      reasoning: true, toolUse: true, vision: modelId !== 'gpt-5.3-codex-spark',
      supportsEffort: true,
      supportedEffortLevels: modelId === 'gpt-6-astra' || modelId.startsWith('gpt-5.6-') ? EFFORTS : EFFORTS.slice(0, 4),
      defaultEffortLevel: 'medium' as const,
      // Codex backend default usable input; API context must not be used here.
      ...(!modelId.startsWith('gpt-5.3-') ? { contextWindow: 258_400 } : {}),
    },
  })),
];

export function parseOpenAIOAuthModels(payload: unknown): CatalogModel[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { models?: unknown }).models)) {
    throw new Error('Invalid OpenAI model catalog');
  }
  const seen = new Set<string>();
  return (payload as { models: Record<string, unknown>[] }).models.flatMap(m => {
    // An unknown schema is a failed discovery, not an authoritative empty
    // account. Never turn missing visibility into permission to list a model.
    if (!m || (m.visibility !== 'list' && m.visibility !== 'hide')) {
      throw new Error('Invalid OpenAI model catalog visibility');
    }
    if (!m || typeof m.slug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(m.slug)
      || m.visibility !== 'list' || seen.has(m.slug)) return [];
    seen.add(m.slug);
    const rawEfforts = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
    const levels = EFFORTS.filter(e => rawEfforts.some(v => v && typeof v === 'object' && v.effort === e));
    const window = typeof m.context_window === 'number' && m.context_window > 0 ? m.context_window : undefined;
    const percent = typeof m.effective_context_window_percent === 'number' ? m.effective_context_window_percent : 95;
    const modalities = Array.isArray(m.input_modalities) ? m.input_modalities : undefined;
    return [{ modelId: m.slug, displayName: typeof m.display_name === 'string' ? m.display_name : m.slug,
      capabilities: {
        reasoning: levels.length > 0, supportsEffort: levels.length > 0,
        supportedEffortLevels: levels,
        ...(levels.includes(m.default_reasoning_level as ProviderEffortLevel) ? { defaultEffortLevel: m.default_reasoning_level as ProviderEffortLevel } : {}),
        ...(modalities ? { vision: modalities.includes('image') } : {}),
        ...(window && percent > 0 && percent <= 100 ? { contextWindow: Math.floor(window * percent / 100) } : {}),
      },
    }];
  });
}

type CatalogCache = { generation: number; models: CatalogModel[]; at: number };
let cache: CatalogCache | undefined;
let pending: { generation: number; promise: Promise<void> } | undefined;
let retryAfter = { generation: -1, at: 0 };

export function isOpenAIOAuthDiscoveryPending(): boolean {
  return pending?.generation === getOpenAIOAuthGeneration();
}

export function getOpenAIOAuthModels(): CatalogModel[] {
  return cache?.generation === getOpenAIOAuthGeneration() ? cache.models : OPENAI_OAUTH_CATALOG_MODELS;
}

/** Bounded, cached discovery using THIS OAuth login, never the app-server login. */
export async function refreshOpenAIOAuthModels(): Promise<void> {
  if (!getOAuthStatus().authenticated) return;
  const generation = getOpenAIOAuthGeneration();
  if (cache?.generation === generation && Date.now() - cache.at < 300_000) return;
  if (pending?.generation === generation) return pending.promise;
  if (retryAfter.generation === generation && Date.now() < retryAfter.at) return;
  const promise = (async () => {
    try {
      const creds = await ensureTokenFresh();
      if (!creds || generation !== getOpenAIOAuthGeneration()) return;
      const headers = new Headers({ Authorization: `Bearer ${creds.accessToken}` });
      if (creds.accountId) headers.set('ChatGPT-Account-Id', creds.accountId);
      const residency = extractComputeResidency(creds.accessToken);
      if (residency) headers.set('x-openai-internal-codex-residency', residency);
      // Protocol compatibility version, not a claim about the installed CLI.
      const response = await fetch('https://chatgpt.com/backend-api/codex/models?client_version=0.153.1', {
        headers, signal: AbortSignal.timeout(2500), redirect: 'error',
      });
      if (!response.ok) throw new Error(`Model discovery failed (${response.status})`);
      const models = parseOpenAIOAuthModels(await response.json());
      if (generation === getOpenAIOAuthGeneration()) cache = { generation, models, at: Date.now() };
    } catch {
      // Keep the last same-account catalog or the bundled compatibility list.
      if (generation === getOpenAIOAuthGeneration()) retryAfter = { generation, at: Date.now() + 30_000 };
    } finally {
      if (pending?.generation === generation) pending = undefined;
    }
  })();
  pending = { generation, promise };
  return promise;
}

export function buildOpenAIOAuthOptions(model: string, effort?: string) {
  const caps = getOpenAIOAuthModels().find(m => m.modelId === model)?.capabilities;
  if (effort && !caps?.supportedEffortLevels?.includes(effort as ProviderEffortLevel)) {
    throw new ModelSelectionError('OPENAI_OAUTH_EFFORT_UNAVAILABLE');
  }
  return {
    store: false,
    ...(caps?.reasoning ? { forceReasoning: true } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}
