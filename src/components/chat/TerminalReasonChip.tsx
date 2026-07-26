/**
 * TerminalReasonChip — renders a contextual end-of-turn status chip based on
 * `SDKResultMessage.terminal_reason` (SDK 0.2.111+).
 *
 * Phase 1 of agent-sdk-0-2-111-adoption: additive display layer. Does NOT
 * replace error-classifier.ts — errors without a result message continue to
 * flow through the existing classifier pipeline.
 *
 * Only renders for reasons that carry information users can act on or interpret.
 * Silent for `completed` (normal) and `aborted_*` (user-initiated).
 *
 * When `phase` is 'error' or 'stopped' without a known reason, a generic
 * retry button is shown so users can quickly re-send the last message after
 * an interruption or network error.
 */

import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import type { StreamPhase } from '@/types';

export type TerminalActionId =
  | 'compress_and_retry'
  | 'enable_1m_and_retry'
  | 'compress_only'
  | 'switch_to_sonnet'
  | 'continue_max_turns'
  | 'open_hook_settings'
  | 'retry_simple'
  | 'retry_image_upload';

interface Props {
  reason: string | undefined;
  phase?: StreamPhase;
  onAction?: (actionId: TerminalActionId) => void;
}

type Tone = 'warning' | 'error' | 'info' | 'muted';

interface ActionDescriptor {
  id: TerminalActionId;
  labelKey: TranslationKey;
  variant: 'primary' | 'secondary';
}

const ACTIONS_BY_REASON: Record<string, ActionDescriptor[]> = {
  prompt_too_long: [
    { id: 'compress_and_retry', labelKey: 'terminalAction.compressAndRetry' as TranslationKey, variant: 'primary' },
    { id: 'enable_1m_and_retry', labelKey: 'terminalAction.enable1mAndRetry' as TranslationKey, variant: 'secondary' },
    { id: 'compress_only', labelKey: 'terminalAction.compressOnly' as TranslationKey, variant: 'secondary' },
  ],
  blocking_limit: [
    { id: 'switch_to_sonnet', labelKey: 'terminalAction.switchToSonnet' as TranslationKey, variant: 'primary' },
  ],
  rapid_refill_breaker: [
    { id: 'switch_to_sonnet', labelKey: 'terminalAction.switchToSonnet' as TranslationKey, variant: 'primary' },
  ],
  max_turns: [
    { id: 'continue_max_turns', labelKey: 'terminalAction.continue' as TranslationKey, variant: 'primary' },
  ],
  hook_stopped: [
    { id: 'open_hook_settings', labelKey: 'terminalAction.openHookSettings' as TranslationKey, variant: 'secondary' },
  ],
  stop_hook_prevented: [
    { id: 'open_hook_settings', labelKey: 'terminalAction.openHookSettings' as TranslationKey, variant: 'secondary' },
  ],
  image_error: [
    { id: 'retry_image_upload', labelKey: 'terminalAction.retryImageUpload' as TranslationKey, variant: 'primary' },
  ],
  model_error: [
    { id: 'retry_simple', labelKey: 'terminalAction.retry' as TranslationKey, variant: 'primary' },
  ],
};

const TONE_BY_REASON: Record<string, Tone> = {
  max_turns: 'warning',
  prompt_too_long: 'error',
  blocking_limit: 'error',
  rapid_refill_breaker: 'error',
  image_error: 'error',
  model_error: 'error',
  stop_hook_prevented: 'muted',
  hook_stopped: 'muted',
  tool_deferred: 'info',
};

const SILENT_REASONS = new Set(['completed', 'aborted_streaming', 'aborted_tools']);

const KNOWN_REASONS = new Set([
  'max_turns',
  'prompt_too_long',
  'blocking_limit',
  'rapid_refill_breaker',
  'image_error',
  'model_error',
  'stop_hook_prevented',
  'hook_stopped',
  'tool_deferred',
]);

const TONE_CLASSES: Record<Tone, string> = {
  warning: 'bg-status-warning-muted text-status-warning-foreground border-status-warning-muted',
  error: 'bg-status-error-muted text-status-error-foreground border-status-error-muted',
  info: 'bg-status-info-muted text-status-info-foreground border-status-info-muted',
  muted: 'bg-muted text-muted-foreground border-border',
};

const RETRY_ACTION: ActionDescriptor = {
  id: 'retry_simple',
  labelKey: 'terminalAction.retry' as TranslationKey,
  variant: 'primary',
};

export function TerminalReasonChip({ reason, phase, onAction }: Props) {
  const { t } = useTranslation();

  const isInterrupted = phase === 'error' || phase === 'stopped';

  if (!reason || SILENT_REASONS.has(reason)) {
    if (isInterrupted && onAction) {
      return (
        <div className="mx-auto mt-2 flex w-full max-w-3xl flex-wrap items-center justify-start gap-2 px-4">
          <button
            type="button"
            onClick={() => onAction(RETRY_ACTION.id)}
            data-terminal-action={RETRY_ACTION.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
              <path d="M13.65 2.35A8 8 0 1 0 15.94 9H13.9a6 6 0 1 1-1.63-5.27L10 6h6V0l-2.35 2.35z" fill="currentColor"/>
            </svg>
            {t(RETRY_ACTION.labelKey)}
          </button>
        </div>
      );
    }
    return null;
  }

  const isKnown = KNOWN_REASONS.has(reason);
  const tone = TONE_BY_REASON[reason] ?? 'warning';
  const label = isKnown
    ? t(`terminal.${reason}` as TranslationKey)
    : t('terminal.unknown' as TranslationKey);
  const actions = onAction ? (ACTIONS_BY_REASON[reason] || []) : [];

  const showRetry = isInterrupted && actions.every(a => a.id !== 'retry_simple') && onAction;

  return (
    <div className="mx-auto mt-2 flex w-full max-w-3xl flex-wrap items-center justify-start gap-2 px-4">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${TONE_CLASSES[tone]}`}
        data-terminal-reason={reason}
      >
        {label}
      </span>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          onClick={() => onAction?.(action.id)}
          data-terminal-action={action.id}
          className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
            action.variant === 'primary'
              ? `${TONE_CLASSES[tone]} hover:opacity-90`
              : 'border-border bg-background text-foreground hover:bg-muted'
          }`}
        >
          {t(action.labelKey)}
        </button>
      ))}
      {showRetry && (
        <button
          type="button"
          onClick={() => onAction(RETRY_ACTION.id)}
          data-terminal-action={RETRY_ACTION.id}
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${TONE_CLASSES[tone]} hover:opacity-90`}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
            <path d="M13.65 2.35A8 8 0 1 0 15.94 9H13.9a6 6 0 1 1-1.63-5.27L10 6h6V0l-2.35 2.35z" fill="currentColor"/>
          </svg>
          {t(RETRY_ACTION.labelKey)}
        </button>
      )}
    </div>
  );
}
