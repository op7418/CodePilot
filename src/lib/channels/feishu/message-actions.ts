/**
 * Feishu message-actions — readMessages, readThreadMessages, and searchMessagesLocal.
 *
 * These functions are dynamically imported by bridge-manager for /history and /search commands.
 *
 * Identity note: All functions here use bot identity (app_access_token) via the
 * Lark SDK client. OpenClaw's equivalent (feishu_im_user_*) uses user_access_token
 * for richer results and broader access.
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import type { MessageListResult, FeishuMessageItem } from './types';

/** Extract error message from unknown catch value */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Shape of a single message item from Lark IM list API */
interface LarkMessageItem {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  msg_type?: string;
  create_time?: string;
  update_time?: string;
  body?: { content: string };
  sender?: {
    id: string;
    id_type: string;
    sender_type: string;
    tenant_key?: string;
  };
}

interface ReadOptions {
  pageSize?: number;
  pageToken?: string;
}

interface SearchOptions {
  pageSize?: number;
  pageToken?: string;
}

/**
 * Read recent messages from a Feishu chat using bot identity (app_access_token).
 *
 * OpenClaw's equivalent (feishu_im_user_get_chat_messages) uses user_access_token
 * for richer results including messages from all participants.
 */
export async function readMessages(
  client: lark.Client,
  chatId: string,
  options: ReadOptions = {},
): Promise<MessageListResult> {
  const { pageSize = 10, pageToken } = options;

  try {
    const resp = await client.im.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        page_size: pageSize,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });

    const items: FeishuMessageItem[] = (resp?.data?.items || []).map((item: LarkMessageItem) => ({
      messageId: item.message_id || '',
      rootId: item.root_id || undefined,
      parentId: item.parent_id || undefined,
      msgType: item.msg_type || '',
      createTime: item.create_time || '',
      updateTime: item.update_time || undefined,
      content: item.body?.content || '',
      sender: {
        id: item.sender?.id || '',
        idType: item.sender?.id_type || '',
        senderType: item.sender?.sender_type || '',
        tenantKey: item.sender?.tenant_key || undefined,
      },
    }));

    return {
      items,
      hasMore: resp?.data?.has_more || false,
      pageToken: resp?.data?.page_token || undefined,
    };
  } catch (err: unknown) {
    console.error('[feishu/message-actions] readMessages failed:', errMsg(err));
    return { items: [], hasMore: false };
  }
}

/**
 * Read messages from a Feishu thread (reply chain).
 *
 * Uses `container_id_type: 'thread'` to fetch all messages in a specific thread.
 * OpenClaw's equivalent is feishu_im_user_get_thread_messages.
 */
export async function readThreadMessages(
  client: lark.Client,
  threadId: string,
  options: ReadOptions = {},
): Promise<MessageListResult> {
  const { pageSize = 10, pageToken } = options;

  try {
    const resp = await client.im.message.list({
      params: {
        container_id_type: 'thread',
        container_id: threadId,
        page_size: pageSize,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });

    const items: FeishuMessageItem[] = (resp?.data?.items || []).map((item: LarkMessageItem) => ({
      messageId: item.message_id || '',
      rootId: item.root_id || undefined,
      parentId: item.parent_id || undefined,
      msgType: item.msg_type || '',
      createTime: item.create_time || '',
      updateTime: item.update_time || undefined,
      content: item.body?.content || '',
      sender: {
        id: item.sender?.id || '',
        idType: item.sender?.id_type || '',
        senderType: item.sender?.sender_type || '',
        tenantKey: item.sender?.tenant_key || undefined,
      },
    }));

    return {
      items,
      hasMore: resp?.data?.has_more || false,
      pageToken: resp?.data?.page_token || undefined,
    };
  } catch (err: unknown) {
    console.error('[feishu/message-actions] readThreadMessages failed:', errMsg(err));
    return { items: [], hasMore: false };
  }
}

/**
 * Simplified local search — lists recent messages and filters client-side.
 *
 * Unlike OpenClaw's feishu_im_user_search_messages which uses the search.message.create
 * API with user_access_token for true cross-chat server-side search, this function
 * only fetches recent messages from a single chat and applies a client-side keyword filter.
 * Results are limited and pagination is not reliable.
 */
export async function searchMessagesLocal(
  client: lark.Client,
  chatId: string,
  query: string,
  options: SearchOptions = {},
): Promise<MessageListResult> {
  const { pageSize = 10, pageToken } = options;

  try {
    // Use im.message.list and filter client-side.
    // True server-side search requires user_access_token (search.message.create API).
    const resp = await client.im.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        page_size: Math.min(pageSize * 5, 50), // fetch more to filter
        sort_type: 'ByCreateTimeDesc',
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });

    const allItems: FeishuMessageItem[] = (resp?.data?.items || []).map((item: LarkMessageItem) => ({
      messageId: item.message_id || '',
      rootId: item.root_id || undefined,
      parentId: item.parent_id || undefined,
      msgType: item.msg_type || '',
      createTime: item.create_time || '',
      updateTime: item.update_time || undefined,
      content: item.body?.content || '',
      sender: {
        id: item.sender?.id || '',
        idType: item.sender?.id_type || '',
        senderType: item.sender?.sender_type || '',
        tenantKey: item.sender?.tenant_key || undefined,
      },
    }));

    // Client-side keyword filter
    const lowerQuery = query.toLowerCase();
    const filtered = allItems.filter(item => {
      try {
        const parsed = JSON.parse(item.content);
        return (parsed.text || '').toLowerCase().includes(lowerQuery);
      } catch {
        return item.content.toLowerCase().includes(lowerQuery);
      }
    }).slice(0, pageSize);

    return {
      items: filtered,
      hasMore: false, // can't paginate client-side filter reliably
    };
  } catch (err: unknown) {
    console.error('[feishu/message-actions] searchMessagesLocal failed:', errMsg(err));
    return { items: [], hasMore: false };
  }
}

/** Backward-compatible alias for searchMessagesLocal. */
export const searchMessages = searchMessagesLocal;
