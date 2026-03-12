"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { Badge } from "@/components/ui/badge";
import {
  MagnifyingGlass,
  SpinnerGap,
  FolderOpen,
  GitBranch,
  Clock,
  FileArrowDown,
  ChatCircleText,
} from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import { cn, parseDBDate } from "@/lib/utils";

interface ClaudeSessionInfo {
  sessionId: string;
  projectPath: string;
  projectName: string;
  cwd: string;
  gitBranch: string;
  version: string;
  preview: string;
  userMessageCount: number;
  assistantMessageCount: number;
  createdAt: string;
  updatedAt: string;
  fileSize: number;
}

interface ImportSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatRelativeTime(dateStr: string): { key: 'import.justNow' | 'import.minutesAgo' | 'import.hoursAgo' | 'import.daysAgo'; params?: Record<string, number> } | string {
  const date = parseDBDate(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return { key: 'import.justNow' };
  if (diffMin < 60) return { key: 'import.minutesAgo', params: { n: diffMin } };
  if (diffHr < 24) return { key: 'import.hoursAgo', params: { n: diffHr } };
  if (diffDay < 7) return { key: 'import.daysAgo', params: { n: diffDay } };
  return date.toLocaleDateString();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImportSessionDialog({
  open,
  onOpenChange,
}: ImportSessionDialogProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<ClaudeSessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/claude-sessions");
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to fetch sessions");
      }
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetchSessions();
    }
  }, [open, fetchSessions]);

  const handleImport = async (sessionId: string) => {
    setImporting(sessionId);
    setError(null);
    try {
      const res = await fetch("/api/claude-sessions/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });

      const data = await res.json();

      if (res.status === 409 && data.existingSessionId) {
        // Already imported — navigate to the existing session
        onOpenChange(false);
        router.push(`/chat/${data.existingSessionId}`);
        return;
      }

      if (!res.ok) {
        throw new Error(data.error || "Failed to import session");
      }

      // Navigate to the newly imported session
      onOpenChange(false);
      window.dispatchEvent(new CustomEvent("session-created"));
      router.push(`/chat/${data.session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import session");
    } finally {
      setImporting(null);
    }
  };

  const filteredSessions = searchQuery
    ? sessions.filter(
        (s) =>
          s.projectName.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.preview.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.cwd.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.gitBranch.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : sessions;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] !flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileArrowDown size={20} className="text-primary" />
            {t('import.title')}
          </DialogTitle>
          <DialogDescription>
            Browse and import conversations from Claude Code CLI. Imported
            sessions can be resumed in CodePilot.
          </DialogDescription>
        </DialogHeader>

        {/* Search */}
        <div className="relative">
          <MagnifyingGlass
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            placeholder={t('import.searchSessions')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 text-sm"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Session List */}
        <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6">
          <div className="flex flex-col gap-2 pb-2">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <SpinnerGap size={20} className="animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">
                  Scanning CLI sessions...
                </span>
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <FolderOpen size={32} className="mb-2 opacity-40" />
                <p className="text-sm">
                  {searchQuery
                    ? t('import.noSessions')
                    : t('import.noSessions')}
                </p>
                <p className="text-xs mt-1 opacity-60">
                  {searchQuery
                    ? "Try a different search term"
                    : "Sessions are stored in ~/.claude/projects/"}
                </p>
              </div>
            ) : (
              filteredSessions.map((session) => {
                const isImporting = importing === session.sessionId;
                const totalMessages =
                  session.userMessageCount + session.assistantMessageCount;
                return (
                  <div
                    key={session.sessionId}
                    className={cn(
                      "group flex flex-col gap-1.5 rounded-lg border p-3 transition-colors",
                      "hover:bg-accent/50",
                      isImporting && "opacity-60 pointer-events-none"
                    )}
                  >
                    {/* Top row: project name + import button */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-sm truncate">
                            {session.projectName}
                          </span>
                          {session.gitBranch && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] px-1.5 py-0 h-4 shrink-0"
                            >
                              <GitBranch size={10} className="mr-0.5" />
                              {session.gitBranch}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-2 break-all">
                          {session.preview}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 h-7 text-xs"
                        onClick={() => handleImport(session.sessionId)}
                        disabled={isImporting}
                      >
                        {isImporting ? (
                          <>
                            <SpinnerGap size={12} className="mr-1 animate-spin" />
                            {t('import.importing')}
                          </>
                        ) : (
                          <>
                            <FileArrowDown size={12} className="mr-1" />
                            {t('import.import')}
                          </>
                        )}
                      </Button>
                    </div>

                    {/* Bottom row: metadata */}
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60">
                      <span
                        className="flex items-center gap-0.5 truncate"
                        title={session.cwd}
                      >
                        <FolderOpen size={10} className="shrink-0" />
                        {session.cwd}
                      </span>
                      <span className="flex items-center gap-0.5 shrink-0">
                        <ChatCircleText size={10} />
                        {t(totalMessages !== 1 ? 'import.messagesPlural' : 'import.messages', { n: totalMessages })}
                      </span>
                      <span className="flex items-center gap-0.5 shrink-0">
                        <Clock size={10} />
                        {(() => {
                          const rel = formatRelativeTime(session.updatedAt);
                          return typeof rel === 'string' ? rel : t(rel.key, rel.params);
                        })()}
                      </span>
                      <span className="shrink-0">
                        {formatFileSize(session.fileSize)}
                      </span>
                      {session.version && (
                        <span className="shrink-0">v{session.version}</span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
