import { NextRequest, NextResponse } from 'next/server';
import { getSetting } from '@/lib/db';
import { getJson, HttpClientError } from '@/lib/http/client';

/**
 * POST /api/settings/discord/verify
 *
 * Verifies Discord bot token by calling the Discord API /users/@me endpoint.
 * If bot_token starts with "***" (masked), falls back to the stored token.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    let { bot_token } = body;

    // Fall back to stored value if not provided or masked
    if (!bot_token || bot_token.startsWith('***')) {
      bot_token = getSetting('bridge_discord_bot_token') || '';
    }

    if (!bot_token) {
      return NextResponse.json(
        { verified: false, error: 'Bot token is required' },
        { status: 400 },
      );
    }

    const { data } = await getJson<{
      id?: string;
      username?: string;
      discriminator?: string;
    }>('https://discord.com/api/v10/users/@me', {
      method: 'GET',
      headers: {
        Authorization: `Bot ${bot_token}`,
      },
      timeoutMs: 10_000,
      retries: 1,
      retryDelayMs: 250,
      retryJitterMs: 50,
    });

    if (data.id) {
      return NextResponse.json({
        verified: true,
        botName: data.username ? `${data.username}#${data.discriminator || '0'}` : data.id,
      });
    }

    return NextResponse.json({
      verified: false,
      error: 'Could not retrieve bot info',
    });
  } catch (error) {
    if (error instanceof HttpClientError) {
      if (error.code === 'http_status') {
        return NextResponse.json({
          verified: false,
          error: `HTTP ${error.status ?? 500}: Token verification failed`,
          detail: error.message,
          requestId: error.requestId,
        });
      }

      return NextResponse.json({
        verified: false,
        error: 'Verification request failed',
        detail: error.message,
        requestId: error.requestId,
      }, { status: 500 });
    }

    const message = error instanceof Error ? error.message : 'Verification failed';
    return NextResponse.json({ verified: false, error: message }, { status: 500 });
  }
}
