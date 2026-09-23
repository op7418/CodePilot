import type { RuntimeId } from './runtime-id';

export type RouteChangeMode = 'in_session' | 'replay_context' | 'new_session' | 'unsupported';

export interface RuntimeContinuationPolicy {
  continuationKey: string;
  modelChange: RouteChangeMode;
  providerInstanceChange: RouteChangeMode;
  contextImport: 'canonical_handoff' | 'db_replay' | 'unsupported';
  source: 'adapter';
}

export interface RuntimeRouteIdentity {
  runtimeId: RuntimeId;
  providerId: string;
  modelId: string;
}

export const RUNTIME_CONTINUATION_POLICIES: Readonly<Record<RuntimeId, RuntimeContinuationPolicy>> = {
  claude_code: {
    continuationKey: 'claude_code:db_replay',
    modelChange: 'replay_context',
    providerInstanceChange: 'replay_context',
    contextImport: 'db_replay',
    source: 'adapter',
  },
  codepilot_runtime: {
    continuationKey: 'codepilot_runtime:db_replay',
    modelChange: 'replay_context',
    providerInstanceChange: 'replay_context',
    contextImport: 'db_replay',
    source: 'adapter',
  },
  codex_runtime: {
    continuationKey: 'codex_runtime:thread_provider',
    modelChange: 'in_session',
    // The product chat stays put. The adapter rebuilds its provider-bound
    // native thread with the chat summary/history on the next send.
    providerInstanceChange: 'replay_context',
    contextImport: 'canonical_handoff',
    source: 'adapter',
  },
};

export function getRuntimeContinuationPolicy(runtimeId: RuntimeId): RuntimeContinuationPolicy {
  return RUNTIME_CONTINUATION_POLICIES[runtimeId];
}

export function routeChangeMode(
  current: RuntimeRouteIdentity,
  target: RuntimeRouteIdentity,
): RouteChangeMode {
  if (current.runtimeId !== target.runtimeId) return 'new_session';
  if (current.providerId !== target.providerId) {
    return getRuntimeContinuationPolicy(current.runtimeId).providerInstanceChange;
  }
  if (current.modelId !== target.modelId) {
    return getRuntimeContinuationPolicy(current.runtimeId).modelChange;
  }
  return 'in_session';
}

export function runtimeRefToClearForRouteChange(
  runtimeId: RuntimeId,
  mode: RouteChangeMode,
): RuntimeId | undefined {
  if (mode !== 'replay_context') return undefined;
  return runtimeId === 'claude_code' ? 'claude_code' : undefined;
}
