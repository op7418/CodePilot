/**
 * Telegram Adapter — implements BaseChannelAdapter for Telegram Bot API.
 *
 * Uses long polling to consume updates, persists offset watermark to DB,
 * and routes messages/callbacks through an internal async queue.
 */

import crypto from 'crypto';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../types';
import type { FileAttachment } from '@/types';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter';
import { callTelegramApi } from './telegram-utils';
import {
  isImageEnabled,
  downloadPhoto,
  downloadDocumentImage,
  isSupportedImageMime,
  inferMimeType,
} from './telegram-media';
import type { TelegramPhotoSize, TelegramDocument, MediaDownloadResult } from './telegram-media';
import { getChannelOffset, setChannelOffset, insertAuditLog } from '../../db';
import { getSetting } from '../../db';

const TELEGRAM_API = 'https://api.telegram.org';

/** Max number of recent update_ids to keep for idempotency dedup on restart. */
const DEDUP_SET_MAX = 1000;

/** Derive a short token-specific hash for per-bot offset isolation. */
function tokenShortHash(botToken: string): string {
  return crypto.createHash('sha256').update(botToken).digest('hex').slice(0, 8);
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; first_name?: string; title?: string; username?: string };
    from?: { id: number; first_name: string; username?: string };
    text?: string;
    caption?: string;
    photo?: TelegramPhotoSize[];
    document?: TelegramDocument;
    media_group_id?: string;
    date: number;
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name: string; username?: string };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
}

/** Media group debounce buffer entry for album messages. */
interface MediaGroupBufferEntry {
  updates: TelegramUpdate[];
  updateIds: number[];
  timer: ReturnType<typeof setTimeout>;
  chatId: string;
  userId: string;
  displayName: string;
}

/** Debounce window for media group messages (ms). */
const MEDIA_GROUP_DEBOUNCE_MS = 500;

