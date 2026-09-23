import { TOKENDANCE_FEATURED_MODEL_IDS } from './tokendance';
/**
 * catalog-recommend — "should this model be enabled by default" decision.
 *
 * Used by the discover-models apply path so that a freshly-connected
 * provider doesn't dump 100+ rows into the chat picker. Strategy:
 *
 *   1. Blacklist by name pattern — image / embedding / audio / rerank /
 *      preview / free / deprecated / test models never get auto-enabled,
 *      regardless of catalog whitelist.
 *
 *   2. Catalog whitelist — preset.defaultModels is treated as the
 *      "we picked these because they're the right starting set" list.
 *
 *   3. Claude alias fallback — for anthropic-protocol providers
 *      (claude_code_ready / verified / experimental), `sonnet` /
 *      `opus` / `haiku` and `claude-*` IDs are auto-enabled even
 *      without explicit catalog presence (handles relays that expose
 *      Claude through paths like `anthropic/claude-3-opus`).
 *
 *   4. Otherwise → not recommended (row materialised as enable_source=
 *      'discovered' with enabled=0; user can flip in Models page).
 *
 * Refresh apply is gated by enable_source: rows already marked
 * `manual_enabled` / `manual_hidden` are NEVER touched, so the
 * recommendation only takes effect on new / pristine rows.
 */

import type { VendorPreset } from '@/lib/provider-catalog';
import type { ProviderRuntimeCompat } from '@/types';

/**
 * Patterns that veto auto-enabling. Matched against the lowercase
 * model id. Matches are intentionally generous — a false negative
 * (we leave a stable model off by default) is recoverable in the
 * Models page; a false positive (we enable an embedding model in
 * the chat picker) confuses users and breaks chat calls.
 *
 * Order doesn't matter; any match disqualifies.
 */
const BLACKLIST_PATTERNS: RegExp[] = [
  // Modality — these never belong in the chat picker
  /\b(image|img|dall-?e|imagen|nano-?banana|gpt-?image)\b/,
  /\b(embed|embedding|embeddings)\b/,
  /\b(audio|whisper|tts|speech)\b/,
  /\b(rerank|reranker)\b/,
  // Lifecycle markers — preview / experimental / test / deprecated.
  // `experimental` matches names like `gemini-2.0-pro-experimental` —
  // distinct from the *provider*-tier `claude_code_experimental`, which
  // describes the connection's reliability rather than the model id.
  /\b(preview|alpha|beta|test|deprecated|legacy|sunset|experimental)\b/,
  // Tier markers — free / trial usually means rate-limited and not
  // suitable as a default
  /\b(free|trial|sandbox)\b/,
  // Date-based deprecated suffixes (e.g. -2024-04-09 lookalike)
  // Already handled by `legacy` keyword for OpenAI-compat naming.
];

const CLAUDE_ALIAS_SHORT = new Set(['sonnet', 'opus', 'haiku']);

function looksLikeClaudeAlias(id: string): boolean {
  if (CLAUDE_ALIAS_SHORT.has(id)) return true;
  if (id.startsWith('claude-')) return true;
  if (id.includes('/claude-')) return true; // OpenRouter / relay path forms
  return false;
}

function isAnthropicTier(c: ProviderRuntimeCompat): boolean {
  return c === 'claude_code_ready' || c === 'claude_code_verified' || c === 'claude_code_experimental';
}

/**
 * Returns true when the row should be auto-enabled by the system.
 *
 * @param modelId  The id we're materializing (downcased internally)
 * @param preset   The matched preset (may be undefined for custom URLs)
 * @param providerCompat  Provider-tier compat from getProviderCompat()
 */
export function isRecommendedModel(
  modelId: string,
  preset: VendorPreset | undefined,
  providerCompat: ProviderRuntimeCompat,
): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();

  // Protocol discovery filters the candidates; product defaults select only
  // the six featured models. Manual choices remain protected by apply.
  if (preset?.key === 'tokendance' || preset?.key === 'tokendance-anthropic') {
    return (TOKENDANCE_FEATURED_MODEL_IDS as readonly string[]).includes(modelId);
  }

  // (1) Blacklist always wins.
  for (const re of BLACKLIST_PATTERNS) {
    if (re.test(id)) return false;
  }

  // (2) Catalog whitelist — preset.defaultModels is the curated list.
  if (preset?.defaultModels?.some(m => m.modelId.toLowerCase() === id)) {
    return true;
  }

  // (3) Claude alias fallback — only for anthropic-protocol providers.
  //     OpenAI-compat / OpenRouter relays that happen to expose
  //     `anthropic/claude-*` would also fall here. Auto-enabling
  //     them as recommended makes "switch to OpenRouter, add → see
  //     claude opus appear" feel natural. Both OpenRouter skins qualify
  //     here:
  //       - `openrouter_anthropic_skin` (`/api`) routes through Claude
  //         Code Runtime; `claude-*` aliases are the documented best
  //         path.
  //       - `codepilot_only` (`/v1` skin and other OpenAI-compat relays)
  //         keeps the historical alias-lift so chats under CodePilot
  //         Runtime can still pin `anthropic/claude-*` names.
  if (isAnthropicTier(providerCompat) && looksLikeClaudeAlias(id)) {
    return true;
  }
  if ((providerCompat === 'codepilot_only' || providerCompat === 'openrouter_anthropic_skin')
      && looksLikeClaudeAlias(id)) {
    return true;
  }

  // (4) Otherwise — discovered but not recommended.
  return false;
}

/** Exposed for unit testing. */
export const __test = { BLACKLIST_PATTERNS, CLAUDE_ALIAS_SHORT, looksLikeClaudeAlias };
