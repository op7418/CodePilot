"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { StructureFolderIcon, PanelRightCloseIcon, PencilEdit01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePanel } from "@/hooks/usePanel";
import { FileTree } from "@/components/project/FileTree";
import { FilePreview } from "@/components/project/FilePreview";

export function RightPanel() {
  const { panelOpen, setPanelOpen, workingDirectory, sessionId, sessionTitle, setSessionTitle } = usePanel();
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const displayTitle = sessionTitle || (sessionId ? `Session ${sessionId.slice(0, 8)}` : "Untitled Chat");

  useEffect(() => {
    if (isEditingName && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditingName]);

  const handleStartEdit = useCallback(() => {
    setEditName(displayTitle);
    setIsEditingName(true);
  }, [displayTitle]);

  const handleSaveName = useCallback(async () => {
    const trimmed = editName.trim();
    if (!trimmed || !sessionId) {
      setIsEditingName(false);
      return;
    }
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (res.ok) {
        setSessionTitle(trimmed);
      }
    } catch {
      // silently fail
    }
    setIsEditingName(false);
  }, [editName, sessionId, setSessionTitle]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSaveName();
    } else if (e.key === "Escape") {
      setIsEditingName(false);
    }
  }, [handleSaveName]);

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
              <span className="sr-only">Open panel</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Open panel</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  const handleFileSelect = (path: string) => {
    setPreviewPath(path);
  };

  const handleBackToTree = () => {
    setPreviewPath(null);
  };

  return (
    <aside className="hidden h-full w-72 shrink-0 flex-col overflow-hidden bg-background lg:flex">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between px-4">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Chat Info</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPanelOpen(false)}
            >
              <HugeiconsIcon icon={PanelRightCloseIcon} className="h-4 w-4" />
              <span className="sr-only">Close panel</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Close panel</TooltipContent>
        </Tooltip>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Name - editable */}
        <div>
          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1.5 block">Name</label>
          {isEditingName ? (
            <div className="flex items-center gap-1.5">
              <Input
                ref={inputRef}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleSaveName}
                className="h-7 text-sm"
              />
              <Button variant="ghost" size="icon-xs" onClick={handleSaveName}>
                <HugeiconsIcon icon={Tick01Icon} className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 group">
              <p className="text-sm font-medium flex-1 truncate">{displayTitle}</p>
              <Button
                variant="ghost"
                size="icon-xs"
                className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                onClick={handleStartEdit}
              >
                <HugeiconsIcon icon={PencilEdit01Icon} className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="h-px bg-border/50" />

        {/* Files */}
        <div className="flex flex-col min-h-0">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1.5 block">Files</span>
          <div className="overflow-hidden">
            {previewPath ? (
              <FilePreview filePath={previewPath} onBack={handleBackToTree} workingDirectory={workingDirectory} />
            ) : (
              <FileTree
                workingDirectory={workingDirectory}
                onFileSelect={handleFileSelect}
              />
            )}
          </div>
        </div>

      </div>
    </aside>
  );
}
