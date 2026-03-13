import { NextRequest, NextResponse } from 'next/server';
import { WSClient } from '@wecom/aibot-node-sdk';
import { getSetting } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * POST /api/settings/wecom/verify
 *
 * Verifies WeCom AI Bot credentials by establishing a short-lived WebSocket
 * connection and waiting for the SDK authenticated event.
 * If secret starts with *** (masked), falls back to the stored secret.
 */
export async function POST(request: NextRequest) {
  let client: WSClient | null = null;

  try {
    const body = await request.json();
    let { bot_id, secret } = body;

    if (!bot_id) {
      bot_id = getSetting('bridge_wecom_bot_id') || '';
    }
    if (!secret || secret.startsWith('***')) {
      secret = getSetting('bridge_wecom_secret') || '';
    }

    if (!bot_id || !secret) {
      return NextResponse.json(
        { verified: false, error: 'Bot ID and Secret are required' },
        { status: 400 },
      );
    }

    client = new WSClient({
      botId: bot_id,
      secret,
      requestTimeout: 10_000,
      reconnectInterval: 1_000,
      maxReconnectAttempts: 0,
    });
    const verifyClient = client;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out while waiting for WeCom authentication'));
      }, 10_000);

      const cleanup = () => {
        clearTimeout(timeout);
        verifyClient.off('authenticated', onAuthenticated);
        verifyClient.off('error', onError);
        verifyClient.off('disconnected', onDisconnected);
      };

      const onAuthenticated = () => {
        cleanup();
        resolve();
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const onDisconnected = (reason: string) => {
        cleanup();
        reject(new Error(reason || 'WeCom connection disconnected before authentication'));
      };

      verifyClient.once('authenticated', onAuthenticated);
      verifyClient.once('error', onError);
      verifyClient.once('disconnected', onDisconnected);
      verifyClient.connect();
    });

    return NextResponse.json({ verified: true, botId: bot_id });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Verification failed';
    return NextResponse.json({ verified: false, error: message }, { status: 500 });
  } finally {
    try {
      client?.disconnect();
    } catch {
      // ignore cleanup failure
    }
  }
}