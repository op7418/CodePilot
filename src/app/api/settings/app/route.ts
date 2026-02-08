import { NextRequest, NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/db';

/**
 * CodePilot app-level settings (stored in SQLite, separate from ~/.claude/settings.json).
 * Used for API configuration (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, etc.)
 */

const ALLOWED_KEYS = [
  'anthropic_auth_token',
  'anthropic_base_url',
];

const ENV_VAR_MAP: Record<string, string[]> = {
  anthropic_auth_token: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  anthropic_base_url: ['ANTHROPIC_BASE_URL'],
};

export async function GET() {
  try {
    const result: Record<string, string> = {};
    const sources: Record<string, 'db' | 'env'> = {};
    for (const key of ALLOWED_KEYS) {
      let value = getSetting(key);
      let source: 'db' | 'env' = 'db';

      if (value === undefined || value === '') {
        const envVarNames = ENV_VAR_MAP[key] ?? [];
        for (const envName of envVarNames) {
          const envValue = process.env[envName];
          if (envValue) {
            value = envValue;
            source = 'env';
            break;
          }
        }
      }

      if (value !== undefined && value !== '') {
        if (key === 'anthropic_auth_token' && value.length > 8) {
          result[key] = '***' + value.slice(-8);
        } else {
          result[key] = value;
        }
        sources[key] = source;
      }
    }
    return NextResponse.json({ settings: result, sources });
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
