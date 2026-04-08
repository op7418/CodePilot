"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import type { ScheduledTask } from "@/types";
import { Clock, Play, Pause, Trash, Plus, SpinnerGap, CheckCircle, WarningCircle, Info } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function ScheduledTasksManager() {
  const { t, locale } = useTranslation();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [detailTask, setDetailTask] = useState<ScheduledTask | null>(null);

  // Form state
  const [newTaskName, setNewTaskName] = useState("");
  const [newTaskPrompt, setNewTaskPrompt] = useState("");
  const [scheduleType, setScheduleType] = useState<"cron" | "interval" | "once">("interval");
  const [scheduleValue, setScheduleValue] = useState("1h");
  const [priority, setPriority] = useState<"low" | "normal" | "urgent">("normal");
  const [notifyOnComplete, setNotifyOnComplete] = useState(true);
  const [workingDirectory, setWorkingDirectory] = useState("");

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks/list");
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch (err) {
      console.error("Failed to fetch scheduled tasks:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const handleCreateTask = async () => {
    if (!newTaskName || !newTaskPrompt || !scheduleValue) {
      return;
    }

    try {
      const res = await fetch("/api/tasks/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newTaskName,
          prompt: newTaskPrompt,
          schedule_type: scheduleType,
          schedule_value: scheduleValue,
          priority,
          notify_on_complete: notifyOnComplete ? 1 : 0,
          working_directory: workingDirectory || null,
        }),
      });

      if (res.ok) {
        setCreateDialogOpen(false);
        // Reset form
        setNewTaskName("");
        setNewTaskPrompt("");
        setScheduleType("interval");
        setScheduleValue("1h");
        setPriority("normal");
        setNotifyOnComplete(true);
        setWorkingDirectory("");
        fetchTasks();
      }
    } catch (err) {
      console.error("Failed to create task:", err);
    }
  };

  const handleToggleTask = async (task: ScheduledTask) => {
    try {
      const newStatus = task.status === "active" ? "paused" : "active";
      await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      fetchTasks();
    } catch (err) {
      console.error("Failed to toggle task:", err);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    try {
      await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
      fetchTasks();
    } catch (err) {
      console.error("Failed to delete task:", err);
    }
  };

  const handleRunTask = async (task: ScheduledTask) => {
    try {
      await fetch(`/api/tasks/${task.id}/run`, { method: "POST" });
      fetchTasks();
    } catch (err) {
      console.error("Failed to run task:", err);
    }
  };

  const getStatusColor = (status: ScheduledTask["status"]) => {
    switch (status) {
      case "active": return "bg-status-success";
      case "paused": return "bg-status-warning";
      case "completed": return "bg-status-info";
      case "disabled": return "bg-status-error";
      default: return "bg-muted";
    }
  };

  const getStatusText = (status: ScheduledTask["status"]) => {
    switch (status) {
      case "active": return t("tasks.active");
      case "paused": return t("tasks.paused");
      case "completed": return t("tasks.completed");
      case "disabled": return t("tasks.failed");
      default: return status;
    }
  };

  const formatNextRun = (nextRun: string) => {
    const date = new Date(nextRun);
    const now = new Date();
    const diff = date.getTime() - now.getTime();

    if (diff < 0) return t("tasks.overdue");

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 60) return `${t("tasks.in")} ${minutes} ${t("tasks.minutes")}`;
    if (hours < 24) return `${t("tasks.in")} ${hours} ${t("tasks.hours")}`;
    return `${t("tasks.in")} ${days} ${t("tasks.days")}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <SpinnerGap size={24} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Fixed header */}
      <div className="shrink-0 border-b border-border/50 px-6 pt-4 pb-4">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold">{t("tasks.title")}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {t("tasks.description") || "管理和查看 Claude Code 定时任务"}
            </p>
          </div>
          <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1.5 shrink-0">
                <Plus size={14} />
                {t("tasks.createTask")}
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>{t("tasks.createTask")}</DialogTitle>
                <DialogDescription>
                  {t("tasks.createDescription") || "创建一个新的定时任务"}
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="task-name">{t("tasks.taskName")}</Label>
                  <Input
                    id="task-name"
                    placeholder={t("tasks.taskNamePlaceholder") || "例如：每日汇报"}
                    value={newTaskName}
                    onChange={(e) => setNewTaskName(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="task-prompt">{t("tasks.taskPrompt")}</Label>
                  <textarea
                    id="task-prompt"
                    placeholder={t("tasks.taskPromptPlaceholder") || "描述任务要执行的内容..."}
                    className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    value={newTaskPrompt}
                    onChange={(e) => setNewTaskPrompt(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="schedule-type">{t("tasks.scheduleType")}</Label>
                    <Select value={scheduleType} onValueChange={(v) => setScheduleType(v as typeof scheduleType)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="interval">{t("tasks.interval")}</SelectItem>
                        <SelectItem value="cron">{t("tasks.cron")}</SelectItem>
                        <SelectItem value="once">{t("tasks.once")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="schedule-value">{t("tasks.scheduleValue")}</Label>
                    <Input
                      id="schedule-value"
                      placeholder={scheduleType === "cron" ? "0 9 * * *" : "1h"}
                      value={scheduleValue}
                      onChange={(e) => setScheduleValue(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {scheduleType === "cron"
                        ? (t("tasks.cronFormat") || "格式：分 时 日 月 周")
                        : (t("tasks.intervalFormat") || "格式：30m, 1h, 1d")}
                    </p>
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="priority">{t("tasks.priority")}</Label>
                  <Select value={priority} onValueChange={(v) => setPriority(v as typeof priority)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">{t("tasks.priorityLow")}</SelectItem>
                      <SelectItem value="normal">{t("tasks.priorityNormal")}</SelectItem>
                      <SelectItem value="urgent">{t("tasks.priorityUrgent")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="notify">{t("tasks.notifyOnComplete")}</Label>
                  <Switch
                    id="notify"
                    checked={notifyOnComplete}
                    onCheckedChange={setNotifyOnComplete}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="working-dir">{t("tasks.workingDirectory")}</Label>
                  <Input
                    id="working-dir"
                    placeholder={t("tasks.workingDirectoryPlaceholder") || "/path/to/project"}
                    value={workingDirectory}
                    onChange={(e) => setWorkingDirectory(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                  {t("tasks.cancel")}
                </Button>
                <Button onClick={handleCreateTask}>
                  {t("tasks.create")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex flex-col gap-4">
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Clock size={48} className="text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">{t("tasks.noScheduledTasks")}</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {t("tasks.noScheduledTasksDescription") || "创建一个定时任务来自动化你的工作"}
              </p>
              <Button className="mt-4" onClick={() => setCreateDialogOpen(true)}>
                <Plus size={14} className="mr-1" />
                {t("tasks.createTask")}
              </Button>
            </div>
          ) : (
            tasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center gap-4 rounded-lg border border-border/40 p-4 hover:bg-muted/30 transition-colors"
              >
                {/* Status indicator */}
                <div className={`shrink-0 h-3 w-3 rounded-full ${getStatusColor(task.status)}`} />

                {/* Task info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium truncate">{task.name}</h3>
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0">
                      {task.schedule_type === "cron" ? task.schedule_value : task.schedule_type === "interval" ? `每 ${task.schedule_value}` : t("tasks.once")}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1 truncate">
                    {task.prompt}
                  </p>
                  <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                    <span>{t("tasks.nextRun")}: {formatNextRun(task.next_run)}</span>
                    {task.last_run && (
                      <span>{t("tasks.lastRun")}: {new Date(task.last_run).toLocaleString()}</span>
                    )}
                    {task.consecutive_errors > 0 && (
                      <span className="text-status-error">{t("tasks.errors")}: {task.consecutive_errors}</span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  {task.status === "active" ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleToggleTask(task)}
                      title={t("tasks.pause")}
                    >
                      <Pause size={16} />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleToggleTask(task)}
                      title={t("tasks.resume")}
                    >
                      <Play size={16} />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleRunTask(task)}
                    title={t("tasks.runNow")}
                  >
                    <SpinnerGap size={16} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDetailTask(task)}
                    title={t("tasks.details")}
                  >
                    <Info size={16} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDeleteTask(task.id)}
                    title={t("tasks.delete")}
                    className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                  >
                    <Trash size={16} />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Task detail dialog */}
      {detailTask && (
        <Dialog open={!!detailTask} onOpenChange={() => setDetailTask(null)}>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>{detailTask.name}</DialogTitle>
              <DialogDescription>{detailTask.prompt}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs text-muted-foreground">{t("tasks.status")}</Label>
                  <p className="text-sm font-medium">{getStatusText(detailTask.status)}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("tasks.priority")}</Label>
                  <p className="text-sm font-medium">{detailTask.priority}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs text-muted-foreground">{t("tasks.scheduleType")}</Label>
                  <p className="text-sm font-medium">{detailTask.schedule_type}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("tasks.scheduleValue")}</Label>
                  <p className="text-sm font-medium font-mono">{detailTask.schedule_value}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs text-muted-foreground">{t("tasks.nextRun")}</Label>
                  <p className="text-sm font-medium">{new Date(detailTask.next_run).toLocaleString()}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("tasks.lastRun")}</Label>
                  <p className="text-sm font-medium">{detailTask.last_run ? new Date(detailTask.last_run).toLocaleString() : "-"}</p>
                </div>
              </div>
              {detailTask.last_status && (
                <div>
                  <Label className="text-xs text-muted-foreground">{t("tasks.lastStatus")}</Label>
                  <div className="flex items-center gap-2 mt-1">
                    {detailTask.last_status === "success" ? (
                      <CheckCircle size={16} className="text-status-success" />
                    ) : detailTask.last_status === "error" ? (
                      <WarningCircle size={16} className="text-status-error" />
                    ) : (
                      <Info size={16} className="text-muted-foreground" />
                    )}
                    <p className="text-sm font-medium">{detailTask.last_status}</p>
                  </div>
                </div>
              )}
              {detailTask.last_error && (
                <Alert variant="destructive">
                  <AlertDescription className="text-sm">
                    {detailTask.last_error}
                  </AlertDescription>
                </Alert>
              )}
              {detailTask.last_result && (
                <div>
                  <Label className="text-xs text-muted-foreground">{t("tasks.lastResult")}</Label>
                  <pre className="mt-1 p-2 bg-muted rounded text-xs overflow-auto max-h-32">
                    {detailTask.last_result}
                  </pre>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
