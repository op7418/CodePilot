"use client";

import { memo, useState } from "react";
import Link from "next/link";
import {
  Bell,
  Columns,
  X,
  DotsThree,
} from "@/components/ui/icon";
import { CodePilotIcon } from "@/components/ui/semantic-icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { cn } from "@/lib/utils";
import type { ChatSession } from "@/types";
import type { TranslationKey } from "@/i18n";
import { copyWithToast } from "@/lib/clipboard";

interface SessionListItemProps {
  session: ChatSession;
  isActive: boolean;
  isHovered: boolean;
  isDeleting: boolean;
  isSessionStreaming: boolean;
  needsApproval: boolean;
  canSplit: boolean;
  /** Whether this session belongs to the assistant workspace */
  isWorkspace?: boolean;
  formatRelativeTime: (dateStr: string, t: (key: TranslationKey, params?: Record<string, string | number>) => string) => string;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  onMouseEnter: (sessionId: string) => void;
  onMouseLeave: () => void;
  onDelete: (e: React.MouseEvent, sessionId: string) => void;
  onRename: (sessionId: string, newTitle: string) => void;
  onAddToSplit: (session: ChatSession) => void;
}

export const SessionListItem = memo(function SessionListItem({
  session,
  isActive,
  isHovered,
  isDeleting,
  isSessionStreaming,
  needsApproval,
  canSplit,
  isWorkspace,
  formatRelativeTime,
  t,
  onMouseEnter,
  onMouseLeave,
  onDelete,
  onRename,
  onAddToSplit,
}: SessionListItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const showActions = isHovered || menuOpen || isDeleting;

  return (
    <div
      className="group relative"
      onMouseEnter={() => onMouseEnter(session.id)}
      onMouseLeave={onMouseLeave}
    >
      <Link
        href={`/chat/${session.id}`}
        className={cn(
          "flex items-center gap-2 rounded-xl px-3 h-8 transition-all duration-150 min-w-0",
          isWorkspace
            ? isActive
              ? "bg-primary/[0.12] text-sidebar-accent-foreground"
              : "text-sidebar-foreground hover:bg-primary/[0.10]"
            : isActive
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground hover:bg-sidebar-accent"
        )}
      >
        {/* Left icon area — streaming/approval indicators.
            Skip empty 14px slot for assistant (workspace) sessions when idle:
            助理 section 是 flat list,无父 folder,空 slot 看着像无意义缩进。
            项目下的会话保留以维持"在 folder 内"的层级感。 */}
        {(isSessionStreaming || needsApproval || !isWorkspace) && (
          <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            {isSessionStreaming && (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-success opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-status-success" />
              </span>
            )}
            {needsApproval && !isSessionStreaming && (
              <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-status-warning-muted">
                <Bell size={10} className="text-status-warning-foreground" />
              </span>
            )}
          </span>
        )}
        {/* Title — flex-1 + truncate ensures it shrinks */}
        <span className="flex-1 min-w-0 line-clamp-1 text-[13px] font-normal leading-tight break-all">
          {session.title}
        </span>
        {/* Right area — fixed width, time or dots swap via opacity */}
        <span className="shrink-0 w-[38px] flex items-center justify-end">
          <span className={cn(
            "text-[11px] text-muted-foreground/40 truncate transition-opacity",
            showActions ? "opacity-0" : "opacity-100"
          )}>
            {formatRelativeTime(session.updated_at, t)}
          </span>
        </span>
      </Link>
      {/* Three-dot menu — absolute over the right area */}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "absolute right-2 top-1/2 -translate-y-1/2 z-10 flex items-center justify-center text-muted-foreground/60 hover:text-foreground transition-opacity h-5 w-5 p-0",
              showActions ? "opacity-100" : "opacity-0 pointer-events-none"
            )}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <DotsThree size={16} weight="bold" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[160px]">
          <DropdownMenuItem
            disabled={isActive || !canSplit}
            onClick={() => onAddToSplit(session)}
          >
            <Columns size={14} />
            <span>{t('chatList.splitScreen' as TranslationKey)}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              // Prevent the default close-menu → focus-trigger behavior.
              // Radix DropdownMenu tries to restore focus to the trigger
              // when the menu closes, which fights with the dialog's
              // autoFocus. Calling preventDefault lets us manage close
              // independently and open the dialog cleanly.
              e.preventDefault();
              setMenuOpen(false);
              setRenameOpen(true);
            }}
          >
            <CodePilotIcon name="edit" size="sm" aria-hidden />
            <span>{t('chatList.renameConversation' as TranslationKey)}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            // v11 fix — see lib/clipboard.ts for why fire-and-forget
            // writeText fails in Electron renderers post-DropdownMenu blur.
            void copyWithToast({ text: session.id, t });
          }}>
            <CodePilotIcon name="copy" size="sm" aria-hidden />
            <span>{t('chatList.copySessionId' as TranslationKey)}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={(e) => onDelete(e as unknown as React.MouseEvent, session.id)}
          >
            <CodePilotIcon name="delete" size="sm" aria-hidden />
            <span>{t('chatList.deleteConversation' as TranslationKey)}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Rename dialog — replaces window.prompt() which is unsupported in
          Electron renderers (throws TypeError: prompt() is not supported).
          See docs/exec-plans/active/v0.48-post-release-issues.md §5.6. */}
      <PromptDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title={t('prompt.rename.title' as TranslationKey)}
        defaultValue={session.title}
        placeholder={t('prompt.rename.placeholder' as TranslationKey)}
        confirmLabel={t('common.confirm' as TranslationKey)}
        cancelLabel={t('common.cancel' as TranslationKey)}
        onConfirm={(value) => {
          if (value !== session.title) {
            onRename(session.id, value);
          }
        }}
      />
    </div>
  );
}

