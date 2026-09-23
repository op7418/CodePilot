import type { NormalizedTelemetryFailure } from './root-cause';
import { telemetryCallScene } from './diagnostics';

interface BudgetInput {
  failure: NormalizedTelemetryFailure;
  callScene?: string;
  providerProtocol?: string;
  providerClass?: string;
  runtimeId?: string;
}

const MAX_SUPPRESSED = 1_000_000;
const token = (value?: string) => value && /^[a-z0-9_.-]{1,64}$/i.test(value) ? value.toLowerCase() : 'unknown';

/**
 * Only known transient failures are budgeted. Unknown/protocol/product faults
 * retain every event until they can be classified, rather than hiding defects.
 * This budget is per running process, not a claim about organization quotas.
 */
export function createTelemetryReportBudget(options: {
  now?: () => number; windowMs?: number; limit?: number; maxEntries?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const windowMs = Math.max(1, options.windowMs ?? 15 * 60_000);
  const limit = Math.max(1, options.limit ?? 3);
  const maxEntries = Math.max(1, options.maxEntries ?? 256);
  const entries = new Map<string, { start: number; sent: number; suppressed: number }>();
  return {
    reset() { entries.clear(); },
    take(input: BudgetInput): { allowed: boolean; suppressed: number } {
      if (input.failure.outcome !== 'transient_upstream') return { allowed: true, suppressed: 0 };
      const key = [input.failure.rootCause, telemetryCallScene(input.callScene),
        token(input.providerProtocol), token(input.providerClass), token(input.runtimeId)].join(':');
      const timestamp = now();
      let entry = entries.get(key);
      let suppressed = 0;
      if (!entry || timestamp - entry.start >= windowMs || timestamp < entry.start) {
        suppressed = entry?.suppressed ?? 0;
        if (!entry && entries.size >= maxEntries) {
          // Drop expired bookkeeping first; never suppress an unseen signature.
          for (const [candidate, value] of entries) {
            if (timestamp - value.start >= windowMs) entries.delete(candidate);
          }
          if (entries.size >= maxEntries) return { allowed: true, suppressed: 0 };
        }
        entry = { start: timestamp, sent: 0, suppressed: 0 };
        entries.set(key, entry);
      }
      if (entry.sent >= limit) {
        entry.suppressed = Math.min(MAX_SUPPRESSED, entry.suppressed + 1);
        return { allowed: false, suppressed: entry.suppressed };
      }
      entry.sent++;
      return { allowed: true, suppressed };
    },
    /** Bounded aggregate only, for local diagnostics. No keys or identities. */
    snapshot() {
      return { groups: entries.size, suppressed: Math.min(MAX_SUPPRESSED,
        [...entries.values()].reduce((sum, entry) => sum + entry.suppressed, 0)) };
    },
  };
}

const state = globalThis as typeof globalThis & {
  __codepilotTelemetryReportBudget?: ReturnType<typeof createTelemetryReportBudget>;
};
export const telemetryReportBudget = state.__codepilotTelemetryReportBudget ??= createTelemetryReportBudget();
