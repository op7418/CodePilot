import { CLAUDE_MODELS } from './model-ids';

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Short aliases
  ...Object.fromEntries(Object.entries(CLAUDE_MODELS).map(([alias, m]) => [alias, m.contextWindow])),
  // Full model IDs
  ...Object.fromEntries(Object.values(CLAUDE_MODELS).map(m => [m.id, m.contextWindow])),
};

export function getContextWindow(
  model: string,
  options?: { context1m?: boolean },
): number | null {
  const base = MODEL_CONTEXT_WINDOWS[model]
    ?? MODEL_CONTEXT_WINDOWS[Object.keys(MODEL_CONTEXT_WINDOWS).find(k => model.includes(k)) ?? '']
    ?? null;
  if (base === null) return null;
  // When 1M context beta is enabled, all supported models get 1M window
  if (options?.context1m) return 1_000_000;
  return base;
}