interface SplitGroupSectionProps {
  splitSessions: Array<{ sessionId: string; title: string }>;
  activeColumnId: string;
  streamingSessionId: string;
  pendingApprovalSessionId: string;
  activeStreamingSessions: Set<string>;
  pendingApprovalSessionIds: Set<string>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  setActiveColumn: (sessionId: string) => void;
  removeFromSplit: (sessionId: string) => void;
}

export function SplitGroupSection({
  splitSessions,
  activeColumnId,
  streamingSessionId,
  pendingApprovalSessionId,
  activeStreamingSessions,
  pendingApprovalSessionIds,
  t,
  setActiveColumn,
  removeFromSplit,
}: SplitGroupSectionProps) {
  return (
    <div className="mb-2 rounded-lg border border-border/60 bg-muted/30 p-1.5">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <Columns className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">{t('split.splitGroup' as TranslationKey)}</span>
      </div>
      <div className="mt-0.5 flex flex-col gap-0.5">
        {splitSessions.map((session) => {
          const isActiveInSplit = activeColumnId === session.sessionId;
          const isSessionStreaming =
            activeStreamingSessions.has(session.sessionId) || streamingSessionId === session.sessionId;
          const needsApproval =
            pendingApprovalSessionIds.has(session.sessionId) || pendingApprovalSessionId === session.sessionId;

          return (
            <div
              key={session.sessionId}
              className={cn(
                "group relative flex items-center gap-1.5 rounded-md pl-7 pr-2 py-1.5 transition-all duration-150 min-w-0 cursor-pointer",
                isActiveInSplit
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/50"
              )}
              onClick={(e) => {
                e.preventDefault();
                setActiveColumn(session.sessionId);
              }}
            >
              {isSessionStreaming && (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-success opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-status-success" />
                </span>
              )}
              {needsApproval && (
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-status-warning-muted">
                  <Bell size={10} className="text-status-warning-foreground" />
                </span>
              )}
              <div className="flex-1 min-w-0">
                <span className="line-clamp-1 text-[13px] font-medium leading-tight break-all">
                  {session.title}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                className="h-4 w-4 shrink-0 text-muted-foreground/60 hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => {
                  e.stopPropagation();
                  removeFromSplit(session.sessionId);
                }}
              >
                <X className="h-2.5 w-2.5" />
                <span className="sr-only">{t('split.closeSplit' as TranslationKey)}</span>
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
});
