"use client";

import { useState, useEffect, useCallback } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { TaskCard } from "./TaskCard";
import { useTranslation } from "@/hooks/useTranslation";
import type { TaskItem, TaskStatus } from "@/types";

interface TaskListProps {
  sessionId: string;
}

type FilterTab = "all" | "in_progress" | "completed";

export function TaskList({ sessionId }: TaskListProps) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [filter, setFilter] = useState<FilterTab>("all");
  const { t } = useTranslation();

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

  const handleCreate = async () => {
    const title = newTitle.trim();
    if (!title || !sessionId) return;

    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, title }),
      });
      if (res.ok) {
        const data = await res.json();
        setTasks((prev) => [...prev, data.task]);
        setNewTitle("");
      }
    } catch {
      // silently fail
    }
  };

  const handleUpdate = async (
    id: string,
    updates: { title?: string; status?: TaskStatus }
  ) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        const data = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === id ? data.task : t)));
      }
    } catch {
      // silently fail
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      if (res.ok) {
        setTasks((prev) => prev.filter((t) => t.id !== id));
      }
    } catch {
      // silently fail
    }
  };

  const filtered = tasks.filter((task) => {
    if (filter === "all") return true;
    if (filter === "in_progress")
      return task.status === "pending" || task.status === "in_progress";
    if (filter === "completed") return task.status === "completed";
    return true;
  });

  const filterTabs: { key: FilterTab; label: string }[] = [
    { key: "all", label: t('taskList.all') },
    { key: "in_progress", label: t('taskList.active') },
    { key: "completed", label: t('taskList.done') },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Filter tabs */}
      <div className="flex items-center gap-1 pb-2">
        {filterTabs.map((tab) => (
          <Button
            key={tab.key}
            variant="ghost"
            size="sm"
            className={cn(
              "h-6 px-2 text-[10px]",
              filter === tab.key && "bg-accent"
            )}
            onClick={() => setFilter(tab.key)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      {/* Add task input */}
      <div className="flex items-center gap-1 pb-2">
        <Input
          placeholder={t('taskList.addPlaceholder')}
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreate();
          }}
          className="h-7 text-xs"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleCreate}
          disabled={!newTitle.trim()}
        >
          <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
          <span className="sr-only">{t('taskList.addTask')}</span>
        </Button>
      </div>

      {/* Task list */}
      <ScrollArea className="flex-1">
        {loading && tasks.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {t('taskList.loading')}
          </p>
        ) : filtered.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {tasks.length === 0 ? t('taskList.noTasks') : t('taskList.noMatching')}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5 pb-4">
            {filtered.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onUpdate={handleUpdate}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
