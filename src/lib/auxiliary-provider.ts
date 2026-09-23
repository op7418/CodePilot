import { createHash } from 'node:crypto';
import { getActiveProvider, getDefaultProviderId, getSetting } from './db';
import { getNativeTransportAvailability } from './ai-provider';
import { assertProviderCallAllowed, getProviderUsagePolicy, ProviderCallPolicyError, type ProviderCallScene } from './provider-call-policy';
import { resolveExactProvider, toAiSdkConfig, type ResolvedProvider } from './provider-resolver';
import { generateTextFromProvider, type StreamTextParams } from './text-generator';
import { normalizeTelemetryFailure } from './telemetry/root-cause';
import { ModelSelectionError } from './model-selection-error';
import { fingerprintAuxiliaryConfiguration, readAuxiliaryConfigurationBlock, blockAuxiliaryConfiguration } from './auxiliary-provider-identity';

export type AuxiliaryCallScene = Extract<ProviderCallScene, 'automatic_memory_extract' | 'automatic_quick_actions' | 'active_turn_memory_rerank'>;
export type AuxiliaryFailureReason = 'claude_settings_only' | 'credentials_missing' | 'provider_missing'
  | 'identity_unavailable' | 'persistence_unavailable' | 'runtime_unsupported' | 'policy_blocked' | 'configuration_required' | 'request_failed' | 'empty_response' | 'cancelled' | 'in_flight';
export type AuxiliaryTextResult =
  | { status: 'completed'; text: string }
  | { status: 'unavailable' | 'cooldown' | 'failed'; reason: AuxiliaryFailureReason; retryAt?: number; requiresConfigurationChange?: true };
export type AuxiliaryExecutionStatus =
  | { status: 'completed' }
  | Exclude<AuxiliaryTextResult, { status: 'completed' }>;

