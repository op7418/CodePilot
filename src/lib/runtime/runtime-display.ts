import type { TranslationKey } from '@/i18n';

/**
 * Map persisted Runtime wire ids to user-facing translation keys.
 *
 * Keep this separate from API identity handling: Runtime ids remain stable on
 * the wire, while every UI surface renders the same localized product label.
 */
export function runtimeDisplayLabelKey(runtime: unknown): TranslationKey {
  if (runtime === 'codepilot_runtime') return 'runtimeSelector.codepilotRuntime';
  if (runtime === 'codex_runtime') return 'runtimeSelector.codexRuntime';
  if (runtime === 'claude_code') return 'runtimeSelector.claudeCode';
  return 'runtimeSwitchMarker.followGlobal';
}
