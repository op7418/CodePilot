/**
 * Telegram Bot notification module for CodePilot.
 *
 * Sends task status notifications (start, complete, error, permission requests)
 * to a configured Telegram chat. Optionally listens for /status commands
 * via long polling.
 *
 * Configuration is stored in the SQLite settings table:
 *   - telegram_bot_token: Bot API token from @BotFather
 *   - telegram_chat_id:   Target chat/group/channel ID
 *   - telegram_enabled:   'true' | '' (empty = disabled)
 *   - telegram_notify_start:      'true' | '' — notify on session start
 *   - telegram_notify_complete:   'true' | '' — notify on session complete
 *   - telegram_notify_error:      'true' | '' — notify on errors
 *   - telegram_notify_permission: 'true' | '' — notify on permission requests
 */

import { getSetting, getActiveSessions, getAllSessions } from './db';
import {
  callTelegramApi,
  escapeHtml,
  splitMessage,
  formatSessionHeader,
} from './bridge/adapters/telegram-utils';

// ── Types ──────────────────────────────────────────────────────

interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
  notifyStart: boolean;
  notifyComplete: boolean;
  notifyError: boolean;
  notifyPermission: boolean;
}

interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

interface TelegramBotInfo {
  ok: boolean;
  result?: TelegramUser;
  description?: string;
}

export interface TelegramNotifyOptions {
  sessionId?: string;
  sessionTitle?: string;
  workingDirectory?: string;
}

// ── Constants ──────────────────────────────────────────────────

const TELEGRAM_API = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4000; // Telegram limit is 4096, leave buffer

// ── Bridge Mode Guard ─────────────────────────────────────────

/**
 * When the bridge adapter is active, the notification bot's polling
 * must be suppressed to avoid conflicts (both would consume updates).
 *
 * Stored on globalThis so the flag survives Next.js HMR in development.
 * Without this, a hot-reload resets the flag to false and the notification
 * bot restarts polling, stealing updates from the bridge adapter.
 */
const BRIDGE_MODE_KEY = '__telegram_bridge_mode_active__';

function isBridgeModeActive(): boolean {
  return !!(globalThis as unknown as Record<string, boolean>)[BRIDGE_MODE_KEY];
}

export function setBridgeModeActive(active: boolean): void {
  (globalThis as unknown as Record<string, boolean>)[BRIDGE_MODE_KEY] = active;
  if (active) {
    stopPolling();
  }
}

// ── Config ─────────────────────────────────────────────────────

export function getTelegramConfig(): TelegramConfig {
  return {
    botToken: getSetting('telegram_bot_token') || '',
    chatId: getSetting('telegram_chat_id') || '',
    enabled: getSetting('telegram_enabled') === 'true',
    notifyStart: getSetting('telegram_notify_start') === 'true',
    notifyComplete: getSetting('telegram_notify_complete') === 'true',
    notifyError: getSetting('telegram_notify_error') === 'true',
    notifyPermission: getSetting('telegram_notify_permission') === 'true',
  };
}

function isConfigured(): boolean {
  const config = getTelegramConfig();
  return config.enabled && !!config.botToken && !!config.chatId;
}

/**
 * Ensure the long-polling loop is started if Telegram is configured.
 * Called lazily on the first notification attempt.
 */
let pollingInitialized = false;
function ensurePollingStarted(): void {
  if (pollingInitialized || isBridgeModeActive()) return;
  pollingInitialized = true;
  if (isConfigured()) {
    startPolling();
  }
}

// ── Core API ───────────────────────────────────────────────────

/**
 * Send a message to the configured Telegram chat.
 * Automatically splits messages that exceed the Telegram limit.
 */
