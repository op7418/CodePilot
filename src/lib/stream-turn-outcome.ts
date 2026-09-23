/** Shared sticky terminal semantics for Desktop and Bridge committed turns. */
import type { SSEEvent } from '@/types';
export const NON_SUCCESSFUL_TERMINAL_FINISH_REASONS = new Set(['interrupted', 'inProgress']);
export function isNonSuccessfulTerminalResult(result: { is_error?: unknown; finish_reason?: unknown }): boolean {
  return !!result.is_error || (typeof result.finish_reason === 'string' && NON_SUCCESSFUL_TERMINAL_FINISH_REASONS.has(result.finish_reason));
}
export function createStreamTurnOutcome() {
  let sawSuccess = false;
  let failed = false;
  return {
    observe(event: Pick<SSEEvent, 'type' | 'data'>) {
      if (event.type === 'error') failed = true;
      if (event.type !== 'result') return;
      try {
        const result = JSON.parse(event.data);
        if (!result || typeof result !== 'object' || Array.isArray(result)) return;
        if (isNonSuccessfulTerminalResult(result)) failed = true;
        else sawSuccess = true;
      } catch { /* malformed data proves no successful terminal */ }
    },
    get successful() { return sawSuccess && !failed; },
  };
}
