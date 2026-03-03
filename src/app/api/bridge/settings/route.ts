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
