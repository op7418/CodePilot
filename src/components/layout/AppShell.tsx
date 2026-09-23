"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
// NavRail removed — navigation merged into ChatListPanel
import { ChatListPanel } from "./ChatListPanel";
import { SettingsSidebar } from "./SettingsSidebar";
import { CardFrame, CardSurface, ResizeGutter } from "./card-primitives";
import { UpdateBanner } from "./UpdateBanner";
import { UnifiedTopBar } from "./UnifiedTopBar";
import { WorkspaceSidebarProvider, useWorkspaceSidebar } from "@/hooks/useWorkspaceSidebar";
import { FileMutationProvider, useFileMutation } from "@/hooks/useFileMutation";
import { PanelContext, type PreviewViewMode, type PreviewSource } from "@/hooks/usePanel";
import { UpdateContext } from "@/hooks/useUpdate";
import { useUpdateChecker } from "@/hooks/useUpdateChecker";
import { CliMaintenanceContext, useCliMaintenanceChecker } from '@/hooks/useCliMaintenance';
import { BatchImageGenContext, useBatchImageGenState } from "@/hooks/useBatchImageGen";
import { SplitContext, type SplitSession } from "@/hooks/useSplit";
import { ErrorBoundary } from "./ErrorBoundary";
import { SentryInit } from "./SentryInit";
import { getActiveSessionIds, getSnapshot } from "@/lib/stream-session-manager";
import { useGitStatus } from "@/hooks/useGitStatus";
import { Toaster } from '@/components/ui/toast';
import { useNotificationClickRoute } from '@/hooks/useNotificationClickRoute';
import { useGlobalSearchShortcut } from '@/hooks/useGlobalSearchShortcut';
import { GlobalSearchDialog } from './GlobalSearchDialog';
import { ANNOUNCEMENT_KEY } from './feature-announcement-key';
import {
  pathIsWithin,
  remapMutationPath,
  type FileMutationTransaction,
} from "@/lib/file-mutation";

// AppShell static-import contract (Phase A memory cut, 2026-05-08): the six
// components below are conditionally rendered (gated by route, modal state,
// or dialog-trigger state). Lazy-loading them via next/dynamic + ssr:false
// keeps their compile graphs out of the initial /chat dev compile (which
// previously hit ~2.3 GB on first paint just from AppShell's static chain).
// Locked in by `src/__tests__/unit/appshell-lazy-imports.test.ts` — adding
// a static import here regresses memory and will fail CI.
//
// Each loader keeps the named export shape so downstream JSX is unchanged.
const SetupCenter = dynamic(
  () => import('@/components/setup/SetupCenter').then((m) => ({ default: m.SetupCenter })),
  { ssr: false },
);
const SplitChatContainer = dynamic(
  () => import('./SplitChatContainer').then((m) => ({ default: m.SplitChatContainer })),
  { ssr: false },
);
const WorkspaceSidebar = dynamic(
  () => import('./WorkspaceSidebar').then((m) => ({ default: m.WorkspaceSidebar })),
  { ssr: false },
);
const PanelZone = dynamic(
  () => import('./PanelZone').then((m) => ({ default: m.PanelZone })),
  { ssr: false },
);
const UpdateDialog = dynamic(
  () => import('./UpdateDialog').then((m) => ({ default: m.UpdateDialog })),
  { ssr: false },
);
const FeatureAnnouncementDialog = dynamic(
  () => import('./FeatureAnnouncementDialog').then((m) => ({ default: m.FeatureAnnouncementDialog })),
  { ssr: false },
);

const SPLIT_SESSIONS_KEY = "codepilot:split-sessions";
const SPLIT_ACTIVE_COLUMN_KEY = "codepilot:split-active-column";

function loadSplitSessions(): SplitSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(SPLIT_SESSIONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return [];
}

function saveSplitSessions(sessions: SplitSession[]) {
  if (sessions.length >= 2) {
    localStorage.setItem(SPLIT_SESSIONS_KEY, JSON.stringify(sessions));
  } else {
    localStorage.removeItem(SPLIT_SESSIONS_KEY);
    localStorage.removeItem(SPLIT_ACTIVE_COLUMN_KEY);
  }
}

function loadActiveColumn(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(SPLIT_ACTIVE_COLUMN_KEY) || "";
}

const EMPTY_SET = new Set<string>();
const CHATLIST_MIN = 180;
const CHATLIST_MAX = 300;

