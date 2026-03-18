import { NextRequest, NextResponse } from 'next/server';
import {
  setDefaultProviderId,
  updateSdkSessionId,
  getProvider,
  getDefaultProviderId,
  updateProvider,
  updateSessionProviderId,
  setSetting,
} from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { action, params } = (await request.json()) as {
      action: string;
      params?: Record<string, string>;
    };

    if (!action) {
      return NextResponse.json({ error: 'action is required' }, { status: 400 });
    }

    switch (action) {
      case 'set-default-provider': {
        if (!params?.providerId) {
          return NextResponse.json(
            { error: 'params.providerId is required for set-default-provider' },
            { status: 400 },
          );
        }
        setDefaultProviderId(params.providerId);
        break;
      }

      case 'clear-stale-resume': {
        if (params?.sessionId) {
          // Clear a specific session
          updateSdkSessionId(params.sessionId, '');
        } else {
          // Clear all sessions with stale sdk_session_id
          const { getDb } = await import('@/lib/db');
          const db = getDb();
          const result = db.prepare(
            `UPDATE chat_sessions SET sdk_session_id = '' WHERE sdk_session_id != '' AND sdk_session_id IS NOT NULL`
          ).run();
          console.log(`[doctor/repair] Cleared sdk_session_id from ${result.changes} session(s)`);
        }
        break;
      }

      case 'switch-auth-style': {
        if (!params?.providerId || !params?.authStyle) {
          return NextResponse.json(
            { error: 'params.providerId and params.authStyle are required for switch-auth-style' },
            { status: 400 },
          );
        }

        const provider = getProvider(params.providerId);
        if (!provider) {
          return NextResponse.json(
            { error: `Provider ${params.providerId} not found` },
            { status: 404 },
          );
        }

        // Parse existing extra_env
        let extraEnv: Record<string, string> = {};
        try {
          extraEnv = JSON.parse(provider.extra_env || '{}');
        } catch {
          extraEnv = {};
        }

        // Swap between ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN
        // Use key existence (not value) because presets use empty placeholders like {"ANTHROPIC_AUTH_TOKEN":""}
        if (params.authStyle === 'api-key') {
          // Switch to api_key: ensure ANTHROPIC_API_KEY exists, remove ANTHROPIC_AUTH_TOKEN
          if ('ANTHROPIC_AUTH_TOKEN' in extraEnv) {
            // Preserve any non-empty value
            const val = extraEnv.ANTHROPIC_AUTH_TOKEN;
            delete extraEnv.ANTHROPIC_AUTH_TOKEN;
            extraEnv.ANTHROPIC_API_KEY = val || '';
          } else if (!('ANTHROPIC_API_KEY' in extraEnv)) {
            extraEnv.ANTHROPIC_API_KEY = '';
          }
        } else if (params.authStyle === 'auth-token') {
          // Switch to auth_token: ensure ANTHROPIC_AUTH_TOKEN exists, remove ANTHROPIC_API_KEY
          if ('ANTHROPIC_API_KEY' in extraEnv) {
            const val = extraEnv.ANTHROPIC_API_KEY;
            delete extraEnv.ANTHROPIC_API_KEY;
            extraEnv.ANTHROPIC_AUTH_TOKEN = val || '';
          } else if (!('ANTHROPIC_AUTH_TOKEN' in extraEnv)) {
            extraEnv.ANTHROPIC_AUTH_TOKEN = '';
          }
        } else {
          return NextResponse.json(
            { error: `Unknown authStyle: ${params.authStyle}. Use "api-key" or "auth-token"` },
            { status: 400 },
          );
        }

        updateProvider(params.providerId, {
          extra_env: JSON.stringify(extraEnv),
        });
        break;
      }

      case 'apply-provider-to-session': {
        // Apply the default (or specified) provider to a session
        let providerId = params?.providerId || getDefaultProviderId();
        if (!providerId) {
          return NextResponse.json(
            { error: 'No default provider configured and no providerId specified' },
            { status: 400 },
          );
        }
        // Validate the provider actually exists — stale default IDs are a known issue
        const targetProvider = getProvider(providerId);
        if (!targetProvider) {
          // Try first available provider instead
          const { getAllProviders } = await import('@/lib/db');
          const all = getAllProviders();
          if (all.length > 0) {
            providerId = all[0].id;
            setDefaultProviderId(providerId); // also fix the stale default
          } else {
            return NextResponse.json(
              { error: `Provider "${providerId}" not found and no alternatives available` },
              { status: 404 },
            );
          }
        }
        if (params?.sessionId) {
          updateSessionProviderId(params.sessionId, providerId);
        } else {
          // Apply to all sessions without a provider_id
          const { getDb } = await import('@/lib/db');
          const db = getDb();
          const result = db.prepare(
            `UPDATE chat_sessions SET provider_id = ? WHERE (provider_id IS NULL OR provider_id = '')`
          ).run(providerId);
          console.log(`[doctor/repair] Applied provider ${providerId} to ${result.changes} session(s)`);
        }
        break;
      }

      case 'reimport-env-config': {
        // Re-read env vars and persist to DB settings so the resolver can
        // find them even when process.env is incomplete (e.g. Electron).
        //
        // Only write settings the resolver actually consumes:
        //   - anthropic_auth_token  (read by toClaudeCodeEnv + resolveAnthropicAuth)
        //   - anthropic_base_url    (read by toClaudeCodeEnv + toAiSdkConfig)
        //
        // ANTHROPIC_API_KEY is consumed directly from process.env by the
        // resolver — writing it to a DB setting that nothing reads would be
        // a no-op. Instead, if only API_KEY is present, we still don't write
        // it to anthropic_auth_token (that would change the auth style from
        // x-api-key to Bearer and break official API).
        const envToken = process.env.ANTHROPIC_AUTH_TOKEN;
        const envBaseUrl = process.env.ANTHROPIC_BASE_URL;
        let imported = 0;
        if (envToken) { setSetting('anthropic_auth_token', envToken); imported++; }
        if (envBaseUrl) { setSetting('anthropic_base_url', envBaseUrl); imported++; }
        console.log(`[doctor/repair] Re-imported ${imported} env setting(s)`);
        if (!envToken && process.env.ANTHROPIC_API_KEY) {
          console.log(`[doctor/repair] ANTHROPIC_API_KEY is set in env — resolver reads it directly, no DB import needed`);
        }
        break;
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    return NextResponse.json({ success: true, action });
  } catch (error) {
    console.error('[doctor/repair] Repair action failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
