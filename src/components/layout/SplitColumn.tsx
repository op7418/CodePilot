"use client";

import { useEffect, useState, useCallback } from "react";
import { X } from "@/components/ui/icon";
import type { Message, MessagesResponse, ChatSession } from "@/types";
import { ChatView } from "@/components/chat/ChatView";
import { Button } from "@/components/ui/button";
import { usePanel } from "@/hooks/usePanel";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";

interface SplitColumnProps {
  sessionId: string;
  isActive: boolean;
  onClose: () => void;
  onFocus: () => void;
}

export function SplitColumn({ sessionId, isActive, onClose, onFocus }: SplitColumnProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState("");
  const [sessionModel, setSessionModel] = useState("");
  const [sessionProviderId, setSessionProviderId] = useState("");
  const [sessionInfoLoaded, setSessionInfoLoaded] = useState(false);
  const [sessionMode, setSessionMode] = useState("");
  const [projectName, setProjectName] = useState("");
  const [sessionWorkingDir, setSessionWorkingDir] = useState("");
  const { setWorkingDirectory, setSessionId, setSessionTitle: setPanelSessionTitle, setPanelOpen } = usePanel();
  const { t } = useTranslation();

  // Load session metadata
  useEffect(() => {
    let cancelled = false;
    setSessionInfoLoaded(false);
    setSessionModel("");
    setSessionProviderId("");
    async function loadSession() {
      try {
        const res = await fetch(`/api/chat/sessions/${sessionId}`);
        if (cancelled) return;
        if (res.ok) {
          const data: { session: ChatSession } = await res.json();
          setSessionTitle(data.session.title || t("chat.newConversation"));
          setSessionModel(data.session.model || "");
          setSessionProviderId(data.session.provider_id || "");
          setSessionMode(data.session.mode || "code");
          setProjectName(data.session.project_name || "");
          setSessionWorkingDir(data.session.working_directory || "");
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setSessionInfoLoaded(true);
      }
    }
    loadSession();
    return () => { cancelled = true; };
  }, [sessionId, t]);

  // Load messages
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMessages([]);
    setHasMore(false);

    async function loadMessages() {
      try {
        const res = await fetch(`/api/chat/sessions/${sessionId}/messages?limit=30`);
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 404) {
            setError("Session not found");
            return;
          }
          throw new Error("Failed to load messages");
        }
        const data: MessagesResponse = await res.json();
        if (cancelled) return;
        setMessages(data.messages);
        setHasMore(data.hasMore ?? false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load messages");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadMessages();
    return () => { cancelled = true; };
  }, [sessionId]);

  // When this column becomes active, sync PanelContext
  useEffect(() => {
    if (!isActive) return;
    if (sessionWorkingDir) {
      setWorkingDirectory(sessionWorkingDir);
      localStorage.setItem("codepilot:last-working-directory", sessionWorkingDir);
      window.dispatchEvent(new Event("refresh-file-tree"));
    } else {
      // Clear stale directory from previous column so FileTree doesn't show old project
      setWorkingDirectory('');
    }
    setSessionId(sessionId);
    setPanelOpen(true);
    if (sessionTitle) {
      setPanelSessionTitle(sessionTitle);
    }
  }, [isActive, sessionId, sessionWorkingDir, sessionTitle, setWorkingDirectory, setSessionId, setPanelSessionTitle, setPanelOpen]);

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  }, [onClose]);

  if (loading || !sessionInfoLoaded) {
    return (
      <div
        className={cn(
          "flex flex-1 min-w-0 flex-col overflow-hidden rounded-md border-2 transition-colors",
          isActive ? "border-primary" : "border-transparent"
        )}
        onClick={onFocus}
      >
        <div className="flex h-full items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={cn(
          "flex flex-1 min-w-0 flex-col overflow-hidden rounded-md border-2 transition-colors",
          isActive ? "border-primary" : "border-transparent"
        )}
        onClick={onFocus}
      >
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-1 min-w-0 flex-col overflow-hidden rounded-md border-2 transition-colors",
        isActive ? "border-primary" : "border-transparent"
      )}
      onClick={onFocus}
    >
      {/* Compact title bar */}
      <div className="flex h-9 shrink-0 items-center justify-between px-3 border-b bg-muted/30">
        <div className="flex items-center gap-1.5 min-w-0">
          {projectName && (
            <>
              <span className="text-[11px] text-muted-foreground shrink-0">{projectName}</span>
              <span className="text-[11px] text-muted-foreground shrink-0">/</span>
            </>
          )}
          <span className="text-[11px] font-medium truncate">{sessionTitle}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={handleClose}
        >
          <X className="h-3 w-3" />
          <span className="sr-only">{t("split.closeSplit")}</span>
        </Button>
      </div>
      {/* ChatView */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <ChatView
          key={sessionId}
          sessionId={sessionId}
          initialMessages={messages}
          initialHasMore={hasMore}
          modelName={sessionModel}
          initialMode={sessionMode}
          providerId={sessionProviderId}
        />
      </div>
    </div>
  );
}
