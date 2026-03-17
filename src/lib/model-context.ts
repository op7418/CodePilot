import { CLAUDE_MODELS } from './model-ids';

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Short aliases
  ...Object.fromEntries(Object.entries(CLAUDE_MODELS).map(([alias, m]) => [alias, m.contextWindow])),
  // Full model IDs
  ...Object.fromEntries(Object.values(CLAUDE_MODELS).map(m => [m.id, m.contextWindow])),
};

export function getContextWindow(model: string): number | null {
  return MODEL_CONTEXT_WINDOWS[model]
    ?? MODEL_CONTEXT_WINDOWS[Object.keys(MODEL_CONTEXT_WINDOWS).find(k => model.includes(k)) ?? '']
    ?? null;
}
