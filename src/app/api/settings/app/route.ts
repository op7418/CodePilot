import { NextRequest, NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/db';

/**
 * CodePilot app-level settings (stored in SQLite, separate from ~/.claude/settings.json).
 * Used for API configuration (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, etc.)
 */

const ALLOWED_KEYS = [
  'anthropic_auth_token',
  'anthropic_base_url',
  'dangerously_skip_permissions',
  'generative_ui_enabled',
  'locale',
  'thinking_mode',
];

export async function GET() {
  try {
    const result: Record<string, string> = {};
    for (const key of ALLOWED_KEYS) {
      const value = getSetting(key);
      if (value !== undefined) {
        // Mask token for security (only return last 8 chars)
        if (key === 'anthropic_auth_token' && value.length > 8) {
          result[key] = '***' + value.slice(-8);
        } else {
          result[key] = value;
        }
      }
    }
    return NextResponse.json({ settings: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read app settings';
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
      if (!ALLOWED_KEYS.includes(key)) continue;
      const strValue = String(value ?? '').trim();
      if (strValue) {
        // Don't overwrite token if user sent the masked version back
        if (key === 'anthropic_auth_token' && strValue.startsWith('***')) {
          continue;
        }
        setSetting(key, strValue);
      } else {
        // Empty value = remove the setting
        setSetting(key, '');
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save app settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
