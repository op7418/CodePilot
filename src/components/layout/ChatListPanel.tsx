"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, useCallback, useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  Search01Icon,
  Notification02Icon,
  FileImportIcon,
  Folder01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  PlusSignIcon,
  FolderOpenIcon,
} from "@hugeicons/core-free-icons";
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
import { useTranslation } from "@/hooks/useTranslation";
import { ConnectionStatus } from "./ConnectionStatus";
import { ImportSessionDialog } from "./ImportSessionDialog";
import { FolderPicker } from "@/components/chat/FolderPicker";
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
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHr < 24) return `${diffHr}h`;
  if (diffDay < 7) return `${diffDay}d`;
  return date.toLocaleDateString();
}

const COLLAPSED_PROJECTS_KEY = "codepilot:collapsed-projects";

function loadCollapsedProjects(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(COLLAPSED_PROJECTS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    // ignore
  }
  return new Set();
}

function saveCollapsedProjects(collapsed: Set<string>) {
  localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsed]));
}

interface ProjectGroup {
  workingDirectory: string;
  displayName: string;
  sessions: ChatSession[];
  latestUpdatedAt: number;
}

function groupSessionsByProject(sessions: ChatSession[]): ProjectGroup[] {
  const map = new Map<string, ChatSession[]>();
  for (const session of sessions) {
    const key = session.working_directory || "";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(session);
  }

  const groups: ProjectGroup[] = [];
  for (const [wd, groupSessions] of map) {
    // Sort sessions within group by updated_at DESC
    groupSessions.sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
    const displayName =
      wd === ""
        ? "No Project"
        : groupSessions[0]?.project_name || wd.split("/").pop() || wd;
    const latestUpdatedAt = new Date(groupSessions[0].updated_at).getTime();
    groups.push({
      workingDirectory: wd,
      displayName,
      sessions: groupSessions,
      latestUpdatedAt,
    });
  }

  // Sort groups by most recently active first
  groups.sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt);
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
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [deletingSession, setDeletingSession] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => loadCollapsedProjects()
  );
  const [hoveredFolder, setHoveredFolder] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);

  const handleNewChat = useCallback(async () => {
    const lastDir = typeof window !== 'undefined'
      ? localStorage.getItem("codepilot:last-working-directory")
      : null;

    if (!lastDir) {
      // No saved directory — let user pick one
      setFolderPickerOpen(true);
      return;
    }

    // Validate the saved directory still exists
    setCreatingChat(true);
    try {
      const checkRes = await fetch(
        `/api/files/browse?dir=${encodeURIComponent(lastDir)}`
      );
      if (!checkRes.ok) {
        // Directory is gone — clear stale value and prompt user
        localStorage.removeItem("codepilot:last-working-directory");
        setFolderPickerOpen(true);
        return;
      }

      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ working_directory: lastDir }),
      });
      if (!res.ok) {
        // Backend rejected it (e.g. INVALID_DIRECTORY) — prompt user
        localStorage.removeItem("codepilot:last-working-directory");
        setFolderPickerOpen(true);
        return;
      }
      const data = await res.json();
      router.push(`/chat/${data.session.id}`);
      window.dispatchEvent(new CustomEvent("session-created"));
    } catch {
      setFolderPickerOpen(true);
    } finally {
      setCreatingChat(false);
    }
  }, [router]);

  const toggleProject = useCallback((wd: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(wd)) next.delete(wd);
      else next.add(wd);
      saveCollapsedProjects(next);
      return next;
    });
  }, []);

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
    window.addEventListener("session-created", handler);
    window.addEventListener("session-updated", handler);
    return () => {
      window.removeEventListener("session-created", handler);
      window.removeEventListener("session-updated", handler);
    };
  }, [fetchSessions]);

  const handleDeleteSession = async (
    e: React.MouseEvent,
    sessionId: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(t('chatList.deleteConfirm'))) return;
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

  const handleCreateSessionInProject = async (
    e: React.MouseEvent,
    workingDirectory: string
  ) => {
    e.stopPropagation();
    try {
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ working_directory: workingDirectory }),
      });
      if (res.ok) {
        const data = await res.json();
        window.dispatchEvent(new CustomEvent("session-created"));
        router.push(`/chat/${data.session.id}`);
      }
    } catch {
      // Silently fail
    }
  };

  const handleFolderSelect = async (path: string) => {
    try {
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ working_directory: path }),
      });
      if (res.ok) {
        const data = await res.json();
        window.dispatchEvent(new CustomEvent("session-created"));
        router.push(`/chat/${data.session.id}`);
      }
    } catch {
      // Silently fail
    }
  };

  const isSearching = searchQuery.length > 0;

  const filteredSessions = searchQuery
    ? sessions.filter(
        (s) =>
          s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (s.project_name &&
            s.project_name.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : sessions;

  const projectGroups = useMemo(
    () => groupSessionsByProject(filteredSessions),
    [filteredSessions]
  );

  if (!open) return null;

  return (
    <aside
      className="hidden h-full shrink-0 flex-col overflow-hidden bg-sidebar lg:flex"
      style={{ width: width ?? 240 }}
    >
      {/* Header - extra top padding for macOS traffic lights */}
      <div className="flex h-12 shrink-0 items-center justify-between px-3 mt-5 pl-6">
        <span className="text-[13px] font-semibold tracking-tight text-sidebar-foreground">
          {t('chatList.threads')}
        </span>
        <ConnectionStatus />
      </div>

      {/* New Chat + New Project */}
      <div className="flex items-center gap-2 px-3 pb-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 justify-center gap-1.5 h-8 text-xs"
          disabled={creatingChat}
          onClick={handleNewChat}
        >
          <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
          {t('chatList.newChat')}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              className="h-8 w-8 shrink-0"
              onClick={() => setFolderPickerOpen(true)}
            >
              <HugeiconsIcon icon={FolderOpenIcon} className="h-3.5 w-3.5" />
              <span className="sr-only">{t('chatList.openProjectFolder')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('chatList.openProjectFolder')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="relative">
          <HugeiconsIcon
            icon={Search01Icon}
            className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            placeholder={t('chatList.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      {/* Import CLI Session */}
      <div className="px-3 pb-1">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 h-7 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setImportDialogOpen(true)}
        >
          <HugeiconsIcon icon={FileImportIcon} className="h-3 w-3" />
          {t('chatList.importCliSession')}
        </Button>
      </div>

      {/* Session list grouped by project */}
      <ScrollArea className="flex-1 min-h-0 px-3">
        <div className="flex flex-col pb-3">
          {filteredSessions.length === 0 ? (
            <p className="px-2.5 py-3 text-[11px] text-muted-foreground/60">
              {searchQuery ? t('chatList.noMatchingThreads') : t('chatList.noConversations')}
            </p>
          ) : (
            projectGroups.map((group) => {
              const isCollapsed =
                !isSearching && collapsedProjects.has(group.workingDirectory);
              const isFolderHovered =
                hoveredFolder === group.workingDirectory;

              return (
                <div key={group.workingDirectory || "__no_project"} className="mt-1 first:mt-0">
                  {/* Folder header */}
                  <div
                    className={cn(
                      "flex items-center gap-1 rounded-md px-2 py-1 cursor-pointer select-none transition-colors",
                      "hover:bg-accent/50"
                    )}
                    onClick={() => toggleProject(group.workingDirectory)}
                    onMouseEnter={() =>
                      setHoveredFolder(group.workingDirectory)
                    }
                    onMouseLeave={() => setHoveredFolder(null)}
                  >
                    <HugeiconsIcon
                      icon={isCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                      className="h-3 w-3 shrink-0 text-muted-foreground"
                    />
                    <HugeiconsIcon
                      icon={Folder01Icon}
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="flex-1 truncate text-[12px] font-medium text-sidebar-foreground">
                      {group.displayName === "No Project" ? t('chatList.noProject') : group.displayName}
                    </span>
                    {/* New chat in project button (on hover) */}
                    {group.workingDirectory !== "" && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className={cn(
                              "h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground transition-opacity",
                              isFolderHovered ? "opacity-100" : "opacity-0"
                            )}
                            tabIndex={isFolderHovered ? 0 : -1}
                            onClick={(e) =>
                              handleCreateSessionInProject(
                                e,
                                group.workingDirectory
                              )
                            }
                          >
                            <HugeiconsIcon
                              icon={PlusSignIcon}
                              className="h-3 w-3"
                            />
                            <span className="sr-only">
                              {t('chatList.newChatIn', { name: group.displayName })}
                            </span>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {t('chatList.newChatIn', { name: group.displayName })}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>

                  {/* Session items */}
                  {!isCollapsed && (
                    <div className="mt-0.5 flex flex-col gap-0.5">
                      {group.sessions.map((session) => {
                        const isActive = pathname === `/chat/${session.id}`;
                        const isHovered = hoveredSession === session.id;
                        const isDeleting = deletingSession === session.id;
                        const isSessionStreaming =
                          streamingSessionId === session.id;
                        const needsApproval =
                          pendingApprovalSessionId === session.id;
                        const mode = session.mode || "code";
                        const badgeCfg = MODE_BADGE_CONFIG[mode];

                        return (
                          <div
                            key={session.id}
                            className="group relative"
                            onMouseEnter={() =>
                              setHoveredSession(session.id)
                            }
                            onMouseLeave={() => setHoveredSession(null)}
                          >
                            <Link
                              href={`/chat/${session.id}`}
                              className={cn(
                                "flex items-center gap-1.5 rounded-md pl-7 pr-2 py-1.5 transition-all duration-150 min-w-0",
                                isActive
                                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                  : "text-sidebar-foreground hover:bg-accent/50"
                              )}
                            >
                              {/* Streaming pulse indicator */}
                              {isSessionStreaming && (
                                <span className="relative flex h-2 w-2 shrink-0">
                                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                                  <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                                </span>
                              )}
                              {/* Approval indicator */}
                              {needsApproval && (
                                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
                                  <HugeiconsIcon
                                    icon={Notification02Icon}
                                    className="h-2.5 w-2.5 text-amber-500"
                                  />
                                </span>
                              )}
                              <div className="flex-1 min-w-0">
                                <span className="line-clamp-1 text-[12px] font-medium leading-tight break-all">
                                  {session.title}
                                </span>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                {/* Mode badge */}
                                <span
                                  className={cn(
                                    "text-[9px] px-1 py-0.5 rounded font-medium leading-none",
                                    badgeCfg.className
                                  )}
                                >
                                  {badgeCfg.label}
                                </span>
                                <span className="text-[10px] text-muted-foreground/40">
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
                                    className="absolute right-1 top-1 bg-sidebar text-muted-foreground/60 hover:text-destructive"
                                    onClick={(e) =>
                                      handleDeleteSession(e, session.id)
                                    }
                                    disabled={isDeleting}
                                  >
                                    <HugeiconsIcon
                                      icon={Delete02Icon}
                                      className="h-3 w-3"
                                    />
                                    <span className="sr-only">
                                      {t('chatList.deleteSession')}
                                    </span>
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent side="right">
                                  {t('chatList.delete')}
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
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

      {/* Folder Picker Dialog */}
      <FolderPicker
        open={folderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        onSelect={handleFolderSelect}
      />
    </aside>
  );
}
