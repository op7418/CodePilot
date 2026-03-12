"use client";

import { useCallback } from "react";
import { TreeStructure, SidebarSimple } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePanel } from "@/hooks/usePanel";
import { useTranslation } from "@/hooks/useTranslation";
import { FileTree } from "@/components/project/FileTree";
import { TaskList } from "@/components/project/TaskList";

interface RightPanelProps {
  width?: number;
}

export function RightPanel({ width }: RightPanelProps) {
  const { panelOpen, setPanelOpen, workingDirectory, sessionId, previewFile, setPreviewFile } = usePanel();
  const { t } = useTranslation();

  const handleFileAdd = useCallback((path: string) => {
    window.dispatchEvent(new CustomEvent('attach-file-to-chat', { detail: { path } }));
  }, []);

  const handleFileSelect = useCallback((path: string) => {
    // Only open preview for text-based files, skip images/videos/binaries
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const NON_PREVIEWABLE = new Set([
      "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg", "avif",
      "mp4", "mov", "avi", "mkv", "webm", "flv", "wmv",
      "mp3", "wav", "ogg", "flac", "aac", "wma",
      "zip", "tar", "gz", "rar", "7z", "bz2",
      "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
      "exe", "dll", "so", "dylib", "bin", "dmg", "iso",
      "woff", "woff2", "ttf", "otf", "eot",
    ]);
    if (NON_PREVIEWABLE.has(ext)) return;

    // Toggle: clicking the same file closes the preview
    if (previewFile === path) {
      setPreviewFile(null);
    } else {
      setPreviewFile(path);
    }
  }, [previewFile, setPreviewFile]);

  if (!panelOpen) {
    return (
      <div className="flex flex-col items-center gap-2 bg-background p-2 mt-5 border-l border-border/40">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPanelOpen(true)}
            >
              <TreeStructure size={16} />
              <span className="sr-only">{t('panel.openPanel')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t('panel.openPanel')}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <aside className="hidden h-full shrink-0 flex-col overflow-hidden bg-background lg:flex" style={{ width: width ?? 288 }}>
      {/* Header */}
      <div className="flex h-12 mt-5 shrink-0 items-center justify-between px-4">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('panel.tasks')}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPanelOpen(false)}
            >
              <SidebarSimple size={16} />
              <span className="sr-only">{t('panel.closePanel')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t('panel.closePanel')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Body — TaskList + divider + FileTree */}
      <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
        {/* Tasks */}
        <div className="shrink-0 px-3 pb-3">
          <TaskList sessionId={sessionId} />
        </div>

        {/* Divider */}
        <div className="mx-4 mt-1 mb-2 border-t border-border/40" />

        {/* File tree */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <div className="px-4 pt-1 pb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('panel.files')}
            </span>
          </div>
          <FileTree
            workingDirectory={workingDirectory}
            onFileSelect={handleFileSelect}
            onFileAdd={handleFileAdd}
          />
        </div>
      </div>
    </aside>
  );
}
