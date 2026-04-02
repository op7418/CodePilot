"use client";

import { usePanel } from "@/hooks/usePanel";
import { PreviewPanel } from "./panels/PreviewPanel";
import { GitPanelContainer } from "./panels/GitPanel";
import { FileTreePanel } from "./panels/FileTreePanel";
import { DashboardPanel } from "./panels/DashboardPanel";
import { AssistantPanel } from "./panels/AssistantPanel";

export function PanelZone() {
  const { previewOpen, previewFile, gitPanelOpen, fileTreeOpen, dashboardPanelOpen, assistantPanelOpen } = usePanel();

  const anyOpen = (previewOpen && !!previewFile) || gitPanelOpen || fileTreeOpen || dashboardPanelOpen || assistantPanelOpen;

  if (!anyOpen) return null;

  return (
    <div className="flex h-full shrink-0 border-l border-border/40 overflow-hidden">
      {assistantPanelOpen && <AssistantPanel />}
      {previewOpen && previewFile && <PreviewPanel />}
      {gitPanelOpen && <GitPanelContainer />}
      {fileTreeOpen && <FileTreePanel />}
      {dashboardPanelOpen && <DashboardPanel />}
    </div>
  );
}
