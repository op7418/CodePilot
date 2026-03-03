/**
 * Telegram utility functions — shared between the notification bot
 * (telegram-bot.ts) and the bridge adapter (telegram-adapter.ts).
 *
 * Extracted from telegram-bot.ts to avoid duplication.
 */

const TELEGRAM_API = 'https://api.telegram.org';

export interface TelegramSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** HTTP status code from the Telegram API response. */
  httpStatus?: number;
  /** Retry-after seconds returned by Telegram on 429 responses. */
  retryAfter?: number;
}

export interface TelegramApiResponse {
  ok: boolean;
  result?: {
    message_id?: number;
    [key: string]: unknown;
  };
  description?: string;
  /** Telegram returns retry_after (seconds) on 429 rate limit responses. */
  parameters?: {
    retry_after?: number;
    [key: string]: unknown;
  };
}

/**
 * Call a Telegram Bot API method.
 */
export async function callTelegramApi(
  botToken: string,
  method: string,
  params: Record<string, unknown>,
): Promise<TelegramSendResult> {
  try {
    const url = `${TELEGRAM_API}/bot${botToken}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const httpStatus = res.status;
    const data: TelegramApiResponse = await res.json();
    if (!data.ok) {
      return {
        ok: false,
        error: data.description || 'Unknown Telegram API error',
        httpStatus,
        retryAfter: data.parameters?.retry_after,
      };
    }
    return {
      ok: true,
      messageId: data.result?.message_id != null ? String(data.result.message_id) : undefined,
      httpStatus,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

/**
 * Escape special HTML characters for Telegram HTML mode.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Split a message into chunks that fit within Telegram's message size limit.
 * Tries to split at line boundaries when possible.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx <= 0 || splitIdx < maxLength * 0.5) {
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }

  return chunks;
}

/**
 * Format a session header for notification messages.
 */
export function formatSessionHeader(opts?: {
  sessionId?: string;
  sessionTitle?: string;
  workingDirectory?: string;
}): string {
  const parts: string[] = [];
  if (opts?.sessionTitle) {
    parts.push(`<b>${escapeHtml(opts.sessionTitle)}</b>`);
  }
  if (opts?.workingDirectory) {
    parts.push(`<code>${escapeHtml(opts.workingDirectory)}</code>`);
  }
  return parts.join('\n');
}
