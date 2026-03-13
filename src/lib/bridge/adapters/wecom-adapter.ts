/**
 * Enterprise WeCom Adapter — implements BaseChannelAdapter for the
 * @wecom/aibot-node-sdk WebSocket channel.
 */

import crypto from 'crypto';
import path from 'path';
import {
  WSClient,
  type EventMessageWith,
  type FileMessage,
  type ImageMessage,
  type MixedMessage,
  type TemplateCardEventData,
  type TextMessage,
  type VoiceMessage,
  type WsFrame,
} from '@wecom/aibot-node-sdk';
import type { FileAttachment } from '@/types';
import type { ChannelType, InboundMessage, OutboundMessage, SendResult } from '../types';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter';
import { getSetting, insertAuditLog } from '../../db';
import {
  buildMarkdownMessage,
  buildPermissionCard,
  buildPermissionCommandText,
  htmlToWecomMarkdown,
  preprocessWecomMarkdown,
} from '../markdown/wecom';

const DEDUP_MAX = 1000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;

export const WECOM_PROCESSING_STARTED_TEXT = '已收到，正在处理中...';

type WecomEventBody = {
  event?: {
    event_key?: string;
    key?: string;
    task_id?: string;
    eventtype?: string;
    template_card_event?: {
      event_key?: string;
      key?: string;
      task_id?: string;
      card_type?: string;
    };
  };
  event_key?: string;
} | undefined;

export function extractWecomTemplateCardCallbackData(body: WecomEventBody): string | undefined {
  if (!body) return undefined;

  const event = body.event as {
    event_key?: string;
    key?: string;
    task_id?: string;
    eventtype?: string;
    template_card_event?: {
      event_key?: string;
      key?: string;
      task_id?: string;
    };
  } | undefined;

  return event?.template_card_event?.event_key
    || event?.template_card_event?.key
    || event?.event_key
    || event?.key
    || (body as { event_key?: string }).event_key;
}

export function isWecomTemplateCardEvent(body: WecomEventBody): boolean {
  if (!body) return false;

  const event = body.event as {
    event_key?: string;
    key?: string;
    task_id?: string;
    eventtype?: string;
    template_card_event?: {
      event_key?: string;
      key?: string;
      task_id?: string;
    };
  } | undefined;

  return event?.eventtype === 'template_card_event'
    || Boolean(event?.template_card_event?.event_key)
    || Boolean(event?.template_card_event?.key)
    || Boolean(event?.event_key)
    || Boolean(event?.key)
    || Boolean((body as { event_key?: string }).event_key)
    || Boolean(event?.template_card_event?.task_id)
    || Boolean(event?.task_id);
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
};

