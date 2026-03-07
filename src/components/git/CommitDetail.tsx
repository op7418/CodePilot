"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft02Icon,
  Loading02Icon,
  Clock01Icon,
  UserIcon,
  HashtagIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DiffViewer } from "./DiffViewer";
import { useTranslation } from "@/hooks/useTranslation";
import type { GitCommit, GitDiff } from "@/types/git";

interface CommitDetailProps {
  commit: GitCommit;
  diff: GitDiff | null;
  isLoading: boolean;
  onBack: () => void;
}

export function CommitDetail({ commit, diff, isLoading, onBack }: CommitDetailProps) {
  const { t } = useTranslation();

  // Format date
  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  // Copy commit hash to clipboard
  const copyHash = async () => {
    try {
      await navigator.clipboard.writeText(commit.hash);
    } catch (err) {
      console.error("Failed to copy hash:", err);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/50 px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onBack}
          title={t("common.back")}
        >
          <HugeiconsIcon icon={ArrowLeft02Icon} className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="truncate text-sm font-medium">{commit.message}</div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {/* Hash */}
            <button
              onClick={copyHash}
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
              {formatDate(commit.date)}
            </span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <HugeiconsIcon icon={Loading02Icon} className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : diff ? (
          <DiffViewer diff={diff} />
        ) : (
          <div className="flex items-center justify-center p-8 text-muted-foreground">
            {t("git.noDiff")}
          </div>
        )}
      </div>
    </div>
  );
}
