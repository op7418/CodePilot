/**
 * Feishu Card Streaming Controller
 *
 * Manages streaming card lifecycle via CardKit v2 API.
 * State machine: idle → creating → streaming → completed | interrupted | error
 *
 * Features:
 * - Thinking state display (💭 Thinking...)
 * - Streaming text with throttled updates
 * - Tool call progress indicators (🔄/✅/❌)
 * - Final card with status footer and elapsed time
 * - Markdown optimization for Feishu rendering
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import type { CardStreamController, ToolCallInfo } from '../types';
import type { CardStreamConfig } from './types';
import { optimizeMarkdown } from './outbound';

/** Extract error message from unknown catch value */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Lark IM message response shape (shared by create/reply) */
interface LarkMessageResponse {
  code?: number;
  msg?: string;
  data?: { message_id?: string };
}

/** CardKit v2 API shape (not in SDK types — accessed via runtime) */
interface CardKitV2 {
  card: {
    create(payload: { data: { type: string; data: string } }): Promise<{ data?: { card_id?: string } }>;
    streamContent(payload: { path: { card_id: string }; data: { content: string; sequence: number } }): Promise<unknown>;
    setStreamingMode(payload: { path: { card_id: string }; data: { streaming_mode: boolean; sequence: number } }): Promise<unknown>;
    update(payload: { path: { card_id: string }; data: { type: string; data: string; sequence: number } }): Promise<unknown>;
  };
}

/** Card element in Schema V2 cards */
interface CardElement {
  tag: string;
  content?: string;
  text_size?: string;
  text_align?: string;
  element_id?: string;
  [key: string]: unknown;
}

/** Access cardkit.v2 from lark.Client (not typed in SDK) */
function getCardKitV2(client: lark.Client): CardKitV2 {
  return (client as unknown as { cardkit: { v2: CardKitV2 } }).cardkit.v2;
}

const LOG_TAG = '[card-controller]';

interface CardState {
  cardId: string;
  messageId: string;
  sequence: number;
  lastUpdateAt: number;
  startTime: number;
  throttleTimer: ReturnType<typeof setTimeout> | null;
  pendingText: string | null;
  /** Current tool calls being tracked */
  toolCalls: ToolCallInfo[];
  /** Whether we're in thinking state (before text starts flowing) */
  thinking: boolean;
}

/** Format elapsed time for footer display */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m ${remSec}s`;
}

/** Build tool progress lines for card display */
function buildToolProgressMarkdown(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map((tc) => {
    const icon = tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
    return `${icon} \`${tc.name}\``;
  });
  return lines.join('\n');
}

class FeishuCardStreamController implements CardStreamController {
  private client: lark.Client;
  private config: CardStreamConfig;
  private cards = new Map<string, CardState>();

  constructor(client: lark.Client, config: CardStreamConfig) {
    this.client = client;
    this.config = config;
  }