export class WecomAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'wecom';

  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private wsClient: WSClient | null = null;
  private seenMessageIds = new Map<string, boolean>();

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[wecom-adapter] Cannot start:', configError);
      return;
    }

    const botId = getSetting('bridge_wecom_bot_id') || '';
    const secret = getSetting('bridge_wecom_secret') || '';

    const client = new WSClient({ botId, secret });
    this.wsClient = client;
    this.bindClientHandlers(client);

    try {
      await this.connectAndWait(client);
      this.running = true;
      console.log('[wecom-adapter] Started');
    } catch (err) {
      try {
        client.disconnect();
      } catch {
        // ignore disconnect cleanup errors
      }
      this.wsClient = null;
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.running && !this.wsClient) return;

    this.running = false;

    if (this.wsClient) {
      try {
        this.wsClient.disconnect();
      } catch (err) {
        console.warn('[wecom-adapter] disconnect error:', err instanceof Error ? err.message : err);
      }
      this.wsClient = null;
    }

    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
    this.queue = [];
    this.seenMessageIds.clear();

    console.log('[wecom-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (!this.running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.wsClient) {
      return { ok: false, error: 'WeCom client not initialized' };
    }

    let text = message.text;
    if (message.parseMode === 'HTML') {
      text = htmlToWecomMarkdown(text);
    }
    if (message.parseMode === 'HTML' || message.parseMode === 'Markdown') {
      text = preprocessWecomMarkdown(text);
    }

    if (message.inlineButtons && message.inlineButtons.length > 0) {
      return this.sendPermissionCard(message.address.chatId, text, message.inlineButtons);
    }

    return this.sendMarkdown(message.address.chatId, text);
  }

  validateConfig(): string | null {
    const enabled = getSetting('bridge_wecom_enabled');
    if (enabled !== 'true') return 'bridge_wecom_enabled is not true';

    const botId = getSetting('bridge_wecom_bot_id');
    if (!botId) return 'bridge_wecom_bot_id not configured';

    const secret = getSetting('bridge_wecom_secret');
    if (!secret) return 'bridge_wecom_secret not configured';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const allowedUsers = getSetting('bridge_wecom_allowed_users') || '';
    if (!allowedUsers) return true;

    const allowed = allowedUsers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowed.length === 0) return true;
    return allowed.includes(userId) || allowed.includes(chatId);
  }

  onMessageStart(chatId: string): void {
    void this.send({
      address: {
        channelType: this.channelType,
        chatId,
      },
      text: WECOM_PROCESSING_STARTED_TEXT,
      parseMode: 'plain',
    }).then((result) => {
      if (!result.ok) {
        console.warn('[wecom-adapter] Processing-start feedback failed:', result.error || 'Send failed');
      }
    }).catch((err) => {
      console.warn('[wecom-adapter] Processing-start feedback errored:', err instanceof Error ? err.message : err);
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

  private bindClientHandlers(client: WSClient): void {
    client.on('connected', () => {
      console.log('[wecom-adapter] WebSocket connected');
    });
    client.on('authenticated', () => {
      console.log('[wecom-adapter] WebSocket authenticated');
    });
    client.on('disconnected', (reason) => {
      console.log('[wecom-adapter] WebSocket disconnected:', reason);
    });
    client.on('reconnecting', (attempt) => {
      console.log('[wecom-adapter] WebSocket reconnecting, attempt:', attempt);
    });
    client.on('error', (error) => {
      console.error('[wecom-adapter] WebSocket error:', error.message);
    });

    client.on('message.text', (frame) => {
      this.handleTextMessage(frame).catch(err => this.logHandlerError('message.text', err));
    });
    client.on('message.image', (frame) => {
      this.handleImageMessage(frame).catch(err => this.logHandlerError('message.image', err));
    });
    client.on('message.file', (frame) => {
      this.handleFileMessage(frame).catch(err => this.logHandlerError('message.file', err));
    });
    client.on('message.mixed', (frame) => {
      this.handleMixedMessage(frame).catch(err => this.logHandlerError('message.mixed', err));
    });
    client.on('message.voice', (frame) => {
      this.handleVoiceMessage(frame).catch(err => this.logHandlerError('message.voice', err));
    });
    client.on('event', (frame) => {
      this.handleEventFrame(frame).catch(err => this.logHandlerError('event', err));
    });
  }

  private async handleEventFrame(frame: WsFrame<{ event?: { eventtype?: string; event_key?: string; task_id?: string; template_card_event?: { event_key?: string; task_id?: string } } }>): Promise<void> {
    if (!isWecomTemplateCardEvent(frame.body)) return;
    await this.handleTemplateCardEvent(frame as WsFrame<EventMessageWith<TemplateCardEventData>>);
  }

  private async connectAndWait(client: WSClient): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('WeCom authentication timeout'));
      }, 10_000);

      const cleanup = () => {
        clearTimeout(timeout);
        client.off('authenticated', handleAuthenticated);
        client.off('error', handleError);
      };

      const handleAuthenticated = () => {
        cleanup();
        resolve();
      };

      const handleError = (error: Error) => {
        cleanup();
        reject(error);
      };

      client.once('authenticated', handleAuthenticated);
      client.once('error', handleError);
      client.connect();
    });
  }

  private logHandlerError(label: string, err: unknown): void {
    console.error(
      `[wecom-adapter] ${label} handler error:`,
      err instanceof Error ? err.stack || err.message : err,
    );
  }

  private async sendMarkdown(chatId: string, text: string): Promise<SendResult> {
    try {
      const res = await this.wsClient!.sendMessage(chatId, buildMarkdownMessage(text));
      return { ok: true, messageId: this.extractOutboundMessageId(res) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  private async sendPermissionCard(
    chatId: string,
    text: string,
    inlineButtons: import('../types').InlineButton[][],
  ): Promise<SendResult> {
    let explanationMessageId: string | undefined;

    if (text.trim()) {
      const explanation = await this.sendMarkdown(chatId, text);
      if (!explanation.ok) return explanation;
      explanationMessageId = explanation.messageId;
    }

    try {
      const res = await this.wsClient!.sendMessage(chatId, buildPermissionCard(inlineButtons));
      return {
        ok: true,
        messageId: this.extractOutboundMessageId(res) || explanationMessageId,
      };
    } catch (err) {
      console.warn('[wecom-adapter] Permission card send failed, falling back to /perm text:', err);
      const fallbackText = buildPermissionCommandText(
        explanationMessageId ? '' : text,
        inlineButtons,
      );
      const fallback = await this.sendMarkdown(chatId, fallbackText);
      if (fallback.ok && !fallback.messageId) {
        fallback.messageId = explanationMessageId;
      }
      return fallback;
    }
  }

  private extractOutboundMessageId(frame?: WsFrame): string | undefined {
    return frame?.headers?.req_id;
  }

  private async handleTextMessage(frame: WsFrame<TextMessage>): Promise<void> {
    const body = frame.body;
    if (!body) return;
    await this.enqueueStandardMessage(body, body.text?.content || '', undefined, frame);
  }

  private async handleVoiceMessage(frame: WsFrame<VoiceMessage>): Promise<void> {
    const body = frame.body;
    if (!body) return;
    await this.enqueueStandardMessage(body, body.voice?.content || '', undefined, frame);
  }

  private async handleImageMessage(frame: WsFrame<ImageMessage>): Promise<void> {
    const body = frame.body;
    if (!body) return;

    const attachment = body.image?.url
      ? await this.downloadAttachment(body.image.url, body.image.aeskey, `image-${body.msgid}.png`, 'image/png')
      : null;

    await this.enqueueStandardMessage(
      body,
      attachment ? '' : '[image download failed]',
      attachment ? [attachment] : undefined,
      frame,
    );
  }

  private async handleFileMessage(frame: WsFrame<FileMessage>): Promise<void> {
    const body = frame.body;
    if (!body) return;

    const attachment = body.file?.url
      ? await this.downloadAttachment(body.file.url, body.file.aeskey, `file-${body.msgid}.bin`, 'application/octet-stream')
      : null;

    await this.enqueueStandardMessage(
      body,
      attachment ? '' : '[file download failed]',
      attachment ? [attachment] : undefined,
      frame,
    );
  }

  private async handleMixedMessage(frame: WsFrame<MixedMessage>): Promise<void> {
    const body = frame.body;
    if (!body) return;

    const textParts: string[] = [];
    const attachments: FileAttachment[] = [];

    for (const item of body.mixed?.msg_item || []) {
      if (item.msgtype === 'text' && item.text?.content) {
        textParts.push(item.text.content);
        continue;
      }

      if (item.msgtype === 'image' && item.image?.url) {
        const attachment = await this.downloadAttachment(
          item.image.url,
          item.image.aeskey,
          `mixed-image-${body.msgid}-${attachments.length + 1}.png`,
          'image/png',
        );
        if (attachment) {
          attachments.push(attachment);
        } else {
          textParts.push('[image download failed]');
        }
      }
    }

    await this.enqueueStandardMessage(
      body,
      textParts.join('\n').trim(),
      attachments.length > 0 ? attachments : undefined,
      frame,
    );
  }

  private async handleTemplateCardEvent(
    frame: WsFrame<EventMessageWith<TemplateCardEventData>>,
  ): Promise<void> {
    const body = frame.body;
    const callbackData = extractWecomTemplateCardCallbackData(body);
    if (!body || !callbackData) {
      console.warn('[wecom-adapter] Ignoring template card event without callback data:', JSON.stringify(body));
      return;
    }

    const userId = body.from?.userid || '';
    const chatId = body.chatid || userId;
    if (!chatId) return;

    if (!this.shouldAcceptInbound(body.msgid, userId, chatId, body.chattype === 'group')) {
      return;
    }

    const inbound: InboundMessage = {
      messageId: body.msgid,
      address: {
        channelType: 'wecom',
        chatId,
        userId,
      },
      text: callbackData,
      timestamp: body.create_time || Date.now(),
      callbackData,
      raw: frame,
    };

    this.auditInbound(chatId, body.msgid, `[callback] ${callbackData}`);
    this.enqueue(inbound);
  }

  private async enqueueStandardMessage(
    body: TextMessage | VoiceMessage | ImageMessage | FileMessage | MixedMessage,
    text: string,
    attachments: FileAttachment[] | undefined,
    raw: unknown,
  ): Promise<void> {
    const userId = body.from?.userid || '';
    const chatId = body.chatid || userId;
    if (!chatId) return;

    if (!this.shouldAcceptInbound(body.msgid, userId, chatId, body.chattype === 'group')) {
      return;
    }

    const trimmedText = text.trim();
    if (!trimmedText && (!attachments || attachments.length === 0)) return;

    const inbound: InboundMessage = {
      messageId: body.msgid,
      address: {
        channelType: 'wecom',
        chatId,
        userId,
      },
      text: trimmedText,
      timestamp: body.create_time || Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      raw,
    };

    const summary = attachments && attachments.length > 0
      ? `[${attachments.length} attachment(s)] ${trimmedText.slice(0, 150)}`
      : trimmedText.slice(0, 200);
    this.auditInbound(chatId, body.msgid, summary);
    this.enqueue(inbound);
  }

  private shouldAcceptInbound(
    messageId: string,
    userId: string,
    chatId: string,
    isGroup: boolean,
  ): boolean {
    if (this.seenMessageIds.has(messageId)) return false;
    this.addToDedup(messageId);

    if (!this.isAuthorized(userId, chatId)) {
      console.warn('[wecom-adapter] Unauthorized message from userId:', userId, 'chatId:', chatId);
      return false;
    }

    if (!isGroup) return true;

    const policy = getSetting('bridge_wecom_group_policy') || 'open';
    if (policy === 'disabled') {
      console.log('[wecom-adapter] Group message ignored (policy=disabled), chatId:', chatId);
      return false;
    }

    if (policy === 'allowlist') {
      const allowedGroups = (getSetting('bridge_wecom_group_allow_from') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!allowedGroups.includes(chatId)) {
        console.log('[wecom-adapter] Group message ignored (not in allowlist), chatId:', chatId);
        return false;
      }
    }

    return true;
  }

  private addToDedup(messageId: string): void {
    this.seenMessageIds.set(messageId, true);
    if (this.seenMessageIds.size <= DEDUP_MAX) return;

    const oldest = this.seenMessageIds.keys().next().value;
    if (oldest) this.seenMessageIds.delete(oldest);
  }

  private auditInbound(chatId: string, messageId: string, summary: string): void {
    try {
      insertAuditLog({
        channelType: 'wecom',
        chatId,
        direction: 'inbound',
        messageId,
        summary,
      });
    } catch {
      // best effort
    }
  }

  private async downloadAttachment(
    url: string,
    aesKey: string | undefined,
    fallbackName: string,
    fallbackMime: string,
  ): Promise<FileAttachment | null> {
    if (!this.wsClient) return null;

    try {
      const { buffer, filename } = await this.wsClient.downloadFile(url, aesKey);
      if (!buffer || buffer.length === 0 || buffer.length > MAX_FILE_SIZE) {
        return null;
      }

      const name = filename || fallbackName;
      return {
        id: crypto.randomUUID(),
        name,
        type: this.guessMimeType(name, fallbackMime),
        size: buffer.length,
        data: buffer.toString('base64'),
      };
    } catch (err) {
      console.warn('[wecom-adapter] download failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private guessMimeType(filename: string, fallback: string): string {
    const ext = path.extname(filename).toLowerCase();
    return MIME_BY_EXTENSION[ext] || fallback;
  }
}

registerAdapterFactory('wecom', () => new WecomAdapter());