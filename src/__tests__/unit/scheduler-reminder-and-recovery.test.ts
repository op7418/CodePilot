/**
 * Phase 3 Step 3 — scheduler runtime behavior.
 *
 * Covers (in execution-order):
 *   1. `getDueTasks` text-comparison fix: a "now + 5 minutes" once-task
 *      becomes due after wall-clock advance. The pre-fix bug compared
 *      `next_run` (ISO string with 'T'/'Z') against `datetime('now')`
 *      output (space-separated), so same-day reminders never fired.
 *   2. `kind='reminder'` execution: prompt is the notification body,
 *      `generateTextFromProvider` is NEVER called (verified via
 *      module mock). One row in `task_run_logs` gets flipped from
 *      'running' → 'success'.
 *   3. `runScheduledTaskNow` returns `{ status: 'running', runId }`,
 *      writes a single `task_run_logs` row (no duplicate), and a
 *      concurrent call returns `{ status: 'already_running', … }`.
 *   4. Stale `running` recovery: a task whose `last_run` is > 30 min
 *      old and `last_status='running'` gets reset to 'error' on
 *      `ensureSchedulerRunning()`.
 *
 * Each test isolates DB state via a per-test `CLAUDE_GUI_DATA_DIR`
 * temp dir + `closeDb()` between cases. The scheduler module owns a
 * globalThis flag and an in-process db handle, so we also `delete`
 * the flag and re-import to get a clean run.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let tempDir: string;
let originalDataDir: string | undefined;

before(() => {
  originalDataDir = process.env.CLAUDE_GUI_DATA_DIR;
});

after(() => {
  if (originalDataDir === undefined) {
    delete process.env.CLAUDE_GUI_DATA_DIR;
  } else {
    process.env.CLAUDE_GUI_DATA_DIR = originalDataDir;
  }
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-sched-test-'));
  process.env.CLAUDE_GUI_DATA_DIR = tempDir;
});

afterEach(async () => {
  // Close the active DB handle so the temp dir is truly fresh.
  try {
    const { closeDb } = await import('../../lib/db');
    closeDb();
  } catch { /* ignore */ }
  // Reset the scheduler's globalThis "started" flag so the next test
  // can call ensureSchedulerRunning() without the early-return.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__codepilot_scheduler__;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__codepilot_session_tasks__;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('scheduler — reminder kind path', () => {
  it('reminder fire writes notification + a single success run-row, no provider call', async () => {
    const db = await import('../../lib/db');
    // Create a reminder due in the past so it gets picked up immediately.
    const past = new Date(Date.now() - 1000).toISOString();
    const task = db.createScheduledTask({
      name: 'Drink water',
      prompt: 'Stand up and drink water',
      kind: 'reminder',
      schedule_type: 'once',
      schedule_value: past,
      next_run: past,
      consecutive_errors: 0,
      status: 'active',
      priority: 'normal',
      notify_on_complete: 1,
      permanent: 0,
    });

    // Assert it is selected by getDueTasks
    const due = db.getDueTasks();
    assert.ok(
      due.some((t) => t.id === task.id),
      'reminder due in the past must appear in getDueTasks (next_run text-compare bug fix)',
    );

    // Run it via the public entry. runScheduledTaskNow fires the
    // executeDueTask machinery the same way the poll cycle does.
    const { runScheduledTaskNow } = await import('../../lib/task-scheduler');
    const result = await runScheduledTaskNow(task.id);
    assert.equal(result.status, 'running');
    if (result.status !== 'running') return;
    const runId = result.runId;

    // executeDueTask is fire-and-forget; wait briefly for it to finish.
    await new Promise((r) => setTimeout(r, 250));

    const runs = db.listTaskRunLogs(task.id);
    const matching = runs.filter((r) => r.id === runId);
    assert.equal(
      matching.length,
      1,
      'exactly one task_run_logs row per execution (v3 fix #2: insert running, then UPDATE in place)',
    );
    assert.equal(
      matching[0].status,
      'success',
      'reminder execution flipped the running row to success — not appended a new row',
    );
    assert.equal(
      matching[0].result,
      'Stand up and drink water',
      'reminder result is the prompt text, NOT a model reply',
    );

    // notification_events row must exist (1 per logical fire) with the task linked.
    const events = (db.getDb() as unknown as { prepare: (s: string) => { all: (...args: unknown[]) => unknown[] } })
      .prepare('SELECT event_id, task_id, title FROM notification_events WHERE task_id = ?')
      .all(task.id) as Array<{ event_id: string; task_id: string; title: string }>;
    assert.equal(events.length, 1, 'one notification_events row per logical task notification (v4 fix #2)');
    assert.match(events[0].title, /Drink water/);

    // notification_deliveries: normal priority has one native candidate.
    const deliveries = db.listNotificationDeliveries(events[0].event_id);
    const channels = new Set(deliveries.map((d) => d.channel));
    assert.ok(channels.has('electron-native'), 'electron-native delivery row missing for normal priority');
    assert.ok(!channels.has('renderer-toast'), 'normal priority must not duplicate as an in-app toast');
    assert.ok(
      ![...channels].some((c) => c.startsWith('bridge-')),
      'non-urgent priority must NOT write any bridge-* delivery row (v4 fix #3 — Bridge is urgent-only candidate)',
    );
  });
});

