/**
 * Task Scheduler — polls SQLite for due scheduled tasks and executes them.
 *
 * Architecture:
 * - Runs in Next.js server process via setInterval (10s poll)
 * - Uses globalThis to survive HMR in development
 * - Lightweight execution via generateTextFromProvider (no streaming UI)
 * - Exponential backoff on failure (30s → 1m → 5m → 15m)
 * - Auto-disables after 10 consecutive failures
 */

import type { ScheduledTask } from '@/types';
import crypto from 'crypto';

const POLL_INTERVAL = 10_000; // 10s
const GLOBAL_KEY = '__codepilot_scheduler__';
const BACKOFF_DELAYS = [30000, 60000, 300000, 900000]; // 30s, 1m, 5m, 15m
const MAX_CONSECUTIVE_ERRORS = 10;
const RECURRING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Session-only tasks (in-memory, not persisted) ────────────────
const SESSION_TASKS_KEY = '__codepilot_session_tasks__';

export function getSessionTasks(): Map<string, ScheduledTask> {
  if (!(globalThis as Record<string, unknown>)[SESSION_TASKS_KEY]) {
    (globalThis as Record<string, unknown>)[SESSION_TASKS_KEY] = new Map();
  }
  return (globalThis as Record<string, unknown>)[SESSION_TASKS_KEY] as Map<string, ScheduledTask>;
}

export function addSessionTask(task: ScheduledTask): void {
  getSessionTasks().set(task.id, task);
}

export function removeSessionTask(id: string): void {
  getSessionTasks().delete(id);
}

/**
 * Ensure the scheduler polling loop is running.
 * Safe to call multiple times — only starts once.
 */
export function ensureSchedulerRunning(): void {
  if ((globalThis as Record<string, unknown>)[GLOBAL_KEY]) return;
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = true;

  // One-time missed task recovery on startup
  handleMissedTasks().catch(err => console.error('[scheduler] Missed task recovery failed:', err));

  // Phase 3 Step 3 — recover any task left in `last_status='running'`
  // by a previous crash. Without this, those rows never get picked up
  // by `getDueTasks` (which excludes running) and stay stuck forever.
  recoverStaleRunningTasks().catch(err =>
    console.error('[scheduler] Stale running recovery failed:', err),
  );

  // Auto-expire recurring tasks on startup + hourly
  checkExpiredTasks().catch(() => {});
  const expiryIntervalId = setInterval(() => checkExpiredTasks().catch(() => {}), 3600_000); // hourly
  if (expiryIntervalId && typeof expiryIntervalId === 'object' && 'unref' in expiryIntervalId) {
    (expiryIntervalId as NodeJS.Timeout).unref();
  }

  const intervalId = setInterval(async () => {
    try {
      const { getDueTasks } = await import('@/lib/db');
      const dueTasks = getDueTasks();
      for (const task of dueTasks) {
        // Fire-and-forget: don't block the poll loop
        executeDueTask(task).catch(err =>
          console.error(`[scheduler] Task ${task.id} (${task.name}) failed:`, err)
        );
      }

      // Check session-only tasks too
      const sessionTasks = getSessionTasks();
      for (const [id, task] of sessionTasks) {
        if (task.status === 'active' && new Date(task.next_run) <= new Date()) {
          // Execute and handle errors in-memory (session tasks aren't in SQLite)
          try {
            await executeDueTask(task, true);
            // Reset error count on success
            task.consecutive_errors = 0;
          } catch (err) {
            task.consecutive_errors = (task.consecutive_errors || 0) + 1;
            console.error(`[scheduler] Session task ${id} failed (${task.consecutive_errors}x):`, err);

            // Auto-disable after too many consecutive failures
            if (task.consecutive_errors >= MAX_CONSECUTIVE_ERRORS) {
              task.status = 'disabled' as ScheduledTask['status'];
              console.warn(`[scheduler] Session task ${id} auto-disabled after ${task.consecutive_errors} failures`);
              continue;
            }

            // Exponential backoff: push next_run forward
            const backoffMs = BACKOFF_DELAYS[Math.min(task.consecutive_errors - 1, BACKOFF_DELAYS.length - 1)];
            task.next_run = new Date(Date.now() + backoffMs).toISOString();
            continue; // Skip normal next_run advancement
          }

          if (task.schedule_type === 'once') {
            // One-shot session tasks: remove after fire
            sessionTasks.delete(id);
          } else {
            // Recurring session tasks: advance next_run in memory
            const now = new Date();
            if (task.schedule_type === 'interval') {
              const ms = parseInterval(task.schedule_value);
              let nextRun = new Date(now.getTime() + ms);
              while (nextRun <= now) nextRun = new Date(nextRun.getTime() + ms);
              task.next_run = nextRun.toISOString();
            } else if (task.schedule_type === 'cron') {
              const cronNext = getNextCronTime(task.schedule_value);
              if (cronNext) {
                task.next_run = cronNext.toISOString();
              } else {
                // No valid next occurrence — pause this session task
                task.status = 'paused' as ScheduledTask['status'];
                console.warn(`[scheduler] Session cron task ${id} paused: no match within 4 years`);
                continue;
              }
            }
            task.last_run = now.toISOString();
          }
        }
      }
    } catch (err) {
      console.error('[scheduler] Poll error:', err);
    }
  }, POLL_INTERVAL);

  // Prevent the interval from keeping the process alive
  if (intervalId && typeof intervalId === 'object' && 'unref' in intervalId) {
    (intervalId as NodeJS.Timeout).unref();
  }

  console.log('[scheduler] Started with 10s poll interval');
}

