/**
 * status-notice-i18n.ts — map an SSE status notification's (code, reason) pair
 * to the i18n keys that render it.
 *
 * Why this exists (Codex review P2, 2026-07-18; Opus 5 follow-up,
 * 2026-07-28): sampling/effort adjustments were emitted as server-rendered
 * English strings. The server can't know the reader's locale, so a zh user got
 * an English toast for a decision the app made on their behalf. The producers
 * now send `{ code, reason, params }` and the rendering happens here, on the
 * client, where the locale lives.
 *
 * Kept as its own dependency-free module (same convention as
 * anthropic-sampling-notice.ts) so BOTH chat entry points — useSSEStream's
 * handler and the inline SSE parser in app/chat/page.tsx — provably resolve the
 * SAME key: they both call `maybeShowStatusToast`, which calls this. A second
 * mapping table would be exactly the drift this module prevents.
 *
 * Notices without a `reason` (for example THINKING_ALWAYS_ON) are NOT mapped
 * here and keep using the server's `message` field.
 */

import type { TranslationKey } from '@/i18n';

/** The subset of an SSE status payload this module reads. */
export interface LocalizableStatusNotice {
  code?: string;
  reason?: string;
  params?: Record<string, string | number>;
}

export interface StatusNoticeKeys {
  titleKey: TranslationKey;
  messageKey: TranslationKey;
}

/**
 * Resolve the i18n keys for a code/reason pair, or null when the notice isn't
 * localizable (no reason, or an unrecognized one — e.g. a newer server talking
 * to an older client). Callers fall back to the payload's `message`, so an
 * unmapped notice degrades to "shown in the server's language" rather than
 * "silently dropped".
 */
export function resolveStatusNoticeKeys(
  notice: LocalizableStatusNotice,
): StatusNoticeKeys | null {
  const { code, reason, params } = notice;
  if (!code || !reason) return null;

  // English pluralizes "was/were not sent"; the count rides in params so the
  // key — not the server — picks the form.
  const plural = typeof params?.count === 'number' && params.count > 1 ? 'other' : 'one';

  switch (`${code}:${reason}`) {
    case 'GEMINI_OPTIONS_ADJUSTED:model-contract':
      return { titleKey: 'chat.notice.geminiOptions.title', messageKey: 'chat.notice.geminiOptions.message' };
    case 'NATIVE_OUTPUT_TRUNCATED:length':
      return { titleKey: 'chat.notice.outputTruncated.title', messageKey: 'chat.notice.outputTruncated.message' };
    case 'SAMPLING_PARAMS_IGNORED:model-rejects':
      return {
        titleKey: 'chat.notice.samplingIgnored.title',
        messageKey: `chat.notice.samplingIgnored.modelRejects.${plural}` as TranslationKey,
      };
    case 'SAMPLING_PARAMS_IGNORED:runtime-cannot-send':
      return {
        titleKey: 'chat.notice.samplingIgnored.title',
        messageKey: `chat.notice.samplingIgnored.runtimeCannotSend.${plural}` as TranslationKey,
      };
    case 'RUNTIME_EFFORT_IGNORED:unsupported-model':
      return {
        titleKey: 'chat.notice.effortIgnored.unsupportedModel.title',
        messageKey: 'chat.notice.effortIgnored.unsupportedModel.message',
      };
    case 'RUNTIME_EFFORT_IGNORED:unsupported-tier':
      return {
        titleKey: 'chat.notice.effortIgnored.unsupportedTier.title',
        messageKey: 'chat.notice.effortIgnored.unsupportedTier.message',
      };
    case 'RUNTIME_EFFORT_IGNORED:third-party-proxy':
      return {
        titleKey: 'chat.notice.effortIgnored.thirdPartyProxy.title',
        messageKey: 'chat.notice.effortIgnored.thirdPartyProxy.message',
      };
    case 'RUNTIME_EFFORT_ADJUSTED:thinking-disabled-cap':
      return {
        titleKey: 'chat.notice.effortAdjusted.thinkingDisabled.title',
        messageKey: 'chat.notice.effortAdjusted.thinkingDisabled.message',
      };
    case 'SUBAGENT_MODEL_UNAVAILABLE:runtime-model-unsupported':
      return {
        titleKey: 'chat.notice.subagentModelUnavailable.title',
        messageKey: 'chat.notice.subagentModelUnavailable.message',
      };
    default:
      return null;
  }
}
