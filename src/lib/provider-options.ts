import type { ProviderOptions } from '@/types';

export const VALID_PROVIDER_EFFORTS = ['low', 'medium', 'high', 'max'] as const;

export function normalizeProviderEffort(value: unknown): ProviderOptions['effort'] | undefined {
  if (typeof value !== 'string') return undefined;
  return VALID_PROVIDER_EFFORTS.includes(value as typeof VALID_PROVIDER_EFFORTS[number])
    ? value as ProviderOptions['effort']
    : undefined;
}

export function sanitizeProviderOptions(options: ProviderOptions): ProviderOptions {
  const sanitized: ProviderOptions = { ...options };
  if (Object.prototype.hasOwnProperty.call(sanitized, 'effort')) {
    const normalizedEffort = normalizeProviderEffort(sanitized.effort);
    if (normalizedEffort) {
      sanitized.effort = normalizedEffort;
    } else {
      delete (sanitized as { effort?: unknown }).effort;
    }
  }
  return sanitized;
}