export class TelegramAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'telegram';

  private running = false;
  private abortController: AbortController | null = null;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private mediaGroupBuffers = new Map<string, MediaGroupBufferEntry>();

  /** Committed offset — the highest update_id that has been safely enqueued or skipped. */
  private committedOffset = 0;
  /** In-memory set of recently processed update_ids for idempotency on restart. */
  private recentUpdateIds = new Set<number>();
  /** Stable bot user ID from Telegram's getMe, used for offset key identity. */
  private botUserId: string | null = null;

  get botToken(): string {
    return getSetting('telegram_bot_token') || '';
  }

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[telegram-adapter] Cannot start:', configError);
      return;
    }

    // Resolve bot identity via getMe before starting the poll loop.
    // This provides a stable offset key that survives token rotation.
    await this.resolveBotIdentity();

    this.running = true;
    this.abortController = new AbortController();

    // Register bot commands menu with Telegram
    this.registerCommands().catch(() => {});

    // Start polling in background (no await — runs until stop())
    this.pollLoop().catch(err => {
      console.error('[telegram-adapter] Poll loop error:', err);
    });

    console.log('[telegram-adapter] Started (botUserId:', this.botUserId || 'fallback-to-hash', ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;

    // Persist committed offset before shutdown
    this.persistCommittedOffset();

    // Reject all waiting consumers
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    // Stop all typing indicators
    for (const [, interval] of this.typingIntervals) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Clear media group debounce timers
    for (const [, entry] of this.mediaGroupBuffers) {
      clearTimeout(entry.timer);
    }
    this.mediaGroupBuffers.clear();

    console.log('[telegram-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  consumeOne(): Promise<InboundMessage | null> {
    // If there's a queued message, return it immediately
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    // If not running, return null
    if (!this.running) return Promise.resolve(null);

    // Otherwise, wait for the poll loop to enqueue a message
    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const token = this.botToken;
    if (!token) return { ok: false, error: 'No bot token configured' };

    const params: Record<string, unknown> = {
      chat_id: message.address.chatId,
      text: message.text,
      disable_web_page_preview: true,
    };

    if (message.parseMode === 'HTML') {
      params.parse_mode = 'HTML';
    } else if (message.parseMode === 'Markdown') {
      params.parse_mode = 'Markdown';
    }

    if (message.replyToMessageId) {
      params.reply_to_message_id = message.replyToMessageId;
    }

    // Inline keyboard buttons
    if (message.inlineButtons && message.inlineButtons.length > 0) {
      params.reply_markup = {
        inline_keyboard: message.inlineButtons.map(row =>
          row.map(btn => ({
            text: btn.text,
            callback_data: btn.callbackData,
          }))
        ),
      };
    }

    return callTelegramApi(token, 'sendMessage', params);
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    const token = this.botToken;
    if (!token) return;

    await callTelegramApi(token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text || 'OK',
    });
  }

  validateConfig(): string | null {
    const token = getSetting('telegram_bot_token');
    if (!token) return 'telegram_bot_token not configured';

    const bridgeEnabled = getSetting('bridge_telegram_enabled');
    if (bridgeEnabled !== 'true') return 'bridge_telegram_enabled is not true';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    // Check bridge-specific allowed users first
    const allowedUsers = getSetting('telegram_bridge_allowed_users') || '';
    if (allowedUsers) {
      const allowed = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
      if (allowed.length > 0) {
        return allowed.includes(userId) || allowed.includes(chatId);
      }
    }

    // Fallback: check notification bot's chat_id
    const notifyChatId = getSetting('telegram_chat_id') || '';
    if (notifyChatId) {
      return chatId === notifyChatId;
    }

    // No auth configured — deny by default
    return false;
  }

  /**
   * Start a typing indicator that fires every 5 seconds.
   */
  startTyping(chatId: string): void {
    this.stopTyping(chatId); // Clear any existing
    const token = this.botToken;
    if (!token) return;

    // Send immediately
    callTelegramApi(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    // Repeat every 5s
    const interval = setInterval(() => {
      callTelegramApi(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    }, 5000);
    this.typingIntervals.set(chatId, interval);
  }

  /**
   * Stop the typing indicator for a chat.
   */
  stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  /**
   * Acknowledge that an update has been fully processed by the bridge-manager.
   * Only at this point do we advance the committed offset and persist it.
   * This ensures no message is lost if the process crashes between enqueue and processing.
   */
  acknowledgeUpdate(updateId: number): void {
    this.markUpdateProcessed(updateId);
    this.persistCommittedOffset();
  }

  // ── Lifecycle hooks (called generically by bridge-manager) ───

  onMessageStart(chatId: string): void {
    this.startTyping(chatId);
  }

  onMessageEnd(chatId: string): void {
    this.stopTyping(chatId);
  }

  // ── Private ──────────────────────────────────────────────────

  /**
   * Register slash commands with Telegram Bot API so they appear in the menu.
   */
  private async registerCommands(): Promise<void> {
    const token = this.botToken;
    if (!token) return;

    await callTelegramApi(token, 'setMyCommands', {
      commands: [
        { command: 'new', description: 'Start new session (optionally specify path)' },
        { command: 'bind', description: 'Bind to existing session' },
        { command: 'cwd', description: 'Change working directory' },
        { command: 'mode', description: 'Switch mode: plan / code / ask' },
        { command: 'status', description: 'Show current session status' },
        { command: 'sessions', description: 'List recent sessions' },
        { command: 'stop', description: 'Stop current task' },
        { command: 'help', description: 'Show available commands' },
      ],
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  /**
   * Return the DB key used to store the offset, scoped to the bot's stable identity.
   * Uses the bot user ID (from getMe) which survives token rotation.
   * Falls back to the token hash if getMe was not successful.
   */
  private offsetKey(): string {
    if (this.botUserId) {
      return 'telegram:bot' + this.botUserId;
    }
    const token = this.botToken;
    if (!token) return 'telegram';
    return 'telegram:' + tokenShortHash(token);
  }

  /**
   * Resolve the bot's stable user ID via Telegram's getMe API.
   * On first startup with bot-ID-based key, migrates the offset from the
   * old token-hash-based key so no messages are re-fetched.
   */
  private async resolveBotIdentity(): Promise<void> {
    const token = this.botToken;
    if (!token) return;

    try {
      const url = `${TELEGRAM_API}/bot${token}/getMe`;
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      if (data.ok && data.result?.id) {
        this.botUserId = String(data.result.id);

        // Migrate offset from old token-hash key to new bot-ID key
        const newKey = 'telegram:bot' + this.botUserId;
        const oldKey = 'telegram:' + tokenShortHash(token);
        const existingNew = getChannelOffset(newKey);
        if (!existingNew || existingNew === '0') {
          const existingOld = getChannelOffset(oldKey);
          if (existingOld && existingOld !== '0') {
            setChannelOffset(newKey, existingOld);
            console.log(`[telegram-adapter] Migrated offset from ${oldKey} to ${newKey}: ${existingOld}`);
          }
        }
      } else {
        console.warn('[telegram-adapter] getMe did not return a valid bot ID, falling back to token hash');
      }
    } catch (err) {
      console.warn('[telegram-adapter] getMe failed, falling back to token hash:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Mark an update as safely processed (enqueued or intentionally skipped).
   *
   * Uses contiguous watermark advancement: committedOffset only advances when
   * there are no gaps (e.g., media-group updates still buffered) below it.
   * This prevents offset from jumping past un-flushed album messages.
   */
  private markUpdateProcessed(updateId: number): void {
    this.recentUpdateIds.add(updateId);

    // Walk committedOffset forward contiguously — only advance while
    // the current position has been confirmed as processed.
    while (this.recentUpdateIds.has(this.committedOffset)) {
      this.committedOffset++;
    }

    // Prune dedup set when it exceeds capacity
    if (this.recentUpdateIds.size > DEDUP_SET_MAX) {
      const excess = this.recentUpdateIds.size - DEDUP_SET_MAX;
      let removed = 0;
      for (const id of this.recentUpdateIds) {
        if (removed >= excess) break;
        this.recentUpdateIds.delete(id);
        removed++;
      }
    }
  }

  /**
   * Persist the committed offset to DB. Safe to call at any time.
   */
  private persistCommittedOffset(): void {
    if (this.committedOffset <= 0) return;
    try {
      setChannelOffset(this.offsetKey(), String(this.committedOffset));
    } catch { /* best effort */ }
  }

  private async pollLoop(): Promise<void> {
    const key = this.offsetKey();

    // Load persisted committed offset
    this.committedOffset = parseInt(getChannelOffset(key), 10) || 0;

    // fetchOffset is used for the getUpdates API call; starts at committed offset
    let fetchOffset = this.committedOffset;

    while (this.running) {
      try {
        const token = this.botToken;
        if (!token) {
          console.warn('[telegram-adapter] No bot token, waiting...');
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        const url = `${TELEGRAM_API}/bot${token}/getUpdates`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset: fetchOffset,
            timeout: 30,
            allowed_updates: ['message', 'callback_query'],
          }),
          signal: this.abortController?.signal,
        });

        if (!this.running) break;

        const data = await res.json();
        if (!data.ok || !Array.isArray(data.result)) {
          console.warn('[telegram-adapter] getUpdates failed:', JSON.stringify(data).slice(0, 200));
          continue;
        }
        const updates: TelegramUpdate[] = data.result;
        for (const update of updates) {
          // Advance fetchOffset so the next getUpdates call skips this update
          if (update.update_id >= fetchOffset) {
            fetchOffset = update.update_id + 1;
          }

          // Idempotency: skip updates already processed (dedup on restart)
          if (this.recentUpdateIds.has(update.update_id)) {
            this.markUpdateProcessed(update.update_id);
            continue;
          }

          if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message?.chat.id ? String(cb.message.chat.id) : '';
            const userId = String(cb.from.id);

            if (!this.isAuthorized(userId, chatId)) {
              console.warn('[telegram-adapter] Unauthorized callback from userId:', userId, 'chatId:', chatId);
              this.markUpdateProcessed(update.update_id);
              continue;
            }

            const msg: InboundMessage = {
              messageId: cb.id,
              address: {
                channelType: 'telegram',
                chatId,
                userId,
                displayName: cb.from.username || cb.from.first_name,
              },
              text: '',
              timestamp: Date.now(),
              callbackData: cb.data,
              callbackMessageId: cb.message?.message_id ? String(cb.message.message_id) : undefined,
              raw: update,
              updateId: update.update_id,
            };

            this.enqueue(msg);

            // Answer callback to dismiss the loading state
            this.answerCallback(cb.id).catch(() => {});
          } else if (update.message) {
            const m = update.message;
            const chatId = String(m.chat.id);
            const userId = m.from ? String(m.from.id) : chatId;
            const displayName = m.from?.username || m.from?.first_name || chatId;

            if (!this.isAuthorized(userId, chatId)) {
              console.warn('[telegram-adapter] Unauthorized message from userId:', userId, 'chatId:', chatId);
              this.markUpdateProcessed(update.update_id);
              continue;
            }

            const hasPhoto = m.photo && m.photo.length > 0;
            const hasDocImage = m.document && this.isDocumentImage(m.document);
            const hasMedia = hasPhoto || hasDocImage;

            // Unified text extraction: text for regular messages, caption for media messages
            const messageText = m.text ?? m.caption ?? '';

            if (hasMedia && isImageEnabled()) {
              if (m.media_group_id) {
                // Album message — buffer for debounce, advance fetchOffset immediately
                this.bufferMediaGroup(m.media_group_id, update, chatId, userId, displayName);
                // Don't markUpdateProcessed yet — offset will be committed on flush
              } else {
                // Single image message — process immediately
                await this.processSingleImageMessage(update, chatId, userId, displayName);
              }
            } else if (messageText) {
              // Text/caption message (covers: pure text, image_enabled=false + caption,
              // unsupported document + caption)
              const msg: InboundMessage = {
                messageId: String(m.message_id),
                address: {
                  channelType: 'telegram',
                  chatId,
                  userId,
                  displayName,
                },
                text: messageText,
                timestamp: m.date * 1000,
                raw: update,
                updateId: update.update_id,
              };

              // Audit log
              try {
                insertAuditLog({
                  channelType: 'telegram',
                  chatId,
                  direction: 'inbound',
                  messageId: String(m.message_id),
                  summary: messageText.slice(0, 200),
                });
              } catch { /* best effort */ }

              this.enqueue(msg);
            } else {
              // Unhandled message type (sticker, voice, etc.) — skip
              this.markUpdateProcessed(update.update_id);
            }
          } else {
            // Unhandled update type — still safe to advance past it
            this.markUpdateProcessed(update.update_id);
          }
        }

        // Persist committed offset after processing the batch
        this.persistCommittedOffset();
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') break;
        console.warn('[telegram-adapter] Polling error:', err instanceof Error ? err.message : err);
        // Persist whatever we've safely committed before backing off
        this.persistCommittedOffset();
        if (this.running) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
  }

  /**
   * Check if a Telegram document is a supported image type.
   */
  private isDocumentImage(doc: TelegramDocument): boolean {
    if (doc.mime_type && isSupportedImageMime(doc.mime_type)) return true;
    if (doc.file_name) {
      const mime = inferMimeType(doc.file_name);
      if (mime && isSupportedImageMime(mime)) return true;
    }
    return false;
  }

  /**
   * Process a single image message (no media_group_id).
   * Downloads the image and enqueues a message with attachments.
   * Sends rejection notifications directly to Telegram on failure.
   */
  private async processSingleImageMessage(
    update: TelegramUpdate,
    chatId: string,
    userId: string,
    displayName: string,
  ): Promise<void> {
    const m = update.message!;
    const token = this.botToken;
    const address = { channelType: 'telegram' as const, chatId, userId, displayName };

    if (!token) {
      this.markUpdateProcessed(update.update_id);
      return;
    }

    const attachments: FileAttachment[] = [];
    const rejections: MediaDownloadResult[] = [];

    if (m.photo && m.photo.length > 0) {
      const result = await downloadPhoto(token, m.photo, String(m.message_id));
      if (result.attachment) {
        attachments.push(result.attachment);
      } else if (result.rejected && result.rejected !== 'unsupported_type') {
        rejections.push(result);
      }
    } else if (m.document) {
      const result = await downloadDocumentImage(token, m.document, String(m.message_id));
      if (result.attachment) {
        attachments.push(result.attachment);
      } else if (result.rejected && result.rejected !== 'unsupported_type') {
        rejections.push(result);
      }
    }

    // Send rejection notification directly to user
    if (rejections.length > 0) {
      const notice = rejections.map(r => r.rejectedMessage || 'Image processing failed').join('\n');
      this.send({ address, text: notice, parseMode: 'plain' }).catch(() => {});
    }

    const text = m.caption || m.text || '';
    const hasContent = attachments.length > 0 || text.trim();

    if (!hasContent) {
      // Nothing usable (all images failed, no text) — mark processed
      this.markUpdateProcessed(update.update_id);
      return;
    }

    const summary = attachments.length > 0
      ? `[${attachments.length} image(s)] ${text.slice(0, 150)}`
      : text.slice(0, 200);

    // Audit log
    try {
      insertAuditLog({
        channelType: 'telegram',
        chatId,
        direction: 'inbound',
        messageId: String(m.message_id),
        summary,
      });
    } catch { /* best effort */ }

    const msg: InboundMessage = {
      messageId: String(m.message_id),
      address,
      text,
      timestamp: m.date * 1000,
      raw: update,
      updateId: update.update_id,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    this.enqueue(msg);
  }

  /**
   * Buffer a media group update for debounced processing.
   * Resets the 500ms timer on each new update in the same group.
   */
  private bufferMediaGroup(
    mediaGroupId: string,
    update: TelegramUpdate,
    chatId: string,
    userId: string,
    displayName: string,
  ): void {
    const existing = this.mediaGroupBuffers.get(mediaGroupId);

    if (existing) {
      // Add to existing buffer, reset timer
      clearTimeout(existing.timer);
      existing.updates.push(update);
      existing.updateIds.push(update.update_id);
      existing.timer = setTimeout(() => this.flushMediaGroup(mediaGroupId), MEDIA_GROUP_DEBOUNCE_MS);
    } else {
      // New buffer
      const timer = setTimeout(() => this.flushMediaGroup(mediaGroupId), MEDIA_GROUP_DEBOUNCE_MS);
      this.mediaGroupBuffers.set(mediaGroupId, {
        updates: [update],
        updateIds: [update.update_id],
        timer,
        chatId,
        userId,
        displayName,
      });
    }
  }

  /**
   * Flush a media group buffer — download all images and enqueue a single message.
   */
  private async flushMediaGroup(mediaGroupId: string): Promise<void> {
    const entry = this.mediaGroupBuffers.get(mediaGroupId);
    if (!entry) return;
    this.mediaGroupBuffers.delete(mediaGroupId);

    const address = {
      channelType: 'telegram' as const,
      chatId: entry.chatId,
      userId: entry.userId,
      displayName: entry.displayName,
    };

    const token = this.botToken;
    if (!token) {
      // Can't download — mark all as processed
      for (const uid of entry.updateIds) {
        this.markUpdateProcessed(uid);
      }
      this.persistCommittedOffset();
      return;
    }

    const attachments: FileAttachment[] = [];
    const rejections: MediaDownloadResult[] = [];
    let caption = '';
    let firstMessageId = '';
    let firstDate = 0;

    // Download all images in the group
    for (const update of entry.updates) {
      const m = update.message!;
      if (!firstMessageId) {
        firstMessageId = String(m.message_id);
        firstDate = m.date;
      }
      // Use caption from whichever update has it (Telegram only sends caption on one)
      if (m.caption && !caption) {
        caption = m.caption;
      }

      if (m.photo && m.photo.length > 0) {
        const result = await downloadPhoto(token, m.photo, String(m.message_id));
        if (result.attachment) {
          attachments.push(result.attachment);
        } else if (result.rejected && result.rejected !== 'unsupported_type') {
          rejections.push(result);
        }
      } else if (m.document && this.isDocumentImage(m.document)) {
        const result = await downloadDocumentImage(token, m.document, String(m.message_id));
        if (result.attachment) {
          attachments.push(result.attachment);
        } else if (result.rejected && result.rejected !== 'unsupported_type') {
          rejections.push(result);
        }
      }
    }

    // Send rejection notification if any images failed
    if (rejections.length > 0) {
      const reasons = rejections.map(r => r.rejectedMessage || 'Image processing failed').join('\n');
      const notice = rejections.length === 1
        ? reasons
        : `${rejections.length} image(s) failed:\n${reasons}`;
      this.send({ address, text: notice, parseMode: 'plain' }).catch(() => {});
    }

    const text = caption;
    const hasContent = attachments.length > 0 || text.trim();

    if (!hasContent) {
      // All downloads failed and no caption — mark all processed
      for (const uid of entry.updateIds) {
        this.markUpdateProcessed(uid);
      }
      this.persistCommittedOffset();
      return;
    }

    const summary = attachments.length > 0
      ? `[Album: ${attachments.length} image(s)] ${text.slice(0, 150)}`
      : text.slice(0, 200);

    try {
      insertAuditLog({
        channelType: 'telegram',
        chatId: entry.chatId,
        direction: 'inbound',
        messageId: firstMessageId,
        summary,
      });
    } catch { /* best effort */ }

    // Use the max updateId so acknowledgeUpdate advances offset past all buffered updates
    const maxUpdateId = Math.max(...entry.updateIds);

    // Pre-register all buffered IDs in recentUpdateIds so the contiguous
    // watermark walk can advance past them when bridge-manager acks maxUpdateId.
    for (const uid of entry.updateIds) {
      this.recentUpdateIds.add(uid);
    }

    const msg: InboundMessage = {
      messageId: firstMessageId,
      address,
      text,
      timestamp: firstDate * 1000,
      updateId: maxUpdateId,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    this.enqueue(msg);
  }
}

// Self-register so bridge-manager can create TelegramAdapter via the registry.
registerAdapterFactory('telegram', () => new TelegramAdapter());
