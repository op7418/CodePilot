"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  FolderIcon,
  RefreshIcon,
  PlusSignIcon,
  Settings02Icon,
  Delete02Icon,
  StarIcon,
  FolderOpenIcon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useTranslation } from "@/hooks/useTranslation";
import { AddRepoDialog } from "./AddRepoDialog";
import { GitSettingsDialog } from "./GitSettingsDialog";
import type { GitRepoWithStatus } from "@/types/git";

interface RepoSidebarProps {
  repos: GitRepoWithStatus[];
  selectedRepoId: string | null;
  onSelectRepo: (id: string) => void;
  onRefresh: () => void;
}

export function RepoSidebar({ repos, selectedRepoId, onSelectRepo, onRefresh }: RepoSidebarProps) {
  const { t } = useTranslation();
  const [isScanning, setIsScanning] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [scanResult, setScanResult] = useState<{ found: number; added: number } | null>(null);

  const handleDeleteRepo = async (repoId: string) => {
    if (!confirm(t("git.deleteRepoConfirm"))) return;

    try {
      const res = await fetch(`/api/git/repos?id=${repoId}`, { method: "DELETE" });
      if (res.ok) {
        onRefresh();
      }
    } catch (error) {
      console.error("Failed to delete repo:", error);
    }
  };

  const handleSetDefault = async (repoId: string) => {
    try {
      const res = await fetch("/api/git/repos/default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: repoId }),
      });
      if (res.ok) {
        onRefresh();
      }
    } catch (error) {
      console.error("Failed to set default repo:", error);
    }
  };

  const handleOpenInFileManager = async (repoPath: string) => {
    try {
      if (window.electronAPI?.shell?.openPath) {
        await window.electronAPI.shell.openPath(repoPath);
      } else {
        // Fallback for web - use API
        await fetch("/api/files/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: repoPath }),
        });
      }
    } catch (error) {
      console.error("Failed to open in file manager:", error);
    }
  };

  const handleScan = async () => {
    setIsScanning(true);
    setScanResult(null);
    try {
      // Scan default directories (user's code directories)
      const res = await fetch("/api/git/repos/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addAsScanRoot: true, useDefault: true }),
      });
      const data = await res.json();
      console.log("Scan result:", data);
      setScanResult({ found: data.found, added: data.added });
      onRefresh();
      // Auto-hide scan result after 5 seconds
      setTimeout(() => setScanResult(null), 5000);
    } catch (error) {
      console.error("Failed to scan:", error);
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <div className="flex w-56 shrink-0 flex-col border-r border-border/50">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <span className="text-xs font-medium uppercase text-muted-foreground">
          {t("git.repositories")}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onRefresh}
            title={t("common.refresh")}
          >
            <HugeiconsIcon icon={RefreshIcon} className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setShowSettingsDialog(true)}
            title={t("git.gitSettings")}
          >
            <HugeiconsIcon icon={Settings02Icon} className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setShowAddDialog(true)}
            title={t("git.addRepository")}
          >
            <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Scan Result */}
      {scanResult && (
        <div className="mx-3 mt-2 rounded-md bg-green-500/10 px-3 py-2 text-xs text-green-600 dark:text-green-400">
          {t("git.scanResult", { found: scanResult.found, added: scanResult.added })}
        </div>
      )}

      {/* Repo List */}
      <div className="flex-1 overflow-auto py-1">
        {repos.length === 0 ? (
          <div className="px-3 py-4 text-center text-sm text-muted-foreground">
            {t("git.noRepos")}
            <div className="mt-2 flex justify-center gap-2">
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={handleScan}
                disabled={isScanning}
              >
                {t("git.scanNow")}
              </Button>
              <span className="text-muted-foreground">|</span>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => setShowAddDialog(true)}
              >
                {t("git.addRepo")}
              </Button>
            </div>
          </div>
        ) : (
          repos.map((repo) => (
            <ContextMenu key={repo.id}>
              <ContextMenuTrigger asChild>
                <button
                  onClick={() => onSelectRepo(repo.id)}
                  className={cn(
                    "group flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors",
                    selectedRepoId === repo.id
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <HugeiconsIcon icon={FolderIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-medium flex-1">{repo.name}</span>
                    {repo.is_default && (
                      <span className="rounded bg-primary/10 px-1 text-[10px] font-medium text-primary">
                        {t("git.default")}
                      </span>
                    )}
                    {/* Delete button - shows on hover */}
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteRepo(repo.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleDeleteRepo(repo.id);
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                      title={t("git.removeRepo")}
                    >
                      <HugeiconsIcon icon={Delete02Icon} className="h-3.5 w-3.5" />
                    </span>
                  </div>
                  {repo.branch && (
                    <div className="flex items-center gap-2 pl-6">
                      <span className="truncate text-xs text-muted-foreground">
                        {repo.branch}
                      </span>
                      {(repo.changes ?? 0) > 0 && (
                        <span className="rounded bg-yellow-500/20 px-1 text-[10px] font-medium text-yellow-600 dark:text-yellow-400">
                          {repo.changes}
                        </span>
                      )}
                      {(repo.ahead ?? 0) > 0 && (
                        <span className="rounded bg-green-500/20 px-1 text-[10px] font-medium text-green-600 dark:text-green-400">
                          ↑{repo.ahead}
                        </span>
                      )}
                      {(repo.behind ?? 0) > 0 && (
                        <span className="rounded bg-blue-500/20 px-1 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                          ↓{repo.behind}
                        </span>
                      )}
                    </div>
                  )}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                {!repo.is_default && (
                  <ContextMenuItem onClick={() => handleSetDefault(repo.id)}>
                    <HugeiconsIcon icon={StarIcon} className="mr-2 h-4 w-4" />
                    {t("git.setAsDefault")}
                  </ContextMenuItem>
                )}
                <ContextMenuItem onClick={() => handleOpenInFileManager(repo.path)}>
                  <HugeiconsIcon icon={FolderOpenIcon} className="mr-2 h-4 w-4" />
                  {t("git.openInFileManager")}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onClick={() => handleDeleteRepo(repo.id)}
                  className="text-destructive focus:text-destructive"
                >
                  <HugeiconsIcon icon={Delete02Icon} className="mr-2 h-4 w-4" />
                  {t("git.removeRepo")}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))
        )}
      </div>

      {/* Add Repo Dialog */}
      <AddRepoDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onSuccess={onRefresh}
      />

      {/* Git Settings Dialog */}
      <GitSettingsDialog
        open={showSettingsDialog}
        onOpenChange={setShowSettingsDialog}
      />
    </div>
  );
}
