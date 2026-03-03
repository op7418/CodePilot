"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
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
import { Columns2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, parseDBDate } from "@/lib/utils";
import { usePanel } from "@/hooks/usePanel";
import { useSplit } from "@/hooks/useSplit";
import { useTranslation } from "@/hooks/useTranslation";
import { useNativeFolderPicker } from "@/hooks/useNativeFolderPicker";
import { ConnectionStatus } from "./ConnectionStatus";
import { ImportSessionDialog } from "./ImportSessionDialog";
import { FolderPicker } from "@/components/chat/FolderPicker";
import type { ChatSession } from "@/types";

interface ChatListPanelProps {
  open: boolean;
  width?: number;
}

function formatRelativeTime(dateStr: string, t: (key: import('@/i18n').TranslationKey, params?: Record<string, string | number>) => string): string {
  const date = parseDBDate(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return t('chatList.justNow');
  if (diffMin < 60) return t('chatList.minutesAgo', { n: diffMin });
  if (diffHr < 24) return t('chatList.hoursAgo', { n: diffHr });
  if (diffDay < 7) return t('chatList.daysAgo', { n: diffDay });
  return date.toLocaleDateString();
}

const COLLAPSED_PROJECTS_KEY = "codepilot:collapsed-projects";
const COLLAPSED_INITIALIZED_KEY = "codepilot:collapsed-initialized";

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
        parseDBDate(b.updated_at).getTime() - parseDBDate(a.updated_at).getTime()
    );
    const displayName =
      wd === ""
        ? "No Project"
        : groupSessions[0]?.project_name || wd.split("/").pop() || wd;
    const latestUpdatedAt = parseDBDate(groupSessions[0].updated_at).getTime();
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

