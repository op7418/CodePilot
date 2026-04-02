/**
 * Feishu inbound message processing.
 *
 * Converts raw Feishu event data into InboundMessage for the bridge queue.
 */

import type { InboundMessage } from '../../bridge/types';
import type { FeishuConfig } from './types';

const LOG_TAG = '[feishu/inbound]';

/** Shape of a Feishu im.message.receive_v1 event message */
interface FeishuRawMessage {
  chat_id?: string;
  message_id?: string;
  message_type?: string;
  content?: string;
  root_id?: string;
  create_time?: string;
}

/** Shape of a Feishu event (may be wrapped or unwrapped) */
interface FeishuRawEvent {
  event?: {
    message?: FeishuRawMessage;
    sender?: { sender_id?: { open_id?: string } };
  };
  message?: FeishuRawMessage;
  sender?: { sender_id?: { open_id?: string } };
}

/** Parse a raw Feishu im.message.receive_v1 event into an InboundMessage. */
export function parseInboundMessage(
  eventData: unknown,
  _config: FeishuConfig,
): InboundMessage | null {
  try {
    const raw = eventData as FeishuRawEvent;
    const event = raw?.event ?? raw;
    const message = event?.message;
    if (!message) return null;

    const chatId = message.chat_id || '';
    const messageId = message.message_id || '';
    const sender = event.sender?.sender_id?.open_id || '';
    const msgType = message.message_type;

    // Only handle text messages for now
    let text = '';
    if (msgType === 'text') {
      try {
        const content = JSON.parse(message.content || '{}');
        text = content.text || '';
      } catch {
        text = message.content || '';
      }
    } else {
      // Non-text messages — skip silently
      return null;
    }

    if (!text.trim()) return null;

    // Build thread-session address if applicable
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
      timestamp: parseInt(message.create_time || '0', 10) || Date.now(),
    };
  } catch (err) {
    console.error(LOG_TAG, 'Failed to parse inbound message:', err);
    return null;
  }
}
