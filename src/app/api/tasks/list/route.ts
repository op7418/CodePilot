import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const status = request.nextUrl.searchParams.get('status') || undefined;
    const { listScheduledTasks } = await import('@/lib/db');
    const tasks = listScheduledTasks(status ? { status } : undefined);
    return NextResponse.json({ tasks });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 });
  }
}
