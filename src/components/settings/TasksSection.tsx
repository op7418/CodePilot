"use client";

/**
 * Settings → 定时任务 / Tasks — global task center (Phase 3 Step 3,
 * v6 review-fix product redesign).
 *
 * Owns the user-facing task management surface. Per the v6 product
 * direction: the page is **list-only**. Creation flows through the AI
 * tool (`codepilot_schedule_task`) — clicking "New Task" opens a chat
 * with a prefilled prompt that nudges the model to call the tool. The
 * UI does not duplicate the create logic; `/api/tasks/schedule` is the
 * server-side persistence path used by tools, not a primary user-facing
 * dialog.
 *
 * Capabilities here:
 *   - List durable scheduled tasks
 *   - Per-row: Run now / Pause / Resume / Delete
 *   - Per-row: expand to see the most recent execution + its
 *     `notification_events` + `notification_deliveries` rows
 *     (which channel delivered / errored / not_configured / skipped)
 *   - URL: `?focus=<taskId>` highlights and scrolls to the matching
 *     row (driven by Electron notification clicks)
 *
 * Heartbeat config is intentionally NOT here — that lives in
 * Settings → Assistant. Tasks page is the global / per-task view.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import { Button } from "@/components/ui/button";
import { CodePilotIcon } from "@/components/ui/semantic-icon";
import { cn } from "@/lib/utils";

interface TaskRow {
  id: string;
  name: string;
  prompt: string;
  schedule_type: "cron" | "interval" | "once";
  schedule_value: string;
  kind: "reminder" | "ai_task";
  next_run: string;
  last_run?: string;
  last_status?: "success" | "error" | "skipped" | "running";
  last_error?: string;
  last_result?: string;
  status: "active" | "paused" | "completed" | "disabled";
  priority: "low" | "normal" | "urgent";
  /** Phase 3 Step 4 — task-bound chat session id (set on first run). */
  session_id?: string | null;
  created_at: string;
}

interface DeliveryRow {
  channel: string;
  status: string;
  error: string | null;
  acked_at: string | null;
}

interface RunRow {
  id: string;
  task_id: string;
  status: string;
  result: string | null;
  error: string | null;
  duration_ms: number | null;
  notification_event_id: string | null;
  created_at: string;
  event: {
    event_id: string;
    title: string;
    body: string;
    priority: string;
  } | null;
  deliveries: DeliveryRow[];
}

const NEW_TASK_PREFILL =
  "请帮我创建一个定时任务。先问我一两个问题确认意图（提醒还是 AI 任务、何时触发、提醒文本 / AI 指令是什么），然后调用 codepilot_schedule_task 工具创建。";

function formatRelative(iso: string | undefined, isZh: boolean): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(isZh ? "zh-CN" : undefined);
}

function deliveryStatusToTone(status: string): string {
  switch (status) {
    case "delivered":
      return "text-status-success-foreground";
    case "error":
      return "text-destructive";
    case "queued":
      return "text-muted-foreground";
    case "not_configured":
    case "skipped":
      return "text-muted-foreground/70";
    default:
      return "text-muted-foreground";
  }
}

