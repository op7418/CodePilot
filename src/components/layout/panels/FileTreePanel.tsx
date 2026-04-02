"use client";

import { useState, useCallback } from "react";
import { X } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { usePanel } from "@/hooks/usePanel";
import { useTranslation } from "@/hooks/useTranslation";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import { FileTree } from "@/components/project/FileTree";
import { TaskList } from "@/components/project/TaskList";

const TREE_MIN_WIDTH = 220;
const TREE_MAX_WIDTH = 500;
const TREE_DEFAULT_WIDTH = 280;

export function FileTreePanel() {
  const { workingDirectory, sessionId, previewFile, setPreviewFile, setPreviewOpen, setFileTreeOpen } = usePanel();
  const { t } = useTranslation();
  const [width, setWidth] = useState(TREE_DEFAULT_WIDTH);

  const handleResize = useCallback((delta: number) => {
    setWidth((w) => Math.min(TREE_MAX_WIDTH, Math.max(TREE_MIN_WIDTH, w - delta)));
  }, []);

  const handleFileAdd = useCallback((path: string) => {
    window.dispatchEvent(new CustomEvent('attach-file-to-chat', { detail: { path } }));
  }, []);

  const handleFileSelect = useCallback((path: string) => {
    const ext = path.split(".").pop()?.toLowerCase() || "";

    // Truly non-previewable: archives, binaries, office docs, fonts
    const NON_PREVIEWABLE = new Set([
      "zip", "tar", "gz", "rar", "7z", "bz2",
      "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
      "exe", "dll", "so", "dylib", "bin", "dmg", "iso",
      "woff", "woff2", "ttf", "otf", "eot",
      "flv", "wmv", "wma",
    ]);
    if (NON_PREVIEWABLE.has(ext)) return;

    // Toggle: clicking the same file closes the preview
    if (previewFile === path) {
      setPreviewFile(null);
      setPreviewOpen(false);
    } else {
      setPreviewFile(path);
      setPreviewOpen(true);
    }
  }, [previewFile, setPreviewFile, setPreviewOpen]);

  return (
    <div className="flex h-full shrink-0 overflow-hidden">
      <ResizeHandle side="left" onResize={handleResize} />
      <div className="flex h-full flex-1 flex-col overflow-hidden border-r border-border/40 bg-background" style={{ width }}>
        {/* Header */}
        <div className="flex h-10 shrink-0 items-center justify-between px-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('panel.files')}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setFileTreeOpen(false)}
          >
            <X size={14} />
            <span className="sr-only">{t('panel.closePanel')}</span>
          </Button>
        </div>

        {/* Body — TaskList + divider + FileTree */}
        <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
          {/* Tasks */}
          <div className="shrink-0 px-3 pb-3">
            <TaskList sessionId={sessionId} />
          </div>

          {/* Divider */}
          <div className="mx-3 mt-1 mb-2 border-t border-border/40" />

          {/* File tree */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <FileTree
              workingDirectory={workingDirectory}
              onFileSelect={handleFileSelect}
              onFileAdd={handleFileAdd}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
