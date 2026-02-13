"use client";

import { useCallback } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { StructureFolderIcon, PanelRightCloseIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePanel } from "@/hooks/usePanel";
import { useTranslation } from "@/hooks/useTranslation";
import { FileTree } from "@/components/project/FileTree";

interface RightPanelProps {
  width?: number;
}

export function RightPanel({ width }: RightPanelProps) {
  const { panelOpen, setPanelOpen, workingDirectory, previewFile, setPreviewFile } = usePanel();
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
      <div className="flex flex-col items-center gap-2 bg-background p-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPanelOpen(true)}
            >
              <HugeiconsIcon icon={StructureFolderIcon} className="h-4 w-4" />
              <span className="sr-only">{t('rightPanel.openPanel')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t('rightPanel.openPanel')}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <aside className="hidden h-full shrink-0 flex-col overflow-hidden bg-background lg:flex" style={{ width: width ?? 288 }}>
      {/* Header */}
      <div className="flex h-12 mt-5 shrink-0 items-center justify-between px-4">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t('rightPanel.files')}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPanelOpen(false)}
            >
              <HugeiconsIcon icon={PanelRightCloseIcon} className="h-4 w-4" />
              <span className="sr-only">{t('rightPanel.closePanel')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t('rightPanel.closePanel')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
        <FileTree
          workingDirectory={workingDirectory}
          onFileSelect={handleFileSelect}
          onFileAdd={handleFileAdd}
        />
      </div>
    </aside>
  );
}
