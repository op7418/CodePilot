'use client';

/**
 * RuntimeSwitchMarker — inline transcript checkpoint.
 *
 * Step 4c R6 — when the user switches RuntimeSelector mid-conversation
 * (i.e. with at least one prior message in the chat), ChatView writes
 * a marker message into the transcript so future scroll-back can
 * answer "where did we change engines?". The marker is persisted as a
 * regular message row whose content carries a unique sentinel:
 *
 *   `[__RUNTIME_SWITCH__ from=claude_code to=codepilot_runtime]`
 *
 * Same pattern the image-gen pipeline already uses for
 * `[__IMAGE_GEN_NOTICE__ ...]`. MessageList detects the prefix and
 * renders THIS component instead of a normal user bubble.
 *
 * Visually it's a thin centred chip with horizontal rule on either
 * side — close to ai-elements/conversation's separator pattern. We
 * keep it understated so it never competes with real assistant /
 * user turns.
 */

import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import { CodePilotIcon } from '@/components/ui/semantic-icon';
import type { ChatRuntime } from '@/lib/chat-runtime-shared';
import { runtimeDisplayLabelKey } from '@/lib/runtime/runtime-display';

export const RUNTIME_SWITCH_MARKER_PREFIX = '[__RUNTIME_SWITCH__';

export interface RuntimeSwitchPayload {
  from: ChatRuntime | '';
  to: ChatRuntime;
}

/**
 * Pure parser — given a message content string, return either a parsed
 * payload or `null` if the content isn't a runtime-switch marker. Kept
 * pure so MessageList can detect markers without importing the
 * component itself for tree-shaking.
 */
export function parseRuntimeSwitchMarker(content: string): RuntimeSwitchPayload | null {
  if (!content.startsWith(RUNTIME_SWITCH_MARKER_PREFIX)) return null;
  // Format: `[__RUNTIME_SWITCH__ from=claude_code to=codepilot_runtime]`
  const fromMatch = /from=([a-z_]+)/.exec(content);
  const toMatch = /to=([a-z_]+)/.exec(content);
  if (!toMatch) return null;
  const fromVal = fromMatch?.[1];
  const toVal = toMatch[1];
  if (toVal !== 'claude_code' && toVal !== 'codepilot_runtime' && toVal !== 'codex_runtime') return null;
  const from: ChatRuntime | '' =
    fromVal === 'claude_code' || fromVal === 'codepilot_runtime' || fromVal === 'codex_runtime'
      ? fromVal
      : '';
  return { from, to: toVal };
}

/** Build the marker content string for `addMessage` / API calls. */
export function buildRuntimeSwitchMarker(payload: RuntimeSwitchPayload): string {
  const fromPart = payload.from ? ` from=${payload.from}` : '';
  return `${RUNTIME_SWITCH_MARKER_PREFIX}${fromPart} to=${payload.to}]`;
}

interface RuntimeSwitchMarkerProps {
  payload: RuntimeSwitchPayload;
}

export function RuntimeSwitchMarker({ payload }: RuntimeSwitchMarkerProps) {
  const { t } = useTranslation();
  const labelOf = (runtime: ChatRuntime | '') => t(runtimeDisplayLabelKey(runtime));

  const text = payload.from
    ? t('runtimeSwitchMarker.changedFromTo' as TranslationKey, {
        from: labelOf(payload.from),
        to: labelOf(payload.to),
      })
    : t('runtimeSwitchMarker.switchedTo' as TranslationKey, {
        to: labelOf(payload.to),
      });

  return (
    <div
      role="separator"
      data-runtime-switch-marker
      data-from={payload.from || ''}
      data-to={payload.to}
      className="my-3 flex items-center gap-2 px-2 text-[11px] text-muted-foreground"
    >
      <span className="h-px flex-1 bg-border/60" />
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-2 py-0.5">
        <CodePilotIcon name="runtime" size={11} aria-hidden />
        {text}
      </span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}