async function sendMessage(text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<{ ok: boolean; error?: string }> {
  const config = getTelegramConfig();
  if (!config.enabled || !config.botToken || !config.chatId) {
    return { ok: false, error: 'Telegram not configured' };
  }

  // Lazily start the command listener on first outgoing message
  ensurePollingStarted();

  const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
  for (const chunk of chunks) {
    const result = await callTelegramApi(config.botToken, 'sendMessage', {
      chat_id: config.chatId,
      text: chunk,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    });
    if (!result.ok) return result;
  }
  return { ok: true };
}

// ── Public Notification Functions ──────────────────────────────

/**
 * Notify that a session has started processing.
 */
export async function notifySessionStart(opts?: TelegramNotifyOptions): Promise<void> {
  const config = getTelegramConfig();
  if (!config.enabled || !config.notifyStart) return;

  const header = formatSessionHeader(opts);
  const msg = `▶️ <b>Task Started</b>\n${header}`.trim();

  const result = await sendMessage(msg);
  if (!result.ok) {
    console.warn('[telegram] Failed to send start notification:', result.error);
  }
}

/**
 * Notify that a session has completed successfully.
 */
export async function notifySessionComplete(
  summary?: string,
  opts?: TelegramNotifyOptions,
): Promise<void> {
  const config = getTelegramConfig();
  if (!config.enabled || !config.notifyComplete) return;

  const header = formatSessionHeader(opts);
  let msg = `✅ <b>Task Completed</b>\n${header}`.trim();
  if (summary) {
    const truncated = summary.length > 500
      ? summary.slice(0, 500) + '...'
      : summary;
    msg += `\n\n${escapeHtml(truncated)}`;
  }

  const result = await sendMessage(msg);
  if (!result.ok) {
    console.warn('[telegram] Failed to send completion notification:', result.error);
  }
}

/**
 * Notify that an error occurred during a session.
 */
export async function notifySessionError(
  errorMessage: string,
  opts?: TelegramNotifyOptions,
): Promise<void> {
  const config = getTelegramConfig();
  if (!config.enabled || !config.notifyError) return;

  const header = formatSessionHeader(opts);
  const truncatedError = errorMessage.length > 500
    ? errorMessage.slice(0, 500) + '...'
    : errorMessage;
  const msg = `❌ <b>Task Error</b>\n${header}\n\n<pre>${escapeHtml(truncatedError)}</pre>`.trim();

  const result = await sendMessage(msg);
  if (!result.ok) {
    console.warn('[telegram] Failed to send error notification:', result.error);
  }
}

/**
 * Notify that a permission request is pending.
 */
export async function notifyPermissionRequest(
  toolName: string,
  toolInput: Record<string, unknown>,
  opts?: TelegramNotifyOptions,
): Promise<void> {
  const config = getTelegramConfig();
  if (!config.enabled || !config.notifyPermission) return;

  const header = formatSessionHeader(opts);
  const inputStr = JSON.stringify(toolInput, null, 2);
  const truncatedInput = inputStr.length > 300
    ? inputStr.slice(0, 300) + '...'
    : inputStr;

  const msg = [
    `🔐 <b>Permission Required</b>`,
    header,
    ``,
    `Tool: <code>${escapeHtml(toolName)}</code>`,
    `<pre>${escapeHtml(truncatedInput)}</pre>`,
    ``,
    `⚠️ Please approve or deny in CodePilot.`,
  ].filter(Boolean).join('\n');

  const result = await sendMessage(msg);
  if (!result.ok) {
    console.warn('[telegram] Failed to send permission notification:', result.error);
  }
}

/**
 * Send a generic SDK notification (from Notification hook).
 */
export async function notifyGeneric(
  title: string,
  message: string,
  opts?: TelegramNotifyOptions,
): Promise<void> {
  if (!isConfigured()) return;

  const header = formatSessionHeader(opts);
  const msg = [
    `📢 <b>${escapeHtml(title)}</b>`,
    header,
    message ? `\n${escapeHtml(message)}` : '',
  ].filter(Boolean).join('\n');

  const result = await sendMessage(msg);
  if (!result.ok) {
    console.warn('[telegram] Failed to send notification:', result.error);
  }
}

// ── Bot Verification ───────────────────────────────────────────

/**
 * Verify a bot token and optionally send a test message.
 * Returns bot info on success.
 */
export async function verifyBot(
  botToken: string,
  chatId?: string,
): Promise<{ ok: boolean; botName?: string; error?: string }> {
  try {
    const url = `${TELEGRAM_API}/bot${botToken}/getMe`;
    const res = await fetch(url);
    const data: TelegramBotInfo = await res.json();

    if (!data.ok || !data.result) {
      return { ok: false, error: data.description || 'Invalid bot token' };
    }

    const botName = data.result.username || data.result.first_name;

    // Send a test message if chat_id provided
    if (chatId) {
      const testResult = await callTelegramApi(botToken, 'sendMessage', {
        chat_id: chatId,
        text: `✅ CodePilot connected successfully!\n\nBot: @${botName}\nNotifications will be sent to this chat.`,
        parse_mode: 'HTML',
      });
      if (!testResult.ok) {
        return { ok: false, botName, error: `Bot verified but cannot send to chat: ${testResult.error}` };
      }
    }

    return { ok: true, botName };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

/**
 * Auto-detect chat ID by reading recent messages sent to the bot.
 * The user should send /start (or any message) to the bot before calling this.
 * Returns the chat ID of the most recent private message sender.
 */
export async function detectChatId(
  botToken: string,
): Promise<{ ok: boolean; chatId?: string; chatTitle?: string; error?: string }> {
  try {
    // Try getUpdates first (works when polling hasn't consumed the message)
    const url = `${TELEGRAM_API}/bot${botToken}/getUpdates`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 100, timeout: 0, allowed_updates: ['message'] }),
    });
    const data = await res.json();

    if (data.ok && Array.isArray(data.result) && data.result.length > 0) {
      // Find the most recent message with a chat id
      for (let i = data.result.length - 1; i >= 0; i--) {
        const update = data.result[i];
        const msg = update.message;
        if (msg?.chat?.id) {
          const chatId = String(msg.chat.id);
          const chatTitle = msg.chat.first_name
            || msg.chat.title
            || msg.chat.username
            || chatId;
          return { ok: true, chatId, chatTitle };
        }
      }
    }

    // Fallback: check chat IDs recorded during polling
    const recentChats = getRecentChats();
    if (recentChats.length > 0) {
      const latest = recentChats[recentChats.length - 1];
      return { ok: true, chatId: latest.chatId, chatTitle: latest.chatTitle };
    }

    return {
      ok: false,
      error: 'No messages found. Please send /start to the bot first, then try again.',
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

// ── Status Query ───────────────────────────────────────────────

/**
 * Build a status summary of current CodePilot sessions.
 * Used by the /status command handler.
 */
export function buildStatusMessage(): string {
  const activeSessions = getActiveSessions();
  const allSessions = getAllSessions();
  const recentSessions = allSessions.slice(0, 5);

  const lines: string[] = [
    `📊 <b>CodePilot Status</b>`,
    ``,
  ];

  if (activeSessions.length === 0) {
    lines.push(`No active tasks running.`);
  } else {
    lines.push(`<b>Active Tasks (${activeSessions.length}):</b>`);
    for (const s of activeSessions) {
      const status = s.runtime_status === 'waiting_permission' ? '🔐 Waiting Permission' : '⚡ Running';
      const title = s.title || 'Untitled';
      const dir = s.working_directory ? ` — <code>${escapeHtml(s.working_directory)}</code>` : '';
      lines.push(`  ${status} ${escapeHtml(title)}${dir}`);
    }
  }

  lines.push(``);
  lines.push(`<b>Recent Sessions:</b>`);
  if (recentSessions.length === 0) {
    lines.push(`  No sessions yet.`);
  } else {
    for (const s of recentSessions) {
      const statusIcon = s.runtime_status === 'running' ? '⚡'
        : s.runtime_status === 'waiting_permission' ? '🔐'
        : '💤';
      const title = s.title || 'Untitled';
      lines.push(`  ${statusIcon} ${escapeHtml(title)}`);
    }
  }

  lines.push(``);
  lines.push(`Total sessions: ${allSessions.length}`);

  return lines.join('\n');
}

// ── Long Polling ───────────────────────────────────────────────

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number; first_name?: string; title?: string; username?: string };
    text?: string;
    from?: TelegramUser;
  };
}

