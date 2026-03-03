import { listChannelBindings } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/bridge/channels — List channel bindings.
 *
 * Returns all bindings by default. Supports query parameters:
 *   ?active=true  — return only active bindings
 *   ?active=false — return only inactive bindings
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const activeParam = searchParams.get('active');

    let bindings = listChannelBindings();

    if (activeParam === 'true') {
      bindings = bindings.filter(b => b.active);
    } else if (activeParam === 'false') {
      bindings = bindings.filter(b => !b.active);
    }

    return Response.json({ bindings });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