export function TasksSection() {
  const { t, locale } = useTranslation();
  const isZh = locale === "zh";
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusId = searchParams.get("focus");

  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(focusId);
  const [runsByTask, setRunsByTask] = useState<Record<string, RunRow[]>>({});
  const focusedRowRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks/list");
      if (!res.ok) return;
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch {
      // best effort
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  // Scroll the focused row into view after the list lands.
  useEffect(() => {
    if (!focusId || !focusedRowRef.current) return;
    focusedRowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, tasks]);

  // Lazy-load runs for the expanded task so the list page itself
  // stays light. /api/tasks/[id]/runs returns up to 50 of the most
  // recent task_run_logs joined to events + deliveries.
  useEffect(() => {
    if (!expanded) return;
    if (runsByTask[expanded]) return; // cached
    let cancelled = false;
    fetch(`/api/tasks/${expanded}/runs`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setRunsByTask((prev) => ({ ...prev, [expanded]: data.runs || [] }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [expanded, runsByTask]);

  const handleNewTaskInChat = useCallback(() => {
    // v6 product redesign: don't open a creation form. Send the user
    // to /chat with a prefilled prompt that asks the AI to call the
    // canonical `codepilot_schedule_task` tool. The chat page reads
    // `?prefill=` on mount and stages the message into the composer.
    router.push(`/chat?prefill=${encodeURIComponent(NEW_TASK_PREFILL)}`);
  }, [router]);

  const handleRunNow = useCallback(async (taskId: string) => {
    setActionPending(taskId);
    try {
      await fetch(`/api/tasks/${taskId}/run`, { method: "POST" });
      // Give the scheduler a moment to flip last_status, then refresh.
      setTimeout(() => {
        void refresh();
        // Also invalidate the cached runs so the freshly-fired run
        // shows up if this task is expanded.
        setRunsByTask((prev) => {
          const next = { ...prev };
          delete next[taskId];
          return next;
        });
      }, 500);
    } finally {
      setActionPending(null);
    }
  }, [refresh]);

  const handlePause = useCallback(async (taskId: string, currentStatus: string) => {
    setActionPending(taskId);
    try {
      const action = currentStatus === "paused" ? "resume" : "pause";
      await fetch(`/api/tasks/${taskId}/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await refresh();
    } finally {
      setActionPending(null);
    }
  }, [refresh]);

  const handleDelete = useCallback(async (taskId: string) => {
    setActionPending(taskId);
    try {
      await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
      await refresh();
    } finally {
      setActionPending(null);
    }
  }, [refresh]);

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      // Focused row first, then active before paused, then by next_run ascending
      if (focusId && a.id === focusId) return -1;
      if (focusId && b.id === focusId) return 1;
      if (a.status !== b.status) {
        const order: Record<string, number> = { active: 0, paused: 1, disabled: 2, completed: 3 };
        return (order[a.status] ?? 9) - (order[b.status] ?? 9);
      }
      return (a.next_run || "").localeCompare(b.next_run || "");
    });
  }, [tasks, focusId]);

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{t("settings.tasks" as TranslationKey)}</h2>
        <p className="text-sm text-muted-foreground mt-1.5">
          {t("settings.tasksDesc" as TranslationKey)}
        </p>
      </div>

      {/* Single button row — left-align since there's no sibling on the
          left. Earlier `justify-end` made the button float over to the
          right corner alone, which felt detached from the page title /
          description. */}
      <div className="flex items-center justify-start">
        <Button size="sm" onClick={handleNewTaskInChat}>
          <CodePilotIcon name="plus" size="sm" aria-hidden />
          {t("tasks.create" as TranslationKey)}
        </Button>
      </div>

      {loading ? (
        <div className="rounded-lg border border-dashed border-border/50 bg-card/50 p-10 text-center">
          <p className="text-xs text-muted-foreground">{t("tasks.loading")}</p>
        </div>
      ) : sortedTasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 bg-card/50 p-10 text-center space-y-2">
          <p className="text-sm text-muted-foreground">{t("tasks.empty" as TranslationKey)}</p>
          <p className="text-[11px] text-muted-foreground/70">
            {t("tasks.createHint" as TranslationKey)}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {sortedTasks.map((task) => {
            const isFocused = focusId === task.id;
            const isExpanded = expanded === task.id;
            const runs = runsByTask[task.id] || [];
            return (
              <div
                key={task.id}
                ref={isFocused ? focusedRowRef : null}
                data-task-row={task.id}
                className={cn(
                  "rounded-lg border bg-card/50 p-4",
                  isFocused
                    ? "border-primary/60 ring-1 ring-primary/40"
                    : "border-border/50",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setExpanded((cur) => (cur === task.id ? null : task.id))}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{task.name}</span>
                      <span
                        className={cn(
                          "text-[10px] px-1.5 py-0.5 rounded",
                          task.kind === "reminder"
                            ? "bg-primary/10 text-primary"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {task.kind === "reminder"
                          ? t("tasks.kindReminder" as TranslationKey)
                          : t("tasks.kindAiTask" as TranslationKey)}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase">
                        {task.status}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{task.prompt}</p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground mt-2">
                      <span>
                        {t("tasks.schedule" as TranslationKey)}:{" "}
                        <span className="font-mono text-foreground/80">
                          {task.schedule_type} / {task.schedule_value}
                        </span>
                      </span>
                      <span>
                        {t("tasks.nextRun" as TranslationKey)}:{" "}
                        <span className="font-mono text-foreground/80">
                          {formatRelative(task.next_run, isZh)}
                        </span>
                      </span>
                      {task.last_run && (
                        <span>
                          {t("tasks.lastRun" as TranslationKey)}:{" "}
                          <span className="font-mono text-foreground/80">
                            {formatRelative(task.last_run, isZh)}
                          </span>
                          {task.last_status && (
                            <span
                              className={cn(
                                "ml-1",
                                task.last_status === "success"
                                  ? "text-status-success-foreground"
                                  : task.last_status === "error"
                                  ? "text-destructive"
                                  : "",
                              )}
                            >
                              ({task.last_status})
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </button>
                  <div className="shrink-0 flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={actionPending === task.id || task.status !== "active"}
                      onClick={() => handleRunNow(task.id)}
                    >
                      {t("tasks.runNow" as TranslationKey)}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={actionPending === task.id}
                      onClick={() => handlePause(task.id, task.status)}
                    >
                      {task.status === "paused"
                        ? t("tasks.resume" as TranslationKey)
                        : t("tasks.pause" as TranslationKey)}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={actionPending === task.id}
                      onClick={() => handleDelete(task.id)}
                    >
                      {t("tasks.delete" as TranslationKey)}
                    </Button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="mt-3 border-t border-border/40 pt-3 space-y-2">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t("tasks.deliveryLog" as TranslationKey)}
                    </p>
                    {runs.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground/70">
                        {t("tasks.noHistory")}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {runs.slice(0, 5).map((run) => (
                          <div
                            key={run.id}
                            className="rounded-md border border-border/30 bg-background/60 p-2 text-[11px]"
                          >
                            <div className="flex items-center gap-2 text-muted-foreground flex-wrap">
                              <span>{formatRelative(run.created_at, isZh)}</span>
                              {/* Phase 3 Step 4 — 5-state status display, with
                                  legacy `'success'` / `'error'` mapped to the
                                  same colors as the new `'succeeded'` /
                                  `'failed'` so historical rows look consistent. */}
                              <span
                                className={cn(
                                  "uppercase",
                                  run.status === "success" || run.status === "succeeded"
                                    ? "text-status-success-foreground"
                                    : run.status === "error" || run.status === "failed"
                                    ? "text-destructive"
                                    : run.status === "waiting_for_permission"
                                    ? "text-status-warning-foreground"
                                    : run.status === "cancelled"
                                    ? "text-muted-foreground/70"
                                    : "",
                                )}
                              >
                                {run.status}
                              </span>
                              {typeof run.duration_ms === "number" && (
                                <span>{run.duration_ms}ms</span>
                              )}
                              {/* Phase 3 Step 4 — link into the task-bound
                                  chat session this run wrote to. Hidden for
                                  reminder runs (no session) and rows where
                                  task.session_id wasn't populated yet. */}
                              {task.session_id && task.kind === "ai_task" && (
                                <a
                                  href={`/chat/${task.session_id}`}
                                  className="ml-auto text-foreground/70 hover:text-foreground hover:underline"
                                >
                                  {t("tasks.openSession")}
                                </a>
                              )}
                            </div>
                            {run.deliveries.length > 0 ? (
                              <ul className="mt-1 space-y-0.5">
                                {run.deliveries.map((d) => (
                                  <li key={`${run.id}-${d.channel}`} className="flex items-center gap-2">
                                    <span className="font-mono text-muted-foreground/80">
                                      {d.channel}
                                    </span>
                                    <span className={cn("uppercase", deliveryStatusToTone(d.status))}>
                                      {d.status}
                                    </span>
                                    {d.error && (
                                      <span className="truncate text-muted-foreground/70">
                                        — {d.error}
                                      </span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="mt-1 text-muted-foreground/70">
                                {t("tasks.noDeliveries")}
                              </p>
                            )}
                            {run.error && (
                              <p className="mt-1 text-destructive truncate">{run.error}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