/**
 * Stop the scheduler polling loop.
 */
export function stopScheduler(): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = false;
  console.log('[scheduler] Stopped');
}

/**
 * Execute a single due task.
 *
 * Phase 3 Step 3 — kind dispatch + single-row lifecycle.
 *
 * `kind === 'reminder'`: prompt text IS the notification body. No AI
 *   provider is called. This is what makes "5-minute reminder to drink
 *   water" work without any model configured. Result text is the prompt
 *   verbatim (truncated for the notification).
 *
 * `kind === 'ai_task'`: prompt is fed to the configured provider, the
 *   AI's reply becomes the result text. Original behavior.
 *
 * Run row lifecycle (v3 plan): one execution = one row. Insert
 * `task_run_logs` with status='running' up front, get `runId`, do the
 * work, then `updateTaskRunLog(runId, …)` flips to 'success' / 'error'
 * IN PLACE. No second insert.
 *
 * @param isSessionTask If true, skip SQLite writes and re-throw errors for caller handling.
 * @param providedRunId Optional pre-existing run row id (set by
 *   `runScheduledTaskNow`, which inserted the running row before locking
 *   the task). When omitted, this function inserts the row itself.
 */
async function executeDueTask(
  task: ScheduledTask,
  isSessionTask = false,
  providedRunId?: string,
): Promise<void> {
  const {
    updateScheduledTask,
    insertTaskRunLog,
    updateTaskRunLog,
  } = await import('@/lib/db');
  const startTime = Date.now();

  // Codex P1 — heartbeat stale-check guard. Earlier rev: when the app
  // started after being closed for a few minutes, any heartbeat row
  // with `next_run <= now` was picked up by the next 10s poll and
  // executed immediately. So restarting the app at 3:01pm (right after
  // the 3:00pm cron) would re-run the 3pm heartbeat. Worse, the cron
  // pattern `0 */N * * *` with N=24 means EVERY app start sees an
  // overdue next_run.
  //
  // Guard: for source='assistant_heartbeat', if last_run exists and
  // (now - last_run) is shorter than the heartbeat interval, skip
  // execution this tick and advance next_run to last_run + interval.
  // Heartbeats only RUN when they're genuinely stale per the user's
  // configured cadence; the scheduler poll loop is "may run if due
  // AND not too recent", not "must run immediately on app start".
  if (task.source === 'assistant_heartbeat' && task.last_run) {
    const intervalMs = heartbeatIntervalMsForTask(task);
    const lastRunMs = new Date(task.last_run).getTime();
    const sinceLastMs = Date.now() - lastRunMs;
    if (Number.isFinite(intervalMs) && sinceLastMs < intervalMs) {
      // Not stale — push next_run forward instead of running.
      const nextDue = new Date(lastRunMs + intervalMs).toISOString();
      try {
        updateScheduledTask(task.id, { next_run: nextDue });
      } catch { /* best-effort */ }
      console.log(
        `[scheduler] Heartbeat ${task.id} skipped: only ${Math.round(sinceLastMs / 60000)}m since last run (interval ${Math.round(intervalMs / 60000)}m); next_run pushed to ${nextDue}`,
      );
      return;
    }
  }

  // Mark task as running on the scheduled_tasks row. last_status keeps
  // its legacy enum (success/error/skipped/running) — Phase 3 Step 4
  // intentionally does NOT extend last_status to 5 states (the column
  // has a SQLite CHECK constraint we'd have to rebuild the table to
  // change). The 5-state machine lives only on `task_run_logs.status`,
  // and the Tasks page derives display state from the latest run.
  if (!isSessionTask) {
    updateScheduledTask(task.id, { last_status: 'running' });
  }

  // Phase 3 Step 4 — `ai_task` (both `source='user'` and
  // `source='assistant_heartbeat'`) goes through the agent task
  // runner. Reminder still uses the cheap text-only path since it
  // doesn't need a chat session. `providedRunId` (from
  // `runScheduledTaskNow`) is forwarded so the caller's pre-allocated
  // running row gets the terminal status update — without this,
  // manual "Run now" callers would see their runId stuck at
  // `'running'` forever while the runner used a separate runId.
  if (task.kind === 'ai_task' && !isSessionTask) {
    try {
      const { runScheduledAgentTask } = await import('./agent-task-runner');
      const out = await runScheduledAgentTask(task, providedRunId);
      const isHeartbeat = task.source === 'assistant_heartbeat';

      if (out.status === 'succeeded') {
        // Update scheduled_tasks. last_status stays in its legacy
        // alphabet — 'success' here is the correct legacy mapping.
        updateScheduledTask(task.id, {
          last_status: 'success',
          last_result: (out.result || '').slice(0, 2000),
          last_run: new Date().toISOString(),
          last_error: undefined,
          consecutive_errors: 0,
        });
        computeNextRun(task);

        // Heartbeat silent contract: no notification, no marker, no
        // assistant message (the runner already suppressed all three).
        // Heartbeat speak-up: notify with assistant-buddy framing.
        // Normal ai_task: notify per `notify_on_complete`.
        const isSilentHeartbeat = isHeartbeat && out.silent === true;
        const shouldNotify = !isSilentHeartbeat
          && (isHeartbeat || !!task.notify_on_complete);
        if (shouldNotify) {
          const titlePrefix = isHeartbeat ? '💬' : '✅';
          const eventId = await sendTaskNotification(
            `${titlePrefix} ${task.name}`,
            (out.result || '').slice(0, 200),
            task.priority as 'low' | 'normal' | 'urgent',
            { taskId: task.id, sessionId: out.sessionId || task.session_id },
          );
          if (eventId) {
            try { updateTaskRunLog(out.runId, { notification_event_id: eventId }); } catch { /* best effort */ }
          }
        }
      } else if (out.status === 'waiting_for_permission') {
        // Phase 3 Step 4 — paused state: scheduler must NOT re-trigger
        // this task on the next due tick. Park `scheduled_tasks.status`
        // at 'paused'; user resumes by entering the task-bound session
        // and choosing "Re-run this task" (creates a new runId from
        // scratch) or "Abandon" (cancelled). No durable resume in v1.
        updateScheduledTask(task.id, {
          status: 'paused',
          last_run: new Date().toISOString(),
          last_error: out.error || 'Permission required',
        });
        const eventId = await sendTaskNotification(
          `⚠️ ${task.name}`,
          'Background task paused — open the session to decide whether to re-run or abandon.',
          'urgent',
          { taskId: task.id, sessionId: out.sessionId || task.session_id },
        );
        if (eventId) {
          try { updateTaskRunLog(out.runId, { notification_event_id: eventId }); } catch { /* best effort */ }
        }
      } else {
        // failed / cancelled
        const errors = task.consecutive_errors + 1;
        updateScheduledTask(task.id, {
          last_status: 'error',
          last_error: out.error || 'Task failed',
          last_run: new Date().toISOString(),
          consecutive_errors: errors,
        });
        if (task.notify_on_complete || isHeartbeat) {
          const eventId = await sendTaskNotification(
            `❌ ${task.name}`,
            (out.error || 'Task failed').slice(0, 200),
            'urgent',
            { taskId: task.id, sessionId: out.sessionId || task.session_id },
          );
          if (eventId) {
            try { updateTaskRunLog(out.runId, { notification_event_id: eventId }); } catch { /* best effort */ }
          }
        }
        computeNextRun(task);
      }

      console.log(`[scheduler] Task ${task.id} (${task.name}, ${task.kind}, ${task.source}) → ${out.status}`);
      return;
    } catch (err) {
      // Defensive: agent-task-runner shouldn't throw (it returns a
      // failed result instead), but if it does, fall through to the
      // legacy reminder/error path so the task still gets a row.
      console.error('[scheduler] agent task runner threw:', err);
    }
  }

  // Pre-insert the running row so a concurrent UI poll of /runs sees
  // the in-flight execution. Session tasks skip DB entirely. (Reminder
  // path / fallback only — ai_task already has a row from the runner.)
  let runId: string | null = providedRunId ?? null;
  if (!isSessionTask && !runId) {
    try {
      runId = insertTaskRunLog({ task_id: task.id, status: 'running' }).runId;
    } catch {
      runId = null; // best effort — we still finish the task
    }
  }

  try {
    let result: string;

    if (task.kind === 'reminder') {
      // Reminder path: the prompt IS the notification body. No AI
      // provider call, so this works even when the user hasn't
      // configured any model. `notify_on_complete` is implicitly true
      // for reminders — a reminder that doesn't notify is meaningless.
      result = task.prompt;
    } else {
      // ai_task fallback (only reached on agent-runner exceptions or
      // session tasks). Keeps the v6 generateTextFromProvider one-shot
      // path so isSessionTask reminders still work.
      const { generateTextFromProvider } = await import('./text-generator');
      const { resolveProvider } = await import('./provider-resolver');
      const resolved = resolveProvider({ callScene: 'scheduled_task' });
      if (!resolved.hasCredentials) {
        throw new Error('No API credentials configured');
      }
      result = await generateTextFromProvider({
        callScene: 'scheduled_task',
        providerId: resolved.provider?.id || '',
        model: resolved.upstreamModel || resolved.model || 'sonnet',
        system: `You are executing a scheduled task. Be concise and direct.\nTask name: ${task.name}\nCurrent time: ${new Date().toLocaleString()}`,
        prompt: task.prompt,
        maxTokens: 1000,
      });
    }

    // Success — update SQLite (skip for session tasks)
    if (!isSessionTask) {
      updateScheduledTask(task.id, {
        last_status: 'success',
        last_result: result.slice(0, 2000),
        last_run: new Date().toISOString(),
        last_error: undefined,
        consecutive_errors: 0,
      });

      // v3 plan: ONE row per execution. Update the row we inserted at
      // the top of this function from 'running' → 'success'.
      if (runId) {
        try {
          updateTaskRunLog(runId, {
            status: 'success',
            result: result.slice(0, 2000),
            duration_ms: Date.now() - startTime,
          });
        } catch { /* best effort logging */ }
      }

      computeNextRun(task);
    }

    // Notify on completion. Reminders always notify (they ARE the
    // notification); ai_task fallback respects `notify_on_complete`.
    const shouldNotify = task.kind === 'reminder' || !!task.notify_on_complete;
    if (shouldNotify) {
      const titlePrefix = task.kind === 'reminder' ? '⏰' : '✅';
      const eventId = await sendTaskNotification(
        `${titlePrefix} ${task.name}`,
        result.slice(0, 200),
        task.priority as 'low' | 'normal' | 'urgent',
        { taskId: task.id, sessionId: task.session_id },
      );
      if (!isSessionTask && runId && eventId) {
        try {
          updateTaskRunLog(runId, { notification_event_id: eventId });
        } catch { /* best effort */ }
      }
    }

    console.log(`[scheduler] Task ${task.id} (${task.name}, ${task.kind}) completed`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    const errors = task.consecutive_errors + 1;

    // For session tasks: skip SQLite writes and re-throw so the poll loop handles backoff
    if (isSessionTask) {
      // Notify on failure (best effort)
      if (task.notify_on_complete || task.kind === 'reminder') {
        await sendTaskNotification(
          `❌ ${task.name}`,
          errorMsg.slice(0, 200),
          'urgent',
          { taskId: task.id, sessionId: task.session_id },
        ).catch(() => {});
      }
      console.error(`[scheduler] Session task ${task.id} (${task.name}) error:`, errorMsg);
      throw err;
    }

    updateScheduledTask(task.id, {
      last_status: 'error',
      last_error: errorMsg,
      last_run: new Date().toISOString(),
      consecutive_errors: errors,
    });

    // v3 plan: same row, terminal flip. If for some reason runId is
    // null (insert failed earlier), fall back to a fresh terminal row
    // — preserves history at the cost of skipping the running row.
    if (runId) {
      try {
        updateTaskRunLog(runId, {
          status: 'error',
          error: errorMsg,
          duration_ms: Date.now() - startTime,
        });
      } catch { /* best effort logging */ }
    } else {
      try {
        insertTaskRunLog({
          task_id: task.id,
          status: 'error',
          error: errorMsg,
          duration_ms: Date.now() - startTime,
        });
      } catch { /* best effort logging */ }
    }

    // Exponential backoff
    applyBackoff(task.id, errors);

    // Notify on failure. v6 fix (P1): same event_id linkage as the
    // success path so failed runs surface their delivery log too —
    // otherwise users see "task errored" with no record of which
    // notification channels did/didn't carry the failure notice.
    if (task.notify_on_complete || task.kind === 'reminder') {
      const failureEventId = await sendTaskNotification(
        `❌ ${task.name}`,
        errorMsg.slice(0, 200),
        'urgent',
        { taskId: task.id, sessionId: task.session_id },
      );
      if (runId && failureEventId) {
        try {
          updateTaskRunLog(runId, { notification_event_id: failureEventId });
        } catch { /* best effort */ }
      }
    }

    // Codex P2 — earlier rev fell back to "latest workspace session"
    // here when task.session_id was empty, then wrote the failure as
    // an assistant message there. Same cross-project bleed shape as
    // handleMissedTasks before its fix: a project-A ai_task that
    // crashed could land its error message in project-B's assistant
    // chat (whichever workspace session sorted as latest). The
    // failure is already surfaced to the user via:
    //   1. sendTaskNotification(❌ task.name, errorMsg, urgent) above
    //   2. task_run_logs row terminal-flipped to 'error' with the
    //      error column populated
    //   3. /settings/tasks "View runs" surfaces (1) + (2) in the
    //      UI, with the failure notice linked back to the run row.
    //
    // For tasks that already have a task-bound execution session
    // (task.session_id pointing at source='task'), it's still useful
    // to drop a record of the failure into THAT session — the user
    // opens the task to see what went wrong. So we keep the write
    // when task.session_id is set, but DROP the latest-workspace
    // fallback. ensureTaskBoundSession was supposed to populate
    // task.session_id by now anyway; if it didn't (very early
    // failure), notification + log are sufficient.
    if (task.kind === 'ai_task' && task.session_id) {
      try {
        const { addMessage, getSession, getSetting } = await import('@/lib/db');
        const targetSession = getSession(task.session_id);
        // Only write when the session is actually a task-bound execution
        // surface. A stale `session_id` pointing at a `source='user'`
        // chat (legacy dirty rows) must NOT receive the failure
        // message — same guard the runner's ensureTaskBoundSession
        // applies. Notification + run row remain the user's view.
        if (targetSession && targetSession.source === 'task') {
          const workspacePath = getSetting('assistant_workspace_path');
          let buddyPrefix = '❌';
          try {
            const { loadState } = await import('@/lib/assistant-workspace');
            if (workspacePath) {
              const st = loadState(workspacePath);
              if (st.buddy) {
                buddyPrefix = `${st.buddy.emoji} ${st.buddy.buddyName || ''}`.trim();
              }
            }
          } catch {}
          addMessage(
            targetSession.id,
            'assistant',
            `${buddyPrefix} ❌ **${task.name}** (定时任务失败)\n\n${errorMsg}`,
          );
        }
      } catch { /* best effort */ }
    }

    console.error(`[scheduler] Task ${task.id} (${task.name}, ${task.kind}) error (${errors}x):`, errorMsg);
  }
}

/**
 * Phase 3 Step 3 — controlled execution entry. Used by `/api/tasks/[id]/run`
 * (the "Run Now" button) and by anywhere else that wants to trigger a task
 * outside the poll cycle.
 *
 * Behavior:
 *   - Atomically takes a "running" lock on the task via UPDATE … WHERE
 *     last_status != 'running'. Concurrent calls (poll-cycle + Run Now
 *     racing) cooperate: only one wins the lock; the other gets back
 *     `{ status: 'already_running', runId }` referencing the in-flight row.
 *   - Inserts a single `task_run_logs` row with status='running' up
 *     front and returns its `runId` synchronously, so the API can
 *     respond immediately. The actual execution runs fire-and-forget
 *     and updates the same row when it terminates.
 *
 * The poll loop calls `executeDueTask` directly with `providedRunId`
 * obtained the same way; both paths share the same row-lifecycle.
 */
export async function runScheduledTaskNow(taskId: string): Promise<
  | { status: 'running'; runId: string }
  | { status: 'already_running'; runId: string | null }
  | { status: 'not_found' }
> {
  const { getScheduledTask, getDb } = await import('@/lib/db');
  const task = getScheduledTask(taskId);
  if (!task) return { status: 'not_found' };

  // Row-level lock. The UPDATE only matches when last_status isn't
  // already 'running' — concurrent invocations get back changes=0 and
  // we report `already_running`. We intentionally do NOT use a separate
  // mutex column because last_status already encodes the in-flight
  // state and the WHERE clause is atomic in SQLite.
  const db = getDb();
  const lock = db
    .prepare(
      "UPDATE scheduled_tasks SET last_status = 'running', updated_at = datetime('now') WHERE id = ? AND (last_status IS NULL OR last_status != 'running')",
    )
    .run(taskId);
  if (lock.changes === 0) {
    // Another caller (poll-cycle or another /run press) is already
    // executing. Surface the in-flight runId if we have one.
    const { listTaskRunLogs } = await import('@/lib/db');
    const recent = listTaskRunLogs(taskId, 1);
    const inflight = recent[0]?.status === 'running' ? recent[0].id : null;
    return { status: 'already_running', runId: inflight };
  }

  const { insertTaskRunLog } = await import('@/lib/db');
  const { runId } = insertTaskRunLog({ task_id: taskId, status: 'running' });

  // Fire-and-forget; caller (API) returns the runId immediately so the
  // UI can pivot to "running" without blocking on the actual work.
  executeDueTask(task, false, runId).catch((err) => {
    console.error(`[scheduler] runScheduledTaskNow(${taskId}) post-handler error:`, err);
  });

  return { status: 'running', runId };
}

/**
 * Phase 3 Step 3 — startup recovery for stale `running` rows. A crash
 * mid-execution leaves a task with `last_status='running'` and
 * `getDueTasks()` will skip it forever. Walk all `running` tasks at
 * startup and reset to `error` with an exponential backoff `next_run`
 * so the user sees the failure and the task tries again later.
 *
 * Threshold: 30 minutes since the row was last updated. Tasks
 * legitimately in flight finish well before that; anything older is
 * almost certainly a crash.
 */
async function recoverStaleRunningTasks(): Promise<void> {
  const { getDb, listScheduledTasks, updateScheduledTask, listTaskRunLogs, updateTaskRunLog } =
    await import('@/lib/db');
  const STALE_MS = 30 * 60 * 1000;
  const now = Date.now();
  const running = listScheduledTasks().filter((t) => t.last_status === 'running');
  if (running.length === 0) return;

  for (const task of running) {
    const lastUpdate = task.updated_at ? new Date(task.updated_at).getTime() : 0;
    if (now - lastUpdate < STALE_MS) continue; // genuinely in flight

    const errors = (task.consecutive_errors || 0) + 1;
    const backoffMs = BACKOFF_DELAYS[Math.min(errors - 1, BACKOFF_DELAYS.length - 1)];
    const nextRun = new Date(now + backoffMs).toISOString();

    updateScheduledTask(task.id, {
      last_status: 'error',
      last_error: 'Task interrupted (process restarted while running)',
      consecutive_errors: errors,
      next_run: nextRun,
    });

    // Flip the most recent running run-row to 'error' too so history
    // doesn't pretend the task is still in flight.
    try {
      const recent = listTaskRunLogs(task.id, 1);
      if (recent[0]?.status === 'running') {
        updateTaskRunLog(recent[0].id, {
          status: 'error',
          error: 'Task interrupted (process restarted while running)',
        });
      }
    } catch { /* best effort */ }

    console.warn(`[scheduler] Recovered stale running task ${task.id} (${task.name}) — backoff ${backoffMs}ms`);
    void getDb; // keep the import live in case we add a transaction later
  }
}

/**
 * Deterministic jitter: same task always gets the same jitter offset.
 * Prevents thundering-herd when many tasks share the same interval.
 */
function getJitter(taskId: string, intervalMs: number): number {
  const hash = parseInt(taskId.slice(0, 8), 16) / 0xFFFFFFFF;
  const maxJitter = Math.min(intervalMs * 0.1, 15 * 60 * 1000); // 10% of interval, max 15min
  return Math.floor(hash * maxJitter);
}

/**
 * Compute and set the next_run time for a recurring task.
 */
async function computeNextRun(task: ScheduledTask): Promise<void> {
  const { updateScheduledTask } = await import('@/lib/db');
  const now = new Date();

  switch (task.schedule_type) {
    case 'once':
      updateScheduledTask(task.id, { status: 'completed' });
      return;

    case 'interval': {
      const ms = parseInterval(task.schedule_value);
      const lastRun = new Date(task.last_run || now.toISOString());
      let nextRun = new Date(lastRun.getTime() + ms);
      // Anchor-based: skip past missed runs
      while (nextRun <= now) nextRun = new Date(nextRun.getTime() + ms);
      // Apply deterministic jitter to avoid thundering-herd
      nextRun = new Date(nextRun.getTime() + getJitter(task.id, ms));
      updateScheduledTask(task.id, { next_run: nextRun.toISOString() });
      break;
    }

    case 'cron': {
      const nextRun = getNextCronTime(task.schedule_value);
      if (nextRun) {
        updateScheduledTask(task.id, { next_run: nextRun.toISOString() });
      } else {
        // No valid next occurrence within 4 years — pause the task
        updateScheduledTask(task.id, { status: 'paused', last_error: 'No valid cron match within 4 years' });
        console.warn(`[scheduler] Task ${task.id} paused: cron "${task.schedule_value}" has no match within 4 years`);
      }
      break;
    }
  }
}

/**
 * Apply exponential backoff after task failure.
 */
async function applyBackoff(taskId: string, errors: number): Promise<void> {
  const { updateScheduledTask } = await import('@/lib/db');
  const delay = BACKOFF_DELAYS[Math.min(errors - 1, BACKOFF_DELAYS.length - 1)];
  const nextRun = new Date(Date.now() + delay);
  updateScheduledTask(taskId, { next_run: nextRun.toISOString() });

  // Auto-disable after too many consecutive failures
  if (errors >= MAX_CONSECUTIVE_ERRORS) {
    updateScheduledTask(taskId, { status: 'disabled' });
    console.warn(`[scheduler] Task ${taskId} auto-disabled after ${errors} consecutive failures`);
  }
}

/**
 * Send a notification via the notify API (which handles Toast + Electron + Telegram).
 *
 * Phase 3 Step 3 — payload extension. The fourth arg carries `taskId`
 * and `sessionId` so the notification-manager can stamp the resulting
 * `notification_events` row with the source task, and Electron can put
 * them in the OS notification's click payload to drive
 * `router.push('/settings/tasks?focus=…')` when the user clicks.
 *
 * v6 fix (P1) — returns the new `event_id` so the caller can write
 * `task_run_logs.notification_event_id = event_id`, which is what
 * `/api/tasks/[id]/runs` joins on to surface delivery details. Without
 * that link, the runs API would always return `event=null` and the
 * UI would never see "this run notified renderer-toast: delivered,
 * bridge-telegram: not_configured" even though the rows exist in DB.
 *
 * Returns `null` only on a hard send failure (sendNotification threw);
 * a fired notification with zero successful channels still returns
 * its event_id — the per-channel statuses are visible via the link.
 */
async function sendTaskNotification(
  title: string,
  body: string,
  priority: 'low' | 'normal' | 'urgent',
  payload?: { taskId?: string; sessionId?: string },
): Promise<string | null> {
  try {
    const { sendNotification } = await import('@/lib/notification-manager');
    const result = await sendNotification({
      title,
      body,
      priority,
      taskId: payload?.taskId,
      sessionId: payload?.sessionId,
      source: 'codepilot',
    });
    // #34 observability — confirm the notification reached the queue (the
    // chain's first hop). If a task "fires but no popup", grep `[notify]`:
    // enqueue OK here but no Electron `[notify]` show line ⇒ the bg-poller /
    // renderer drain dropped it; enqueue FAILED below ⇒ the queue never got it.
    console.log(`[notify] enqueued event_id=${result.event_id ?? 'null'} priority=${priority} title=${JSON.stringify(title)}`);
    return result.event_id;
  } catch (err) {
    // #34: previously swallowed silently — surface it so a failed enqueue is
    // visible in logs (still best-effort: never block task execution).
    console.error('[notify] enqueue FAILED (task notification not queued):', err);
    return null;
  }
}

// ── Missed task recovery ──────────────────────────────────────────

/**
 * One-time recovery for tasks that were missed while the app was closed.
 * Finds past-due one-shot tasks and executes them immediately with a notification.
 */
async function handleMissedTasks(): Promise<void> {
  const { getDueTasks } = await import('@/lib/db');

  // Find one-shot tasks that are past due (missed while app was closed)
  const dueTasks = getDueTasks();
  const missedOnce = dueTasks.filter(t => t.schedule_type === 'once');

  if (missedOnce.length === 0) return;

  console.log(`[scheduler] Found ${missedOnce.length} missed one-shot task(s)`);

  for (const task of missedOnce) {
    // Codex P1 — earlier rev wrote a "过期提醒" assistant message
    // into the latest workspace session as a fallback when
    // task.session_id was empty. That fallback was the same
    // cross-project-bleed pattern the origin_session_id fix closed
    // for the main runner path: a missed ai_task created from
    // project A could land its "missed" notice in project B's
    // assistant chat (whichever workspace session sorted as
    // latest). We now ONLY send a notification — the executeDueTask
    // call below routes through agent-task-runner which creates a
    // proper task-bound session via ensureTaskBoundSession +
    // origin_session_id inheritance, so the run result lands where
    // it should.
    sendTaskNotification(
      `⏰ ${task.name}`,
      `Missed during downtime — running now. Open the task to view the result.`,
      'normal',
      { taskId: task.id, sessionId: task.session_id },
    ).catch(() => { /* best effort */ });

    // Execute the missed task immediately
    executeDueTask(task).catch(err =>
      console.error(`[scheduler] Missed task ${task.id} execution failed:`, err)
    );
  }
}

/**
 * Auto-expire recurring tasks older than 7 days (unless marked permanent).
 */
async function checkExpiredTasks(): Promise<void> {
  const { listScheduledTasks, updateScheduledTask } = await import('@/lib/db');
  const now = Date.now();
  const activeTasks = listScheduledTasks({ status: 'active' });

  for (const task of activeTasks) {
    if (task.schedule_type === 'once') continue; // once tasks complete themselves
    if (task.permanent) continue; // permanent tasks never expire

    const age = now - new Date(task.created_at).getTime();
    if (age > RECURRING_MAX_AGE_MS) {
      updateScheduledTask(task.id, { status: 'disabled' });
      console.log(`[scheduler] Task ${task.id} (${task.name}) auto-expired after 7 days`);

      // Notify
      try {
        await sendTaskNotification(`⏰ ${task.name}`, 'This recurring task has auto-expired after 7 days. Recreate it if needed.', 'low');
      } catch { /* best effort */ }
    }
  }
}

// ── Utility functions ──────────────────────────────────────────────

/**
 * Phase 3 Step 4 — system-injected heartbeat task management.
 *
 * Heartbeat is **NOT** a separate kind. It's an `ai_task` with
 * `source='assistant_heartbeat'`. The runner branches on `source` to
 * reuse the buddy session and apply the silent contract; everything
 * else (scheduling, status tracking, notification routing) is the
 * normal ai_task path.
 *
 * `ensureHeartbeatTask({ enabled, intervalHours })` is idempotent:
 *   - `enabled === false` (or `intervalHours <= 0`) → delete any
 *     existing heartbeat row (no-op if none).
 *   - `enabled === true` → ensure exactly one row with the given
 *     interval. If a row exists with a different interval, update it
 *     in place (don't churn the id).
 *
 * Interval enforcement: minimum 1 hour to avoid background polling
 * pressure. `intervalHours < 1` is treated as 1.
 */
export async function ensureHeartbeatTask(opts: {
  enabled: boolean;
  intervalHours?: number;
}): Promise<void> {
  const { getHeartbeatTask, removeHeartbeatTask, createScheduledTask, updateScheduledTask } = await import('@/lib/db');
  const desiredInterval = Math.max(1, Math.floor(opts.intervalHours ?? 24));

  if (!opts.enabled) {
    removeHeartbeatTask();
    return;
  }

  // cron at every Nth hour at minute 0. For intervals > 24 we fall
  // back to "0 9 * * *" (daily 9 AM) — multi-day cadence isn't worth
  // the complexity.
  const cronExpr = desiredInterval >= 24
    ? '0 9 * * *'
    : `0 */${desiredInterval} * * *`;

  const existing = getHeartbeatTask();
  if (existing) {
    // Always re-sync prompt + schedule when the existing row has any
    // drift. A user upgrading from the pre-Codex-P1 build still has a
    // row with the old "respond per silent contract" prompt, which
    // lets the model fan out into list_tasks / shell / etc. Lifting
    // it to HEARTBEAT_TASK_PROMPT here closes that path on first
    // app start after the upgrade.
    const promptDrift = existing.prompt !== HEARTBEAT_TASK_PROMPT;
    const scheduleDrift = existing.schedule_value !== cronExpr || existing.status !== 'active';
    if (promptDrift || scheduleDrift) {
      // Codex P1 — DON'T move next_run forward to the next cron
      // boundary just because we touched the row. If the existing
      // row's next_run is already in the future, leave it alone; if
      // it's overdue we still let the scheduler stale-check guard
      // (see executeDueTask) decide whether to actually run. This
      // avoids "user upgrades the app at 3pm, heartbeat row gets
      // re-synced, next_run gets reset to 4pm cron boundary, runs
      // again at 4pm" creating a fresh run on every redeploy.
      const updates: Partial<typeof existing> = {
        prompt: HEARTBEAT_TASK_PROMPT,
        schedule_value: cronExpr,
        status: 'active',
      };
      // Only refresh next_run when the existing one is missing or
      // overdue + clearly stale enough that we'd want to "wake up"
      // anyway. Conservative default: leave next_run alone unless
      // it's obviously bogus.
      if (!existing.next_run) {
        const next = getNextCronTime(cronExpr);
        updates.next_run = next
          ? next.toISOString()
          : new Date(Date.now() + 3600_000).toISOString();
      }
      updateScheduledTask(existing.id, updates);
    }
    return;
  }

  const next = getNextCronTime(cronExpr);
  createScheduledTask({
    name: 'Assistant heartbeat',
    // Codex P1 — heartbeat prompt deliberately narrow. Earlier rev
    // told the model "respond per silent contract" with no tool
    // restrictions, so the model would routinely fan out into
    // codepilot_list_tasks (recursing on the scheduler itself),
    // memory search, file reads, shell `date`, etc. and on a runtime
    // that doesn't honor a final `done` after a step the headless
    // run would hang forever. Here we list the legal sources of
    // information explicitly and forbid the dangerous ones; the
    // runner ALSO disallows the same tool list at the SDK level
    // (see agent-task-runner.ts heartbeat branch) — belt + suspenders.
    prompt: HEARTBEAT_TASK_PROMPT,
    schedule_type: 'cron',
    schedule_value: cronExpr,
    kind: 'ai_task',
    source: 'assistant_heartbeat',
    next_run: next ? next.toISOString() : new Date(Date.now() + 3600_000).toISOString(),
    consecutive_errors: 0,
    status: 'active',
    priority: 'normal',
    notify_on_complete: 1,
    permanent: 1,
  });
}

/**
 * Heartbeat prompt — exported so the runner's heartbeat-branch
 * systemPrompt can reuse it / append to it. Phrased as instructions
 * to the model:
 *
 *   - Only HEARTBEAT.md + (optional) memory_recent are legal data
 *     sources for this turn. Do NOT call codepilot_list_tasks or any
 *     other scheduler-introspection tool — heartbeat would recurse
 *     into the scheduling system it lives inside.
 *   - At most ONE tool call. If HEARTBEAT.md is empty / says nothing
 *     needs attention, respond with exactly `HEARTBEAT_OK` and stop.
 *   - The silent contract is exact-trim: any other output (including
 *     `HEARTBEAT_OK\n\nfoo`) is a speak-up.
 */
/**
 * Codex P1 — derive heartbeat cadence (in ms) from the task's cron
 * expression. ensureHeartbeatTask writes either "0 [slash][star]N * * *"
 * (every Nth hour) or "0 9 * * *" (daily 9am for intervals >= 24h).
 * We back the chosen N out of the cron string for the stale-check
 * guard rather than reading workspace state, so the guard works
 * even when settings/workspace state is unavailable to the scheduler
 * thread. Note: cron-syntax slash-star can't be written verbatim
 * here because it closes the JSDoc block.
 *
 * Returns 24h as a conservative default when the cron doesn't match
 * either heartbeat shape (legacy rows, manual overrides) — that's
 * the upper bound, so the worst case is "we run once a day instead
 * of catching every interval boundary", which is still safer than
 * the pre-fix "run on every app start".
 */
export function heartbeatIntervalMsForTask(task: ScheduledTask): number {
  const HOUR_MS = 3_600_000;
  const cron = task.schedule_value || '';
  // "0 */N * * *" cron pattern → every N hours
  const everyNHours = cron.match(/^\s*0\s+\*\/(\d+)\s+\*\s+\*\s+\*\s*$/);
  if (everyNHours) {
    const n = parseInt(everyNHours[1], 10);
    if (Number.isFinite(n) && n >= 1) return n * HOUR_MS;
  }
  // 0 9 * * *  → daily 9am (interval >= 24h)
  if (/^\s*0\s+\d+\s+\*\s+\*\s+\*\s*$/.test(cron)) return 24 * HOUR_MS;
  return 24 * HOUR_MS;
}

export const HEARTBEAT_TASK_PROMPT =
  '[Heartbeat check]\n\n' +
  'You are doing a periodic background check. Strict rules for this turn:\n' +
  '1. HEARTBEAT.md content is already injected as context below. Read it.\n' +
  '2. You MAY make AT MOST ONE tool call — and only `codepilot_memory_recent` if you genuinely need recent memory context to interpret HEARTBEAT.md. Do NOT call: codepilot_list_tasks, codepilot_schedule_task, codepilot_cancel_task, codepilot_hatch_buddy, codepilot_notify, any shell command, Bash, or other agent / web / search tools. Heartbeat introspecting the scheduler would recurse.\n' +
  '3. If HEARTBEAT.md is empty, missing, or its content does not require user attention right now: respond with EXACTLY the literal string `HEARTBEAT_OK` and nothing else. No prefix, no suffix, no markdown.\n' +
  '4. Otherwise, write a SHORT (<= 2 sentence) message to the user about what needs attention. Do not invent items not grounded in HEARTBEAT.md.';

/**
 * Parse interval string like "30m", "2h", "1d" to milliseconds.
 */
export function parseInterval(value: string): number {
  const match = value.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 10 * 60 * 1000; // default 10m
  const num = parseInt(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return num * (multipliers[unit] || 60000);
}

/**
 * Simple 5-field cron expression parser.
 * Day-level scan over 4 years (1461 days) to cover all valid schedules
 * including leap-year-only dates like `0 9 29 2 *`.
 */
export function getNextCronTime(expression: string): Date | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    console.warn(`[scheduler] Invalid cron expression: "${expression}"`);
    return null;
  }

  const now = new Date();

  // Scan each day for up to 4 years, testing all 1440 minutes per day.
  // For common expressions this returns on day 0-1; sparse ones (monthly, yearly)
  // may scan further but the day-level outer loop keeps it bounded.
  for (let day = 0; day <= 1461; day++) {
    const baseDate = new Date(now.getTime() + day * 86400000);
    const y = baseDate.getFullYear();
    const mo = baseDate.getMonth();
    const d = baseDate.getDate();

    // Quick pre-check: skip this day entirely if dom/month/dow can't match
    const testDate = new Date(y, mo, d, 0, 0, 0, 0);
    if (!matchField(testDate.getDate(), parts[2]) ||
        !matchField(testDate.getMonth() + 1, parts[3]) ||
        !matchField(testDate.getDay(), parts[4])) {
      continue;
    }

    // Day matches — scan minutes
    for (let m = 0; m < 1440; m++) {
      const candidate = new Date(y, mo, d, Math.floor(m / 60), m % 60, 0, 0);
      if (candidate <= now) continue;
      if (matchField(candidate.getMinutes(), parts[0]) &&
          matchField(candidate.getHours(), parts[1])) {
        return candidate;
      }
    }
  }

  // No match found within 4 years — expression is either impossible (e.g. Feb 30)
  // or extremely sparse (e.g. Feb 29 on a specific weekday). Return null so
  // callers can pause the task instead of scheduling a fake execution time.
  console.warn(`[scheduler] No cron match for "${expression}" within 4 years`);
  return null;
}

function matchesCron(date: Date, parts: string[]): boolean {
  const [min, hour, dom, month, dow] = parts;
  return matchField(date.getMinutes(), min)
    && matchField(date.getHours(), hour)
    && matchField(date.getDate(), dom)
    && matchField(date.getMonth() + 1, month)
    && matchField(date.getDay(), dow);
}

function matchField(value: number, field: string): boolean {
  if (field === '*') return true;
  if (field.includes('/')) {
    const [base, step] = field.split('/');
    const stepNum = parseInt(step);
    if (base === '*') return value % stepNum === 0;
    return value >= parseInt(base) && (value - parseInt(base)) % stepNum === 0;
  }
  if (field.includes(',')) {
    return field.split(',').map(Number).includes(value);
  }
  if (field.includes('-')) {
    const [start, end] = field.split('-').map(Number);
    return value >= start && value <= end;
  }
  return parseInt(field) === value;
}
