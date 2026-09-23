import type { RuntimeId } from './runtime-id';

export type RuntimeCompactionMode = 'proactive' | 'reactive_only' | 'unsupported';

export interface RuntimeCompactionPolicy {
  runtimeId: RuntimeId;
  mode: RuntimeCompactionMode;
  source: 'codepilot_context_summary' | 'runtime_managed';
  recreatedUnderlyingSession: boolean;
}

export function getRuntimeCompactionPolicy(runtimeId: RuntimeId): RuntimeCompactionPolicy {
  switch (runtimeId) {
    case 'claude_code':
      return {
        runtimeId,
        mode: 'proactive',
        source: 'codepilot_context_summary',
        recreatedUnderlyingSession: true,
      };
    case 'codepilot_runtime':
      return {
        runtimeId,
        mode: 'proactive',
        source: 'codepilot_context_summary',
        recreatedUnderlyingSession: false,
      };
    case 'codex_runtime':
      return {
        runtimeId,
        mode: 'reactive_only',
        source: 'runtime_managed',
        recreatedUnderlyingSession: false,
      };
    default: {
      const exhaustive: never = runtimeId;
      return exhaustive;
    }
  }
}
