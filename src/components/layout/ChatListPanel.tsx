"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import {
  CaretDown,
  CaretRight,
} from "@/components/ui/icon";
import { CodePilotIcon, type CodePilotIconName } from "@/components/ui/semantic-icon";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { cn } from "@/lib/utils";
// ConnectionStatus removed from header — CLI status now lives in Settings > Claude CLI
// ImportSessionDialog moved to Settings page
import { SessionListItem } from "./SessionListItem";
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
  hasUpdate?: boolean;
  readyToInstall?: boolean;
}


export function ChatListPanel({ open, hasUpdate, readyToInstall }: ChatListPanelProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { streamingSessionId, pendingApprovalSessionId, activeStreamingSessions, pendingApprovalSessionIds, workingDirectory, setChatListOpen } = usePanel();
  const { addToSplit, removeFromSplit, isInSplit } = useSplit();
  const { t } = useTranslation();
  const { isElectron, openNativePicker } = useNativeFolderPicker();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [deletingSession, setDeletingSession] = useState<string | null>(null);
  const [expandedSessionGroups, setExpandedSessionGroups] = useState<Set<string>>(new Set());
  const SESSION_TRUNCATE_LIMIT = 10;
  // importDialogOpen removed — Import CLI moved to Settings
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => loadCollapsedProjects()
  );
  const [hoveredFolder, setHoveredFolder] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  // Codex-style sectioned sidebar: separate 项目 (non-assistant) and 助理 (assistant flat list)
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [assistantCollapsed, setAssistantCollapsed] = useState(false);
  // projectsHovered / assistantHovered state previously gated chevron
  // visibility (opacity-0 → opacity-100 on hover). 2026-05-21: chevron
  // is now always visible + button itself takes hover:bg, so the
  // hover-tracked state is no longer needed.
  const [projectListExpanded, setProjectListExpanded] = useState(false);
  const PROJECT_LIST_TRUNCATE_LIMIT = 10;
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
        // Drop from split group if it's there
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
    const projectName = workingDirectory.split('/').pop() || workingDirectory;
    if (!confirm(t('chatList.removeProjectConfirm' as TranslationKey, { name: projectName }))) return;
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

  const filteredSessions = sessions;

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

  // Split into 助理 (assistant workspace) and 项目 (everything else)
  const assistantGroup = useMemo(
    () => workspacePath ? projectGroups.find(g => g.workingDirectory === workspacePath) : undefined,
    [projectGroups, workspacePath],
  );
  const nonAssistantGroups = useMemo(
    () => projectGroups.filter(g => !workspacePath || g.workingDirectory !== workspacePath),
    [projectGroups, workspacePath],
  );

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

  // Phase 2D.4 (2026-05-01): Skills / MCP / CLI Tools collapsed into
  // a single "Plugins" entry — see ExtensionsPage for the unified UI.
  // Bridge moved to `/settings/bridge` (2026-05-02) — channel configs
  // are settings, not a primary destination.
  const navItems: Array<{ href: string; label: string; icon: CodePilotIconName }> = [
    { href: "/plugins", label: t('nav.plugins' as TranslationKey), icon: "plugin" },
    { href: "/gallery", label: t('nav.gallery' as TranslationKey), icon: "image" },
  ];

  // Phase 7c-B — surface chrome (data-platform-sidebar attribute, bg
  // token, backdrop-filter, overflow-hidden, width inset) moved to
  // <CardSurface kind="sidebar"> in AppShell. This inner block now
  // only owns the column layout for its own children.
  return (
    <div className="flex h-full w-full flex-col">
      {/* Round 20 — the h-12 traffic-light-safe-area + collapse
          button used to live at the top of this panel. Both moved
          to UnifiedTopBar so the four floating cards (this sidebar,
          main, workspace, file tree) share the same y-origin under
          the topbar. Sidebar toggle is now the topbar's
          `sidebarToggleButton` (handles open AND close). */}

      {/* Quick actions + feature nav (Codex-style unified list) */}
      <div className="p-2">
        <div className="flex flex-col gap-0.5">
          {/* New chat — list option (no shortcut bound currently) */}
          <Button
            variant="ghost"
            size="sm"
            className="group w-full justify-start gap-2 h-9 px-3 rounded-xl text-[13px] font-normal text-sidebar-foreground"
            disabled={creatingChat}
            onClick={handleNewChat}
          >
            <CodePilotIcon name="chat" size="md" className="text-inherit" aria-hidden />
            {t('chatList.newConversation')}
          </Button>

          {/* Search — list option with ⌘K shortcut on hover */}
          <Button
            variant="ghost"
            size="sm"
            className="group w-full justify-start gap-2 h-9 px-3 rounded-xl text-[13px] font-normal text-sidebar-foreground"
            onClick={() => window.dispatchEvent(new CustomEvent('open-global-search'))}
          >
            <CodePilotIcon name="search" size="md" className="text-inherit" aria-hidden />
            <span>{t('chatList.searchSessions')}</span>
            <kbd className="ml-auto hidden group-hover:inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground/80">
              ⌘K
            </kbd>
          </Button>

          {/* Feature pages */}
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href}>
                <Button
                  variant="ghost"
                  size="sm"
                  className={`group w-full justify-start gap-2 h-9 px-3 rounded-xl text-[13px] ${
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-sidebar-foreground font-normal"
                  }`}
                >
                  <CodePilotIcon name={item.icon} size="md" strokeWidth={isActive ? 2 : undefined} className="text-inherit" aria-hidden />
                  {item.label}
                </Button>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Sectioned list: 项目 + 助理 (Codex-style) */}
      <ScrollArea className="flex-1 min-h-0 [&>[data-slot=scroll-area-viewport]>div]:!block">
        <div className="flex flex-col pb-3">

          {/* Assistant promo card for unconfigured users */}
          {assistantSummary && !assistantSummary.configured && !promoDismissed && (
            <AssistantPromoCard
              onSetup={() => router.push('/settings/assistant')}
              onDismiss={() => setPromoDismissed(true)}
            />
          )}

          {/* ─── 项目 section ─── */}
          <div
            className="px-2 pt-2 pb-1"
          >
            {/* Section header — chevron always visible (was hover-revealed
                and "太不显眼"); button itself takes a hover background
                so the toggle reads as a tappable affordance, not as
                plain text. */}
            <button
              type="button"
              onClick={() => setProjectsCollapsed(c => !c)}
              className={cn(
                "flex w-full items-center gap-1 px-3 h-7 cursor-pointer select-none rounded-xl",
                "transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              )}
            >
              <span className="text-[13px] font-semibold text-sidebar-foreground/55 group-hover:text-sidebar-foreground">
                {t('chatList.projects' as TranslationKey)}
              </span>
              <span className="text-muted-foreground/80">
                {projectsCollapsed
                  ? <CaretRight size={12} />
                  : <CaretDown size={12} />}
              </span>
            </button>

            <AnimatePresence initial={false}>
              {!projectsCollapsed && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  style={{ overflow: 'hidden' }}
                >
                  <div className="flex flex-col gap-1.5">
                    {/* Fixed top item: 新建项目 */}
                    <button
                      type="button"
                      onClick={() => openFolderPicker()}
                      className="group flex items-center gap-2 rounded-xl px-3 h-8 cursor-pointer select-none transition-colors hover:bg-sidebar-accent"
                    >
                      <CodePilotIcon name="folder_add" size="md" className="shrink-0 text-muted-foreground" aria-hidden />
                      <span className="flex-1 truncate text-left text-[13px] font-normal text-sidebar-foreground">
                        {t('chatList.newProject' as TranslationKey)}
                      </span>
                    </button>

                    {/* Non-assistant project folders — truncate when more than PROJECT_LIST_TRUNCATE_LIMIT */}
                    {(() => {
                      const projectsShouldTruncate = nonAssistantGroups.length > PROJECT_LIST_TRUNCATE_LIMIT;
                      let visibleProjects = nonAssistantGroups;
                      if (projectsShouldTruncate && !projectListExpanded) {
                        const truncated = nonAssistantGroups.slice(0, PROJECT_LIST_TRUNCATE_LIMIT);
                        // Always include the project containing the currently active session
                        const activeProject = nonAssistantGroups.find(g =>
                          g.sessions.some(s => pathname === `/chat/${s.id}`)
                        );
                        if (activeProject && !truncated.includes(activeProject)) {
                          truncated.push(activeProject);
                        }
                        visibleProjects = truncated;
                      }
                      const projectsHiddenCount = nonAssistantGroups.length - visibleProjects.length;
                      return (
                        <>
                          {visibleProjects.map((group) => {
                      const isCollapsed = collapsedProjects.has(group.workingDirectory);
                      const isFolderHovered = hoveredFolder === group.workingDirectory;
                      const isSessionsExpanded = expandedSessionGroups.has(group.workingDirectory);
                      const shouldTruncate = group.sessions.length > SESSION_TRUNCATE_LIMIT;
                      let visibleSessions = group.sessions;
                      if (shouldTruncate && !isSessionsExpanded) {
                        const truncated = group.sessions.slice(0, SESSION_TRUNCATE_LIMIT);
                        const activeSession = group.sessions.find(s => pathname === `/chat/${s.id}`);
                        if (activeSession && !truncated.includes(activeSession)) {
                          truncated.push(activeSession);
                        }
                        visibleSessions = truncated;
                      }
                      const hiddenCount = group.sessions.length - visibleSessions.length;

                      return (
                        <div key={group.workingDirectory || "__no_project"}>
                          <ProjectGroupHeader
                            workingDirectory={group.workingDirectory}
                            displayName={group.displayName}
                            isCollapsed={isCollapsed}
                            isFolderHovered={isFolderHovered}
                            isWorkspace={false}
                            hideCaret
                            onToggle={() => toggleProject(group.workingDirectory)}
                            onMouseEnter={() => setHoveredFolder(group.workingDirectory)}
                            onMouseLeave={() => setHoveredFolder(null)}
                            onCreateSession={(e) => handleCreateSessionInProject(e, group.workingDirectory)}
                            onRemoveProject={handleRemoveProject}
                          />

                          <AnimatePresence initial={false}>
                            {!isCollapsed && (
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.2, ease: 'easeOut' }}
                                style={{ overflow: 'hidden' }}
                              >
                                <div className="flex flex-col gap-1.5">
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
                                        isWorkspace={false}
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
                                      className="w-full py-1.5 pl-3 text-left text-xs font-semibold text-sidebar-foreground/70 hover:text-sidebar-foreground transition-colors"
                                    >
                                      {isSessionsExpanded
                                        ? t('chatList.showLess' as TranslationKey)
                                        : t('chatList.showMore' as TranslationKey, { count: String(hiddenCount) })}
                                    </button>
                                  )}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                          })}

                          {/* Project-list show more / show less */}
                          {projectsShouldTruncate && (
                            <button
                              onClick={() => setProjectListExpanded(v => !v)}
                              className="w-full py-1.5 pl-3 text-left text-xs font-semibold text-sidebar-foreground/70 hover:text-sidebar-foreground transition-colors"
                            >
                              {projectListExpanded
                                ? t('chatList.showLess' as TranslationKey)
                                : t('chatList.showMore' as TranslationKey, { count: String(projectsHiddenCount) })}
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* ─── 助理 section ─── */}
          {assistantGroup && (() => {
            const aGroup = assistantGroup;
            const isAssistantSessionsExpanded = expandedSessionGroups.has(aGroup.workingDirectory);
            const aShouldTruncate = aGroup.sessions.length > SESSION_TRUNCATE_LIMIT;
            let aVisibleSessions = aGroup.sessions;
            if (aShouldTruncate && !isAssistantSessionsExpanded) {
              const truncated = aGroup.sessions.slice(0, SESSION_TRUNCATE_LIMIT);
              const activeSession = aGroup.sessions.find(s => pathname === `/chat/${s.id}`);
              if (activeSession && !truncated.includes(activeSession)) truncated.push(activeSession);
              aVisibleSessions = truncated;
            }
            const aHiddenCount = aGroup.sessions.length - aVisibleSessions.length;

            return (
              <div
                className="px-2 pt-1 pb-2"
              >
                <button
                  type="button"
                  onClick={() => setAssistantCollapsed(c => !c)}
                  className={cn(
                    "flex w-full items-center gap-1 px-3 h-7 cursor-pointer select-none rounded-xl",
                    "transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                  )}
                >
                  <span className="text-[13px] font-semibold text-sidebar-foreground/55">
                    {t('chatList.assistantSection' as TranslationKey)}
                  </span>
                  <span className="text-muted-foreground/80">
                    {assistantCollapsed
                      ? <CaretRight size={12} />
                      : <CaretDown size={12} />}
                  </span>
                </button>

                <AnimatePresence initial={false}>
                  {!assistantCollapsed && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: 'easeOut' }}
                      style={{ overflow: 'hidden' }}
                    >
                      <div className="flex flex-col gap-1.5">
                        {aVisibleSessions.map((session) => {
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
                              isWorkspace
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
                        {aShouldTruncate && (
                          <button
                            onClick={() => setExpandedSessionGroups(prev => {
                              const next = new Set(prev);
                              if (next.has(aGroup.workingDirectory)) next.delete(aGroup.workingDirectory);
                              else next.add(aGroup.workingDirectory);
                              return next;
                            })}
                            className="w-full py-1.5 pl-3 text-left text-xs font-semibold text-sidebar-foreground/70 hover:text-sidebar-foreground transition-colors"
                          >
                            {isAssistantSessionsExpanded
                              ? t('chatList.showLess' as TranslationKey)
                              : t('chatList.showMore' as TranslationKey, { count: String(aHiddenCount) })}
                          </button>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })()}

          {/* Empty state */}
          {filteredSessions.length === 0 && (
            <p className="px-2.5 py-3 text-[11px] text-muted-foreground/60">
              {t('chatList.noSessions')}
            </p>
          )}
        </div>
      </ScrollArea>

      {/* Bottom: Settings */}
      <div className="shrink-0 p-2">
        <Link href="/settings">
          <Button
            variant="ghost"
            size="sm"
            className={`w-full justify-start gap-2 h-9 px-3 rounded-xl text-[13px] ${
              pathname.startsWith("/settings")
                ? "bg-accent text-accent-foreground font-medium"
                : "text-sidebar-foreground font-normal"
            }`}
          >
            <CodePilotIcon name="settings" size="md" strokeWidth={pathname.startsWith("/settings") ? 2 : undefined} className="text-inherit" aria-hidden />
            {t('nav.settings' as TranslationKey)}
            {(hasUpdate || readyToInstall) && (
              <span className={`ml-auto h-2 w-2 rounded-full ${readyToInstall ? "bg-primary" : "bg-primary animate-pulse"}`} />
            )}
          </Button>
        </Link>
      </div>

      {/* Folder Picker Dialog */}
      <FolderPicker
        open={folderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        onSelect={handleFolderSelect}
      />

    </div>
  );
}