// ── Recently Seen Chats (for auto-detect fallback) ────────────

interface RecentChat {
  chatId: string;
  chatTitle: string;
  timestamp: number;
}

const RECENT_CHATS_KEY = '__telegram_recent_chats__';

function getRecentChats(): RecentChat[] {
  const g = globalThis as unknown as Record<string, RecentChat[]>;
  if (!g[RECENT_CHATS_KEY]) g[RECENT_CHATS_KEY] = [];
  return g[RECENT_CHATS_KEY];
}

function recordRecentChat(chatId: string, chatTitle: string): void {
  const chats = getRecentChats();
  const idx = chats.findIndex(c => c.chatId === chatId);
  if (idx >= 0) chats.splice(idx, 1);
  chats.push({ chatId, chatTitle, timestamp: Date.now() });
  while (chats.length > 10) chats.shift();
}

// Singleton poller state stored on globalThis to survive Next.js HMR
const POLLER_KEY = '__telegram_poller__';

interface PollerState {
  running: boolean;
  abortController: AbortController | null;
  lastOffset: number;
}

function getPollerState(): PollerState {
  const g = globalThis as unknown as Record<string, PollerState>;
  if (!g[POLLER_KEY]) {
    g[POLLER_KEY] = { running: false, abortController: null, lastOffset: 0 };
  }
  return g[POLLER_KEY];
}