/**
 * Extensions that default to "rendered" view mode when a file is opened
 * via setPreviewSource / setPreviewFile. Keeping this list aligned with
 * PreviewPanel's RENDERABLE_EXTENSIONS so anything we can actually
 * render in Preview mode also lands there by default — previously .jsx
 * / .tsx fell through to Source even though Sandpack can render them,
 * which made the DiffSummary "Open preview" button surface source code
 * when the user clicked a TSX card.
 */
const RENDERED_EXTENSIONS = new Set([".md", ".mdx", ".html", ".htm", ".jsx", ".tsx", ".csv", ".tsv"]);

function defaultViewMode(filePath: string): PreviewViewMode {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  // Markdown now has one canonical surface: CodeMirror Live Preview.
  // Keep "rendered" for the other previewable formats, whose source and
  // rendered views are still meaningfully separate.
  if (ext === ".md" || ext === ".mdx") return "edit";
  return RENDERED_EXTENSIONS.has(ext) ? "rendered" : "source";
}

const LG_BREAKPOINT = 1024;

function AppFileMutationParticipant({
  previewSource,
  onCommit,
}: {
  previewSource: PreviewSource | null;
  onCommit: (transaction: FileMutationTransaction) => void;
}) {
  const { registerParticipant } = useFileMutation();
  const previewSourceRef = useRef(previewSource);

  useLayoutEffect(() => {
    previewSourceRef.current = previewSource;
  }, [previewSource]);

  useEffect(
    () =>
      registerParticipant({
        id: "app-preview-source",
        priority: 20,
        matches: (transaction) =>
          previewSourceRef.current?.kind === "file" &&
          pathIsWithin(
            previewSourceRef.current.filePath,
            transaction.targetPath,
          ),
        commit: (transaction) => onCommit(transaction),
      }),
    [onCommit, registerParticipant],
  );

  return null;
}

/**
 * Inner row that holds chat, the unified WorkspaceSidebar, and the
 * assistant-workspace-only PanelZone. The v13 standalone FileTree rail
 * was removed after Files Primary + Inspector passed responsive UI smoke.
 */

