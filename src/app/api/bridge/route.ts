import { NextRequest } from 'next/server';
import * as bridgeManager from '@/lib/bridge/bridge-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/bridge — Return bridge status (pure query, no side effects)
 */
export async function GET() {
  try {
    const status = bridgeManager.getStatus();
    return Response.json(status);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/bridge — Start, stop, or auto-start the bridge
 * Body: { action: 'start' | 'stop' | 'auto-start' }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'start') {
      await bridgeManager.start();
      return Response.json({ ok: true, status: bridgeManager.getStatus() });
    } else if (action === 'stop') {
      await bridgeManager.stop();
      return Response.json({ ok: true, status: bridgeManager.getStatus() });
    } else if (action === 'auto-start') {
      bridgeManager.tryAutoStart();
      return Response.json({ ok: true, status: bridgeManager.getStatus() });
    } else {
      return Response.json(
        { error: 'Invalid action. Use "start", "stop", or "auto-start".' },
        { status: 400 },
      );
    }
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