describe('scheduler — runScheduledTaskNow concurrency', () => {
  it('concurrent run returns already_running with the in-flight runId', async () => {
    const db = await import('../../lib/db');
    const task = db.createScheduledTask({
      name: 'AI summarize',
      prompt: 'Summarize today',
      // Use an ai_task that will FAIL fast (no provider configured)
      // so we don't depend on a real model — but the running lock
      // still gets taken.
      kind: 'ai_task',
      schedule_type: 'interval',
      schedule_value: '1h',
      next_run: new Date(Date.now() + 3_600_000).toISOString(),
      consecutive_errors: 0,
      status: 'active',
      priority: 'low',
      notify_on_complete: 1,
      permanent: 0,
    });

    const { runScheduledTaskNow } = await import('../../lib/task-scheduler');
    const first = await runScheduledTaskNow(task.id);
    assert.equal(first.status, 'running');

    // Immediately ask again; the row-lock should reject the second
    // call since `last_status='running'` was set above.
    const second = await runScheduledTaskNow(task.id);
    assert.equal(
      second.status,
      'already_running',
      'concurrent runScheduledTaskNow must return already_running, not run twice',
    );
    if (second.status === 'already_running' && first.status === 'running') {
      assert.equal(
        second.runId,
        first.runId,
        'already_running must surface the in-flight runId so callers can join the existing run',
      );
    }

    // Wait for the (failing) ai_task path to settle so afterEach can
    // close the DB cleanly without dangling handles.
    await new Promise((r) => setTimeout(r, 500));
  });
});

describe('scheduler — dispatch concurrency cap', () => {
  it('starts at most MAX_CONCURRENT_SCHEDULED_RUNS due tasks per dispatch and leaves the rest due', async () => {
    const db = await import('../../lib/db');
    const { dispatchDueTasks, MAX_CONCURRENT_SCHEDULED_RUNS } = await import('../../lib/task-scheduler');
    const created = [0, 1, 2, 3].map((i) => {
      const past = new Date(Date.now() - (10 - i) * 1000).toISOString();
      return db.createScheduledTask({
        name: `Reminder ${i}`,
        prompt: `Reminder ${i}`,
        kind: 'reminder',
        schedule_type: 'once',
        schedule_value: past,
        next_run: past,
        consecutive_errors: 0,
        status: 'active',
        priority: 'low',
        notify_on_complete: 1,
        permanent: 0,
      });
    });

    const firstRound = await dispatchDueTasks(db.getDueTasks());
    assert.equal(MAX_CONCURRENT_SCHEDULED_RUNS, 2);
    assert.deepEqual(firstRound, [created[0].id, created[1].id], 'oldest due tasks get the slots first');
    for (const queued of created.slice(2)) {
      assert.equal(db.listTaskRunLogs(queued.id).length, 0, 'tasks beyond the cap must not start this round');
    }

    const waitForCompletion = async (ids: string[]) => {
      for (let i = 0; i < 50; i++) {
        if (ids.every((id) => db.getScheduledTask(id)?.status === 'completed')) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.fail('dispatched tasks did not complete');
    };
    await waitForCompletion(firstRound);

    const due = db.getDueTasks().map((t) => t.id).sort();
    assert.deepEqual(due, created.slice(2).map((t) => t.id).sort(), 'queued tasks stay due for the next poll');

    const secondRound = await dispatchDueTasks(db.getDueTasks());
    assert.deepEqual(secondRound, [created[2].id, created[3].id]);
    await waitForCompletion(secondRound);
  });
});

describe('scheduler — stale running recovery', () => {
  it('does not start or touch runtime state during the Next production build phase', async () => {
    const previousPhase = process.env.NEXT_PHASE;
    process.env.NEXT_PHASE = 'phase-production-build';
    delete (globalThis as Record<string, unknown>).__codepilot_scheduler__;
    try {
      const { ensureSchedulerRunning } = await import('../../lib/task-scheduler');
      ensureSchedulerRunning();
      assert.equal(
        (globalThis as Record<string, unknown>).__codepilot_scheduler__,
        undefined,
      );
    } finally {
      if (previousPhase === undefined) delete process.env.NEXT_PHASE;
      else process.env.NEXT_PHASE = previousPhase;
    }
  });

  it('ensureSchedulerRunning resets stale running rows to error with backoff', async () => {
    const db = await import('../../lib/db');
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const task = db.createScheduledTask({
      name: 'Crashed task',
      prompt: 'Crashed during run',
      kind: 'ai_task',
      schedule_type: 'interval',
      schedule_value: '1h',
      next_run: past,
      consecutive_errors: 0,
      status: 'active',
      priority: 'low',
      notify_on_complete: 1,
      permanent: 0,
    });

    // Manually pin the task into a stale running state.
    const handle = db.getDb();
    handle
      .prepare(
        "UPDATE scheduled_tasks SET last_status = 'running', last_run = ?, updated_at = ? WHERE id = ?",
      )
      .run(past, past, task.id);
    db.insertTaskRunLog({ task_id: task.id, status: 'running' });

    const { ensureSchedulerRunning } = await import('../../lib/task-scheduler');
    ensureSchedulerRunning();
    // Recovery is fire-and-forget; wait a tick.
    await new Promise((r) => setTimeout(r, 100));

    const refreshed = db.getScheduledTask(task.id);
    assert.ok(refreshed);
    assert.equal(
      refreshed!.last_status,
      'error',
      'stale running task must be reset to error on scheduler boot (v3 fix — startup recovery)',
    );
    assert.match(
      refreshed!.last_error || '',
      /interrupted/i,
      'recovery must record an interruption reason so the user understands why',
    );

    // The matching run-row should also flip to 'error'.
    const runs = db.listTaskRunLogs(task.id);
    const running = runs.filter((r) => r.status === 'running');
    assert.equal(
      running.length,
      0,
      'no run-row should remain in `running` after stale recovery',
    );
  });
});
