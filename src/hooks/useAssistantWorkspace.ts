"use client";

import { useState, useEffect, useCallback } from "react";
import { getLocalDateString } from "@/lib/utils";

interface FileStatus {
  exists: boolean;
  chars: number;
  preview: string;
}

interface WorkspaceState {
  onboardingComplete: boolean;
  lastHeartbeatDate: string | null;
  /** @deprecated Use lastHeartbeatDate instead */
  lastCheckInDate?: string | null;
  heartbeatEnabled: boolean;
  schemaVersion: number;
}

interface WorkspaceInfo {
  path: string | null;
  exists?: boolean;
  files: Record<string, FileStatus>;
  state: WorkspaceState | null;
}

export function useAssistantWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/settings/workspace");
      if (res.ok) {
        const data = await res.json();
        setWorkspace(data);
      } else {
        setError("Failed to fetch workspace info");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const setWorkspacePath = useCallback(async (path: string) => {
    try {
      const res = await fetch("/api/settings/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (res.ok) await refetch();
    } catch (e) {
      console.error("Failed to set workspace path:", e);
    }
  }, [refetch]);

  const initializeWorkspace = useCallback(async () => {
    if (!workspace?.path) return;
    try {
      const res = await fetch("/api/settings/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: workspace.path, initialize: true }),
      });
      if (res.ok) await refetch();
    } catch (e) {
      console.error("Failed to initialize workspace:", e);
    }
  }, [workspace?.path, refetch]);

  const today = getLocalDateString();
  const needsCheckIn = workspace?.path != null
    && workspace.state != null
    && workspace.state.lastHeartbeatDate !== today;

  return {
    workspacePath: workspace?.path ?? null,
    fileStatus: workspace?.files ?? {},
    state: workspace?.state ?? null,
    loading,
    error,
    needsCheckIn,
    setWorkspacePath,
    initializeWorkspace,
    refetch,
  };
}
