"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import {
  MagnifyingGlass,
  FileArrowDown,
  Plus,
  FolderOpen,
  FolderPlus,
  Lightning,
  Plug,
  Terminal,
  Image,
  WifiHigh,
  Gear,
  X,
} from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePanel } from "@/hooks/usePanel";
import { useSplit } from "@/hooks/useSplit";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import { useNativeFolderPicker } from "@/hooks/useNativeFolderPicker";
import { showToast } from '@/hooks/useToast';
import { ConnectionStatus } from "./ConnectionStatus";
// ImportSessionDialog moved to Settings page
import { SessionListItem, SplitGroupSection } from "./SessionListItem";
import { ProjectGroupHeader } from "./ProjectGroupHeader";
import { FolderPicker } from "@/components/chat/FolderPicker";
import { useAssistantWorkspace } from "@/hooks/useAssistantWorkspace";
import { AssistantPromoCard } from "@/components/chat/ChatEmptyState";
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
  hasUpdate?: boolean;
  readyToInstall?: boolean;
}


export function ChatListPanel({ open, width, hasUpdate, readyToInstall }: ChatListPanelProps) {
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
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  const [expandedSessionGroups, setExpandedSessionGroups] = useState<Set<string>>(new Set());
  const SESSION_TRUNCATE_LIMIT = 10;
  // importDialogOpen removed — Import CLI moved to Settings
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => loadCollapsedProjects()
  );
  const [hoveredFolder, setHoveredFolder] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const { workspacePath } = useAssistantWorkspace();
  const [assistantSummary, setAssistantSummary] = useState<{
    name: string;
    memoryCount: number;
    lastHeartbeatDate: string;
    configured: boolean;
    buddy?: { emoji: string; buddyName?: string; species?: string };
  } | null>(null);
  const [promoDismissed, setPromoDismissed] = useState(false);

  // Reload assistant summary when sessions change (e.g. after onboarding/rename)
  useEffect(() => {
    fetch('/api/workspace/summary')
      .then(r => r.ok ? r.json() : null)
      .then(data => setAssistantSummary(data))
      .catch(() => {});
  }, [sessions.length]);

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
    let lastDir = workingDirectory
      || (typeof window !== 'undefined' ? localStorage.getItem("codepilot:last-working-directory") : null);

    // Fall back to setup default project if no recent directory
    if (!lastDir) {
      try {
        const setupRes = await fetch('/api/setup');
        if (setupRes.ok) {
          const setupData = await setupRes.json();
          if (setupData.defaultProject) {
            lastDir = setupData.defaultProject;
            localStorage.setItem('codepilot:last-working-directory', lastDir!);
          }
        }
      } catch { /* ignore */ }
    }

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
        // Directory is gone — clear stale value, try setup default before prompting
        localStorage.removeItem("codepilot:last-working-directory");
        let recovered = false;
        try {
          const setupRes = await fetch('/api/setup');
          if (setupRes.ok) {
            const setupData = await setupRes.json();
            if (setupData.defaultProject && setupData.defaultProject !== lastDir) {
              const defaultCheck = await fetch(`/api/files/browse?dir=${encodeURIComponent(setupData.defaultProject)}`);
              if (defaultCheck.ok) {
                lastDir = setupData.defaultProject;
                localStorage.setItem('codepilot:last-working-directory', lastDir!);
                recovered = true;
              }
            }
          }
        } catch { /* ignore */ }
        if (!recovered) {
          showToast({
            type: 'warning',
            message: t('error.directoryInvalid'),
            action: { label: t('error.selectDirectory'), onClick: () => openFolderPicker() },
          });
          openFolderPicker();
          return;
        }
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
  }, [router, workingDirectory, openFolderPicker, getCurrentModelAndProvider, t]);

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

  const handleRenameSession = async (sessionId: string, newTitle: string) => {
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      });
      if (res.ok) {
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, title: newTitle } : s))
        );
        window.dispatchEvent(new CustomEvent("session-updated"));
      }
    } catch {
      // Silently fail
    }
  };

  const handleRemoveProject = async (workingDirectory: string) => {
    if (!confirm(`Remove project "${workingDirectory.split('/').pop()}" and all its conversations?`)) return;
    const projectSessions = sessions.filter((s) => s.working_directory === workingDirectory);
    const deletedIds = new Set<string>();
    for (const session of projectSessions) {
      try {
        const res = await fetch(`/api/chat/sessions/${session.id}`, { method: "DELETE" });
        if (res.ok) {
          deletedIds.add(session.id);
          if (isInSplit(session.id)) {
            removeFromSplit(session.id);
          }
        }
      } catch {
        // Continue with remaining
      }
    }
    // Only remove sessions that were successfully deleted from backend
    if (deletedIds.size > 0) {
      setSessions((prev) => prev.filter((s) => !deletedIds.has(s.id)));
      if (pathname?.startsWith('/chat/')) {
        const currentSessionId = pathname.split('/chat/')[1];
        if (deletedIds.has(currentSessionId)) {
          router.push("/chat");
        }
      }
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

  const projectGroups = useMemo(() => {
    const groups = groupSessionsByProject(filteredSessions);
    // Pin assistant workspace project to top
    if (workspacePath) {
      const wsIdx = groups.findIndex(g => g.workingDirectory === workspacePath);
      if (wsIdx > 0) {
        const [wsGroup] = groups.splice(wsIdx, 1);
        groups.unshift(wsGroup);
      }
    }
    return groups;
  }, [filteredSessions, workspacePath]);

  // Auto-collapse: only expand the project with the most recent session activity.
  // Runs on first use AND whenever the project list changes (new projects added).
  useEffect(() => {
    if (projectGroups.length <= 1) return;
    // Find the project with the latest session (highest latestUpdatedAt), ignoring pin order
    const sorted = [...projectGroups].sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt);
    const mostRecentWd = sorted[0]?.workingDirectory;
    const toCollapse = new Set(
      projectGroups
        .filter(g => g.workingDirectory !== mostRecentWd)
        .map(g => g.workingDirectory)
    );
    // Only update if collapsed set actually changed (avoid infinite loop)
    const currentKeys = [...collapsedProjects].sort().join(',');
    const newKeys = [...toCollapse].sort().join(',');
    // v2: re-initialize with improved logic (pin-aware)
    const initKey = COLLAPSED_INITIALIZED_KEY + '-v2';
    if (currentKeys !== newKeys && !localStorage.getItem(initKey)) {
      setCollapsedProjects(toCollapse);
      saveCollapsedProjects(toCollapse);
      localStorage.setItem(initKey, "1");
    }
  }, [projectGroups, collapsedProjects]);

  if (!open) return null;

  const navItems = [
    { href: "/skills", label: t('nav.skills' as TranslationKey), icon: Lightning },
    { href: "/mcp", label: t('nav.mcp' as TranslationKey), icon: Plug },
    { href: "/cli-tools", label: t('nav.cliTools' as TranslationKey), icon: Terminal },
    { href: "/gallery", label: t('nav.gallery' as TranslationKey), icon: Image },
    { href: "/bridge", label: t('nav.bridge' as TranslationKey), icon: WifiHigh },
  ];

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50 lg:hidden"
        onClick={() => {
          window.dispatchEvent(new CustomEvent("chatlist-close"));
        }}
      />
      
      <aside
        className="flex h-full shrink-0 flex-col overflow-hidden bg-sidebar/80 backdrop-blur-xl fixed inset-y-0 left-0 z-50 shadow-xl lg:static lg:shadow-none"
        style={{ width: width ?? 240 }}
      >
        {/* Mobile header with close button */}
        <div className="flex lg:hidden h-12 shrink-0 items-center justify-between px-3 mt-5">
          <ConnectionStatus />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => window.dispatchEvent(new CustomEvent("chatlist-close"))}
            aria-label="Close sidebar"
          >
            <X size={16} />
          </Button>
        </div>
        
        {/* Desktop header */}
        <div className="hidden lg:flex h-12 shrink-0 items-center justify-between px-3 mt-5">
          <ConnectionStatus />
        </div>

      {/* Top action bar: New Chat + Search */}
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
              onClick={() => setSearchDialogOpen(true)}
            >
              <MagnifyingGlass size={14} />
              <span className="sr-only">{t('chatList.searchSessions')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('chatList.searchSessions')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Feature nav items */}
      <div className="px-3 pb-2">
        <div className="flex flex-col gap-0.5">
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href}>
                <Button
                  variant="ghost"
                  size="sm"
                  className={`w-full justify-start gap-2 h-8 text-xs ${
                    isActive
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <item.icon size={14} weight={isActive ? "fill" : "regular"} />
                  {item.label}
                </Button>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Separator */}
      <div className="mx-3 border-t border-border/40" />

      {/* Section title + add folder button (fixed, not scrolling) */}
      <div className="flex items-center justify-between px-5 pt-2 pb-1.5 shrink-0">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
          {t('chatList.threads')}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 gap-1 px-1.5 text-[11px] text-muted-foreground/60 hover:text-foreground"
          onClick={() => openFolderPicker()}
        >
          <FolderPlus size={12} />
          {t('chatList.addProjectFolder')}
        </Button>
      </div>

      {/* Session list grouped by project */}
      <ScrollArea className="flex-1 min-h-0 px-3 [&>[data-slot=scroll-area-viewport]>div]:!block">
        <div className="flex flex-col pb-3">

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

          {/* Assistant promo card for unconfigured users */}
          {assistantSummary && !assistantSummary.configured && !promoDismissed && (
            <AssistantPromoCard
              onSetup={() => router.push('/settings#assistant')}
              onDismiss={() => setPromoDismissed(true)}
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

              const isSessionsExpanded = expandedSessionGroups.has(group.workingDirectory);
              const shouldTruncate = group.sessions.length > SESSION_TRUNCATE_LIMIT;
              let visibleSessions = group.sessions;
              if (shouldTruncate && !isSessionsExpanded) {
                const truncated = group.sessions.slice(0, SESSION_TRUNCATE_LIMIT);
                // Ensure the active session is always visible even when truncated
                const activeSession = group.sessions.find(s => pathname === `/chat/${s.id}`);
                if (activeSession && !truncated.includes(activeSession)) {
                  truncated.push(activeSession);
                }
                visibleSessions = truncated;
              }
              const hiddenCount = group.sessions.length - visibleSessions.length;

              const groupIsWorkspace = !!(workspacePath && group.workingDirectory === workspacePath);

              return (
                <div key={group.workingDirectory || "__no_project"} className="mt-1 first:mt-0">
                  {/* Folder header */}
                  <ProjectGroupHeader
                    workingDirectory={group.workingDirectory}
                    displayName={group.displayName}
                    isCollapsed={isCollapsed}
                    isFolderHovered={isFolderHovered}
                    isWorkspace={groupIsWorkspace}
                    onToggle={() => toggleProject(group.workingDirectory)}
                    onMouseEnter={() => setHoveredFolder(group.workingDirectory)}
                    onMouseLeave={() => setHoveredFolder(null)}
                    onCreateSession={(e) => handleCreateSessionInProject(e, group.workingDirectory)}
                    onRemoveProject={handleRemoveProject}
                    assistantName={assistantSummary?.name}
                    assistantMemoryCount={assistantSummary?.memoryCount}
                    lastHeartbeatDate={assistantSummary?.lastHeartbeatDate}
                    buddyEmoji={assistantSummary?.buddy?.emoji}
                    buddyName={assistantSummary?.buddy?.buddyName}
                    buddySpecies={assistantSummary?.buddy?.species}
                  />

                  {/* Session items with animated collapse */}
                  <AnimatePresence initial={false}>
                    {!isCollapsed && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        style={{ overflow: 'hidden' }}
                      >
                        <div className="mt-0.5 flex flex-col gap-0.5">
                          {visibleSessions.map((session) => {
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
                                isWorkspace={groupIsWorkspace}
                                formatRelativeTime={formatRelativeTime}
                                t={t}
                                onMouseEnter={() => setHoveredSession(session.id)}
                                onMouseLeave={() => setHoveredSession(null)}
                                onDelete={handleDeleteSession}
                                onRename={handleRenameSession}
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

                          {/* Show more / Show less toggle */}
                          {shouldTruncate && (
                            <button
                              onClick={() => setExpandedSessionGroups(prev => {
                                const next = new Set(prev);
                                if (next.has(group.workingDirectory)) {
                                  next.delete(group.workingDirectory);
                                } else {
                                  next.add(group.workingDirectory);
                                }
                                return next;
                              })}
                              className="w-full py-1.5 text-center text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                            >
                              {isSessionsExpanded
                                ? t('chatList.showLess' as TranslationKey)
                                : t('chatList.showMore' as TranslationKey, { count: String(hiddenCount) })
                              }
                            </button>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* Bottom: Settings */}
      <div className="shrink-0 px-3 py-2">
        <Link href="/settings">
          <Button
            variant="ghost"
            size="sm"
            className={`w-full justify-start gap-2 h-8 text-xs ${
              pathname.startsWith("/settings")
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Gear size={14} weight={pathname.startsWith("/settings") ? "fill" : "regular"} />
            {t('nav.settings' as TranslationKey)}
            {(hasUpdate || readyToInstall) && (
              <span className={`ml-auto h-2 w-2 rounded-full ${readyToInstall ? "bg-primary" : "bg-primary animate-pulse"}`} />
            )}
          </Button>
        </Link>
      </div>

      {/* Search Dialog */}
      <Dialog open={searchDialogOpen} onOpenChange={(open) => { setSearchDialogOpen(open); if (!open) setSearchQuery(""); }}>
        <DialogContent className="sm:max-w-md p-0 max-h-[60vh] flex flex-col overflow-hidden" showCloseButton={false}>
          <div className="p-3 shrink-0">
            <div className="relative">
              <MagnifyingGlass
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                placeholder={t('chatList.searchSessions')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                autoFocus
              />
            </div>
          </div>
          {searchQuery && (
            <div className="overflow-y-auto px-3 pb-3 flex-1 min-h-0">
              {filteredSessions.length === 0 ? (
                <p className="text-sm text-muted-foreground py-3 text-center">
                  {t('chatList.noSessions')}
                </p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {filteredSessions.slice(0, 20).map((session) => (
                    <button
                      key={session.id}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent transition-colors"
                      onClick={() => {
                        router.push(`/chat/${session.id}`);
                        setSearchDialogOpen(false);
                        setSearchQuery("");
                      }}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm">{session.title}</p>
                        {session.project_name && (
                          <p className="truncate text-xs text-muted-foreground">{session.project_name}</p>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {formatRelativeTime(session.updated_at, t)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>


      {/* Folder Picker Dialog */}
      <FolderPicker
        open={folderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        onSelect={handleFolderSelect}
      />

      </aside>
    </>
  );
}
