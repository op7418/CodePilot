"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/useTranslation";
import type { TaskItem, TaskStatus } from "@/types";

interface TaskListProps {
  sessionId: string;
}

export function TaskList({ sessionId }: TaskListProps) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchTasks = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/tasks?session_id=${encodeURIComponent(sessionId)}`);
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // Auto-refresh when SDK TodoWrite syncs tasks
  useEffect(() => {
    const handler = () => { fetchTasks(); };
    window.addEventListener('tasks-updated', handler);
    return () => window.removeEventListener('tasks-updated', handler);
  }, [fetchTasks]);

  const handleToggle = async (task: TaskItem) => {
    const nextStatus: TaskStatus = task.status === "completed" ? "pending" : "completed";
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (res.ok) {
        const data = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === task.id ? data.task : t)));
      }
    } catch {
      // silently fail
    }
  };

  if (loading && tasks.length === 0) {
    return (
      <p className="py-2 text-center text-xs text-muted-foreground">
        {t('tasks.loading')}
      </p>
    );
  }

  if (tasks.length === 0) {
    return (
      <p className="py-2 text-center text-xs text-muted-foreground">
        {t('tasks.noTasks')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {tasks.map((task) => {
        const isDone = task.status === "completed";
        return (
          <Button
            key={task.id}
            variant="ghost"
            className="flex items-center gap-2 justify-start px-1 py-1 text-left h-auto w-full"
            onClick={() => handleToggle(task)}
          >
            <span
              className={cn(
                "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors",
                isDone
                  ? "border-foreground bg-foreground text-background"
                  : "border-muted-foreground/40"
              )}
            >
              {isDone && (
                <svg className="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2.5 6l2.5 2.5 4.5-5" />
                </svg>
              )}
            </span>
            <span
              className={cn(
                "flex-1 truncate text-xs",
                isDone && "text-muted-foreground line-through"
              )}
            >
              {task.title}
            </span>
          </Button>
        );
      })}
    </div>
  );
}
