"use client";

import { useState, useRef, useEffect } from "react";
import { Trash } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, parseDBDate } from "@/lib/utils";
import type { TaskItem, TaskStatus } from "@/types";

interface TaskCardProps {
  task: TaskItem;
  onUpdate: (id: string, updates: { title?: string; status?: TaskStatus }) => void;
  onDelete: (id: string) => void;
}

const statusColors: Record<TaskStatus, string> = {
  pending: "bg-status-warning",
  in_progress: "bg-primary",
  completed: "bg-status-success",
  failed: "bg-status-error",
};

const nextStatus: Record<TaskStatus, TaskStatus> = {
  pending: "in_progress",
  in_progress: "completed",
  completed: "pending",
  failed: "pending",
};

function formatTime(dateStr: string): string {
  const date = parseDBDate(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return date.toLocaleDateString();
}

export function TaskCard({ task, onUpdate, onDelete }: TaskCardProps) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title);
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleStatusClick = () => {
    onUpdate(task.id, { status: nextStatus[task.status] });
  };

  const handleTitleSubmit = () => {
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== task.title) {
      onUpdate(task.id, { title: trimmed });
    } else {
      setEditTitle(task.title);
    }
    setEditing(false);
  };

  return (
    <div
      className="group flex items-start gap-2 rounded-md border border-border p-2 transition-colors hover:bg-accent/50"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Status dot */}
      <Button
        variant="ghost"
        size="icon"
        onClick={handleStatusClick}
        className="mt-1 shrink-0 h-auto w-auto p-0"
        title={`Status: ${task.status} (click to change)`}
      >
        <span
          className={cn(
            "block h-2.5 w-2.5 rounded-full transition-transform hover:scale-125",
            statusColors[task.status]
          )}
        />
      </Button>

      {/* Content */}
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            ref={inputRef}
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={handleTitleSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleTitleSubmit();
              if (e.key === "Escape") {
                setEditTitle(task.title);
                setEditing(false);
              }
            }}
            className="w-full border-none bg-transparent p-0 text-xs font-medium px-1 h-auto"
          />
        ) : (
          <p
            className={cn(
              "cursor-pointer truncate text-xs font-medium",
              task.status === "completed" && "text-muted-foreground line-through"
            )}
            onDoubleClick={() => setEditing(true)}
          >
            {task.title}
          </p>
        )}
        {task.description && (
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {task.description}
          </p>
        )}
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {formatTime(task.updated_at)}
        </p>
      </div>

      {/* Delete button */}
      {hovered && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onDelete(task.id)}
          className="shrink-0 text-muted-foreground hover:text-destructive"
        >
          <Trash size={12} />
          <span className="sr-only">Delete task</span>
        </Button>
      )}
    </div>
  );
}