  async create(chatId: string, initialText: string, replyToMessageId?: string): Promise<string> {
    try {
      // 1. Create streaming card via CardKit v2
      const cardBody = {
        schema: '2.0',
        config: {
          streaming_mode: true,
          wide_screen_mode: true,
          summary: { content: '思考中...' },
        },
        body: {
          elements: [{
            tag: 'markdown',
            content: initialText || '💭 Thinking...',
            text_align: 'left',
            text_size: 'normal',
            element_id: 'streaming_content',
          }],
        },
      };

      const createResp = await getCardKitV2(this.client).card.create({
        data: { type: 'card_json', data: JSON.stringify(cardBody) },
      });
      const cardId = createResp?.data?.card_id;
      if (!cardId) {
        console.error(LOG_TAG, 'Card create returned no card_id');
        return '';
      }

      // 2. Send card as IM message
      const cardContent = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      let msgResp: LarkMessageResponse;
      if (replyToMessageId) {
        msgResp = await this.client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardContent, msg_type: 'interactive' },
        });
      } else {
        msgResp = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, content: cardContent, msg_type: 'interactive' },
        });
      }
      const messageId = msgResp?.data?.message_id || '';

      this.cards.set(messageId, {
        cardId,
        messageId,
        sequence: 0,
        lastUpdateAt: Date.now(),
        startTime: Date.now(),
        throttleTimer: null,
        pendingText: null,
        toolCalls: [],
        thinking: !initialText,
      });

      return messageId;
    } catch (err: unknown) {
      console.error(LOG_TAG, 'Card create failed:', errMsg(err));
      return '';
    }
  }

  async update(messageId: string, text: string): Promise<'ok' | 'fail'> {
    const state = this.cards.get(messageId);
    if (!state) return 'fail';

    // Clear thinking state once text starts flowing
    if (state.thinking && text.trim()) {
      state.thinking = false;
    }

    state.pendingText = text;

    const elapsed = Date.now() - state.lastUpdateAt;
    if (elapsed < this.config.throttleMs) {
      // Schedule trailing-edge flush
      if (!state.throttleTimer) {
        state.throttleTimer = setTimeout(() => {
          state.throttleTimer = null;
          if (state.pendingText) {
            this.flushUpdate(state).catch(() => {});
          }
        }, this.config.throttleMs - elapsed);
      }
      return 'ok';
    }

    return this.flushUpdate(state);
  }

  private async flushUpdate(state: CardState): Promise<'ok' | 'fail'> {
    if (!state.pendingText && state.toolCalls.length === 0) return 'ok';

    // Build content: main text + tool progress
    let content = state.pendingText || '';
    const toolMd = buildToolProgressMarkdown(state.toolCalls);
    if (toolMd) {
      content = content ? `${content}\n\n${toolMd}` : toolMd;
    }
    state.pendingText = null;

    try {
      state.sequence++;
      await getCardKitV2(this.client).card.streamContent({
        path: { card_id: state.cardId },
        data: { content, sequence: state.sequence },
      });
      state.lastUpdateAt = Date.now();
      return 'ok';
    } catch (err: unknown) {
      console.error(LOG_TAG, 'Stream update failed:', errMsg(err));
      return 'fail';
    }
  }

  /** Update tool call progress — triggers a card update */
  updateToolCalls(messageId: string, tools: ToolCallInfo[]): void {
    const state = this.cards.get(messageId);
    if (!state) return;
    state.toolCalls = tools;

    // Force a flush with current text + updated tool progress
    const elapsed = Date.now() - state.lastUpdateAt;
    if (elapsed >= this.config.throttleMs) {
      this.flushUpdate(state).catch(() => {});
    } else if (!state.throttleTimer) {
      state.throttleTimer = setTimeout(() => {
        state.throttleTimer = null;
        this.flushUpdate(state).catch(() => {});
      }, this.config.throttleMs - elapsed);
    }
  }

  /** Set thinking state — shows 💭 Thinking... in card */
  setThinking(messageId: string): void {
    const state = this.cards.get(messageId);
    if (!state) return;
    state.thinking = true;
  }

  async finalize(
    messageId: string,
    finalText: string,
    status: 'completed' | 'interrupted' | 'error' = 'completed',
  ): Promise<void> {
    const state = this.cards.get(messageId);
    if (!state) return;

    // Clear any pending throttle
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }

    try {
      // Close streaming mode
      state.sequence++;
      await getCardKitV2(this.client).card.setStreamingMode({
        path: { card_id: state.cardId },
        data: { streaming_mode: false, sequence: state.sequence },
      });

      // Build final card elements
      const elements: CardElement[] = [];

      // Main content (optimize markdown for Feishu rendering)
      elements.push({
        tag: 'markdown',
        content: optimizeMarkdown(finalText),
        text_size: 'normal',
        element_id: 'streaming_content',
      });

      // Tool call summary (if any tools were used)
      if (state.toolCalls.length > 0) {
        const toolMd = buildToolProgressMarkdown(state.toolCalls);
        if (toolMd) {
          elements.push({
            tag: 'markdown',
            content: toolMd,
            text_size: 'notation',
            element_id: 'tool_summary',
          });
        }
      }

      // Footer
      const footerCfg = this.config.footer;
      const footerParts: string[] = [];

      if (footerCfg?.status) {
        const statusLabels: Record<string, string> = {
          completed: '✅ Completed',
          interrupted: '⚠️ Interrupted',
          error: '❌ Error',
        };
        footerParts.push(statusLabels[status] || status);
      }

      if (footerCfg?.elapsed) {
        const elapsedMs = Date.now() - state.startTime;
        footerParts.push(formatElapsed(elapsedMs));
      }

      if (footerParts.length > 0) {
        elements.push({ tag: 'hr' });
        elements.push({
          tag: 'markdown',
          content: footerParts.join(' · '),
          text_size: 'notation',
          element_id: 'footer',
        });
      }

      // Update final card
      const finalCard = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        body: { elements },
      };

      state.sequence++;
      await getCardKitV2(this.client).card.update({
        path: { card_id: state.cardId },
        data: { type: 'card_json', data: JSON.stringify(finalCard), sequence: state.sequence },
      });
    } catch (err: unknown) {
      console.error(LOG_TAG, 'Finalize failed:', errMsg(err));
    }

    this.cards.delete(messageId);
  }
}

/**
 * Factory function for creating a card stream controller.
 */
export function createCardStreamController(
  client: lark.Client,
  config: CardStreamConfig,
): CardStreamController {
  return new FeishuCardStreamController(client, config);
}