export function ChatListPanel({ open, width }: ChatListPanelProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { streamingSessionId, pendingApprovalSessionId, activeStreamingSessions, pendingApprovalSessionIds, workingDirectory, sessionId: currentSessionId } = usePanel();
  const { splitSessions, isSplitActive, activeColumnId, addToSplit, removeFromSplit, setActiveColumn, isInSplit } = useSplit();
  const { t } = useTranslation();
  const { isElectron, openNativePicker } = useNativeFolderPicker();
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

  /** Read current model + provider_id from localStorage for new session creation */
  const getCurrentModelAndProvider = useCallback(() => {
    const model = typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-model') || '' : '';
    const provider_id = typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-provider-id') || '' : '';
    return { model, provider_id };
  }, []);

  const handleFolderSelect = useCallback(async (path: string) => {
    try {
      const { model, provider_id } = getCurrentModelAndProvider();
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ working_directory: path, model, provider_id }),
      });
      if (res.ok) {
        const data = await res.json();
        window.dispatchEvent(new CustomEvent("session-created"));
        router.push(`/chat/${data.session.id}`);
      }
    } catch {
      // Silently fail
    }
  }, [router, getCurrentModelAndProvider]);

  const openFolderPicker = useCallback(async (defaultPath?: string) => {
    if (isElectron) {
      const path = await openNativePicker({ defaultPath, title: t('folderPicker.title') });
      if (path) handleFolderSelect(path);
    } else {
      setFolderPickerOpen(true);
    }
  }, [isElectron, openNativePicker, t, handleFolderSelect]);

  const handleNewChat = useCallback(async () => {
    const lastDir = workingDirectory
      || (typeof window !== 'undefined' ? localStorage.getItem("codepilot:last-working-directory") : null);

    if (!lastDir) {
      // No saved directory — let user pick one
      openFolderPicker();
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
        openFolderPicker();
        return;
      }

      const { model, provider_id } = getCurrentModelAndProvider();
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ working_directory: lastDir, model, provider_id }),
      });
      if (!res.ok) {
        // Backend rejected it (e.g. INVALID_DIRECTORY) — prompt user
        localStorage.removeItem("codepilot:last-working-directory");
        openFolderPicker();
        return;
      }
      const data = await res.json();
      router.push(`/chat/${data.session.id}`);
      window.dispatchEvent(new CustomEvent("session-created"));
    } catch {
      openFolderPicker();
    } finally {
      setCreatingChat(false);
    }
  }, [router, workingDirectory, openFolderPicker]);

  const toggleProject = useCallback((wd: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(wd)) next.delete(wd);
      else next.add(wd);
      saveCollapsedProjects(next);
      return next;
    });
  }, []);

  // AbortController ref for cancelling in-flight requests
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSessions = useCallback(async () => {
    // Cancel any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/chat/sessions", { signal: controller.signal });
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch (e) {
      // Ignore abort errors; log others
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
  }, []);

  const debouncedFetchSessions = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchSessions();
    }, 300);
  }, [fetchSessions]);

  // Fetch on mount
  useEffect(() => {
    fetchSessions();
    return () => {
      abortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [fetchSessions]);

  // Refresh session list when a session is created or updated (debounced)
  useEffect(() => {
    const handler = () => debouncedFetchSessions();
    window.addEventListener("session-created", handler);
    window.addEventListener("session-updated", handler);
    return () => {
      window.removeEventListener("session-created", handler);
      window.removeEventListener("session-updated", handler);
    };
  }, [debouncedFetchSessions]);

  // Periodic poll to catch sessions created server-side (e.g. bridge)
  useEffect(() => {
    const interval = setInterval(() => {
      fetchSessions();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  const handleDeleteSession = async (
    e: React.MouseEvent,
    sessionId: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this conversation?")) return;
    setDeletingSession(sessionId);
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        // Remove from split if it's there
        if (isInSplit(sessionId)) {
          removeFromSplit(sessionId);
        }
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
      const { model, provider_id } = getCurrentModelAndProvider();
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ working_directory: workingDirectory, model, provider_id }),
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

  const splitSessionIds = useMemo(
    () => new Set(splitSessions.map((s) => s.sessionId)),
    [splitSessions]
  );

  const filteredSessions = useMemo(() => {
    let result = sessions;
    if (searchQuery) {
      result = result.filter(
        (s) =>
          s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (s.project_name &&
            s.project_name.toLowerCase().includes(searchQuery.toLowerCase()))
      );
    }
    // Exclude sessions in split group (they are shown in the split section)
    if (isSplitActive) {
      result = result.filter((s) => !splitSessionIds.has(s.id));
    }
    return result;
  }, [sessions, searchQuery, isSplitActive, splitSessionIds]);

  const projectGroups = useMemo(
    () => groupSessionsByProject(filteredSessions),
    [filteredSessions]
  );

  // On first use, auto-collapse all project groups except the most recent one
  useEffect(() => {
    if (projectGroups.length <= 1) return;
    if (localStorage.getItem(COLLAPSED_INITIALIZED_KEY)) return;
    const toCollapse = new Set(
      projectGroups.slice(1).map((g) => g.workingDirectory)
    );
    setCollapsedProjects(toCollapse);
    saveCollapsedProjects(toCollapse);
    localStorage.setItem(COLLAPSED_INITIALIZED_KEY, "1");
  }, [projectGroups]);

  if (!open) return null;

  return (
    <aside
      className="hidden h-full shrink-0 flex-col overflow-hidden bg-sidebar lg:flex"
      style={{ width: width ?? 240 }}
    >
      {/* Header - extra top padding for macOS traffic lights */}
      <div className="flex h-12 shrink-0 items-center px-3 mt-5">
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
          {t('chatList.newConversation')}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              className="h-8 w-8 shrink-0"
              onClick={() => openFolderPicker()}
            >
              <HugeiconsIcon icon={FolderOpenIcon} className="h-3.5 w-3.5" />
              <span className="sr-only">{t('chatList.addProjectFolder')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('chatList.addProjectFolder')}</TooltipContent>
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
            placeholder={t('chatList.searchSessions')}
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
          {t('chatList.importFromCli')}
        </Button>
      </div>

      {/* Session list grouped by project */}
      <ScrollArea className="flex-1 min-h-0 px-3">
        <div className="flex flex-col pb-3">
          {/* Section title */}
          <div className="px-2 pt-1 pb-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
              {t('chatList.threads')}
            </span>
          </div>

          {/* Split group section */}
          {isSplitActive && (
            <div className="mb-2 rounded-lg border border-border/60 bg-muted/30 p-1.5">
              <div className="flex items-center gap-1.5 px-2 py-1">
                <Columns2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">{t('split.splitGroup')}</span>
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
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                        </span>
                      )}
                      {needsApproval && (
                        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
                          <HugeiconsIcon icon={Notification02Icon} className="h-2.5 w-2.5 text-amber-500" />
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
                        <span className="sr-only">{t('split.closeSplit')}</span>
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {filteredSessions.length === 0 && (!isSplitActive || splitSessions.length === 0) ? (
            <p className="px-2.5 py-3 text-[11px] text-muted-foreground/60">
              {searchQuery ? "No matching threads" : t('chatList.noSessions')}
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
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        className={cn(
                          "flex items-center gap-1 rounded-md px-2 py-1 cursor-pointer select-none transition-colors",
                          "hover:bg-accent/50"
                        )}
                        onClick={() => toggleProject(group.workingDirectory)}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          if (group.workingDirectory) {
                            if (window.electronAPI?.shell?.openPath) {
                              window.electronAPI.shell.openPath(group.workingDirectory);
                            } else {
                              fetch('/api/files/open', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ path: group.workingDirectory }),
                              }).catch(() => {});
                            }
                          }
                        }}
                        onMouseEnter={() =>
                          setHoveredFolder(group.workingDirectory)
                        }
                        onMouseLeave={() => setHoveredFolder(null)}
                      >
                    <HugeiconsIcon
                      icon={isCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                    <HugeiconsIcon
                      icon={isCollapsed ? Folder01Icon : FolderOpenIcon}
                      className="h-4 w-4 shrink-0 text-muted-foreground"
                    />
                    <span className="flex-1 truncate text-[13px] font-medium text-sidebar-foreground">
                      {group.displayName}
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
                              className="h-3.5 w-3.5"
                            />
                            <span className="sr-only">
                              New chat in {group.displayName}
                            </span>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          New chat in {group.displayName}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-xs">
                      <p className="text-xs break-all">{group.workingDirectory || 'No Project'}</p>
                      {group.workingDirectory && <p className="text-[10px] text-muted-foreground mt-0.5">Double-click to open in Finder</p>}
                    </TooltipContent>
                  </Tooltip>

                  {/* Session items */}
                  {!isCollapsed && (
                    <div className="mt-0.5 flex flex-col gap-0.5">
                      {group.sessions.map((session) => {
                        const isActive = pathname === `/chat/${session.id}`;
                        const isHovered = hoveredSession === session.id;
                        const isDeleting = deletingSession === session.id;
                        const isSessionStreaming =
                          activeStreamingSessions.has(session.id) || streamingSessionId === session.id;
                        const needsApproval =
                          pendingApprovalSessionIds.has(session.id) || pendingApprovalSessionId === session.id;
                        const canSplit = !isActive && !isInSplit(session.id);

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
                                  <button
                                    className={cn(
                                      "absolute inset-0 flex items-center justify-center text-muted-foreground hover:text-foreground transition-opacity",
                                      isHovered ? "opacity-100" : "opacity-0 pointer-events-none"
                                    )}
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      addToSplit({
                                        sessionId: session.id,
                                        title: session.title,
                                        workingDirectory: session.working_directory || "",
                                        projectName: session.project_name || "",
                                        mode: session.mode,
                                      });
                                    }}
                                  >
                                    <Columns2 className="h-3.5 w-3.5" />
                                  </button>
                                )}
                                {/* Streaming indicator: hidden when hover shows split icon */}
                                {isSessionStreaming && (
                                  <span className={cn(
                                    "relative flex h-2 w-2 transition-opacity",
                                    isHovered && canSplit ? "opacity-0" : "opacity-100"
                                  )}>
                                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                                    <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                                  </span>
                                )}
                                {/* Approval indicator: hidden when hover shows split icon */}
                                {needsApproval && !isSessionStreaming && (
                                  <span className={cn(
                                    "flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500/10 transition-opacity",
                                    isHovered && canSplit ? "opacity-0" : "opacity-100"
                                  )}>
                                    <HugeiconsIcon icon={Notification02Icon} className="h-2.5 w-2.5 text-amber-500" />
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
                                <button
                                  className={cn(
                                    "absolute inset-0 flex items-center justify-end text-muted-foreground/60 hover:text-destructive transition-opacity",
                                    (isHovered || isDeleting) ? "opacity-100" : "opacity-0 pointer-events-none"
                                  )}
                                  onClick={(e) => handleDeleteSession(e, session.id)}
                                  disabled={isDeleting}
                                >
                                  <HugeiconsIcon icon={Delete02Icon} className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </Link>
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
