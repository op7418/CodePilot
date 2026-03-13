import { NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/db';

const BRIDGE_SETTING_KEYS = [
  'remote_bridge_enabled',
  'bridge_telegram_enabled',
  'telegram_bridge_allowed_users',
  'bridge_auto_start',
  'bridge_default_work_dir',
  'bridge_default_model',
  'bridge_default_provider_id',
  'bridge_telegram_stream_enabled',
  'bridge_telegram_stream_interval_ms',
  'bridge_telegram_stream_min_delta_chars',
  'bridge_telegram_stream_max_chars',
  'bridge_telegram_stream_private_only',
  'bridge_feishu_enabled',
  'bridge_feishu_app_id',
  'bridge_feishu_app_secret',
  'bridge_feishu_domain',
  'bridge_feishu_allowed_users',
  'bridge_feishu_group_policy',
  'bridge_feishu_group_allow_from',
  'bridge_feishu_require_mention',
  'bridge_wecom_enabled',
  'bridge_wecom_bot_id',
  'bridge_wecom_secret',
  'bridge_wecom_allowed_users',
  'bridge_wecom_group_policy',
  'bridge_wecom_group_allow_from',
  'bridge_discord_enabled',
  'bridge_discord_bot_token',
  'bridge_discord_allowed_users',
  'bridge_discord_allowed_channels',
  'bridge_discord_allowed_guilds',
  'bridge_discord_group_policy',
  'bridge_discord_require_mention',
  'bridge_discord_stream_enabled',
  'bridge_discord_stream_interval_ms',
  'bridge_discord_stream_min_delta_chars',
  'bridge_discord_stream_max_chars',
  'bridge_discord_max_attachment_size',
  'bridge_discord_image_enabled',
  'bridge_qq_enabled',
  'bridge_qq_app_id',
  'bridge_qq_app_secret',
  'bridge_qq_allowed_users',
  'bridge_qq_image_enabled',
  'bridge_qq_max_image_size',
] as const;

export async function GET() {
  try {
    const settings: Record<string, string> = {};
    for (const key of BRIDGE_SETTING_KEYS) {
      settings[key] = getSetting(key) ?? '';
    }
    return NextResponse.json({ settings });
  } catch {
    return NextResponse.json(
      { error: 'Failed to read bridge settings' },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { settings } = body;

    if (!settings || typeof settings !== 'object') {
      return NextResponse.json(
        { error: 'Invalid settings data' },
        { status: 400 },
      );
    }

    for (const [key, value] of Object.entries(settings)) {
      if (BRIDGE_SETTING_KEYS.includes(key as typeof BRIDGE_SETTING_KEYS[number])) {
        setSetting(key, String(value));
      }
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: 'Failed to save bridge settings' },
      { status: 500 },
    );
  }
}
