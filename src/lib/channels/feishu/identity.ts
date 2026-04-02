/**
 * Feishu bot identity resolution.
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuBotInfo } from './types';

const LOG_TAG = '[feishu/identity]';

/** Bot info API response shape (not typed in SDK) */
interface BotInfoResponse {
  data?: {
    bot?: {
      app_id?: string;
      app_name?: string;
      open_id?: string;
    };
  };
}

/** Access bot.v3.botInfo from lark.Client (not typed in SDK) */
function getBotInfoApi(client: lark.Client): { list(): Promise<BotInfoResponse> } {
  return (client as unknown as { bot: { v3: { botInfo: { list(): Promise<BotInfoResponse> } } } }).bot.v3.botInfo;
}

/** Fetch bot info from Feishu API. */
export async function getBotInfo(client: lark.Client): Promise<FeishuBotInfo | null> {
  try {
    const resp = await getBotInfoApi(client).list();
    const bot = resp?.data?.bot;
    if (!bot) return null;
    return {
      appId: bot.app_id || '',
      botName: bot.app_name || '',
      openId: bot.open_id || '',
    };
  } catch (err) {
    console.error(LOG_TAG, 'Failed to get bot info:', err);
    return null;
  }
}
