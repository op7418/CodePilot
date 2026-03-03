/**
 * Delivery Layer — reliable outbound message delivery with chunking,
 * dedup, retry, error classification, and reference tracking.
 */

import type {
  ChannelType,
  ChannelAddress,
  OutboundMessage,
  SendResult,
  PLATFORM_LIMITS,
} from './types';
import type { TelegramChunk } from './markdown/telegram';
import { PLATFORM_LIMITS as limits } from './types';
import type { BaseChannelAdapter } from './channel-adapter';
import {
  checkDedup,
  insertDedup,
  cleanupExpiredDedup,
  insertOutboundRef,
  insertAuditLog,
} from '../db';
import { ChatRateLimiter } from './security/rate-limiter';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const JITTER_MAX_MS = 500;
/** Delay between sending multiple chunks to avoid rate limits. */
const INTER_CHUNK_DELAY_MS = 300;

/** Shared rate limiter instance (20 messages/minute per chat). */
const rateLimiter = new ChatRateLimiter();

// Periodically clean up idle rate limiter buckets (every 5 minutes).
setInterval(() => { rateLimiter.cleanup(); }, 5 * 60_000);

/**
 * Split text into chunks that fit within a platform's message size limit.
 * Tries to split at line boundaries when possible.
 */
function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline within the limit
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
 * Compute exponential backoff delay with jitter.
 */
function backoffDelay(attempt: number): number {
  const base = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * JITTER_MAX_MS;
  return base + jitter;
}

// ── Error classification ──────────────────────────────────────

type ErrorCategory = 'rate_limit' | 'server_error' | 'client_error' | 'parse_error' | 'network';

/**
 * Classify a SendResult failure into an error category.
 * Uses httpStatus when available, falls back to error string matching.
 */
function classifyError(result: SendResult): ErrorCategory {
  const status = (result as { httpStatus?: number }).httpStatus;
  const error = result.error ?? '';

  if (status === 429) return 'rate_limit';
  if (status && status >= 500) return 'server_error';
  if (status && status >= 400 && status < 500) {
    // Check for HTML parse errors even though they are 400
    if (/can't parse entities|parse entities|find end of the entity/i.test(error)) {
      return 'parse_error';
    }
    return 'client_error';
  }

  // No HTTP status — fall back to string matching
  if (/can't parse entities|parse entities|find end of the entity/i.test(error)) {
    return 'parse_error';
  }
  if (/too many requests|rate limit|retry.after/i.test(error)) {
    return 'rate_limit';
  }

  return 'network';
}

/**
 * Determine if a failed SendResult should be retried.
 */
function shouldRetry(category: ErrorCategory): boolean {
  switch (category) {
    case 'rate_limit':
    case 'server_error':
    case 'network':
      return true;
    case 'client_error':
    case 'parse_error':
      // Client errors won't succeed on retry; parse errors are handled
      // by the HTML fallback path, not the retry loop.
      return false;
  }
}

/**
 * Compute retry delay. For 429 responses, honor Telegram's retry_after field.
 */
function retryDelay(result: SendResult, attempt: number): number {
  const retryAfter = (result as { retryAfter?: number }).retryAfter;
  if (retryAfter && retryAfter > 0) {
    // Telegram gives seconds; add a small buffer
    return retryAfter * 1000 + 200;
  }
  return backoffDelay(attempt);
}

// ── Public API ────────────────────────────────────────────────

/**
 * Send a message through an adapter with chunking, dedup, retry, and auditing.
 */
