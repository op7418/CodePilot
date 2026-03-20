import { NextRequest, NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/db';
import { expandTilde } from '@/lib/cli-config';
import { clearClaudePathCache } from '@/lib/claude-client';
import fs from 'fs';

/**
 * CodePilot app-level settings (stored in SQLite, separate from ~/.claude/settings.json).
 * Used for API configuration (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, etc.)
 */

const ALLOWED_KEYS = [
  'anthropic_auth_token',
  'anthropic_base_url',
  'claude_cli_path',
  'claude_config_dir',
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
        // Validate path settings
        if (key === 'claude_cli_path') {
          const expanded = expandTilde(strValue);
          if (!fs.existsSync(expanded)) {
            return NextResponse.json(
              { error: `CLI path not found: ${expanded}` },
              { status: 400 }
            );
          }
        }
        if (key === 'claude_config_dir') {
          const expanded = expandTilde(strValue);
          if (!fs.existsSync(expanded) || !fs.statSync(expanded).isDirectory()) {
            return NextResponse.json(
              { error: `Config directory not found: ${expanded}` },
              { status: 400 }
            );
          }
        }
        setSetting(key, strValue);
      } else {
        // Empty value = remove the setting
        setSetting(key, '');
      }
    }

    // Clear cached CLI path when path-related settings change
    if ('claude_cli_path' in settings || 'claude_config_dir' in settings) {
      clearClaudePathCache();
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save app settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
