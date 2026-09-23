// Opus 4.7 ships a default 1M context window (no beta header required);
// Opus 4.6 (claude-opus-4-20250514) still needs context-1m-2025-08-07 to
// reach 1M. Other 4.x models default to 200K.
//
// The `opus` alias is intentionally left at 200K (Opus 4.6 semantics).
// Callers that know the resolved upstream model must pass it to
// getContextWindow via the `upstream` option so first-party sessions
// (which resolve to claude-opus-4-7) get their 1M window while
// Bedrock/Vertex sessions (where opus still resolves to 4.6) stay at
// 200K. This avoids the previous bug where all `opus` lookups were
// budgeted as 1M, over-estimating Bedrock/Vertex by ~5×.
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'sonnet': 200000,
  'opus': 200000,
  'haiku': 200000,
  'claude-sonnet-4-20250514': 200000,
  'claude-opus-4-20250514': 200000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  // Opus 5 — 1M context (default and ceiling) / 128K max output.
  // https://platform.claude.com/docs/en/about-claude/models/overview
  'claude-opus-5': 1_000_000,
  // Fable 5 — 1M context / 128K max output per official model docs
  // https://platform.claude.com/docs/en/about-claude/models/overview
  'claude-fable-5': 1_000_000,
  'claude-fable-5-1': 1_000_000,
  // Sonnet 5 — 1M context (default AND ceiling) / 128K max output per the
  // official migration guide (whats-new-sonnet-5, verified 2026-07-17).
  // Same window semantics as the fable-5 entry above. NOTE: Sonnet 5 ships
  // a new tokenizer — the SAME text counts ≈ +30% tokens vs Sonnet 4.6, so
  // this catalog window is an UNTRUSTED fallback (like all entries here):
  // the SDK / upstream-reported window still wins for the user-visible %,
  // and token-budget estimates that key off char-count will under-count on
  // Sonnet 5. Prefer real usage reporting over char heuristics for it.
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5-20251001': 200000,
  // Third-party chat models — Native runtime fallback (Vercel AI SDK
  // doesn't expose modelContextWindow; ClaudeCode SDK's reported window
  // and Codex ThreadTokenUsage.modelContextWindow still win when present).
  //
  // Discipline:
  //   - Only add modelIds that ACTUALLY appear in:
  //     · src/lib/provider-catalog.ts defaultModels
  //     · DB chat_sessions.model (historical sessions)
  //   - Each entry MUST be web-verified against vendor's official docs
  //     and cite source URL in a leading comment
  //   - DO NOT guess from training memory — 2026-05-20 first attempt
  //     shipped several wrong / non-existent entries before fact-check
  //   - Unverified modelIds: leave absent → useContextUsage reports
  //     "capacity unknown"; the trigger mini-bar then distributes by
  //     used+pending composition (#632 removed the old 200K fallback
  //     denominator — no fabricated capacity, no misleading 100% fill)
  //   - NOTE (#632): this catalog is now an UNTRUSTED fallback. RunCockpit
  //     shows a % only against an SDK / upstream-reported window; a value
  //     here drives composition, never a trusted percentage.
  //
  // GLM-5-Turbo (Z.ai) — heaviest usage in DB (44 sessions)
  // ⚠️ provenance under review (#632): the Z.ai GLM-5-Turbo page states
  // Context 200K / Max Output 128K, NOT 202,752 — this "202752" citation
  // does not match the vendor page. Kept as-is pending a verified source;
  // it only feeds composition now (untrusted fallback, see above), so the
  // exact figure no longer drives a user-visible percentage.
  'glm-5-turbo': 202752,
  // GLM-5.3-Flash — official docs state 1M and configure it as 1,000,000.
  // The `[1m]` Claude Coding Plan wire variant substring-matches this bare
  // key; Codex Responses uses the bare ID. Do not reinterpret decimal 1M as Mi.
  // https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash
  'glm-5.3-flash': 1_000_000,
  // GPT-5.5 (OpenAI) — 16 sessions in DB
  // https://openai.com/index/introducing-gpt-5-5/ — 1M API context
  'gpt-5.5': 1_000_000,
  // GPT-5.4 (OpenAI) — 11 sessions in DB
  // https://openai.com/index/introducing-gpt-5-4/ — 1M API context
  'gpt-5.4': 1_000_000,
};

// Substring fallback keys ordered by length (longest first) so a vendor-
// prefixed or date-suffixed upstream name (e.g.
// 'us.anthropic.claude-opus-4-7-v1:0') hits 'claude-opus-4-7' before
// 'opus'. Without this, insertion order would make the short 'opus' alias
// (200K) win and strip the real 1M window.
const CONTEXT_LOOKUP_KEYS_BY_LENGTH = Object.keys(MODEL_CONTEXT_WINDOWS)
  .slice()
  .sort((a, b) => b.length - a.length);

/**
 * Try to resolve a single key via exact match first, then longest-suffix
 * substring. Returns null when neither strategy finds anything so callers
 * can chain with ?? to a different key.
 */
function resolveWindow(key: string): number | null {
  if (!key) return null;
  if (MODEL_CONTEXT_WINDOWS[key] != null) return MODEL_CONTEXT_WINDOWS[key];
  const match = CONTEXT_LOOKUP_KEYS_BY_LENGTH.find(k => key.includes(k));
  return match ? MODEL_CONTEXT_WINDOWS[match] : null;
}

export function getContextWindow(
  model: string,
  options?: { context1m?: boolean; upstream?: string; channel?: 'api' | 'codex' },
): number | null {
  // Astra API and Codex backend have different default input budgets.
  // A caller without transport evidence must not display either as known.
  // openai/codex 459a79eb, models-manager/models.json (2026-09-05).
  const codexDefaultModels = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];
  if (options?.channel === 'codex' && codexDefaultModels.includes(options.upstream || model)) return 258_400;
  if ((options?.upstream || model) === 'gpt-6-astra') {
    return options?.channel === 'codex' ? 258_400 : options?.channel === 'api' ? 1_050_000 : null;
  }
  // Prefer the upstream model ID when known — it unambiguously selects
  // between alias variants (e.g. `opus` on first-party Anthropic is
  // claude-opus-4-7 but on Bedrock/Vertex it's Opus 4.6). Fall through
  // to the model alias when upstream is absent OR when it resolves
  // to nothing (e.g. unknown vendor-prefixed name that doesn't substring-
  // match any known key).
  const base = (options?.upstream ? resolveWindow(options.upstream) : null)
    ?? resolveWindow(model);
  if (base === null) return null;
  // When 1M context beta is enabled, all supported models get 1M window.
  // (Opus 4.7 already defaults to 1M so the toggle is a no-op there.)
  if (options?.context1m) return 1_000_000;
  return base;
}
