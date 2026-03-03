'use client';

import { useEffect, useState, useRef, useCallback, use } from 'react';
import Link from 'next/link';
import type { Message, MessagesResponse, ChatSession } from '@/types';
import { ChatView } from '@/components/chat/ChatView';
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePanel } from '@/hooks/usePanel';
import { useTranslation } from '@/hooks/useTranslation';

interface ChatSessionPageProps {
  params: Promise<{ id: string }>;
}

export default function ChatSessionPage({ params }: ChatSessionPageProps) {
  const { id } = use(params);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string>('');
  const [sessionModel, setSessionModel] = useState<string>('');
  const [sessionProviderId, setSessionProviderId] = useState<string>('');
  const [sessionMode, setSessionMode] = useState<string>('');
  const [projectName, setProjectName] = useState<string>('');
  const [sessionWorkingDir, setSessionWorkingDir] = useState<string>('');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const { setWorkingDirectory, setSessionId, setSessionTitle: setPanelSessionTitle, setPanelOpen } = usePanel();
  const { t } = useTranslation();

  const handleStartEditTitle = useCallback(() => {
    setEditTitle(sessionTitle || t('chat.newConversation'));
    setIsEditingTitle(true);
  }, [sessionTitle]);

  const handleSaveTitle = useCallback(async () => {
    const trimmed = editTitle.trim();
    if (!trimmed) {
      setIsEditingTitle(false);
      return;
    }
    try {
      const res = await fetch(`/api/chat/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
      if (res.ok) {
        setSessionTitle(trimmed);
        setPanelSessionTitle(trimmed);
        window.dispatchEvent(new CustomEvent('session-updated', { detail: { id, title: trimmed } }));
      }
    } catch {
      // silently fail
    }
    setIsEditingTitle(false);
  }, [editTitle, id, setPanelSessionTitle]);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveTitle();
    } else if (e.key === 'Escape') {
      setIsEditingTitle(false);
    }
  }, [handleSaveTitle]);

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  // Load session info and set working directory
  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const res = await fetch(`/api/chat/sessions/${id}`);
        if (cancelled) return;
        if (res.ok) {
          const data: { session: ChatSession } = await res.json();
          if (cancelled) return;
          if (data.session.working_directory) {
            setWorkingDirectory(data.session.working_directory);
            setSessionWorkingDir(data.session.working_directory);
            localStorage.setItem("codepilot:last-working-directory", data.session.working_directory);
            window.dispatchEvent(new Event('refresh-file-tree'));
          }
          setSessionId(id);
          setPanelOpen(true);
          const title = data.session.title || t('chat.newConversation');
          setSessionTitle(title);
          setPanelSessionTitle(title);
          setSessionModel(data.session.model || '');
          setSessionProviderId(data.session.provider_id || '');
          setSessionMode(data.session.mode || 'code');
          setProjectName(data.session.project_name || '');
        }
      } catch {
        // Session info load failed - panel will still work without directory
      }
    }

    loadSession();
    return () => { cancelled = true; };
  }, [id, setWorkingDirectory, setSessionId, setPanelSessionTitle, setPanelOpen]);

  useEffect(() => {
    // Reset state when switching sessions
    setLoading(true);
    setError(null);
    setMessages([]);
    setHasMore(false);

    let cancelled = false;

    async function loadMessages() {
      try {
        const res = await fetch(`/api/chat/sessions/${id}/messages?limit=30`);
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 404) {
            setError('Session not found');
            return;
          }
          throw new Error('Failed to load messages');
        }
        const data: MessagesResponse = await res.json();
        if (cancelled) return;
        setMessages(data.messages);
        setHasMore(data.hasMore ?? false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load messages');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadMessages();

    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <HugeiconsIcon icon={Loading02Icon} className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-destructive font-medium">{error}</p>
          <Link href="/chat" className="text-sm text-muted-foreground hover:underline">
            Start a new chat
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Chat title bar */}
      {sessionTitle && (
        <div
          className="flex h-12 shrink-0 items-center justify-center px-4 gap-1"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          {projectName && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="text-xs text-muted-foreground shrink-0 hover:text-foreground transition-colors cursor-pointer"
                    style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    onClick={() => {
                      if (sessionWorkingDir) {
                        if (window.electronAPI?.shell?.openPath) {
                          window.electronAPI.shell.openPath(sessionWorkingDir);
                        } else {
                          fetch('/api/files/open', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path: sessionWorkingDir }),
                          }).catch(() => {});
                        }
                      }
                    }}
                  >
                    {projectName}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs break-all">{sessionWorkingDir || projectName}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Click to open in Finder</p>
                </TooltipContent>
              </Tooltip>
              <span className="text-xs text-muted-foreground shrink-0">/</span>
            </>
          )}
          {isEditingTitle ? (
            <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
              <Input
                ref={titleInputRef}
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={handleTitleKeyDown}
                onBlur={handleSaveTitle}
                className="h-7 text-sm max-w-md text-center"
              />
            </div>
          ) : (
            <div
              className="flex items-center gap-1 group cursor-default max-w-md"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <h2 className="text-sm font-medium text-foreground/80 truncate">
                {sessionTitle}
              </h2>
              <button
                onClick={handleStartEditTitle}
                className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 p-0.5 rounded hover:bg-muted"
              >
                <HugeiconsIcon icon={PencilEdit01Icon} className="h-3 w-3 text-muted-foreground" />
              </button>
            </div>
          )}
        </div>
      )}
      <ChatView key={id} sessionId={id} initialMessages={messages} initialHasMore={hasMore} modelName={sessionModel} initialMode={sessionMode} providerId={sessionProviderId} />
    </div>
  );
}
