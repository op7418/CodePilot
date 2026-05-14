"use client";

import { ScheduledTasksManager } from "@/components/scheduled-tasks/ScheduledTasksManager";

export default function ScheduledTasksPage() {
  return (
    <div className="flex h-full flex-col">
      <ScheduledTasksManager />
    </div>
  );
}
