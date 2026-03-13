import { NextRequest, NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/db';

const WECOM_KEYS = [
  'bridge_wecom_enabled',
  'bridge_wecom_bot_id',
  'bridge_wecom_secret',
  'bridge_wecom_allowed_users',
  'bridge_wecom_group_policy',
  'bridge_wecom_group_allow_from',
] as const;

export async function GET() {
  try {
    const result: Record<string, string> = {};
    for (const key of WECOM_KEYS) {
      const value = getSetting(key);
      if (value === undefined) continue;

      if (key === 'bridge_wecom_secret' && value.length > 8) {
        result[key] = '***' + value.slice(-8);
      } else {
        result[key] = value;
      }
    }

    return NextResponse.json({ settings: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read WeCom settings';
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
      if (!WECOM_KEYS.includes(key as typeof WECOM_KEYS[number])) continue;
      const strValue = String(value ?? '').trim();

      if (key === 'bridge_wecom_secret' && strValue.startsWith('***')) {
        continue;
      }

      setSetting(key, strValue);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save WeCom settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}