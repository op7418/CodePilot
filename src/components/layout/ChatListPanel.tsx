"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  MagnifyingGlass,
  FileArrowDown,
  Plus,
  FolderOpen,
} from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePanel } from "@/hooks/usePanel";
import { useSplit } from "@/hooks/useSplit";
import { useTranslation } from "@/hooks/useTranslation";
import { useNativeFolderPicker } from "@/hooks/useNativeFolderPicker";
import { ConnectionStatus } from "./ConnectionStatus";
import { ImportSessionDialog } from "./ImportSessionDialog";
import { SessionListItem, SplitGroupSection } from "./SessionListItem";
import { ProjectGroupHeader } from "./ProjectGroupHeader";
import { FolderPicker } from "@/components/chat/FolderPicker";
import { useAssistantWorkspace } from "@/hooks/useAssistantWorkspace";
import {
  formatRelativeTime,
  groupSessionsByProject,
  loadCollapsedProjects,
  saveCollapsedProjects,
  COLLAPSED_INITIALIZED_KEY,
} from "./chat-list-utils";
import type { ChatSession } from "@/types";

interface ChatListPanelProps {
  open: boolean;
  width?: number;
}


export function ChatListPanel({ open, width }: ChatListPanelProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { streamingSessionId, pendingApprovalSessionId, activeStreamingSessions, pendingApprovalSessionIds, workingDirectory } = usePanel();
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
  const { workspacePath } = useAssistantWorkspace();

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
  }, [router, workingDirectory, openFolderPicker, getCurrentModelAndProvider]);

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
      className="hidden h-full shrink-0 flex-col overflow-hidden bg-sidebar/80 backdrop-blur-xl lg:flex"
      style={{ width: width ?? 240 }}
    >
      {/* Header - extra top padding for macOS traffic lights */}
      <div className="flex h-12 shrink-0 items-center justify-between px-3 mt-5">
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
          <Plus size={14} />
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
              <FolderOpen size={14} />
              <span className="sr-only">{t('chatList.addProjectFolder')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('chatList.addProjectFolder')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="relative">
          <MagnifyingGlass
            size={12}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
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
          <FileArrowDown size={12} />
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
            <SplitGroupSection
              splitSessions={splitSessions}
              activeColumnId={activeColumnId}
              streamingSessionId={streamingSessionId}
              pendingApprovalSessionId={pendingApprovalSessionId}
              activeStreamingSessions={activeStreamingSessions}
              pendingApprovalSessionIds={pendingApprovalSessionIds}
              t={t}
              setActiveColumn={setActiveColumn}
              removeFromSplit={removeFromSplit}
            />
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
                  <ProjectGroupHeader
                    workingDirectory={group.workingDirectory}
                    displayName={group.displayName}
                    isCollapsed={isCollapsed}
                    isFolderHovered={isFolderHovered}
                    isWorkspace={!!(workspacePath && group.workingDirectory === workspacePath)}
                    onToggle={() => toggleProject(group.workingDirectory)}
                    onMouseEnter={() => setHoveredFolder(group.workingDirectory)}
                    onMouseLeave={() => setHoveredFolder(null)}
                    onCreateSession={(e) => handleCreateSessionInProject(e, group.workingDirectory)}
                  />

                  {/* Session items */}
                  {!isCollapsed && (
                    <div className="mt-0.5 flex flex-col gap-0.5">
                      {group.sessions.map((session) => {
                        const isActive = pathname === `/chat/${session.id}`;
                        const canSplit = !isActive && !isInSplit(session.id);

                        return (
                          <SessionListItem
                            key={session.id}
                            session={session}
                            isActive={isActive}
                            isHovered={hoveredSession === session.id}
                            isDeleting={deletingSession === session.id}
                            isSessionStreaming={activeStreamingSessions.has(session.id) || streamingSessionId === session.id}
                            needsApproval={pendingApprovalSessionIds.has(session.id) || pendingApprovalSessionId === session.id}
                            canSplit={canSplit}
                            formatRelativeTime={formatRelativeTime}
                            t={t}
                            onMouseEnter={() => setHoveredSession(session.id)}
                            onMouseLeave={() => setHoveredSession(null)}
                            onDelete={handleDeleteSession}
                            onAddToSplit={(s) => addToSplit({
                              sessionId: s.id,
                              title: s.title,
                              workingDirectory: s.working_directory || "",
                              projectName: s.project_name || "",
                              mode: s.mode,
                            })}
                          />
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
