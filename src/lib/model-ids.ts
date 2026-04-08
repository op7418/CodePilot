/**
 * Canonical Claude model definitions — single source of truth.
 *
 * This file has ZERO server-side imports (no fs, no db) so it can be
 * safely imported from both server code and client-side React hooks.
 *
 * Update these when Anthropic releases new model generations.
 */

export const CLAUDE_MODELS = {
  sonnet: { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', contextWindow: 200000 },
  opus:   { id: 'claude-opus-4-6',   displayName: 'Opus 4.6',   contextWindow: 200000 },
  haiku:  { id: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', contextWindow: 200000 },
} as const;

/** Default model ID used as a last-resort fallback */
export const DEFAULT_MODEL_ID = CLAUDE_MODELS.sonnet.id;
