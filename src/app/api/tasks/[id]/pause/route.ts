import { NextRequest, NextResponse } from 'next/server';

export async function POST(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { getScheduledTask, updateScheduledTask } = await import('@/lib/db');
    const task = getScheduledTask(id);
    if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const newStatus = task.status === 'paused' ? 'active' : 'paused';
    updateScheduledTask(id, { status: newStatus });
    return NextResponse.json({ success: true, status: newStatus });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 });
  }
}
