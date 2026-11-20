/**
 * Codex app-server reasoning-effort compatibility.
 *
 * ── Phase 0 (2026-07-17): per-model allowlist, not a global clamp ──────
 *
 * The rule is now "send exactly what THIS model declares in `model/list`":
 *
 *   - GPT-5.6 Sol declares low/medium/high/xhigh/max/ultra. Its `xhigh` /
 *     `max` are REAL and are forwarded verbatim — the old global clamp
 *     silently downgraded them to `high`, so the user paid for a tier the
 *     wire never carried (exactly the "UI 数字不是用户以为的意思" failure).
 *   - A level the current model does not declare is OMITTED, never coerced
 *     into a neighbouring tier. Omission lets Codex apply its own default;
 *     coercion invents a semantic the user didn't choose.
 *
 * `clampCodexEffort` survives ONLY as the no-capability-info fallback (cold
 * model/list cache, logged out, old binary). That path still can't know
 * whether the binary is one of the strict old builds that REJECT unknown
 * variants FATALLY — observed 2026-05-31 with `/opt/homebrew/bin/codex`:
 *   `Failed to deserialize overridden config: unknown variant `xhigh``
 * (even codex 0.133 only tolerates them with a warning, falling back to
 * `medium`). Absent evidence, staying conservative there is correct.
 *
 * Scope: codex_runtime ONLY. Claude Code / Native runtimes keep the full
 * union for Anthropic models — do NOT route their effort through here.
 *
 * Per-version CLI effort behavior: docs/external-facts.md.
 */

import { codexReleaseAtLeast } from './release-version';

/**
 * Reasoning-effort levels assumed safe when the current model's real
 * capability list is UNKNOWN. Deliberately the old conservative set — this
 * is the fallback floor, not a statement about what Codex supports today.
 */
export const CODEX_SUPPORTED_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

export type CodexEffort = (typeof CODEX_SUPPORTED_EFFORTS)[number];

/**
 * Tiers a Codex model may declare that must NOT appear in the GENERIC effort
 * selector shared with every other provider.
 *
 * `ultra` is a Codex-only product tier whose multi-agent semantics CodePilot
 * has not modeled. Listing it next to low/medium/high would read as "one more
 * notch of the same dial", which is not what it is. Parsed honestly from
 * model/list, withheld from the shared menu until it's actually wired.
 */
export const CODEX_GENERIC_EXCLUDED_EFFORTS: readonly string[] = ['ultra'];

/**
 * Project a model's declared tiers onto the generic effort selector.
 * Codex-exclusive tiers are dropped; order is preserved.
 */
export function toGenericEffortLevels(declared: readonly string[] | undefined): string[] {
  if (!declared) return [];
  return declared.filter((level) => !CODEX_GENERIC_EXCLUDED_EFFORTS.includes(level));
}

/**
 * Resolve the effort to put on the `turn/start` wire for THIS model.
 *
 * @param effort   what the user selected (undefined = Auto → omit).
 * @param declaredLevels the model's `model/list` tiers, or undefined when we
 *   have no capability info (cold cache / logged out / old binary).
 *
 * - declared allowlist present → pass through iff declared, else omit.
 *   `xhigh` / `max` are forwarded verbatim when the model claims them.
 * - no capability info → conservative {@link clampCodexEffort} fallback.
 */
export function resolveCodexEffort(
  effort: string | undefined | null,
  declaredLevels: readonly string[] | undefined,
): string | undefined {
  if (!effort) return undefined;
  if (declaredLevels && declaredLevels.length > 0) {
    // Per-model truth wins — including tiers the old global clamp downgraded.
    return declaredLevels.includes(effort) ? effort : undefined;
  }
  return clampCodexEffort(effort);
}

export interface CodexProviderEffortContract {
  supportedLevels?: readonly string[];
  defaultLevel?: string;
}

/**
 * First locally verified app-server whose turn/start enum accepts both
 * xhigh and max. This is binary-schema evidence, not a Codex Account/model
 * entitlement requirement. Newer core versions are accepted conservatively.
 */
export const CODEX_PROVIDER_EXTENDED_EFFORT_MIN_VERSION = '0.144.2';

export function codexVersionSupportsProviderExtendedEffort(
  version: string | undefined,
): boolean {
  return codexReleaseAtLeast(version, CODEX_PROVIDER_EXTENDED_EFFORT_MIN_VERSION);
}

/**
 * Resolve a CodePilot Provider effort for Codex `turn/start`.
 *
 * Provider models do not appear in Codex Account's model/list, so their own
 * catalog is the semantic allowlist. Extended enum values still need a second
 * proof that the installed app-server understands the token: Codex 0.133, for
 * example, accepted `xhigh` but warned and silently changed unknown `max` to
 * medium. Missing proof is a user-visible error, never a quiet downgrade.
 */
export function resolveCodexProviderEffort(
  requested: string | undefined | null,
  contract: CodexProviderEffortContract,
  appServerEffortVocabulary: readonly string[] | undefined,
  appServerVersion?: string,
): string | undefined {
  const selected = requested || contract.defaultLevel;
  if (!selected || !contract.supportedLevels?.includes(selected)) return undefined;

  if (
    (selected === 'xhigh' || selected === 'max')
    && !appServerEffortVocabulary?.includes(selected)
    && !codexVersionSupportsProviderExtendedEffort(appServerVersion)
  ) {
    throw new Error(
      `The installed Codex app-server has not advertised support for the "${selected}" effort token. Update Codex to ${CODEX_PROVIDER_EXTENDED_EFFORT_MIN_VERSION} or newer, then retry; a Codex Account login is not required, and CodePilot will not silently downgrade this request.`,
    );
  }
  return selected;
}

/**
 * Conservative fallback for when the current model's declared tiers are
 * unknown. Prefer {@link resolveCodexEffort}, which consults the real
 * per-model allowlist first and only falls back to this.
 *
 * - `xhigh` / `max`            → `high`  (unknown-capability guess, see above)
 * - `minimal`/`low`/`medium`/`high` → unchanged
 * - `undefined` / `null` / unknown  → `undefined` (omit; let Codex use its
 *                                      own default rather than risk a reject)
 */
export function clampCodexEffort(effort: string | undefined | null): CodexEffort | undefined {
  if (!effort) return undefined;
  if (effort === 'xhigh' || effort === 'max') return 'high';
  if ((CODEX_SUPPORTED_EFFORTS as readonly string[]).includes(effort)) {
    return effort as CodexEffort;
  }
  return undefined;
}
