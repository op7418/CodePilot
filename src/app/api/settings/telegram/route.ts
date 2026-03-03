import { NextRequest, NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/db';
import { startPolling, stopPolling } from '@/lib/telegram-bot';

/**
 * Telegram Bot notification settings.
 * Stored in the SQLite settings table (same as other app settings).
 */

const TELEGRAM_KEYS = [
  'telegram_bot_token',
  'telegram_chat_id',
  'telegram_enabled',
  'telegram_notify_start',
  'telegram_notify_complete',
  'telegram_notify_error',
  'telegram_notify_permission',
  'telegram_bridge_allowed_users',
] as const;

export async function GET() {
  try {
    const result: Record<string, string> = {};
    for (const key of TELEGRAM_KEYS) {
      const value = getSetting(key);
      if (value !== undefined) {
        // Mask bot token for security
        if (key === 'telegram_bot_token' && value.length > 8) {
          result[key] = '***' + value.slice(-8);
        } else {
          result[key] = value;
        }
      }
    }

    // Auto-start polling if Telegram is configured (survives server restarts)
    const enabled = getSetting('telegram_enabled') === 'true';
    const hasToken = !!getSetting('telegram_bot_token');
    const hasChatId = !!getSetting('telegram_chat_id');
    if (enabled && hasToken && hasChatId) {
      startPolling();
    }

    return NextResponse.json({ settings: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read Telegram settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { settings } = body;

    if (!settings || typeof settings !== 'object') {
      return NextResponse.json({ error: 'Invalid settings data' }, { status: 400 });
    }

    for (const [key, value] of Object.entries(settings)) {
      if (!TELEGRAM_KEYS.includes(key as typeof TELEGRAM_KEYS[number])) continue;
      const strValue = String(value ?? '').trim();

      // Don't overwrite token if user sent the masked version back
      if (key === 'telegram_bot_token' && strValue.startsWith('***')) {
        continue;
      }

      setSetting(key, strValue);
    }

    // Start or stop long-polling based on the enabled state
    const enabled = getSetting('telegram_enabled') === 'true';
    const hasToken = !!getSetting('telegram_bot_token');
    const hasChatId = !!getSetting('telegram_chat_id');
    if (enabled && hasToken && hasChatId) {
      startPolling();
    } else {
      stopPolling();
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save Telegram settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
