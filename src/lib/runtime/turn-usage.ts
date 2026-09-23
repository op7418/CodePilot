import type { NormalizedTurnUsage, TokenUsage } from '@/types';
import type { RuntimeId } from './runtime-id';

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function money(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export interface TurnUsageRouteFacts {
  runtimeId: RuntimeId;
  providerInstanceId?: string;
  modelId?: string;
}

interface NativeStepUsageDetails {
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  raw?: Record<string, unknown>;
}

function hasOwnNumericField(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (keys.some((key) => Object.prototype.hasOwnProperty.call(record, key)
    && typeof record[key] === 'number')) {
    return true;
  }
  return Object.values(record).some((child) => hasOwnNumericField(child, keys));
}

/**
 * AI SDK adapters are not uniform about missing cache counters. In particular,
 * the Anthropic adapter exposes zero-valued inputTokenDetails even when the
 * provider response omitted both cache fields. If raw provider usage exists,
 * only trust the normalized details when the corresponding raw facts exist.
 */
export function getExplicitNativeCacheDetails(
  usage: NativeStepUsageDetails,
): { cacheRead: number; cacheWrite: number } | undefined {
  const cacheRead = tokenCount(usage.inputTokenDetails?.cacheReadTokens);
  const cacheWrite = tokenCount(usage.inputTokenDetails?.cacheWriteTokens);
  if (cacheRead === undefined || cacheWrite === undefined) return undefined;

  if (usage.raw) {
    const hasRead = hasOwnNumericField(usage.raw, [
      'cache_read_input_tokens',
      'cacheReadInputTokens',
      'cache_read_tokens',
      'cacheReadTokens',
      'cached_tokens',
      'cachedTokens',
    ]);
    const hasWrite = hasOwnNumericField(usage.raw, [
      'cache_creation_input_tokens',
      'cacheCreationInputTokens',
      'cache_write_input_tokens',
      'cacheWriteInputTokens',
      'cache_write_tokens',
      'cacheWriteTokens',
    ]);
    if (!hasRead || !hasWrite) return undefined;
  }

  return { cacheRead, cacheWrite };
}

/**
 * Convert the historical cross-runtime TokenUsage envelope into v2 facts.
 * The conversion is deliberately asymmetric because the three adapters do
 * not report the same input-token semantics.
 */
export function normalizeTurnUsage(
  usage: TokenUsage,
  route: TurnUsageRouteFacts,
): NormalizedTurnUsage {
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  const cacheRead = tokenCount(usage.cache_read_input_tokens);
  const cacheWrite = tokenCount(usage.cache_creation_input_tokens);
  const cost = money(usage.cost_usd);

  const normalized: NormalizedTurnUsage = {
    schemaVersion: 2,
    runtimeId: route.runtimeId,
    ...(route.providerInstanceId ? { providerInstanceId: route.providerInstanceId } : {}),
    ...(route.modelId ? { modelId: route.modelId } : {}),
    source: route.runtimeId === 'codepilot_runtime'
      ? 'provider_reported'
      : 'runtime_reported',
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cost !== undefined
      ? { costUsd: cost, costSource: 'provider_reported' as const }
      : {}),
  };

  if (route.runtimeId === 'claude_code') {
    // Anthropic reports uncached input, cache read and cache creation as
    // separate counters. A bucket is copied only when the SDK supplied it.
    if (input !== undefined) normalized.uncachedInputTokens = input;
    if (cacheRead !== undefined) normalized.cacheReadInputTokens = cacheRead;
    if (cacheWrite !== undefined) normalized.cacheWriteInputTokens = cacheWrite;
  } else if (route.runtimeId === 'codepilot_runtime') {
    // AI SDK's input_tokens is total input. We can derive no-cache input only
    // when BOTH detail buckets were reported by the provider adapter.
    if (input !== undefined && cacheRead !== undefined && cacheWrite !== undefined) {
      const uncached = input - cacheRead - cacheWrite;
      if (uncached >= 0) {
        normalized.uncachedInputTokens = uncached;
        normalized.cacheReadInputTokens = cacheRead;
        normalized.cacheWriteInputTokens = cacheWrite;
      }
    }
  } else {
    // Codex app-server reports total input + cached input for the last turn.
    // It does not currently expose cache writes.
    if (input !== undefined && cacheRead !== undefined && input >= cacheRead) {
      normalized.uncachedInputTokens = input - cacheRead;
      normalized.cacheReadInputTokens = cacheRead;
    }
  }

  return normalized;
}

export function attachNormalizedTurnUsage(
  usage: TokenUsage,
  route: TurnUsageRouteFacts,
): TokenUsage {
  return { ...usage, normalized: normalizeTurnUsage(usage, route) };
}
