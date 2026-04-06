"use client";

import dynamic from "next/dynamic";
import { usePanel } from "@/hooks/usePanel";

const PreviewPanel = dynamic(() => import("./panels/PreviewPanel").then(m => ({ default: m.PreviewPanel })), { ssr: false });
const GitPanelContainer = dynamic(() => import("./panels/GitPanel").then(m => ({ default: m.GitPanelContainer })), { ssr: false });
const FileTreePanel = dynamic(() => import("./panels/FileTreePanel").then(m => ({ default: m.FileTreePanel })), { ssr: false });
const DashboardPanel = dynamic(() => import("./panels/DashboardPanel").then(m => ({ default: m.DashboardPanel })), { ssr: false });
const AssistantPanel = dynamic(() => import("./panels/AssistantPanel").then(m => ({ default: m.AssistantPanel })), { ssr: false });

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
    </div>
  );
}
