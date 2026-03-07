"use client";

import { useState, useEffect, useCallback } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Loading02Icon,
  GitCommitIcon,
  RefreshIcon,
  Clock01Icon,
  UserIcon,
  HashtagIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import type { GitCommit, GitLogResponse } from "@/types/git";

interface CommitHistoryProps {
  repoPath: string;
  selectedCommitHash?: string | null;
  onSelectCommit?: (commit: GitCommit | null) => void;
}

export function CommitHistory({ repoPath, selectedCommitHash, onSelectCommit }: CommitHistoryProps) {
  const { t } = useTranslation();
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [skip, setSkip] = useState(0);
  const limit = 50;

  const fetchCommits = useCallback(async (reset = false) => {
    if (!repoPath) return;

    if (reset) {
      setLoading(true);
      setSkip(0);
    } else {
      setLoadingMore(true);
    }
    setError(null);

    try {
      const currentSkip = reset ? 0 : skip;
      const res = await fetch(
        `/api/git/log?path=${encodeURIComponent(repoPath)}&limit=${limit}&skip=${currentSkip}`
      );
      const data: GitLogResponse = await res.json();

      if (!res.ok) {
        throw new Error(data instanceof Error ? data.message : t("git.failedToLoadHistory"));
      }

      if (reset) {
        setCommits(data.commits);
      } else {
        setCommits((prev) => [...prev, ...data.commits]);
      }
      setHasMore(data.hasMore);
      setSkip(currentSkip + data.commits.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("git.failedToLoadHistory"));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [repoPath, skip, t]);

  useEffect(() => {
    fetchCommits(true);
  }, [repoPath]);

  // Format relative time
  const formatRelativeTime = (dateString: string): string => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSeconds < 60) {
      return t("git.justNow");
    } else if (diffMinutes < 60) {
      return t("git.minutesAgo", { n: diffMinutes });
    } else if (diffHours < 24) {
      return t("git.hoursAgo", { n: diffHours });
    } else if (diffDays < 7) {
      return t("git.daysAgo", { n: diffDays });
    } else {
      return date.toLocaleDateString();
    }
  };

  // Copy commit hash to clipboard
  const copyHash = async (e: React.MouseEvent, hash: string) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(hash);
    } catch (err) {
      console.error("Failed to copy hash:", err);
    }
  };

  // Handle commit click
  const handleCommitClick = (commit: GitCommit) => {
    if (selectedCommitHash === commit.hash) {
      // Deselect if clicking the same commit
      onSelectCommit?.(null);
    } else {
      onSelectCommit?.(commit);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <HugeiconsIcon icon={Loading02Icon} className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 p-8">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={() => fetchCommits(true)}>
          <HugeiconsIcon icon={RefreshIcon} className="mr-2 h-4 w-4" />
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
        <div className="flex items-center gap-2">
          <HugeiconsIcon icon={GitCommitIcon} className="h-4 w-4" />
          <span className="font-medium">{t("git.commitHistory")}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => fetchCommits(true)}
          title={t("common.refresh")}
        >
          <HugeiconsIcon icon={RefreshIcon} className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Commit list */}
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border/50">
          {commits.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {t("git.noCommits")}
            </div>
          ) : (
            commits.map((commit) => (
              <div
                key={commit.hash}
                onClick={() => handleCommitClick(commit)}
                className={cn(
                  "flex flex-col gap-1 px-4 py-3 cursor-pointer transition-colors",
                  selectedCommitHash === commit.hash
                    ? "bg-accent"
                    : "hover:bg-muted/50"
                )}
              >
                {/* Commit message */}
                <div className="flex items-start gap-2">
                  <HugeiconsIcon
                    icon={GitCommitIcon}
                    className={cn(
                      "mt-0.5 h-4 w-4 shrink-0",
                      selectedCommitHash === commit.hash
                        ? "text-primary"
                        : "text-muted-foreground"
                    )}
                  />
                  <span className="text-sm leading-relaxed">{commit.message}</span>
                </div>

                {/* Commit meta */}
                <div className="flex items-center gap-3 pl-6 text-xs text-muted-foreground">
                  {/* Hash */}
                  <button
                    onClick={(e) => copyHash(e, commit.shortHash)}
                    className="flex items-center gap-1 hover:text-foreground transition-colors"
                    title={t("git.copyHash")}
                  >
                    <HugeiconsIcon icon={HashtagIcon} className="h-3 w-3" />
                    <code className="rounded bg-muted px-1 font-mono">{commit.shortHash}</code>
                  </button>

                  {/* Author */}
                  <span className="flex items-center gap-1">
                    <HugeiconsIcon icon={UserIcon} className="h-3 w-3" />
                    {commit.author}
                  </span>

                  {/* Date */}
                  <span className="flex items-center gap-1">
                    <HugeiconsIcon icon={Clock01Icon} className="h-3 w-3" />
                    {formatRelativeTime(commit.date)}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Load more */}
        {hasMore && (
          <div className="border-t border-border/50 p-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => fetchCommits(false)}
              disabled={loadingMore}
            >
              {loadingMore ? (
                <>
                  <HugeiconsIcon icon={Loading02Icon} className="mr-2 h-4 w-4 animate-spin" />
                  {t("git.loadingMore")}
                </>
              ) : (
                t("git.loadMore")
              )}
            </Button>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
