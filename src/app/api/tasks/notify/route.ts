import { NextResponse } from 'next/server';

/**
 * GET: Retired destructive drain endpoint; returns 405 directing callers to POST /api/tasks/notify/claim.
 */
export async function GET() {
  return NextResponse.json(
    { error: 'Destructive notification drain retired; use channel-scoped POST claim.' },
    { status: 405 },
  );
}
