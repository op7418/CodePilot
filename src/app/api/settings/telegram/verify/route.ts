import { NextRequest, NextResponse } from 'next/server';
import { verifyBot, detectChatId } from '@/lib/telegram-bot';
import { getSetting } from '@/lib/db';
import { callTelegramApi } from '@/lib/bridge/adapters/telegram-utils';

/**
 * POST /api/settings/telegram/verify
 *
 * Actions:
 *   - { action: "verify", bot_token, chat_id? }  — Verify bot token, optionally send test message
 *   - { action: "detect_chat_id", bot_token }     — Auto-detect chat ID from recent messages
 *   - { bot_token, chat_id? }                     — (Legacy) same as action: "verify"
 *
 * If bot_token starts with "***" (masked), falls back to the stored token in DB.
 * If bot_token is omitted, also falls back to the stored token.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, chat_id } = body;
    let bot_token: string = body.bot_token || '';

    // If token is masked or missing, use the stored one
    if (!bot_token || bot_token.startsWith('***')) {
      const stored = getSetting('telegram_bot_token');
      if (stored) {
        bot_token = stored;
      }
    }

    if (!bot_token) {
      return NextResponse.json({ error: 'bot_token is required' }, { status: 400 });
    }

    // Auto-detect chat ID from recent bot messages
    if (action === 'detect_chat_id') {
      const result = await detectChatId(bot_token);
      return NextResponse.json(result);
    }

    // Register bot commands menu with Telegram
    if (action === 'register_commands') {
      const res = await callTelegramApi(bot_token, 'setMyCommands', {
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
      return NextResponse.json({ ok: res.ok, error: res.error });
    }

    // Default: verify bot token
    const result = await verifyBot(bot_token, chat_id || undefined);

    if (!result.ok) {
      return NextResponse.json({
        verified: false,
        error: result.error,
        botName: result.botName,
      });
    }

    return NextResponse.json({
      verified: true,
      botName: result.botName,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Verification failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