function ChatContentRow({
  isChatRoute,
  isChatDetailRoute,
  isSplitActive,
  children,
}: {
  isChatRoute: boolean;
  isChatDetailRoute: boolean;
  isSplitActive: boolean;
  children: React.ReactNode;
}) {
  // Phase 7c-C — main column and workspace sidebar both wrapped in
  // CardFrame + CardSurface. WorkspaceSidebar is now just inner TabBar
  // + TabPanel content; its width state and ResizeHandle wiring live
  // here so the row's layout geometry is in one place.
  const ws = useWorkspaceSidebar();
  const handleWorkspaceResize = useCallback(
    (delta: number) => {
      ws.setWidth(ws.state.width - delta);
    },
    [ws],
  );

  return (
    <>
      <CardFrame kind="main">
        <CardSurface kind="main">
          <main className="relative flex-1 overflow-hidden">
            {isSplitActive ? (
              <SplitChatContainer />
            ) : (
              <ErrorBoundary>{children}</ErrorBoundary>
            )}
          </main>
        </CardSurface>
      </CardFrame>
      {/* Workspace sidebar: ResizeGutter as sibling of the frame so
          its visible line lands in the gap between main and workspace. */}
      {isChatRoute && ws.state.open && (
        <>
          <ResizeGutter
            onResize={handleWorkspaceResize}
            onReset={() => ws.setWidth(360)}
            ariaLabel="Resize workspace sidebar"
            className="max-lg:hidden"
          />
          <CardFrame
            kind="workspace"
            width={ws.state.width}
            className="max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:max-w-[calc(100vw-24px)]"
          >
            <CardSurface kind="workspace">
              <WorkspaceSidebar />
            </CardSurface>
          </CardFrame>
        </>
      )}
      {isChatDetailRoute && <PanelZone />}
    </>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const [chatListOpenRaw, setChatListOpenRaw] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupInitialCard, setSetupInitialCard] = useState<'claude' | 'provider' | 'project' | undefined>();
  const [searchOpen, setSearchOpen] = useState(false);

  // Phase A state gate (2026-05-08): only mount FeatureAnnouncementDialog
  // when its localStorage dismiss flag is missing. The dialog still owns
  // its own backend fetch + show timing internally; this gate just keeps
  // the dialog's chunk + react-markdown / Dialog primitives off the boot
  // path for the 99% of users who already dismissed it. Initial state is
  // `null` so SSR + hydration agree on "don't render"; client sets the
  // real value on mount.
  const [announcementMaybeVisible, setAnnouncementMaybeVisible] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!localStorage.getItem(ANNOUNCEMENT_KEY)) {
      // SSR-safe hydration gate: initial state is `false` so SSR + first
      // client render agree on "don't render"; we flip to `true` once after
      // mount when localStorage shows no dismiss flag. Single transition,
      // no cascade. The rule has no clean replacement for non-reactive
      // browser storage reads.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAnnouncementMaybeVisible(true);
    }
  }, []);

  useGlobalSearchShortcut(() => setSearchOpen(true));

  // Record the last non-settings pathname for SettingsSidebar's Back button.
  // Without this, deep-linking into /settings/providers (or any /settings
  // sub-route) and pressing Back would call router.back() and escape the app
  // (e.g. to about:blank). sessionStorage scopes per-tab so it doesn't leak
  // across windows.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!pathname.startsWith('/settings')) {
      const fullPath = pathname + window.location.search + window.location.hash;
      sessionStorage.setItem('codepilot:last-non-settings-path', fullPath);
    }
  }, [pathname]);

  // Phase 3 Step 3: route Electron notification clicks (carrying
  // taskId / sessionId payload) to the right page.
  useNotificationClickRoute();

  // Check if setup is needed
  useEffect(() => {
    fetch('/api/setup')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && !data.completed) {
          setSetupOpen(true);
        }
      })
      .catch(() => {});
  }, []);

  // Listen for open-setup-center events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setSetupInitialCard(detail?.initialCard);
      setSetupOpen(true);
    };
    window.addEventListener('open-setup-center', handler);
    return () => window.removeEventListener('open-setup-center', handler);
  }, []);

  // Hash bridge: legacy error messages and external deep links may still
  // arrive carrying a `#providers` fragment (route-level split moved internal
  // links to `/settings/providers`, but old chat sessions and external docs
  // can still embed the hash form). When such a link is clicked outside the
  // /settings tree, surface the SetupCenter Provider card here. On /settings
  // itself the root page's redirect handler owns hash → route translation, so
  // we early-return to avoid ping-ponging between SetupCenter and the section.
  useEffect(() => {
    const maybeOpenFromHash = () => {
      if (typeof window === 'undefined') return;
      if (window.location.pathname.startsWith('/settings')) return;
      if (window.location.hash === '#providers') {
        setSetupInitialCard('provider');
        setSetupOpen(true);
        // Clear the hash so a second navigation to /#providers fires again.
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    };
    maybeOpenFromHash();
    window.addEventListener('hashchange', maybeOpenFromHash);
    return () => window.removeEventListener('hashchange', maybeOpenFromHash);
  }, []);

  // Listen for open-global-search events from ChatListPanel
  useEffect(() => {
    const handler = () => setSearchOpen(true);
    window.addEventListener('open-global-search', handler);
    return () => window.removeEventListener('open-global-search', handler);
  }, []);

  // Sync with viewport after hydration to avoid SSR mismatch
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setChatListOpenRaw(window.matchMedia(`(min-width: ${LG_BREAKPOINT}px)`).matches);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Panel width state with localStorage persistence
  const [chatListWidth, setChatListWidth] = useState(240);

  // Restore persisted width after hydration
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const saved = localStorage.getItem("codepilot_chatlist_width");
    if (saved) setChatListWidth(parseInt(saved));
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleChatListResize = useCallback((delta: number) => {
    setChatListWidth((w) => Math.min(CHATLIST_MAX, Math.max(CHATLIST_MIN, w + delta)));
  }, []);
  const handleChatListResizeEnd = useCallback(() => {
    setChatListWidth((w) => {
      localStorage.setItem("codepilot_chatlist_width", String(w));
      return w;
    });
  }, []);

  // Panel state — chatListOpen is no longer gated by route (sidebar always visible)
  const isChatRoute = pathname.startsWith("/chat/") || pathname === "/chat";
  const chatListOpen = chatListOpenRaw;

  const setChatListOpen = useCallback((open: boolean) => {
    setChatListOpenRaw(open);
  }, []);

  // Workspace surfaces now live in WorkspaceSidebar. AssistantPanel
  // remains separate because it is specific to assistant workspaces.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [assistantPanelOpen, setAssistantPanelOpen] = useState(false);
  const [isAssistantWorkspace, setIsAssistantWorkspace] = useState(false);

  // --- Git summary (derived from polling hook, no setState needed) ---
  const [currentWorktreeLabel, setCurrentWorktreeLabel] = useState("");

  const [workingDirectory, setWorkingDirectory] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [sessionTitle, setSessionTitle] = useState("");
  const [streamingSessionId, setStreamingSessionId] = useState("");
  const [pendingApprovalSessionId, setPendingApprovalSessionId] = useState("");

  const { status: gitStatusFromHook } = useGitStatus(workingDirectory);
  const currentBranch = gitStatusFromHook?.branch ?? "";
  const gitDirtyCount = gitStatusFromHook?.changedFiles.filter(f => f.status !== 'untracked').length ?? 0;
  const gitRepositoryState = !gitStatusFromHook
    ? 'unknown' as const
    : gitStatusFromHook.isRepo
      ? 'repository' as const
      : 'directory' as const;

  // --- Multi-session stream tracking (driven by stream-session-manager) ---
  const [activeStreamingSessions, setActiveStreamingSessions] = useState<Set<string>>(EMPTY_SET);
  const [pendingApprovalSessionIds, setPendingApprovalSessionIds] = useState<Set<string>>(EMPTY_SET);

  // Listen for global stream events from stream-session-manager
  useEffect(() => {
    const handler = (e: Event) => {
      const activeIds = getActiveSessionIds();
      setActiveStreamingSessions(activeIds.length > 0 ? new Set(activeIds) : EMPTY_SET);

      const approvals = new Set<string>();
      for (const sid of activeIds) {
        const snap = getSnapshot(sid);
        if (snap?.pendingPermission && !snap.permissionResolved) {
          approvals.add(sid);
        }
      }
      setPendingApprovalSessionIds(approvals.size > 0 ? approvals : EMPTY_SET);

      // A5 Step 2 follow-up #2 — also clear the single-value global badge when
      // THIS event's session no longer needs approval (resolved / timed out).
      // Runs at the app-shell level for every stream event, so it covers the
      // "user navigated away, THEN the request timed out" case: the session's
      // useStreamSubscription is unmounted then and can't clear it, but the
      // pendingApprovalSessionIds Set above (which DOES re-derive) leaves the
      // single global stuck until stream end. Functional + guarded
      // (prev === sid && not in approvals) so it never clears a still-pending
      // peer or the /chat inline new-session value.
      const sid = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (sid) {
        setPendingApprovalSessionId((prev) => (prev === sid && !approvals.has(sid) ? '' : prev));
      }
    };
    window.addEventListener('stream-session-event', handler);
    return () => window.removeEventListener('stream-session-event', handler);
  }, []);

  // --- Split-screen state ---
  const [splitSessions, setSplitSessions] = useState<SplitSession[]>(() => loadSplitSessions());
  const [activeColumnId, setActiveColumnIdRaw] = useState<string>(() => loadActiveColumn());
  const isSplitActive = splitSessions.length >= 2;
  const isChatDetailRoute = pathname.startsWith("/chat/") || isSplitActive;

  // Persist split sessions to localStorage
  useEffect(() => {
    saveSplitSessions(splitSessions);
    if (activeColumnId) {
      localStorage.setItem(SPLIT_ACTIVE_COLUMN_KEY, activeColumnId);
    }
  }, [splitSessions, activeColumnId]);

  // URL sync: when activeColumn changes, update router
  useEffect(() => {
    if (isSplitActive && activeColumnId) {
      const target = `/chat/${activeColumnId}`;
      if (pathname !== target) {
        router.replace(target);
      }
    }
  }, [isSplitActive, activeColumnId, pathname, router]);

  const setActiveColumn = useCallback((sessionId: string) => {
    setActiveColumnIdRaw(sessionId);
  }, []);

  const addToSplit = useCallback((session: SplitSession) => {
    setSplitSessions((prev) => {
      if (prev.some((s) => s.sessionId === session.sessionId)) return prev;

      if (prev.length < 2) {
        const currentSessionId = sessionId;
        if (currentSessionId && currentSessionId !== session.sessionId) {
          const currentSession: SplitSession = {
            sessionId: currentSessionId,
            title: sessionTitle || "New Conversation",
            workingDirectory: workingDirectory || "",
            projectName: "",
            mode: "code",
          };
          const hasCurrentAlready = prev.some((s) => s.sessionId === currentSessionId);
          const next = hasCurrentAlready ? [...prev, session] : [...prev, currentSession, session];
          setActiveColumnIdRaw(session.sessionId);
          return next;
        }
      }

      const next = [...prev, session];
      setActiveColumnIdRaw(session.sessionId);
      return next;
    });
  }, [sessionId, sessionTitle, workingDirectory]);

  const pendingNavigateRef = useRef<string | null>(null);

  const removeFromSplit = useCallback((removeId: string) => {
    setSplitSessions((prev) => {
      const next = prev.filter((s) => s.sessionId !== removeId);
      if (next.length <= 1) {
        if (next.length === 1) {
          pendingNavigateRef.current = next[0].sessionId;
        }
        return [];
      }
      setActiveColumnIdRaw((currentActive) =>
        currentActive === removeId ? next[0].sessionId : currentActive
      );
      return next;
    });
  }, []);

  useEffect(() => {
    if (pendingNavigateRef.current) {
      const target = pendingNavigateRef.current;
      pendingNavigateRef.current = null;
      router.replace(`/chat/${target}`);
    }
  }, [splitSessions, router]);

  const exitSplit = useCallback(() => {
    const firstSession = splitSessions[0];
    setSplitSessions([]);
    setActiveColumnIdRaw("");
    if (firstSession) {
      router.replace(`/chat/${firstSession.sessionId}`);
    }
  }, [splitSessions, router]);

  const isInSplit = useCallback((sid: string) => {
    return splitSessions.some((s) => s.sessionId === sid);
  }, [splitSessions]);

  useEffect(() => {
    const handler = () => {
      setSplitSessions((prev) => prev);
    };
    window.addEventListener("session-deleted", handler);
    return () => window.removeEventListener("session-deleted", handler);
  }, []);

  useEffect(() => {
    if (isSplitActive && !pathname.startsWith("/chat")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSplitSessions([]);
      setActiveColumnIdRaw("");
    }
  }, [pathname, isSplitActive]);

  const splitContextValue = useMemo(
    () => ({
      splitSessions,
      activeColumnId,
      isSplitActive,
      addToSplit,
      removeFromSplit,
      setActiveColumn,
      exitSplit,
      isInSplit,
    }),
    [splitSessions, activeColumnId, isSplitActive, addToSplit, removeFromSplit, setActiveColumn, exitSplit, isInSplit]
  );

  // Warn before closing window/tab while any session is streaming
  useEffect(() => {
    if (activeStreamingSessions.size === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [activeStreamingSessions]);

  // --- Doc Preview state ---
  // `previewSource` is the discriminated union (file / inline-html /
  // inline-jsx / inline-datatable) that the WorkspaceSidebar's
  // dynamic-Tab content reads. `previewFile` is a derived path-only
  // view for path-only callers (file search/deep links, etc.) that only
  // care about the file kind — when the active source is inline-*,
  // `previewFile` is null.
  const [previewSource, setPreviewSourceRaw] = useState<PreviewSource | null>(null);
  const [previewViewMode, setPreviewViewMode] = useState<PreviewViewMode>("source");
  // Track the last filePath we routed through setPreviewSource so we can
  // distinguish "file change" (reset view mode) from "metadata update"
  // (same-file anchor / trust promotions must NOT bounce the user out
  // of Edit mode).
  const lastPreviewFilePathRef = useRef<string | null>(null);

  const previewFile: string | null =
    previewSource?.kind === "file" ? previewSource.filePath : null;

  const setPreviewSource = useCallback((source: PreviewSource | null) => {
    setPreviewSourceRaw(source);
    if (!source) {
      lastPreviewFilePathRef.current = null;
      return;
    }
    // File sources respect the extension-based default view mode — but
    // ONLY on actual file changes. A same-file metadata update keeps
    // whatever view mode the user is in. Inline sources are always
    // "rendered" — there's no raw path to show for source view, and
    // all inline variants are meaningful only rendered.
    if (source.kind === "file") {
      if (lastPreviewFilePathRef.current !== source.filePath) {
        setPreviewViewMode(defaultViewMode(source.filePath));
        lastPreviewFilePathRef.current = source.filePath;
      }
    } else {
      setPreviewViewMode("rendered");
      lastPreviewFilePathRef.current = null;
    }
    // Right-rail routing: on chat-detail routes we dispatch a
    // `workspace-tab-open-request` event so the WorkspaceSidebar
    // creates / focuses the matching dynamic Tab. Non-chat-detail
    // routes (settings, skills, plugins, etc.) don't mount the
    // sidebar at all; the source sits in context unused, which is
    // intentional — there is no preview panel outside chat-detail.
    if (isChatDetailRoute && typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("workspace-tab-open-request", { detail: { source } }),
      );
    }
  }, [isChatDetailRoute]);

  const setPreviewFile = useCallback(
    (path: string | null) => {
      if (path === null) {
        setPreviewSource(null);
      } else {
        // Legacy file-only adapter — used by path-string callers. All known
        // callers operate on workspace files (the file tree is scoped to
        // workingDirectory), so we stamp the workspace trust tier and
        // pass workingDirectory as baseDir. Callers that need a
        // different trust (e.g. agent-referenced) must use
        // setPreviewSource directly.
        setPreviewSource({
          kind: "file",
          filePath: path,
          trust: "workspace",
          baseDir: workingDirectory || undefined,
        });
      }
    },
    [setPreviewSource, workingDirectory],
  );

  const commitPreviewFileMutation = useCallback(
    (transaction: FileMutationTransaction) => {
      setPreviewSourceRaw((current) => {
        if (
          current?.kind !== "file" ||
          !pathIsWithin(current.filePath, transaction.targetPath)
        ) {
          return current;
        }
        if (transaction.kind === "delete") {
          lastPreviewFilePathRef.current = null;
          return null;
        }
        if (!transaction.newPath) return current;
        const filePath = remapMutationPath(
          current.filePath,
          transaction.targetPath,
          transaction.newPath,
        );
        lastPreviewFilePathRef.current = filePath;
        return { ...current, filePath };
      });
    },
    [],
  );

  // Reset doc preview when navigating between pages/sessions
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setPreviewSourceRaw(null);
  }, [pathname]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Keep chat list state in sync when resizing across the breakpoint
  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${LG_BREAKPOINT}px)`);
    const handler = (e: MediaQueryListEvent) => setChatListOpenRaw(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // --- Update checker (native Electron + browser fallback) ---
  const updateContextValue = useUpdateChecker();
  const cliMaintenanceContextValue = useCliMaintenanceChecker();

  const panelContextValue = useMemo(
    () => ({
      chatListOpen,
      setChatListOpen,
      terminalOpen,
      setTerminalOpen,
      assistantPanelOpen,
      setAssistantPanelOpen,
      isAssistantWorkspace,
      setIsAssistantWorkspace,
      currentBranch,
      gitDirtyCount,
      gitRepositoryState,
      currentWorktreeLabel,
      setCurrentWorktreeLabel,
      workingDirectory,
      setWorkingDirectory,
      sessionId,
      setSessionId,
      sessionTitle,
      setSessionTitle,
      streamingSessionId,
      setStreamingSessionId,
      pendingApprovalSessionId,
      setPendingApprovalSessionId,
      activeStreamingSessions,
      pendingApprovalSessionIds,
      previewSource,
      setPreviewSource,
      previewFile,
      setPreviewFile,
      previewViewMode,
      setPreviewViewMode,
    }),
    [chatListOpen, setChatListOpen, terminalOpen, assistantPanelOpen, isAssistantWorkspace, currentBranch, gitDirtyCount, gitRepositoryState, currentWorktreeLabel, workingDirectory, sessionId, sessionTitle, streamingSessionId, pendingApprovalSessionId, activeStreamingSessions, pendingApprovalSessionIds, previewSource, setPreviewSource, previewFile, setPreviewFile, previewViewMode]
  );

  const batchImageGenValue = useBatchImageGenState();

  return (
    <UpdateContext.Provider value={updateContextValue}>
      <CliMaintenanceContext.Provider value={cliMaintenanceContextValue}>
      <SentryInit />
      <PanelContext.Provider value={panelContextValue}>
        <FileMutationProvider>
        <AppFileMutationParticipant
          previewSource={previewSource}
          onCommit={commitPreviewFileMutation}
        />
        <WorkspaceSidebarProvider workingDirectory={workingDirectory} sessionId={sessionId}>
        <SplitContext.Provider value={splitContextValue}>
        <BatchImageGenContext.Provider value={batchImageGenValue}>
        <TooltipProvider delayDuration={300}>
          {/* Round 20 — layout reorganized so the floating cards
              (left sidebar, main content, workspace sidebar) all
              start at the same y under a SHARED topbar.
              Previously the topbar sat inside the main column, which
              made the left sidebar visually taller than the other
              three (it included the topbar's vertical space inside
              its own card). UnifiedTopBar is now a sibling above the
              content row; traffic-light safe area and sidebar toggle
              both live there.
              `data-app-shell` is now on the outer flex-col so
              globals.css can inset the whole window the same way. */}
          <div className="flex flex-col h-screen overflow-hidden" data-app-shell>
            <UnifiedTopBar />
            <UpdateBanner />
            <div className="relative flex flex-1 min-h-0 overflow-hidden" data-app-content-row>
              {/* Phase 7c closeout — the left sidebar is now a
                  row-level card, exactly like main / workspace: its
                  CardFrame and ResizeGutter sit FLAT in
                  data-app-content-row with no extra wrapper.

                  The old `<div className="flex h-full shrink-0">`
                  wrapper was a vestige of the Round 22 `gap: 4px` era,
                  when it grouped the sidebar + handle into one flex
                  item so the row gap wouldn't double up around the
                  handle. Phase 7c-F set the darwin content-row gap to
                  0 (the 8px ResizeGutter now owns the only visible
                  gap), so the wrapper had no layout job left.

                  Removing it was previously blamed for dataPlatform=
                  null (tech-debt #29). That was a misattribution: the
                  data-platform attribute is stamped on <html> by the
                  anti-FOUC <head> script before hydration and has no
                  causal link to a layout <div> deep in <body>. See
                  tech-debt #29's resolution for the real cause. */}
              {chatListOpen && (
                <CardFrame kind="sidebar" width={chatListWidth}>
                  <CardSurface
                    kind="sidebar"
                    variant={pathname.startsWith('/settings') ? 'settings' : 'chat-list'}
                  >
                    <ErrorBoundary>
                      {pathname.startsWith('/settings') ? (
                        <SettingsSidebar open={chatListOpen} />
                      ) : (
                        <ChatListPanel
                          open={chatListOpen}
                          hasUpdate={updateContextValue.updateInfo?.updateAvailable ?? false}
                          readyToInstall={updateContextValue.updateInfo?.readyToInstall ?? false}
                        />
                      )}
                    </ErrorBoundary>
                  </CardSurface>
                </CardFrame>
              )}
              {chatListOpen && (
                <ResizeGutter
                  onResize={handleChatListResize}
                  onResizeEnd={handleChatListResizeEnd}
                  onReset={() => {
                    setChatListWidth(240);
                    localStorage.setItem("codepilot_chatlist_width", "240");
                  }}
                />
              )}
              <ChatContentRow isChatRoute={isChatRoute} isChatDetailRoute={isChatDetailRoute} isSplitActive={isSplitActive}>
                {children}
              </ChatContentRow>
            </div>
          </div>
          {/* Phase A state gates: only mount when actually needed.
              UpdateDialog gate (P3 review fix): require BOTH
              `showDialog` AND an available update. Earlier the gate was
              just `updateAvailable`, which meant clicking "Later" only
              flipped `showDialog` to false — the dialog stayed mounted
              and the lazy chunk stuck around for the rest of the
              session. UpdateBanner is the always-on lightweight
              indicator; the dialog chunk should only be live when the
              modal is actually open.
              FeatureAnnouncementDialog gates on a localStorage dismiss
              flag (see `announcementMaybeVisible`); the dialog itself
              still owns the post-mount fetch + show-timing logic. */}
          {updateContextValue.showDialog
            && (updateContextValue.updateInfo?.updateAvailable ?? false)
            && <UpdateDialog />}
          {announcementMaybeVisible && <FeatureAnnouncementDialog />}
          <Toaster />
          <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
          {setupOpen && (
            <SetupCenter
              onClose={() => setSetupOpen(false)}
              initialCard={setupInitialCard}
            />
          )}
        </TooltipProvider>
        </BatchImageGenContext.Provider>
        </SplitContext.Provider>
        </WorkspaceSidebarProvider>
        </FileMutationProvider>
      </PanelContext.Provider>
      </CliMaintenanceContext.Provider>
    </UpdateContext.Provider>
  );
}
