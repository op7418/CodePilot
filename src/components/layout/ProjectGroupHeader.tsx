"use client";

import {
  Folder,
  CaretDown,
  CaretRight,
  Plus,
  FolderOpen,
  FolderMinus,
  DotsThree,
  Copy,
  ArrowSquareOut,
} from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from "@/i18n";
import { useState } from "react";
import { SPECIES_IMAGE_URL, EGG_IMAGE_URL, type Species } from "@/lib/buddy";

interface ProjectGroupHeaderProps {
  workingDirectory: string;
  displayName: string;
  isCollapsed: boolean;
  isFolderHovered: boolean;
  isWorkspace: boolean;
  onToggle: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onCreateSession: (e: React.MouseEvent) => void;
  onRemoveProject?: (workingDirectory: string) => void;
  assistantName?: string;
  assistantMemoryCount?: number;
  lastHeartbeatDate?: string;
  buddyEmoji?: string;
  buddyName?: string;
  buddySpecies?: string;
}

export function ProjectGroupHeader({
  workingDirectory,
  displayName,
  isCollapsed,
  isFolderHovered,
  isWorkspace,
  onToggle,
  onMouseEnter,
  onMouseLeave,
  onCreateSession,
  onRemoveProject,
  assistantName,
  assistantMemoryCount,
  lastHeartbeatDate,
  buddyEmoji,
  buddyName,
  buddySpecies,
}: ProjectGroupHeaderProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const showActions = isFolderHovered || menuOpen;

  const actionButtons = workingDirectory !== "" && (
    <div className={cn(
      "flex items-center gap-0.5 transition-opacity",
      showActions ? "opacity-100" : "opacity-0 pointer-events-none"
    )}>
      {/* New chat button */}
      <Button
        variant="ghost"
        size="icon-xs"
        className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
        tabIndex={showActions ? 0 : -1}
        onClick={onCreateSession}
      >
        <Plus size={14} />
      </Button>
      {/* Three-dot menu */}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
            tabIndex={showActions ? 0 : -1}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <DotsThree size={14} weight="bold" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[160px]" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onClick={() => {
            const w = window as unknown as { electronAPI?: { shell?: { openPath?: (p: string) => void } } };
            if (w.electronAPI?.shell?.openPath) {
              w.electronAPI.shell.openPath(workingDirectory);
            } else {
              fetch('/api/files/open', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: workingDirectory }),
              }).catch(() => {});
            }
          }}>
            <ArrowSquareOut size={14} />
            <span>{t('chatList.openFolder' as TranslationKey)}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            navigator.clipboard.writeText(workingDirectory);
          }}>
            <Copy size={14} />
            <span>{t('chatList.copyFolderPath' as TranslationKey)}</span>
          </DropdownMenuItem>
          {onRemoveProject && !isWorkspace && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onRemoveProject(workingDirectory)}
              >
                <FolderMinus size={14} />
                <span>{t('chatList.removeProject' as TranslationKey)}</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  if (isWorkspace) {
    const statusParts: string[] = [];
    if (assistantMemoryCount) {
      statusParts.push(t('assistant.memoryCount' as TranslationKey, { count: String(assistantMemoryCount) }));
    }
    if (lastHeartbeatDate) {
      statusParts.push(t('assistant.lastHeartbeat' as TranslationKey, { date: lastHeartbeatDate }));
    }

    const folderName = displayName;
    const nameDisplay = buddyEmoji
      ? (buddyName || assistantName || t('assistant.defaultName' as TranslationKey))
      : t('buddy.adoptPrompt' as TranslationKey);

    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer select-none transition-colors",
          isCollapsed
            ? "hover:bg-accent/50"
            : "bg-primary/[0.06] hover:bg-primary/[0.10]"
        )}
        onClick={onToggle}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {buddySpecies ? (
          <img
            src={SPECIES_IMAGE_URL[buddySpecies as Species] || ''}
            alt="" width={24} height={24}
            className="shrink-0 rounded"
          />
        ) : (
          <img src={EGG_IMAGE_URL} alt="egg" width={24} height={24} className="shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <span className="truncate text-[13px] font-medium text-sidebar-foreground">
              {nameDisplay}
            </span>
            {isCollapsed ? (
              <CaretRight size={12} className="shrink-0 text-muted-foreground" />
            ) : (
              <CaretDown size={12} className="shrink-0 text-muted-foreground" />
            )}
          </div>
          <span className="block truncate text-[11px] text-muted-foreground/50 leading-tight">
            / {folderName}
          </span>
        </div>
        {actionButtons}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-md px-2 py-1 cursor-pointer select-none transition-colors",
        "hover:bg-accent/50"
      )}
      onClick={onToggle}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {isCollapsed ? (
        <CaretRight size={14} className="shrink-0 text-muted-foreground" />
      ) : (
        <CaretDown size={14} className="shrink-0 text-muted-foreground" />
      )}
      {isCollapsed ? (
        <Folder size={16} className="shrink-0 text-muted-foreground" />
      ) : (
        <FolderOpen size={16} className="shrink-0 text-muted-foreground" />
      )}
      <span className="flex-1 truncate text-[13px] font-medium text-sidebar-foreground">
        {displayName}
      </span>
      {actionButtons}
    </div>
  );
}
