import { NextRequest, NextResponse } from 'next/server';
import { parseInterval, getNextCronTime, ensureSchedulerRunning } from '@/lib/task-scheduler';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, prompt, schedule_type, schedule_value, priority, notify_on_complete, session_id, working_directory } = body;

    if (!name || !prompt || !schedule_type || !schedule_value) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Calculate next_run
    let next_run: string;
    const now = new Date();

    if (schedule_type === 'once') {
      next_run = new Date(schedule_value).toISOString();
    } else if (schedule_type === 'interval') {
      const ms = parseInterval(schedule_value);
      next_run = new Date(now.getTime() + ms).toISOString();
    } else if (schedule_type === 'cron') {
      const cronNext = getNextCronTime(schedule_value);
      if (!cronNext) {
        return NextResponse.json({ error: `Cron expression "${schedule_value}" has no valid occurrence within 4 years` }, { status: 400 });
      }
      next_run = cronNext.toISOString();
    } else {
      return NextResponse.json({ error: 'Invalid schedule_type' }, { status: 400 });
    }

    const { createScheduledTask } = await import('@/lib/db');
    const task = createScheduledTask({
      name, prompt, schedule_type, schedule_value, next_run,
      status: 'active',
      priority: priority || 'normal',
      notify_on_complete: notify_on_complete ?? 1,
      consecutive_errors: 0,
      permanent: 0,
      session_id: session_id || null,
      working_directory: working_directory || null,
    });

    // Ensure the scheduler is running
    ensureSchedulerRunning();

    return NextResponse.json({ task });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 });
  }
}
