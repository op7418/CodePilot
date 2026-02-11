"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, useCallback } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, Search01Icon, Notification02Icon, FileImportIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePanel } from "@/hooks/usePanel";
import { ConnectionStatus } from "./ConnectionStatus";
import { ImportSessionDialog } from "./ImportSessionDialog";
import type { ChatSession } from "@/types";

interface ChatListPanelProps {
  open: boolean;
  width?: number;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr.includes("T") ? dateStr : dateStr + "Z");
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

const DATE_GROUP_ORDER = ["Today", "Yesterday", "Last 7 Days", "Older"];

function groupSessionsByDate(
  sessions: ChatSession[]
): Record<string, ChatSession[]> {
  const groups: Record<string, ChatSession[]> = {};
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const lastWeek = new Date(today.getTime() - 7 * 86400000);

  for (const session of sessions) {
    const date = new Date(session.updated_at);
    let group: string;
    if (date >= today) group = "Today";
    else if (date >= yesterday) group = "Yesterday";
    else if (date >= lastWeek) group = "Last 7 Days";
    else group = "Older";

    if (!groups[group]) groups[group] = [];
    groups[group].push(session);
  }
  return groups;
}

const MODE_BADGE_CONFIG = {
  code: { label: "Code", className: "bg-blue-500/10 text-blue-500" },
  plan: { label: "Plan", className: "bg-sky-500/10 text-sky-500" },
  ask: { label: "Ask", className: "bg-green-500/10 text-green-500" },
} as const;

export function ChatListPanel({ open, width }: ChatListPanelProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { streamingSessionId, pendingApprovalSessionId } = usePanel();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [deletingSession, setDeletingSession] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/sessions");
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch {
      // API may not be available yet
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Refresh session list when navigating
  useEffect(() => {
    fetchSessions();
  }, [pathname, fetchSessions]);

  // Refresh session list when a session is created or updated
  useEffect(() => {
    const handler = () => fetchSessions();
    window.addEventListener('session-created', handler);
    window.addEventListener('session-updated', handler);
    return () => {
      window.removeEventListener('session-created', handler);
      window.removeEventListener('session-updated', handler);
    };
  }, [fetchSessions]);

  const handleDeleteSession = async (
    e: React.MouseEvent,
    sessionId: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Delete this conversation?')) return;
    setDeletingSession(sessionId);
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (pathname === `/chat/${sessionId}`) {
          router.push("/chat");
        }
      }
    } catch {
      // Silently fail
    } finally {
      setDeletingSession(null);
    }
  };

  const filteredSessions = searchQuery
    ? sessions.filter(
        (s) =>
          s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (s.project_name &&
            s.project_name.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : sessions;

  const groupedSessions = groupSessionsByDate(filteredSessions);

  if (!open) return null;

  return (
    <aside className="hidden h-full shrink-0 flex-col overflow-hidden bg-sidebar lg:flex" style={{ width: width ?? 240 }}>
      {/* Header - extra top padding for macOS traffic lights */}
      <div className="flex h-12 shrink-0 items-center justify-between px-3 mt-5 pl-6">
        <span className="text-[13px] font-semibold tracking-tight text-sidebar-foreground">
          Chats
        </span>
        <ConnectionStatus />
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <HugeiconsIcon icon={Search01Icon} className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search chats..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      {/* Import CLI Session */}
      <div className="px-3 pb-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 h-7 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setImportDialogOpen(true)}
            >
              <HugeiconsIcon icon={FileImportIcon} className="h-3 w-3" />
              Import CLI Session
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            Import conversations from Claude Code CLI
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Chat sessions list */}
      <ScrollArea className="flex-1 min-h-0 px-3">
        <div className="flex flex-col pb-3">
          {filteredSessions.length === 0 ? (
            <p className="px-2.5 py-3 text-[11px] text-muted-foreground/60">
              {searchQuery ? "No matching chats" : "No conversations yet"}
            </p>
          ) : (
            DATE_GROUP_ORDER.map((group) => {
              const groupSessions = groupedSessions[group];
              if (!groupSessions || groupSessions.length === 0) return null;
              return (
                <div key={group} className="mt-2 first:mt-0">
                  <span className="px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
                    {group}
                  </span>
                  <div className="mt-1 flex flex-col gap-1">
                    {groupSessions.map((session) => {
                      const isActive = pathname === `/chat/${session.id}`;
                      const isHovered = hoveredSession === session.id;
                      const isDeleting = deletingSession === session.id;
                      const isSessionStreaming = streamingSessionId === session.id;
                      const needsApproval = pendingApprovalSessionId === session.id;
                      const mode = session.mode || "code";
                      const badgeCfg = MODE_BADGE_CONFIG[mode];
                      return (
                        <div
                          key={session.id}
                          className="group relative"
                          onMouseEnter={() => setHoveredSession(session.id)}
                          onMouseLeave={() => setHoveredSession(null)}
                        >
                          <Link
                            href={`/chat/${session.id}`}
                            className={cn(
                              "flex flex-col gap-0.5 rounded-lg px-2.5 py-2 transition-all duration-150",
                              isActive
                                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                : "text-sidebar-foreground hover:bg-accent/50"
                            )}
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              {/* Streaming pulse indicator */}
                              {isSessionStreaming && (
                                <span className="relative flex h-2 w-2 shrink-0">
                                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                                  <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                                </span>
                              )}
                              <span className="line-clamp-2 text-[13px] font-medium leading-tight break-all">
                                {session.title}
                              </span>
                              {/* Approval reminder */}
                              {needsApproval && (
                                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
                                  <HugeiconsIcon icon={Notification02Icon} className="h-2.5 w-2.5 text-amber-500" />
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 min-w-0">
                              {/* Mode badge */}
                              <span className={cn("text-[9px] px-1 py-0.5 rounded font-medium leading-none shrink-0", badgeCfg.className)}>
                                {badgeCfg.label}
                              </span>
                              {session.project_name && (
                                <span className="truncate text-[10px] text-muted-foreground/50">
                                  {session.project_name}
                                </span>
                              )}
                              {session.project_name && (
                                <span className="text-muted-foreground/30 text-[10px]">
                                  ·
                                </span>
                              )}
                              <span className="text-[10px] text-muted-foreground/40 shrink-0">
                                {formatRelativeTime(session.updated_at)}
                              </span>
                            </div>
                          </Link>
                          {(isHovered || isDeleting) && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  className="absolute right-1 top-2 text-muted-foreground/60 hover:text-destructive"
                                  onClick={(e) =>
                                    handleDeleteSession(e, session.id)
                                  }
                                  disabled={isDeleting}
                                >
                                  <HugeiconsIcon icon={Delete02Icon} className="h-3 w-3" />
                                  <span className="sr-only">
                                    Delete session
                                  </span>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="right">
                                Delete
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* Version */}
      <div className="shrink-0 px-3 py-2 text-center">
        <span className="text-[10px] text-muted-foreground/40">
          v{process.env.NEXT_PUBLIC_APP_VERSION}
        </span>
      </div>

      {/* Import CLI Session Dialog */}
      <ImportSessionDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
      />
    </aside>
  );
}
