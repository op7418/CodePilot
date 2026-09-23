import type { AuxiliaryExecutionStatus } from './auxiliary-provider';

const SUCCESS_TTL_MS = 10 * 60 * 1000;
export interface QuickActionGeneration {
  suggestions: string[];
  enhancement: AuxiliaryExecutionStatus;
}
interface Entry {
  workspace: string;
  identity: string;
  result: QuickActionGeneration;
  expiresAt: number;
  pending?: Promise<QuickActionGeneration>;
}

/** One bounded slot, keyed by current provider configuration. Never cache unknown identity. */
export function createQuickActionSuggestionsCache(now: () => number = Date.now) {
  let current: Entry | undefined;
  return {
    async get(workspace: string, identity: string | undefined, generate: () => Promise<QuickActionGeneration>, retry = false): Promise<QuickActionGeneration> {
      if (identity && current?.workspace === workspace && current.identity === identity) {
        if (current.pending) return current.pending;
        // An explicit retry refreshes successful suggestions but never bypasses
        // the actual failure cooldown. Changed configuration uses a new slot.
        if (now() < current.expiresAt && (!retry || current.result.enhancement.status !== 'completed')) return current.result;
      }
      const entry: Entry = { workspace, identity: identity || '',
        result: { suggestions: [], enhancement: { status: 'unavailable', reason: 'in_flight' } }, expiresAt: 0 };
      current = identity ? entry : undefined;
      entry.pending = Promise.resolve().then(generate).then(result => {
        entry.result = result;
        entry.expiresAt = result.enhancement.status === 'completed' && result.suggestions.length
          ? now() + SUCCESS_TTL_MS
          : result.enhancement.status !== 'completed' ? result.enhancement.retryAt ?? now() : now();
        return result;
      }, () => {
        const result: QuickActionGeneration = { suggestions: [], enhancement: { status: 'failed', reason: 'request_failed' } };
        entry.result = result;
        entry.expiresAt = now();
        return result;
      }).finally(() => { entry.pending = undefined; });
      return entry.pending;
    },
  };
}

const state = globalThis as typeof globalThis & {
  __codepilotQuickActionSuggestionsV3?: ReturnType<typeof createQuickActionSuggestionsCache>;
};
export const quickActionSuggestions = state.__codepilotQuickActionSuggestionsV3
  ??= createQuickActionSuggestionsCache();
