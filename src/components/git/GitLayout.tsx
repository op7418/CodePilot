"use client";

import { useState, useEffect } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { GitBranchIcon, Settings02Icon, FileEditIcon, Clock01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { RepoSelector } from "./RepoSelector";
import { ChangesSection } from "./ChangesSection";
import { CommitPanel } from "./CommitPanel";
import { DiffViewer } from "./DiffViewer";
import { BranchSelector } from "./BranchSelector";
import { RemoteActionsPanel } from "./RemoteActionsPanel";
import { CommitHistory } from "./CommitHistory";
import { CommitDetail } from "./CommitDetail";
import { AddRepoDialog } from "./AddRepoDialog";
import { GitSettingsDialog } from "./GitSettingsDialog";
import { useTranslation } from "@/hooks/useTranslation";
import type { GitRepoWithStatus, GitRepoStatus, GitFileChange, GitDiff, GitCommit } from "@/types/git";

interface GitLayoutProps {
  /** Current project path from chat session */
  currentProjectPath?: string;
}

type TabType = "changes" | "history";

export function GitLayout({ currentProjectPath }: GitLayoutProps) {
  const { t } = useTranslation();

  // State
  const [repos, setRepos] = useState<GitRepoWithStatus[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [status, setStatus] = useState<GitRepoStatus | null>(null);
  const [selectedFile, setSelectedFile] = useState<GitFileChange | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [isCommitting, setIsCommitting] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>("changes");

  // Commit history state
  const [selectedCommit, setSelectedCommit] = useState<GitCommit | null>(null);
  const [commitDiff, setCommitDiff] = useState<GitDiff | null>(null);
  const [loadingCommitDiff, setLoadingCommitDiff] = useState(false);

  // Get selected repo
  const selectedRepo = repos.find(r => r.id === selectedRepoId);

  // Fetch repos on mount
  useEffect(() => {
    fetchRepos();
  }, []);

  // Auto-select repo based on current project path or default
  useEffect(() => {
    if (repos.length > 0) {
      // If we have a current project path, only select matching repo
      if (currentProjectPath) {
        const matchingRepo = repos.find(r => r.path === currentProjectPath);
        if (matchingRepo && matchingRepo.id !== selectedRepoId) {
          setSelectedRepoId(matchingRepo.id);
        } else if (!matchingRepo) {
          // No matching repo for current project - clear selection
          setSelectedRepoId(null);
        }
      } else {
        // No current project - select default or first repo
        if (!selectedRepoId) {
          const defaultRepo = repos.find(r => r.is_default);
          setSelectedRepoId(defaultRepo?.id || repos[0].id);
        }
      }
    }
  }, [repos, currentProjectPath]);

  // Fetch status when repo changes
  useEffect(() => {
    if (selectedRepo) {
      fetchStatus(selectedRepo.path);
    }
  }, [selectedRepoId]);

  // Fetch diff when file changes
  useEffect(() => {
    if (selectedRepo && selectedFile) {
      fetchDiff(selectedRepo.path, selectedFile.path, selectedFile.staged);
    } else {
      setDiff(null);
    }
  }, [selectedFile]);

  // Fetch commit diff when commit is selected
  useEffect(() => {
    if (selectedRepo && selectedCommit) {
      fetchCommitDiff(selectedRepo.path, selectedCommit.hash);
    } else {
      setCommitDiff(null);
    }
  }, [selectedCommit]);

  // Clear selected commit when switching tabs
  useEffect(() => {
    if (activeTab === "changes") {
      setSelectedCommit(null);
      setCommitDiff(null);
    }
  }, [activeTab]);

  // Handlers
  const fetchRepos = async () => {
    setLoadingRepos(true);
    try {
      const res = await fetch("/api/git/repos");
      const data = await res.json();
      setRepos(data.repos || []);
    } catch (error) {
      console.error("Failed to fetch repos:", error);
    } finally {
      setLoadingRepos(false);
    }
  };

  const fetchStatus = async (repoPath: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/git/status?path=${encodeURIComponent(repoPath)}`);
      const data = await res.json();
      setStatus(data.status);
      setSelectedFile(null);
      setDiff(null);
    } catch (error) {
      console.error("Failed to fetch status:", error);
      setStatus(null);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchDiff = async (repoPath: string, file: string, staged: boolean) => {
    try {
      const res = await fetch(
        `/api/git/diff?path=${encodeURIComponent(repoPath)}&file=${encodeURIComponent(file)}&staged=${staged}`
      );
      const data = await res.json();
      setDiff(data.diff);
    } catch (error) {
      console.error("Failed to fetch diff:", error);
      setDiff(null);
    }
  };

  const fetchCommitDiff = async (repoPath: string, commitHash: string) => {
    setLoadingCommitDiff(true);
    try {
      const res = await fetch(
        `/api/git/diff?path=${encodeURIComponent(repoPath)}&commit=${encodeURIComponent(commitHash)}`
      );
      const data = await res.json();
      setCommitDiff(data.diff);
    } catch (error) {
      console.error("Failed to fetch commit diff:", error);
      setCommitDiff(null);
    } finally {
      setLoadingCommitDiff(false);
    }
  };

  const handleStage = async (files: string[]) => {
    if (!selectedRepo) return;
    try {
      await fetch("/api/git/stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedRepo.path, files }),
      });
      fetchStatus(selectedRepo.path);
    } catch (error) {
      console.error("Failed to stage:", error);
    }
  };

  const handleUnstage = async (files: string[]) => {
    if (!selectedRepo) return;
    try {
      await fetch("/api/git/unstage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedRepo.path, files }),
      });
      fetchStatus(selectedRepo.path);
    } catch (error) {
      console.error("Failed to unstage:", error);
    }
  };

  const handleDiscard = async (files: string[]) => {
    if (!selectedRepo) return;
    try {
      await fetch("/api/git/discard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedRepo.path, files }),
      });
      fetchStatus(selectedRepo.path);
    } catch (error) {
      console.error("Failed to discard:", error);
    }
  };

  const handleCommit = async () => {
    if (!selectedRepo || !commitMessage.trim()) return;
    setIsCommitting(true);
    try {
      await fetch("/api/git/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedRepo.path, message: commitMessage }),
      });
      setCommitMessage("");
      fetchStatus(selectedRepo.path);
    } catch (error) {
      console.error("Failed to commit:", error);
    } finally {
      setIsCommitting(false);
    }
  };

  const handleRefresh = () => {
    if (selectedRepo) {
      fetchStatus(selectedRepo.path);
    }
  };

  const handleSelectCommit = (commit: GitCommit | null) => {
    setSelectedCommit(commit);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
        <div className="flex items-center gap-3">
          <HugeiconsIcon icon={GitBranchIcon} className="h-5 w-5" />
          <h1 className="text-lg font-semibold">{t("git.title")}</h1>
          {/* Repo Selector */}
          <RepoSelector
            repos={repos}
            selectedRepoId={selectedRepoId}
            onSelectRepo={setSelectedRepoId}
            onAddRepo={() => setShowAddDialog(true)}
          />
        </div>
        <div className="flex items-center gap-3">
          {selectedRepo && status && (
            <>
              <BranchSelector
                repoPath={selectedRepo.path}
                currentBranch={status.branch}
                onBranchChange={() => fetchStatus(selectedRepo.path)}
              />
              <RemoteActionsPanel
                repoPath={selectedRepo.path}
                repoName={selectedRepo.name}
                ahead={status.ahead}
                behind={status.behind}
                hasRemote={status.hasRemotes ?? !!status.tracking}
                onRefresh={handleRefresh}
              />
              {/* Settings button */}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowSettingsDialog(true)}
                title={t("git.gitSettings")}
              >
                <HugeiconsIcon icon={Settings02Icon} className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Main Content - Full Width */}
      <div className="flex min-h-0 flex-1">
        {/* Left Panel - Changes/History */}
        <div className="flex min-w-0 flex-1 flex-col border-r border-border/50">
          {/* Tab Buttons */}
          {selectedRepo && (
            <div className="flex items-center gap-1 border-b border-border/50 px-3 py-2">
              <Button
                variant={activeTab === "changes" ? "secondary" : "ghost"}
                size="sm"
                className="gap-1.5"
                onClick={() => setActiveTab("changes")}
              >
                <HugeiconsIcon icon={FileEditIcon} className="h-4 w-4" />
                <span>{t("git.changes")}</span>
                {(status?.files.length ?? 0) > 0 && (
                  <span className="rounded bg-yellow-500/20 px-1.5 text-[10px] font-medium text-yellow-600">
                    {status?.files.length}
                  </span>
                )}
              </Button>
              <Button
                variant={activeTab === "history" ? "secondary" : "ghost"}
                size="sm"
                className="gap-1.5"
                onClick={() => setActiveTab("history")}
              >
                <HugeiconsIcon icon={Clock01Icon} className="h-4 w-4" />
                <span>{t("git.history")}</span>
              </Button>
            </div>
          )}

          {/* Content */}
          <div className="flex-1 overflow-auto">
            {loadingRepos ? (
              <div className="flex items-center justify-center p-8 text-muted-foreground">
                {t("common.loading")}
              </div>
            ) : isLoading ? (
              <div className="flex items-center justify-center p-8 text-muted-foreground">
                {t("common.loading")}
              </div>
            ) : activeTab === "history" && selectedRepo ? (
              <CommitHistory
                repoPath={selectedRepo.path}
                selectedCommitHash={selectedCommit?.hash}
                onSelectCommit={handleSelectCommit}
              />
            ) : status && selectedRepo ? (
              <ChangesSection
                status={status}
                repoPath={selectedRepo.path}
                selectedFile={selectedFile}
                onSelectFile={setSelectedFile}
                onStage={handleStage}
                onUnstage={handleUnstage}
                onDiscard={handleDiscard}
                onRefresh={handleRefresh}
              />
            ) : selectedRepo ? (
              <div className="flex items-center justify-center p-8 text-muted-foreground">
                {t("git.noChanges")}
              </div>
            ) : currentProjectPath ? (
              // Current project has no repo registered
              <div className="flex flex-col items-center justify-center p-8 text-muted-foreground gap-4">
                <div>{t("git.noRepos")}</div>
                <p className="text-sm text-center">{t("git.addRepoForProject")}</p>
                <Button onClick={() => setShowAddDialog(true)} className="gap-2">
                  {t("git.addRepository")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center p-8 text-muted-foreground gap-4">
                <div>{t("git.noRepos")}</div>
                <Button onClick={() => setShowAddDialog(true)} className="gap-2">
                  {t("git.addRepository")}
                </Button>
              </div>
            )}
          </div>

          {/* Commit Panel - Only show in changes tab */}
          {activeTab === "changes" && status && !status.clean && selectedRepo && (
            <CommitPanel
              message={commitMessage}
              onChangeMessage={setCommitMessage}
              onCommit={handleCommit}
              isCommitting={isCommitting}
              stagedCount={status.files.filter(f => f.staged).length}
              repoPath={selectedRepo.path}
            />
          )}
        </div>

        {/* Right Panel - Diff Viewer / Commit Detail */}
        <div className="flex min-w-0 flex-1 flex-col">
          {activeTab === "changes" && selectedFile && diff ? (
            <DiffViewer diff={diff} />
          ) : activeTab === "changes" ? (
            <div className="flex items-center justify-center p-8 text-muted-foreground">
              {t("git.selectFileToView")}
            </div>
          ) : activeTab === "history" && selectedCommit ? (
            <CommitDetail
              commit={selectedCommit}
              diff={commitDiff}
              isLoading={loadingCommitDiff}
              onBack={() => setSelectedCommit(null)}
            />
          ) : (
            <div className="flex items-center justify-center p-8 text-muted-foreground">
              {t("git.selectCommitToView")}
            </div>
          )}
        </div>
      </div>

      {/* Add Repo Dialog */}
      <AddRepoDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        currentProjectPath={currentProjectPath}
        onSuccess={(newRepoId?: string) => {
          fetchRepos();
          // Select the newly added repo
          if (newRepoId) {
            setSelectedRepoId(newRepoId);
          }
        }}
      />

      {/* Git Settings Dialog */}
      <GitSettingsDialog
        open={showSettingsDialog}
        onOpenChange={setShowSettingsDialog}
      />
    </div>
  );
}
