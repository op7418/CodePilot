/**
 * Feishu inbound message processing.
 *
 * Converts raw Feishu event data into InboundMessage for the bridge queue.
 */

import type { InboundMessage } from '../../bridge/types';
import type { FeishuConfig } from './types';

const LOG_TAG = '[feishu/inbound]';

/** Find the bot's mention entry in the Feishu mentions array, if present. */
function findBotMention(
  mentions: any[] | undefined,
  botOpenId: string,
): { key?: string } | undefined {
  if (!mentions || !botOpenId) return undefined;
  return mentions.find((m: any) => m?.id?.open_id === botOpenId);
}

/** Parse a raw Feishu im.message.receive_v1 event into an InboundMessage. */
export function parseInboundMessage(
  eventData: any,
  config: FeishuConfig,
  botOpenId?: string,
): InboundMessage | null {
  try {
    const event = eventData?.event ?? eventData;
    const message = event?.message;
    if (!message) return null;

    const chatId = message.chat_id || '';
    const messageId = message.message_id || '';
    const sender = event.sender?.sender_id?.open_id || '';
    const msgType = message.message_type;

    const isGroupChat = chatId.startsWith('oc_');
    const botMention = isGroupChat && botOpenId
      ? findBotMention(message.mentions, botOpenId)
      : undefined;

    // When requireMention is enabled, drop group messages that don't @mention the bot.
    if (isGroupChat && config.requireMention && !botMention) {
      return null;
    }

    let text = '';
    if (msgType === 'text') {
      try {
        const content = JSON.parse(message.content || '{}');
        text = content.text || '';
      } catch {
        text = message.content || '';
      }
    } else {
      return null;
    }

    if (!text.trim()) return null;

    // Strip the @bot placeholder so the LLM sees clean input.
    if (botMention?.key) {
      text = text.replaceAll(botMention.key, '').trim();
    }

    const rootId = message.root_id || '';
    const effectiveChatId = rootId ? `${chatId}:thread:${rootId}` : chatId;

    return {
      messageId,
      address: {
        channelType: 'feishu',
        chatId: effectiveChatId,
        userId: sender,
      },
      text: text.trim(),
      timestamp: parseInt(message.create_time, 10) || Date.now(),
    };
  } catch (err) {
    console.error(LOG_TAG, 'Failed to parse inbound message:', err);
    return null;
  }
}