export interface AuxiliaryTextRequest {
  callScene: AuxiliaryCallScene;
  /** Local-only workspace/session scope. Never sent to telemetry. */
  scopeKey: string;
  providerId?: string;
  resolvedProvider?: ResolvedProvider;
  resolvedConfig?: ReturnType<typeof toAiSdkConfig>;
  system: string;
  prompt: string;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

/** A stale explicit/default provider must not silently become another vendor. */
export function resolveAuxiliaryProvider(request: Pick<AuxiliaryTextRequest, 'providerId' | 'resolvedProvider'>): ResolvedProvider | null {
  if (request.resolvedProvider) return request.resolvedProvider;
  const id = request.providerId || getDefaultProviderId() || getActiveProvider()?.id || 'env';
  return resolveExactProvider(id);
}

function smallModel(resolved: ResolvedProvider): string {
  if (!resolved.provider && !resolved._openaiOAuth && !resolved._xaiOAuth && !resolved._codexAccount) return 'haiku';
  return resolved.roleModels.small || resolved.roleModels.haiku || resolved.upstreamModel || resolved.model || '';
}

function providerIdentity(resolved: ResolvedProvider): string {
  return resolved.provider?.id || (resolved._openaiOAuth ? 'openai-oauth' : resolved._xaiOAuth ? 'xai-oauth' : 'env');
}

function routeFingerprint(resolved: ResolvedProvider, config: ReturnType<typeof toAiSdkConfig>): string {
  // Only CodePilot-owned OAuth state participates. Never inspect external CLI
  // credentials or persist a token/digest that can be guessed without our key.
  const oauthRevision = resolved._openaiOAuth
    ? [getSetting('openai_oauth_access_token'), getSetting('openai_oauth_refresh_token'), getSetting('openai_oauth_expires_at')]
    : resolved._xaiOAuth ? getSetting('xai_oauth_bundle') : undefined;
  return fingerprintAuxiliaryConfiguration(JSON.stringify([
    providerIdentity(resolved),
    config, getProviderUsagePolicy(resolved.provider), oauthRevision,
  ]));
}

/** Capture a retry route once; only the keyed opaque fingerprint may be persisted. */
export function captureAuxiliaryRoute(providerId: string, snapshot?: ResolvedProvider) {
  const resolvedProvider = snapshot ?? resolveAuxiliaryProvider({ providerId });
  if (!resolvedProvider) return undefined;
  const resolvedConfig = toAiSdkConfig(resolvedProvider, smallModel(resolvedProvider));
  try {
    return { resolvedProvider, resolvedConfig, fingerprint: routeFingerprint(resolvedProvider, resolvedConfig) };
  } catch {
    return { resolvedProvider, resolvedConfig, unavailable: 'identity_unavailable' as const };
  }
}

type RouteSelection = Pick<AuxiliaryTextRequest, 'providerId' | 'resolvedProvider'>;
type Entry = { identity: string; providerId?: string; failures: number; pending: boolean; retryAt: number; status: AuxiliaryExecutionStatus };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const unavailable = (reason: AuxiliaryFailureReason): Exclude<AuxiliaryTextResult, { status: 'completed' }> => ({ status: 'unavailable', reason });
const credentialBlocked = (): Exclude<AuxiliaryTextResult, { status: 'completed' }> => ({
  status: 'unavailable', reason: 'credentials_missing', requiresConfigurationChange: true,
});

/** Bounded process-local cooldown; only proven credential failures persist. */
export function createAuxiliaryTextRunner(dependencies: {
  now?: () => number;
  resolve?: typeof resolveAuxiliaryProvider;
  generate?: (params: StreamTextParams) => Promise<string>;
  cooldownMs?: number;
  maxEntries?: number;
} = {}) {
  const now = dependencies.now ?? Date.now;
  const resolve = dependencies.resolve ?? resolveAuxiliaryProvider;
  const generate = dependencies.generate ?? generateTextFromProvider;
  const entries = new Map<string, Entry>();
  // Failed receipt writes must not allow credential retries on another scene or
  // after the ordinary scope cache evicts an entry. Contains no credentials.
  const unsavedCredentialBlocks = new Map<string, string>();
  const keyFor = (scopeKey: string, scene: AuxiliaryCallScene) => hash(`${scene}\0${scopeKey}`);
  const maxEntries = Math.max(1, Math.min(dependencies.maxEntries ?? 128, 512));
  const cooldownMs = Math.max(1, Math.min(dependencies.cooldownMs ?? 60_000, 300_000));
  function save(key: string, entry: Entry) {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
  }
  function inspect(request: RouteSelection & { callScene: AuxiliaryCallScene; resolvedConfig?: AuxiliaryTextRequest['resolvedConfig'] }) {
    let resolved: ResolvedProvider | null;
    try {
      resolved = resolve(request);
      if (!resolved || resolved.invalidReason) return { failure: unavailable('provider_missing') };
      assertProviderCallAllowed(resolved.provider, request.callScene);
    } catch (error) {
      if (error instanceof ProviderCallPolicyError) return { failure: unavailable('policy_blocked') };
      if (error instanceof ModelSelectionError) return { failure: unavailable('runtime_unsupported') };
      throw error;
    }
    const model = smallModel(resolved);
    if (!model) return { failure: unavailable('runtime_unsupported') };
    const config = request.resolvedConfig ?? toAiSdkConfig(resolved, model);
    const availability = getNativeTransportAvailability(resolved, config);
    if (!availability.available) return { failure: unavailable(availability.code === 'CLAUDE_SETTINGS_ONLY'
      ? 'claude_settings_only' : availability.code === 'PROVIDER_TRANSPORT_UNSUPPORTED' ? 'runtime_unsupported' : 'credentials_missing') };
    let identity: string;
    try { identity = routeFingerprint(resolved, config); }
    catch { return { failure: unavailable('identity_unavailable') }; }
    return { resolved, config, identity, provider: providerIdentity(resolved) };
  }
  return {
    getStatus(scopeKey: string, scene: AuxiliaryCallScene, selection?: RouteSelection): AuxiliaryExecutionStatus | undefined {
      const entry = entries.get(keyFor(scopeKey, scene));
      // Re-resolve from identity, never retain the old raw credential snapshot.
      const providerId = selection?.providerId ?? (selection?.resolvedProvider ? providerIdentity(selection.resolvedProvider) : entry?.providerId);
      const route = inspect({ providerId, callScene: scene });
      if (route.failure) return route.failure;
      try {
        if (readAuxiliaryConfigurationBlock(route.provider, route.identity)) return credentialBlocked();
      } catch { return unavailable('persistence_unavailable'); }
      if (unsavedCredentialBlocks.get(route.provider) === route.identity) return unavailable('persistence_unavailable');
      return entry?.identity === route.identity ? entry.status : undefined;
    },
    async run(request: AuxiliaryTextRequest): Promise<AuxiliaryTextResult> {
      const key = keyFor(request.scopeKey, request.callScene);
      const requestedProviderId = request.providerId ?? (request.resolvedProvider ? providerIdentity(request.resolvedProvider) : undefined);
      const storeFailure = (status: Exclude<AuxiliaryTextResult, { status: 'completed' }>, identity = '') => {
        save(key, { identity, providerId: requestedProviderId, failures: 0, pending: false, retryAt: 0, status });
        return status;
      };
      const route = inspect(request);
      if (route.failure) return storeFailure(route.failure);
      const { resolved, config, identity, provider } = route;
      const unsaved = unsavedCredentialBlocks.get(provider);
      if (unsaved && unsaved !== identity) unsavedCredentialBlocks.delete(provider);
      if (unsaved === identity) {
        try {
          blockAuxiliaryConfiguration(provider, identity, 'credentials_missing');
          unsavedCredentialBlocks.delete(provider);
          return storeFailure(credentialBlocked(), identity);
        } catch { return storeFailure(unavailable('persistence_unavailable'), identity); }
      }
      try {
        if (readAuxiliaryConfigurationBlock(provider, identity)) return storeFailure(credentialBlocked(), identity);
      } catch { return storeFailure(unavailable('persistence_unavailable'), identity); }
      // Fail closed if private persistence is unavailable for too many routes;
      // never evict a credential latch and silently authorize another request.
      if (unsavedCredentialBlocks.size >= maxEntries) return storeFailure(unavailable('persistence_unavailable'), identity);
      const previous = entries.get(key);
      const prior = previous?.identity === identity ? previous : undefined;
      if (prior?.pending) return { status: 'cooldown', reason: 'in_flight' };
      if (prior && prior.retryAt > now()) {
        const status = { status: 'cooldown' as const, reason: 'request_failed' as const, retryAt: prior.retryAt };
        prior.status = status;
        return status;
      }
      if (request.abortSignal?.aborted) return storeFailure({ status: 'failed', reason: 'cancelled' }, identity);
      const entry: Entry = { identity, providerId: requestedProviderId, failures: prior?.failures ?? 0, pending: true, retryAt: 0,
        status: { status: 'cooldown', reason: 'in_flight' } };
      save(key, entry);
      try {
        const text = await generate({
          callScene: request.callScene, providerId: resolved.provider?.id || request.providerId || 'env',
          resolvedProvider: resolved, resolvedConfig: config, model: config.modelId,
          system: request.system, prompt: request.prompt, maxTokens: request.maxTokens, abortSignal: request.abortSignal,
        });
        if (!text.trim()) {
          entry.failures++;
          entry.retryAt = now() + Math.min(cooldownMs * 2 ** Math.min(entry.failures - 1, 3), 300_000);
          entry.status = { status: 'failed', reason: 'empty_response', retryAt: entry.retryAt };
          return entry.status;
        }
        entry.failures = 0;
        entry.status = { status: 'completed' };
        return { status: 'completed', text };
      } catch (error) {
        const failure = normalizeTelemetryFailure('PROVIDER_FAILURE', error, { retryExhausted: true });
        const cancelled = request.abortSignal?.aborted || failure.outcome === 'user_cancelled';
        entry.failures++;
        if (!cancelled && failure.rootCause === 'credentials') {
          entry.retryAt = 0;
          // Install the memory latch before touching disk. A failed write must
          // return an honest storage state, and must never retry the provider.
          unsavedCredentialBlocks.set(provider, identity);
          try {
            blockAuxiliaryConfiguration(provider, identity, 'credentials_missing');
            unsavedCredentialBlocks.delete(provider);
            entry.status = credentialBlocked();
          } catch { entry.status = unavailable('persistence_unavailable'); }
        } else {
          // Sentry's user-action/4xx taxonomy is not a provider retry policy.
          // Rate limits and other HTTP rejections remain bounded, timed retries.
          entry.retryAt = cancelled ? 0 : now() + Math.min(cooldownMs * 2 ** Math.min(entry.failures - 1, 3), 300_000);
          entry.status = { status: 'failed', reason: cancelled ? 'cancelled' : 'request_failed',
            ...(entry.retryAt ? { retryAt: entry.retryAt } : {}) };
        }
        return entry.status;
      } finally { entry.pending = false; }
    },
  };
}

const globalState = globalThis as typeof globalThis & {
  __codepilotAuxiliaryTextRunnerV2?: ReturnType<typeof createAuxiliaryTextRunner>;
};
const runner = globalState.__codepilotAuxiliaryTextRunnerV2 ??= createAuxiliaryTextRunner();
export const runAuxiliaryText = runner.run;
export const getAuxiliaryExecutionStatus = runner.getStatus;
