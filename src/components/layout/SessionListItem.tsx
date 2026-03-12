"use client";

import Link from "next/link";
import {
  Trash,
  Bell,
  Columns,
  X,
} from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChatSession } from "@/types";
import type { TranslationKey } from "@/i18n";

interface SessionListItemProps {
  session: ChatSession;
  isActive: boolean;
  isHovered: boolean;
  isDeleting: boolean;
  isSessionStreaming: boolean;
  needsApproval: boolean;
  canSplit: boolean;
  formatRelativeTime: (dateStr: string, t: (key: TranslationKey, params?: Record<string, string | number>) => string) => string;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onDelete: (e: React.MouseEvent, sessionId: string) => void;
  onAddToSplit: (session: ChatSession) => void;
}

export function SessionListItem({
  session,
  isActive,
  isHovered,
  isDeleting,
  isSessionStreaming,
  needsApproval,
  canSplit,
  formatRelativeTime,
  t,
  onMouseEnter,
  onMouseLeave,
  onDelete,
  onAddToSplit,
}: SessionListItemProps) {
  return (
    <div
      className="group relative"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <Link
        href={`/chat/${session.id}`}
        className={cn(
          "flex items-center gap-1.5 rounded-md pl-2 pr-2 py-1.5 transition-all duration-150 min-w-0",
          isActive
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-accent/50"
        )}
      >
        {/* Left icon area — always same size, swap content via opacity */}
        <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          {/* Split icon: visible on hover when splittable */}
          {canSplit && (
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "absolute inset-0 flex items-center justify-center text-muted-foreground hover:text-foreground transition-opacity h-auto w-auto p-0",
                isHovered ? "opacity-100" : "opacity-0 pointer-events-none"
              )}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onAddToSplit(session);
              }}
            >
              <Columns className="h-3.5 w-3.5" />
            </Button>
          )}
          {/* Streaming indicator: hidden when hover shows split icon */}
          {isSessionStreaming && (
            <span className={cn(
              "relative flex h-2 w-2 transition-opacity",
              isHovered && canSplit ? "opacity-0" : "opacity-100"
            )}>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-success opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-status-success" />
            </span>
          )}
          {/* Approval indicator: hidden when hover shows split icon */}
          {needsApproval && !isSessionStreaming && (
            <span className={cn(
              "flex h-3.5 w-3.5 items-center justify-center rounded-full bg-status-warning-muted transition-opacity",
              isHovered && canSplit ? "opacity-0" : "opacity-100"
            )}>
              <Bell size={10} className="text-status-warning-foreground" />
            </span>
          )}
        </span>
        <div className="flex-1 min-w-0">
          <span className="line-clamp-1 text-[13px] font-medium leading-tight break-all">
            {session.title}
          </span>
        </div>
        {/* Right area — fixed width, time and delete stacked with opacity */}
        <div className="relative w-[38px] h-4 shrink-0">
          <span className={cn(
            "absolute inset-0 flex items-center justify-end text-[11px] text-muted-foreground/40 truncate transition-opacity",
            (isHovered || isDeleting) ? "opacity-0" : "opacity-100"
          )}>
            {formatRelativeTime(session.updated_at, t)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "absolute inset-0 flex items-center justify-end text-muted-foreground/60 hover:text-destructive transition-opacity h-auto w-auto p-0",
              (isHovered || isDeleting) ? "opacity-100" : "opacity-0 pointer-events-none"
            )}
            onClick={(e) => onDelete(e, session.id)}
            disabled={isDeleting}
          >
            <Trash size={14} />
          </Button>
        </div>
      </Link>
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
                  : "text-sidebar-foreground hover:bg-accent/50"
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
}
