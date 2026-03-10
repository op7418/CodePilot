import type { TranslationKey } from '@/i18n';

export const DEFAULT_MAX_CONTEXT = 200000;
export const RING_RADIUS = 8;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export const CONTEXT_USAGE_COLORS = {
  compacting: '#a855f7',
  stale: '#64748b',
  danger: '#ef4444',
  warning: '#eab308',
  safe: '#22c55e',
} as const;

export function formatTokenCount(value: number): string {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return `${value}`;
}

export function getContextUsageRatio(contextTokens: number, maxContext: number, isContextStale: boolean): number {
  if (isContextStale) return 0;
  if (maxContext <= 0) return 0;
  return Math.min(Math.max(contextTokens / maxContext, 0), 1);
}

export function getContextUsageColor(ratio: number, isCompacting: boolean, isContextStale: boolean): string {
  if (isCompacting) return CONTEXT_USAGE_COLORS.compacting;
  if (isContextStale) return CONTEXT_USAGE_COLORS.stale;
  if (ratio > 0.7) return CONTEXT_USAGE_COLORS.danger;
  if (ratio > 0.5) return CONTEXT_USAGE_COLORS.warning;
  return CONTEXT_USAGE_COLORS.safe;
}

export function getContextUsageTooltip(
  contextTokens: number,
  maxContext: number,
  isCompacting: boolean,
  isContextStale: boolean,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (isCompacting) return t('messageInput.compacting');
  if (isContextStale) return t('messageInput.contextRefreshPending');
  return `${formatTokenCount(contextTokens)} / ${formatTokenCount(maxContext)}`;
}

