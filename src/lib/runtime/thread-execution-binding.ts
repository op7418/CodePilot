import type {
  ChatSession,
  RuntimeBindingSource,
  RuntimeBindingState,
} from '@/types';
import { isRuntimeId, type RuntimeId } from './runtime-id';

export interface ThreadExecutionBinding {
  sessionId: string;
  state: RuntimeBindingState;
  runtimeId?: RuntimeId;
  boundAt?: string;
  routeRevision: number;
  source?: RuntimeBindingSource;
}

export interface LegacyRuntimeBindingFacts {
  runtimePin?: string | null;
  sdkSessionId?: string | null;
  codexThreadId?: string | null;
  hasRealExecutionMessage: boolean;
}

export interface LegacyRuntimeBindingDecision {
  state: RuntimeBindingState;
  runtimeId?: RuntimeId;
  source?: RuntimeBindingSource;
}

const RUNTIME_SWITCH_MARKER_RE = /^\[__RUNTIME_SWITCH__(?:\s+from=(?:claude_code|codepilot_runtime|codex_runtime))?\s+to=(?:claude_code|codepilot_runtime|codex_runtime)\]$/;

/**
 * Historical runtime switch markers are app-owned bookkeeping, not a user
 * execution. They must not make migration conclude that a chat has real
 * transcript history, and they must never be replayed as a user prompt.
 */
export function isInternalRuntimeSwitchMarker(content: unknown): boolean {
  return typeof content === 'string' && RUNTIME_SWITCH_MARKER_RE.test(content.trim());
}

/** Pure, conservative legacy classifier used by migration fixtures and DB. */
export function classifyLegacyRuntimeBinding(
  facts: LegacyRuntimeBindingFacts,
): LegacyRuntimeBindingDecision {
  const runtimePin = isRuntimeId(facts.runtimePin) ? facts.runtimePin : undefined;
  const hasSdkRef = typeof facts.sdkSessionId === 'string' && facts.sdkSessionId.length > 0;
  const hasCodexRef = typeof facts.codexThreadId === 'string' && facts.codexThreadId.length > 0;
  const hasExecutionEvidence = facts.hasRealExecutionMessage || hasSdkRef || hasCodexRef;

  if (!hasExecutionEvidence) return { state: 'unbound' };
  if (runtimePin) {
    return { state: 'bound', runtimeId: runtimePin, source: 'legacy_pin' };
  }
  if (hasSdkRef && !hasCodexRef) {
    return { state: 'bound', runtimeId: 'claude_code', source: 'legacy_runtime_ref' };
  }
  if (hasCodexRef && !hasSdkRef) {
    return { state: 'bound', runtimeId: 'codex_runtime', source: 'legacy_runtime_ref' };
  }
  return { state: 'legacy_unbound' };
}

export function getThreadExecutionBinding(
  session: Pick<
    ChatSession,
    'id' | 'runtime_pin' | 'runtime_binding_state' | 'runtime_bound_at'
      | 'runtime_binding_source' | 'route_revision'
  >,
): ThreadExecutionBinding {
  const state: RuntimeBindingState = session.runtime_binding_state === 'bound'
    || session.runtime_binding_state === 'legacy_unbound'
    ? session.runtime_binding_state
    : 'unbound';
  const runtimeId = isRuntimeId(session.runtime_pin) ? session.runtime_pin : undefined;
  return {
    sessionId: session.id,
    state,
    ...(runtimeId ? { runtimeId } : {}),
    ...(session.runtime_bound_at ? { boundAt: session.runtime_bound_at } : {}),
    routeRevision: Number.isSafeInteger(session.route_revision) && (session.route_revision ?? -1) >= 0
      ? session.route_revision!
      : 0,
    ...(session.runtime_binding_source ? { source: session.runtime_binding_source } : {}),
  };
}

export type ExecutionTrigger = 'manual' | 'auto' | 'retry' | 'queue' | 'bridge';

export type BindingExecutionDecision =
  | { ok: true; shouldBind: false; runtimeId: RuntimeId }
  | { ok: true; shouldBind: true; runtimeId: RuntimeId }
  | { ok: false; code: 'RUNTIME_RECOVERY_REQUIRED' | 'RUNTIME_OWNER_REQUIRED' };

/**
 * Binding-only decision. Route/catalog validation remains a separate server
 * step, so this function can stay pure and table-driven.
 */
export function decideExecutionBinding(
  binding: ThreadExecutionBinding,
  trigger: ExecutionTrigger,
  requestedRuntimeId?: RuntimeId,
): BindingExecutionDecision {
  if (binding.state === 'legacy_unbound') {
    return { ok: false, code: 'RUNTIME_RECOVERY_REQUIRED' };
  }
  if (binding.state === 'bound') {
    if (!binding.runtimeId) return { ok: false, code: 'RUNTIME_RECOVERY_REQUIRED' };
    return { ok: true, shouldBind: false, runtimeId: binding.runtimeId };
  }
  if (trigger === 'auto' || trigger === 'retry' || trigger === 'queue') {
    return { ok: false, code: 'RUNTIME_OWNER_REQUIRED' };
  }
  if (!requestedRuntimeId) return { ok: false, code: 'RUNTIME_OWNER_REQUIRED' };
  return { ok: true, shouldBind: true, runtimeId: requestedRuntimeId };
}
