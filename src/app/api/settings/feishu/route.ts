import { NextRequest, NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/db';

/**
 * Feishu Bot bridge settings.
 * Stored in the SQLite settings table (same as other app settings).
 */

const FEISHU_KEYS = [
  'bridge_feishu_enabled',
  'bridge_feishu_app_id',
  'bridge_feishu_app_secret',
  'bridge_feishu_domain',
  'bridge_feishu_mode',
  'bridge_feishu_webhook_port',
  'bridge_feishu_webhook_verification_token',
  'bridge_feishu_allowed_users',
  'bridge_feishu_group_policy',
  'bridge_feishu_group_allow_from',
  'bridge_feishu_require_mention',
] as const;

export async function GET() {
  try {
    const result: Record<string, string> = {};
    for (const key of FEISHU_KEYS) {
      const value = getSetting(key);
      if (value !== undefined) {
        // Mask app secret for security
        if (key === 'bridge_feishu_app_secret' && value.length > 8) {
          result[key] = '***' + value.slice(-8);
          continue;
        }
        if (key === 'bridge_feishu_webhook_verification_token' && value.length > 8) {
          result[key] = '***' + value.slice(-8);
          continue;
        }
        result[key] = value;
      }
    }

    return NextResponse.json({ settings: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read Feishu settings';
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
      if (!FEISHU_KEYS.includes(key as typeof FEISHU_KEYS[number])) continue;
      const strValue = String(value ?? '').trim();

      // Don't overwrite secret if user sent the masked version back
      if (key === 'bridge_feishu_app_secret' && strValue.startsWith('***')) {
        continue;
      }

      if (key === 'bridge_feishu_webhook_verification_token' && strValue.startsWith('***')) {
        continue;
      }

      setSetting(key, strValue);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save Feishu settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