/**
 * Start the long-polling loop to listen for incoming Telegram commands.
 * Supports: /status — replies with current CodePilot session status.
 * Only processes messages from the configured chat_id for security.
 *
 * This is idempotent — calling it multiple times won't create duplicate pollers.
 */
export function startPolling(): void {
  if (isBridgeModeActive()) return; // Bridge adapter handles polling
  const state = getPollerState();
  if (state.running) return;

  const config = getTelegramConfig();
  if (!config.enabled || !config.botToken || !config.chatId) return;

  state.running = true;
  state.abortController = new AbortController();

  console.log('[telegram] Starting long-polling for commands');
  pollLoop(config.botToken, config.chatId, state);
}

/**
 * Stop the long-polling loop.
 */
export function stopPolling(): void {
  const state = getPollerState();
  state.running = false;
  state.abortController?.abort();
  state.abortController = null;
  console.log('[telegram] Stopped long-polling');
}

async function pollLoop(botToken: string, chatId: string, state: PollerState): Promise<void> {
  while (state.running) {
    try {
      const url = `${TELEGRAM_API}/bot${botToken}/getUpdates`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offset: state.lastOffset,
          timeout: 30,
          allowed_updates: ['message'],
        }),
        signal: state.abortController?.signal,
      });

      if (!state.running) break;

      const data = await res.json();
      if (!data.ok || !Array.isArray(data.result)) continue;

      for (const update of data.result as TelegramUpdate[]) {
        state.lastOffset = update.update_id + 1;

        const msg = update.message;
        if (!msg || !msg.text) continue;

        // Record chat ID for auto-detect (before security filter)
        const incomingChatId = String(msg.chat.id);
        const incomingChatTitle = msg.chat.first_name
          || msg.chat.title
          || msg.chat.username
          || incomingChatId;
        recordRecentChat(incomingChatId, incomingChatTitle);

        // Security: only respond to messages from the configured chat
        if (incomingChatId !== chatId) continue;

        // Extract command (handle /command@botname format)
        const command = msg.text.trim().split(/[\s@]/)[0].toLowerCase();

        if (command === '/start') {
          await callTelegramApi(botToken, 'sendMessage', {
            chat_id: chatId,
            text: [
              `👋 <b>CodePilot Bot</b>`,
              ``,
              `I'll send you notifications about your CodePilot tasks.`,
              ``,
              `<b>Commands:</b>`,
              `/status — Show current task status`,
              `/help — Show available commands`,
            ].join('\n'),
            parse_mode: 'HTML',
          });
        } else if (command === '/status') {
          const statusMsg = buildStatusMessage();
          await callTelegramApi(botToken, 'sendMessage', {
            chat_id: chatId,
            text: statusMsg,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          });
        } else if (command === '/help') {
          await callTelegramApi(botToken, 'sendMessage', {
            chat_id: chatId,
            text: [
              `<b>CodePilot Bot Commands</b>`,
              ``,
              `/status — Show current task status`,
              `/help — Show this help message`,
            ].join('\n'),
            parse_mode: 'HTML',
          });
        }
      }
    } catch (err) {
      // AbortError is expected when stopping
      if (err instanceof Error && err.name === 'AbortError') break;
      console.warn('[telegram] Polling error:', err instanceof Error ? err.message : err);
      // Back off on errors
      if (state.running) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
}
