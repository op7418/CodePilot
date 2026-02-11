"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NavRail } from "./NavRail";
import { ChatListPanel } from "./ChatListPanel";
import { RightPanel } from "./RightPanel";
import { ResizeHandle } from "./ResizeHandle";
import { UpdateDialog } from "./UpdateDialog";
import { DocPreview } from "./DocPreview";
import { PanelContext, type PanelContent, type PreviewViewMode } from "@/hooks/usePanel";
import { UpdateContext, type UpdateInfo } from "@/hooks/useUpdate";

const CHATLIST_MIN = 180;
const CHATLIST_MAX = 400;
const RIGHTPANEL_MIN = 200;
const RIGHTPANEL_MAX = 480;
const DOCPREVIEW_MIN = 320;
const DOCPREVIEW_MAX = 800;

/** Extensions that default to "rendered" view mode */
const RENDERED_EXTENSIONS = new Set([".md", ".mdx", ".html", ".htm"]);

function defaultViewMode(filePath: string): PreviewViewMode {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  return RENDERED_EXTENSIONS.has(ext) ? "rendered" : "source";
}

const LG_BREAKPOINT = 1024;
const CHECK_INTERVAL = 8 * 60 * 60 * 1000; // 8 hours
const DISMISSED_VERSION_KEY = "codepilot_dismissed_update_version";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const [chatListOpen, setChatListOpenRaw] = useState(false);

  // Panel width state with localStorage persistence
  const [chatListWidth, setChatListWidth] = useState(() => {
    if (typeof window === "undefined") return 240;
    return parseInt(localStorage.getItem("codepilot_chatlist_width") || "240");
  });
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    if (typeof window === "undefined") return 288;
    return parseInt(localStorage.getItem("codepilot_rightpanel_width") || "288");
  });

  const handleChatListResize = useCallback((delta: number) => {
    setChatListWidth((w) => Math.min(CHATLIST_MAX, Math.max(CHATLIST_MIN, w + delta)));
  }, []);
  const handleChatListResizeEnd = useCallback(() => {
    setChatListWidth((w) => {
      localStorage.setItem("codepilot_chatlist_width", String(w));
      return w;
    });
  }, []);

  const handleRightPanelResize = useCallback((delta: number) => {
    setRightPanelWidth((w) => Math.min(RIGHTPANEL_MAX, Math.max(RIGHTPANEL_MIN, w - delta)));
  }, []);
  const handleRightPanelResizeEnd = useCallback(() => {
    setRightPanelWidth((w) => {
      localStorage.setItem("codepilot_rightpanel_width", String(w));
      return w;
    });
  }, []);

  // Panel state
  const isChatRoute = pathname.startsWith("/chat/") || pathname === "/chat";
  const isChatDetailRoute = pathname.startsWith("/chat/");

  // Auto-close chat list when leaving chat routes
  const setChatListOpen = useCallback((open: boolean) => {
    setChatListOpenRaw(open);
  }, []);

  useEffect(() => {
    if (!isChatRoute) {
      setChatListOpenRaw(false);
    }
  }, [isChatRoute]);
  const [panelOpen, setPanelOpenRaw] = useState(false);
  const [panelContent, setPanelContent] = useState<PanelContent>("files");
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [sessionTitle, setSessionTitle] = useState("");
  const [streamingSessionId, setStreamingSessionId] = useState("");
  const [pendingApprovalSessionId, setPendingApprovalSessionId] = useState("");

  // --- Doc Preview state ---
  const [previewFile, setPreviewFileRaw] = useState<string | null>(null);
  const [previewViewMode, setPreviewViewMode] = useState<PreviewViewMode>("source");
  const [docPreviewWidth, setDocPreviewWidth] = useState(() => {
    if (typeof window === "undefined") return 480;
    return parseInt(localStorage.getItem("codepilot_docpreview_width") || "480");
  });

  const setPreviewFile = useCallback((path: string | null) => {
    setPreviewFileRaw(path);
    if (path) {
      setPreviewViewMode(defaultViewMode(path));
    }
  }, []);

  const handleDocPreviewResize = useCallback((delta: number) => {
    setDocPreviewWidth((w) => Math.min(DOCPREVIEW_MAX, Math.max(DOCPREVIEW_MIN, w - delta)));
  }, []);
  const handleDocPreviewResizeEnd = useCallback(() => {
    setDocPreviewWidth((w) => {
      localStorage.setItem("codepilot_docpreview_width", String(w));
      return w;
    });
  }, []);

  // Auto-open panel on chat detail routes, close on others
  useEffect(() => {
    setPanelOpenRaw(isChatDetailRoute);
    if (!isChatDetailRoute) {
      setPreviewFileRaw(null);
    }
  }, [isChatDetailRoute]);

  const setPanelOpen = useCallback((open: boolean) => {
    setPanelOpenRaw(open);
  }, []);

  // Keep chat list state in sync when resizing across the breakpoint (only on chat routes)
  useEffect(() => {
    if (!isChatRoute) return;
    const mql = window.matchMedia(`(min-width: ${LG_BREAKPOINT}px)`);
    const handler = (e: MediaQueryListEvent) => setChatListOpenRaw(e.matches);
    mql.addEventListener("change", handler);
    setChatListOpenRaw(mql.matches);
    return () => mql.removeEventListener("change", handler);
  }, [isChatRoute]);

  // --- Skip-permissions indicator ---
  const [skipPermissionsActive, setSkipPermissionsActive] = useState(false);

  const fetchSkipPermissions = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/app");
      if (res.ok) {
        const data = await res.json();
        setSkipPermissionsActive(data.settings?.dangerously_skip_permissions === "true");
      }
    } catch {
      // ignore
    }
  }, []);

  // Poll periodically so the indicator stays in sync when settings change
  useEffect(() => {
    fetchSkipPermissions();
    const id = setInterval(fetchSkipPermissions, 5000);
    return () => clearInterval(id);
  }, [fetchSkipPermissions]);

  // --- Update check state ---
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [showDialog, setShowDialog] = useState(false);

  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/app/updates");
      if (!res.ok) return;
      const data: UpdateInfo = await res.json();
      setUpdateInfo(data);

      if (data.updateAvailable) {
        const dismissed = localStorage.getItem(DISMISSED_VERSION_KEY);
        if (dismissed !== data.latestVersion) {
          setShowDialog(true);
        }
      }
    } catch {
      // silently ignore network errors
    } finally {
      setChecking(false);
    }
  }, []);

  const dismissUpdate = useCallback(() => {
    setShowDialog(false);
    if (updateInfo?.latestVersion) {
      localStorage.setItem(DISMISSED_VERSION_KEY, updateInfo.latestVersion);
    }
  }, [updateInfo]);

  // Check on mount + every 8 hours
  useEffect(() => {
    checkForUpdates();
    const id = setInterval(checkForUpdates, CHECK_INTERVAL);
    return () => clearInterval(id);
  }, [checkForUpdates]);

  const updateContextValue = useMemo(
    () => ({
      updateInfo,
      checking,
      checkForUpdates,
      dismissUpdate,
      showDialog,
      setShowDialog,
    }),
    [updateInfo, checking, checkForUpdates, dismissUpdate, showDialog]
  );

  const panelContextValue = useMemo(
    () => ({
      panelOpen,
      setPanelOpen,
      panelContent,
      setPanelContent,
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
      previewFile,
      setPreviewFile,
      previewViewMode,
      setPreviewViewMode,
    }),
    [panelOpen, setPanelOpen, panelContent, workingDirectory, sessionId, sessionTitle, streamingSessionId, pendingApprovalSessionId, previewFile, setPreviewFile, previewViewMode]
  );

  return (
    <UpdateContext.Provider value={updateContextValue}>
      <PanelContext.Provider value={panelContextValue}>
        <TooltipProvider delayDuration={300}>
          <div className="flex h-screen overflow-hidden">
            <NavRail
              chatListOpen={chatListOpen}
              onToggleChatList={() => setChatListOpen(!chatListOpen)}
              hasUpdate={updateInfo?.updateAvailable ?? false}
              skipPermissionsActive={skipPermissionsActive}
            />
            <ChatListPanel open={chatListOpen} width={chatListWidth} />
            {chatListOpen && (
              <ResizeHandle side="left" onResize={handleChatListResize} onResizeEnd={handleChatListResizeEnd} />
            )}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {/* Electron draggable title bar region */}
              <div
                className="h-11 w-full shrink-0"
                style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
              />
              <main className="relative flex-1 overflow-hidden">{children}</main>
            </div>
            {isChatDetailRoute && previewFile && (
              <ResizeHandle side="right" onResize={handleDocPreviewResize} onResizeEnd={handleDocPreviewResizeEnd} />
            )}
            {isChatDetailRoute && previewFile && (
              <DocPreview
                filePath={previewFile}
                viewMode={previewViewMode}
                onViewModeChange={setPreviewViewMode}
                onClose={() => setPreviewFile(null)}
                width={docPreviewWidth}
              />
            )}
            {isChatDetailRoute && panelOpen && (
              <ResizeHandle side="right" onResize={handleRightPanelResize} onResizeEnd={handleRightPanelResizeEnd} />
            )}
            {isChatDetailRoute && <RightPanel width={rightPanelWidth} />}
          </div>
          <UpdateDialog />
        </TooltipProvider>
      </PanelContext.Provider>
    </UpdateContext.Provider>
  );
}
