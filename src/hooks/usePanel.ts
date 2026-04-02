"use client";

import { createContext, useContext } from "react";

export type PanelContent = "files" | "tasks";

export type PreviewViewMode = "source" | "rendered";

export interface PanelContextValue {
  // --- New independent panel states ---
  fileTreeOpen: boolean;
  setFileTreeOpen: (open: boolean) => void;
  gitPanelOpen: boolean;
  setGitPanelOpen: (open: boolean) => void;
  previewOpen: boolean;
  setPreviewOpen: (open: boolean) => void;
  terminalOpen: boolean;
  setTerminalOpen: (open: boolean) => void;
  dashboardPanelOpen: boolean;
  setDashboardPanelOpen: (open: boolean) => void;
  assistantPanelOpen: boolean;
  setAssistantPanelOpen: (open: boolean) => void;
  isAssistantWorkspace: boolean;
  setIsAssistantWorkspace: (is: boolean) => void;

  // --- Git summary (for top bar, derived — no setters) ---
  currentBranch: string;
  gitDirtyCount: number;
  currentWorktreeLabel: string;
  setCurrentWorktreeLabel: (label: string) => void;

  // --- Preserved from old API ---
  workingDirectory: string;
  setWorkingDirectory: (dir: string) => void;
  sessionId: string;
  setSessionId: (id: string) => void;
  sessionTitle: string;
  setSessionTitle: (title: string) => void;
  streamingSessionId: string;
  setStreamingSessionId: (id: string) => void;
  pendingApprovalSessionId: string;
  setPendingApprovalSessionId: (id: string) => void;
  /** All sessions with active streams (supports multi-session streaming) */
  activeStreamingSessions: Set<string>;
  /** All sessions with pending permission approval */
  pendingApprovalSessionIds: Set<string>;
  previewFile: string | null;
  setPreviewFile: (path: string | null) => void;
  previewViewMode: PreviewViewMode;
  setPreviewViewMode: (mode: PreviewViewMode) => void;
}

export const PanelContext = createContext<PanelContextValue | null>(null);

export function usePanel(): PanelContextValue {
  const ctx = useContext(PanelContext);
  if (!ctx) {
    throw new Error("usePanel must be used within a PanelProvider");
  }
  return ctx;
}
