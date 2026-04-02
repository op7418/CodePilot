import { NextRequest, NextResponse } from 'next/server';

export async function POST(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { getScheduledTask, updateScheduledTask } = await import('@/lib/db');
    const task = getScheduledTask(id);
    if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Set next_run to now to trigger immediate execution
    updateScheduledTask(id, { next_run: new Date().toISOString() });

    // Ensure scheduler picks it up
    const { ensureSchedulerRunning } = await import('@/lib/task-scheduler');
    ensureSchedulerRunning();

    return NextResponse.json({ success: true, message: 'Task will execute on next poll cycle' });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 });
  }
}