export async function deliver(
  adapter: BaseChannelAdapter,
  message: OutboundMessage,
  opts?: {
    sessionId?: string;
    dedupKey?: string;
  },
): Promise<SendResult> {
  // Dedup check
  if (opts?.dedupKey) {
    if (checkDedup(opts.dedupKey)) {
      return { ok: true, messageId: undefined };
    }
  }

  // Periodically clean up expired dedup entries (1 in 100 chance)
  if (Math.random() < 0.01) {
    try { cleanupExpiredDedup(); } catch { /* best effort */ }
  }

  const limit = limits[adapter.channelType] || 4096;
  const chunks = chunkText(message.text, limit);
  let lastMessageId: string | undefined;

  for (let i = 0; i < chunks.length; i++) {
    // Rate limit: wait if this chat is sending too fast
    await rateLimiter.acquire(message.address.chatId);

    // Inter-chunk delay to avoid hitting rate limits on multi-chunk messages
    if (i > 0) {
      await new Promise(r => setTimeout(r, INTER_CHUNK_DELAY_MS));
    }

    const chunkMessage: OutboundMessage = {
      ...message,
      text: chunks[i],
      // Only attach inline buttons to the last chunk
      inlineButtons: i === chunks.length - 1 ? message.inlineButtons : undefined,
    };

    const result = await sendWithRetry(adapter, chunkMessage);
    if (!result.ok) {
      return result;
    }
    lastMessageId = result.messageId;

    // Track outbound reference
    if (result.messageId && opts?.sessionId) {
      try {
        insertOutboundRef({
          channelType: adapter.channelType,
          chatId: message.address.chatId,
          codepilotSessionId: opts.sessionId,
          platformMessageId: result.messageId,
          purpose: message.inlineButtons ? 'permission' : 'response',
        });
      } catch { /* best effort */ }
    }
  }

  // Mark as delivered for dedup
  if (opts?.dedupKey) {
    try { insertDedup(opts.dedupKey); } catch { /* best effort */ }
  }

  // Audit log
  try {
    insertAuditLog({
      channelType: adapter.channelType,
      chatId: message.address.chatId,
      direction: 'outbound',
      messageId: lastMessageId || '',
      summary: message.text.slice(0, 200),
    });
  } catch { /* best effort */ }

  return { ok: true, messageId: lastMessageId };
}

/**
 * Send a single message with retry, error classification, and HTML fallback.
 */
async function sendWithRetry(
  adapter: BaseChannelAdapter,
  message: OutboundMessage,
  plainFallback?: string,
): Promise<SendResult> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const result = await adapter.send(message);
    if (result.ok) return result;

    lastError = result.error;
    const category = classifyError(result);

    // HTML parse error: immediately fallback to plain text (no retry needed)
    if (category === 'parse_error' && message.parseMode === 'HTML') {
      const fallbackText = plainFallback || message.text;
      const plainResult = await adapter.send({
        ...message,
        text: fallbackText,
        parseMode: 'plain',
      });
      if (plainResult.ok) return plainResult;
      lastError = plainResult.error;
      // If plain text also fails, classify that error and continue
      const plainCategory = classifyError(plainResult);
      if (!shouldRetry(plainCategory)) {
        return plainResult;
      }
    }

    // Don't retry client errors (except 429 which is rate_limit)
    if (!shouldRetry(category)) {
      return result;
    }

    // Wait before next retry — honor retry_after for 429
    if (attempt < MAX_RETRIES - 1) {
      await new Promise(r => setTimeout(r, retryDelay(result, attempt)));
    }
  }

  return { ok: false, error: lastError || 'Max retries exceeded' };
}

/**
 * Deliver pre-rendered chunks (from Markdown renderer).
 * Each chunk already has HTML and plain text fallback.
 */
export async function deliverRendered(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  chunks: TelegramChunk[],
  opts?: { sessionId?: string; dedupKey?: string },
): Promise<SendResult> {
  // Dedup check
  if (opts?.dedupKey) {
    if (checkDedup(opts.dedupKey)) {
      return { ok: true, messageId: undefined };
    }
  }
  if (Math.random() < 0.01) {
    try { cleanupExpiredDedup(); } catch { /* best effort */ }
  }

  let lastMessageId: string | undefined;

  for (let i = 0; i < chunks.length; i++) {
    await rateLimiter.acquire(address.chatId);
    if (i > 0) {
      await new Promise(r => setTimeout(r, INTER_CHUNK_DELAY_MS));
    }

    const chunk = chunks[i];
    const htmlMessage: OutboundMessage = {
      address,
      text: chunk.html,
      parseMode: 'HTML',
    };

    // Try HTML first, fall back to plain text on parse error
    const result = await sendWithRetry(adapter, htmlMessage, chunk.text);
    if (!result.ok) return result;
    lastMessageId = result.messageId;

    if (result.messageId && opts?.sessionId) {
      try {
        insertOutboundRef({
          channelType: adapter.channelType,
          chatId: address.chatId,
          codepilotSessionId: opts.sessionId,
          platformMessageId: result.messageId,
          purpose: 'response',
        });
      } catch { /* best effort */ }
    }
  }

  if (opts?.dedupKey) {
    try { insertDedup(opts.dedupKey); } catch { /* best effort */ }
  }

  try {
    insertAuditLog({
      channelType: adapter.channelType,
      chatId: address.chatId,
      direction: 'outbound',
      messageId: lastMessageId || '',
      summary: chunks.map(c => c.text).join('').slice(0, 200),
    });
  } catch { /* best effort */ }

  return { ok: true, messageId: lastMessageId };
}
