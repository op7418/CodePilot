"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PlusSignIcon,
  MinusSignIcon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  File01Icon,
  Download01Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "@/hooks/useTranslation";
import type { GitRepoStatus, GitFileChange } from "@/types/git";
import { getGitStatusIcon, getGitStatusColor } from "@/types/git";

interface ChangesSectionProps {
  status: GitRepoStatus;
  repoPath: string;
  selectedFile: GitFileChange | null;
  onSelectFile: (file: GitFileChange | null) => void;
  onStage: (files: string[]) => void;
  onUnstage: (files: string[]) => void;
  onDiscard: (files: string[]) => void;
  onRefresh: () => void;
}

export function ChangesSection({
  status,
  repoPath,
  selectedFile,
  onSelectFile,
  onStage,
  onUnstage,
  onDiscard,
  onRefresh,
}: ChangesSectionProps) {
  const { t } = useTranslation();
  const [expandedStaged, setExpandedStaged] = useState(true);
  const [expandedChanges, setExpandedChanges] = useState(true);
  const [expandedUntracked, setExpandedUntracked] = useState(true);
  const [showStashDialog, setShowStashDialog] = useState(false);
  const [stashMessage, setStashMessage] = useState("");
  const [isStashing, setIsStashing] = useState(false);
  const [includeUntracked, setIncludeUntracked] = useState(true);

  const stagedFiles = status.files.filter(f => f.staged);
  const changedFiles = status.files.filter(f => !f.staged && f.status !== '?');
  const untrackedFiles = status.files.filter(f => !f.staged && f.status === '?');

  const handleStageAll = () => {
    const paths = [...changedFiles, ...untrackedFiles].map(f => f.path);
    if (paths.length > 0) {
      onStage(paths);
    }
  };

  const handleUnstageAll = () => {
    const paths = stagedFiles.map(f => f.path);
    if (paths.length > 0) {
      onUnstage(paths);
    }
  };

  const handleStash = async () => {
    setIsStashing(true);
    try {
      const res = await fetch("/api/git/stash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: repoPath,
          message: stashMessage.trim() || undefined,
          includeUntracked,
        }),
      });

      if (res.ok) {
        setShowStashDialog(false);
        setStashMessage("");
        onRefresh();
      }
    } catch (error) {
      console.error("Failed to stash:", error);
    } finally {
      setIsStashing(false);
    }
  };

  const renderFileItem = (file: GitFileChange) => {
    const isSelected = selectedFile?.path === file.path;
    const statusIcon = getGitStatusIcon(file.status);
    const statusColor = getGitStatusColor(file.status);

    return (
      <div
        key={file.path}
        onClick={() => onSelectFile(file)}
        className={cn(
          "group flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors",
          isSelected ? "bg-accent" : "hover:bg-accent/50"
        )}
      >
        <HugeiconsIcon icon={File01Icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm">{file.path}</span>
        <span className={cn("text-xs font-medium", statusColor)}>{statusIcon}</span>

        {/* Actions */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
          {file.staged ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={(e) => {
                e.stopPropagation();
                onUnstage([file.path]);
              }}
              title={t("git.unstage")}
            >
              <HugeiconsIcon icon={MinusSignIcon} className="h-3 w-3" />
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={(e) => {
                  e.stopPropagation();
                  onStage([file.path]);
                }}
                title={t("git.stage")}
              >
                <HugeiconsIcon icon={PlusSignIcon} className="h-3 w-3" />
              </Button>
              {file.status !== '?' && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 text-red-500 hover:text-red-600"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(t("git.discardConfirm"))) {
                      onDiscard([file.path]);
                    }
                  }}
                  title={t("git.discard")}
                >
                  <HugeiconsIcon icon={Delete02Icon} className="h-3 w-3" />
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col">
      {/* Stash button - only show when there are changes */}
      {!status.clean && (
        <div className="flex items-center justify-end gap-2 border-b border-border/50 px-3 py-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1"
            onClick={() => setShowStashDialog(true)}
          >
            <HugeiconsIcon icon={Download01Icon} className="h-3.5 w-3.5" />
            {t("git.stash")}
          </Button>
        </div>
      )}

      {/* Staged Changes */}
      {stagedFiles.length > 0 && (
        <div className="border-b border-border/50">
          <div
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setExpandedStaged(!expandedStaged)}
            onClick={() => setExpandedStaged(!expandedStaged)}
            className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium uppercase text-muted-foreground hover:bg-accent/50 cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <HugeiconsIcon icon={CheckmarkCircle02Icon} className="h-3.5 w-3.5" />
              {t("git.stagedChanges")} ({stagedFiles.length})
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  handleUnstageAll();
                }}
              >
                {t("git.unstageAll")}
              </Button>
            </div>
          </div>
          {expandedStaged && stagedFiles.map(renderFileItem)}
        </div>
      )}

      {/* Changes */}
      {changedFiles.length > 0 && (
        <div className="border-b border-border/50">
          <div
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setExpandedChanges(!expandedChanges)}
            onClick={() => setExpandedChanges(!expandedChanges)}
            className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium uppercase text-muted-foreground hover:bg-accent/50 cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <HugeiconsIcon icon={File01Icon} className="h-3.5 w-3.5" />
              {t("git.changes")} ({changedFiles.length})
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  handleStageAll();
                }}
              >
                {t("git.stageAll")}
              </Button>
            </div>
          </div>
          {expandedChanges && changedFiles.map(renderFileItem)}
        </div>
      )}

      {/* Untracked */}
      {untrackedFiles.length > 0 && (
        <div>
          <button
            onClick={() => setExpandedUntracked(!expandedUntracked)}
            className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium uppercase text-muted-foreground hover:bg-accent/50"
          >
            <span className="flex items-center gap-2">
              <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
              {t("git.untracked")} ({untrackedFiles.length})
            </span>
          </button>
          {expandedUntracked && untrackedFiles.map(renderFileItem)}
        </div>
      )}

      {/* Empty state */}
      {status.clean && (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <HugeiconsIcon icon={CheckmarkCircle02Icon} className="mb-2 h-8 w-8 text-green-500" />
          <span className="text-sm">{t("git.noChanges")}</span>
        </div>
      )}

      {/* Stash Dialog */}
      <Dialog open={showStashDialog} onOpenChange={setShowStashDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("git.stashChanges")}</DialogTitle>
            <DialogDescription>
              {t("git.stashChangesDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Input
                value={stashMessage}
                onChange={(e) => setStashMessage(e.target.value)}
                placeholder={t("git.stashMessagePlaceholder")}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeUntracked}
                onChange={(e) => setIncludeUntracked(e.target.checked)}
                className="rounded"
              />
              {t("git.includeUntracked")}
            </label>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowStashDialog(false)}
              disabled={isStashing}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={handleStash} disabled={isStashing}>
              {isStashing ? t("git.stashing") : t("git.stash")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
