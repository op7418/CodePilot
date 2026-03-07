"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Loading02Icon,
  GlobeIcon,
  FolderOpenIcon,
  CheckmarkCircle02Icon,
  GithubIcon,
  Search01Icon,
  StarIcon,
  ForkIcon,
  Logout03Icon,
  Link01Icon,
  Copy01Icon,
  AddCircleIcon,
} from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import type { GitHubRepo } from "@/types/github";

type AddMode = "init" | "link" | "local" | "clone" | "github";

interface GitHubUser {
  login: string;
  name: string | null;
  avatar_url: string;
}

interface AddRepoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (newRepoId?: string) => void;
  /** Current project path - used for init/link modes */
  currentProjectPath?: string;
}

export function AddRepoDialog({ open, onOpenChange, onSuccess, currentProjectPath }: AddRepoDialogProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<AddMode>("github");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  // Local path state
  const [localPath, setLocalPath] = useState("");

  // Clone state
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneTargetDir, setCloneTargetDir] = useState("");
  const [cloneBranch, setCloneBranch] = useState("");
  const [cloneDepth, setCloneDepth] = useState("");

  // GitHub state
  const [githubUser, setGithubUser] = useState<GitHubUser | null>(null);
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([]);
  const [githubLoading, setGithubLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [showCloneConfirm, setShowCloneConfirm] = useState(false);
  const [githubTargetDir, setGithubTargetDir] = useState("");
  const [githubBranch, setGithubBranch] = useState("");
  const [githubDepth, setGithubDepth] = useState("");

  // Link remote state
  const [linkRemoteUrl, setLinkRemoteUrl] = useState("");
  const [linkBranch, setLinkBranch] = useState("");

  // Set default mode based on currentProjectPath
  useEffect(() => {
    if (open && currentProjectPath) {
      // When we have a project path, default to init mode
      setMode("init");
    } else if (open) {
      setMode("github");
    }
  }, [open, currentProjectPath]);

  // Check GitHub auth status on mount
  useEffect(() => {
    if (open) {
      checkGitHubAuth();
    }
  }, [open]);

  const checkGitHubAuth = async () => {
    try {
      const res = await fetch("/api/github/user");
      const data = await res.json();
      if (data.authenticated && data.user) {
        setGithubUser(data.user);
        if (mode === "github") {
          fetchGitHubRepos();
        }
      } else {
        setGithubUser(null);
        setGithubRepos([]);
      }
    } catch {
      setGithubUser(null);
    }
  };

  const fetchGitHubRepos = useCallback(async (search?: string) => {
    setGithubLoading(true);
    try {
      const url = search
        ? `/api/github/repos?search=${encodeURIComponent(search)}`
        : "/api/github/repos";
      const res = await fetch(url);
      const data = await res.json();
      if (res.ok) {
        setGithubRepos(data.repos || []);
      } else if (res.status === 401) {
        setGithubUser(null);
        setGithubRepos([]);
      }
    } catch (err) {
      console.error("Failed to fetch repos:", err);
    } finally {
      setGithubLoading(false);
    }
  }, []);

  const handleGitHubLogin = () => {
    // Check if GitHub token is configured
    // If not, show error message directing user to settings
    setError(t("git.githubNotConfigured"));
  };

  const handleGitHubLogout = async () => {
    try {
      await fetch("/api/github/user", { method: "DELETE" });
      setGithubUser(null);
      setGithubRepos([]);
      setSelectedRepo(null);
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (query.length >= 2) {
      fetchGitHubRepos(query);
    } else if (query.length === 0) {
      fetchGitHubRepos();
    }
  };

  // Select a GitHub repo to clone - show confirmation dialog
  const handleSelectGitHubRepo = (repo: GitHubRepo) => {
    setSelectedRepo(repo);
    setShowCloneConfirm(true);
    setError("");
    // Reset clone options
    setGithubTargetDir("");
    setGithubBranch("");
    setGithubDepth("");
  };

  // Actually clone the selected GitHub repo
  const handleConfirmCloneGitHubRepo = async () => {
    if (!selectedRepo) return;
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/git/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: selectedRepo.clone_url,
          targetDir: githubTargetDir.trim() || undefined,
          branch: githubBranch.trim() || undefined,
          depth: githubDepth ? parseInt(githubDepth, 10) : undefined,
          addAsRepo: true,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || t("git.cloneFailed"));
      }

      setSuccess(true);
      setTimeout(() => {
        resetState();
        onOpenChange(false);
        onSuccess?.(data.repo?.id);
      }, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("git.cloneFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleCancelCloneConfirm = () => {
    setShowCloneConfirm(false);
    setSelectedRepo(null);
    setGithubTargetDir("");
    setGithubBranch("");
    setGithubDepth("");
    setError("");
  };

  const resetState = () => {
    setLocalPath("");
    setCloneUrl("");
    setCloneTargetDir("");
    setCloneBranch("");
    setCloneDepth("");
    setError("");
    setSuccess(false);
    setSelectedRepo(null);
    setSearchQuery("");
    setShowCloneConfirm(false);
    setGithubTargetDir("");
    setGithubBranch("");
    setGithubDepth("");
    setLinkRemoteUrl("");
    setLinkBranch("");
  };

  const handleAddLocal = async () => {
    if (!localPath.trim()) {
      setError(t("git.pathRequired"));
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/git/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: localPath.trim() }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || t("git.addRepoFailed"));
      }

      setSuccess(true);
      setTimeout(() => {
        resetState();
        onOpenChange(false);
        onSuccess?.(data.repo?.id);
      }, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("git.addRepoFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleClone = async () => {
    if (!cloneUrl.trim()) {
      setError(t("git.urlRequired"));
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/git/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: cloneUrl.trim(),
          targetDir: cloneTargetDir.trim() || undefined,
          branch: cloneBranch.trim() || undefined,
          depth: cloneDepth ? parseInt(cloneDepth, 10) : undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || t("git.cloneFailed"));
      }

      setSuccess(true);
      setTimeout(() => {
        resetState();
        onOpenChange(false);
        onSuccess?.(data.repo?.id);
      }, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("git.cloneFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleInit = async () => {
    if (!currentProjectPath) {
      setError(t("git.pathRequired"));
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/git/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directory: currentProjectPath,
          addAsRepo: true,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || t("git.initFailed"));
      }

      setSuccess(true);
      setTimeout(() => {
        resetState();
        onOpenChange(false);
        onSuccess?.(data.repo?.id);
      }, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("git.initFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleLink = async () => {
    if (!currentProjectPath) {
      setError(t("git.pathRequired"));
      return;
    }

    if (!linkRemoteUrl.trim()) {
      setError(t("git.urlRequired"));
      return;
    }

    setLoading(true);
    setError("");

    try {
      // First, try to add the remote (this will fail if not a git repo)
      const remoteRes = await fetch("/api/git/remote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: currentProjectPath,
          name: "origin",
          url: linkRemoteUrl.trim(),
        }),
      });

      const remoteData = await remoteRes.json();

      // If remote add failed, might need to init first
      if (!remoteRes.ok) {
        // Try to initialize git repo first
        const initRes = await fetch("/api/git/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directory: currentProjectPath,
            addAsRepo: false,
          }),
        });

        if (!initRes.ok) {
          const initData = await initRes.json();
          throw new Error(initData.error || t("git.initFailed"));
        }

        // Now try adding remote again
        const retryRemoteRes = await fetch("/api/git/remote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: currentProjectPath,
            name: "origin",
            url: linkRemoteUrl.trim(),
          }),
        });

        if (!retryRemoteRes.ok) {
          const retryData = await retryRemoteRes.json();
          throw new Error(retryData.error || t("git.linkFailed"));
        }
      }

      // Add to managed repos
      const repoRes = await fetch("/api/git/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: currentProjectPath }),
      });

      const repoData = await repoRes.json();
      if (!repoRes.ok) {
        throw new Error(repoData.error || t("git.addRepoFailed"));
      }

      // Fetch from remote
      try {
        await fetch("/api/git/fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: currentProjectPath }),
        });
      } catch {
        // Ignore fetch errors
      }

      setSuccess(true);
      setTimeout(() => {
        resetState();
        onOpenChange(false);
        onSuccess?.(repoData.repo?.id);
      }, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("git.linkFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "local") {
      handleAddLocal();
    } else if (mode === "clone") {
      handleClone();
    } else if (mode === "init") {
      handleInit();
    } else if (mode === "link") {
      handleLink();
    }
  };

  const handleClose = (open: boolean) => {
    if (!open) {
      resetState();
    }
    onOpenChange(open);
  };

  // Format number with K suffix
  const formatNumber = (num: number): string => {
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + "K";
    }
    return String(num);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("git.addRepository")}</DialogTitle>
          <DialogDescription>
            {t("git.addRepositoryDesc")}
          </DialogDescription>
        </DialogHeader>

        {/* Current project path indicator */}
        {currentProjectPath && (
          <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
            <span className="text-muted-foreground">{t("git.currentProject")}: </span>
            <span className="font-mono text-xs">{currentProjectPath}</span>
          </div>
        )}

        {/* Mode Tabs */}
        <div className="flex gap-1 rounded-lg bg-muted p-1 overflow-x-auto">
          {currentProjectPath ? (
            // When we have a project path, show init/link/local options
            <>
              <button
                type="button"
                onClick={() => { setMode("init"); setError(""); }}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
                  mode === "init"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <HugeiconsIcon icon={AddCircleIcon} className="h-4 w-4" />
                {t("git.initRepo")}
              </button>
              <button
                type="button"
                onClick={() => { setMode("link"); setError(""); }}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
                  mode === "link"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <HugeiconsIcon icon={Link01Icon} className="h-4 w-4" />
                {t("git.linkRemote")}
              </button>
              <button
                type="button"
                onClick={() => { setMode("local"); setError(""); }}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
                  mode === "local"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <HugeiconsIcon icon={FolderOpenIcon} className="h-4 w-4" />
                {t("git.localRepo")}
              </button>
            </>
          ) : (
            // Default tabs when no project path
            <>
              <button
                type="button"
                onClick={() => { setMode("github"); setError(""); }}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
                  mode === "github"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <HugeiconsIcon icon={GithubIcon} className="h-4 w-4" />
                {t("git.githubRepos")}
              </button>
              <button
                type="button"
                onClick={() => { setMode("local"); setError(""); }}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
                  mode === "local"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <HugeiconsIcon icon={FolderOpenIcon} className="h-4 w-4" />
                {t("git.localRepo")}
              </button>
              <button
                type="button"
                onClick={() => { setMode("clone"); setError(""); }}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
                  mode === "clone"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <HugeiconsIcon icon={GlobeIcon} className="h-4 w-4" />
                {t("git.cloneRepo")}
              </button>
            </>
          )}
        </div>

        {mode === "github" ? (
          // GitHub repos mode
          <div className="flex-1 overflow-hidden flex flex-col gap-4">
            {/* User info / Login */}
            {githubUser ? (
              <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
                <div className="flex items-center gap-2">
                  <img
                    src={githubUser.avatar_url}
                    alt={githubUser.login}
                    className="h-6 w-6 rounded-full"
                  />
                  <span className="text-sm font-medium">{githubUser.name || githubUser.login}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleGitHubLogout}
                  className="h-7"
                >
                  <HugeiconsIcon icon={Logout03Icon} className="h-4 w-4 mr-1" />
                  {t("common.logout")}
                </Button>
              </div>
            ) : (
              // Not logged in - show setup hint
              <div className="flex flex-col items-center gap-3 py-8">
                <p className="text-sm text-muted-foreground">{t("git.githubLoginHint")}</p>
                <Button onClick={() => window.location.href = "/settings"}>
                  <HugeiconsIcon icon={GithubIcon} className="h-4 w-4 mr-2" />
                  {t("git.loginWithGithub")}
                </Button>
                <p className="text-xs text-muted-foreground">{t("git.githubNotConfigured")}</p>
              </div>
            )}

            {/* Search and repo list */}
            {githubUser && (
              <>
                {showCloneConfirm && selectedRepo ? (
                  // Clone confirmation panel
                  <div className="flex-1 flex flex-col gap-4">
                    {/* Selected repo info */}
                    <div className="rounded-md bg-muted/50 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <HugeiconsIcon icon={GithubIcon} className="h-4 w-4" />
                        <span className="font-medium">{selectedRepo.full_name}</span>
                        {selectedRepo.private && (
                          <span className="rounded bg-yellow-500/20 px-1 text-[10px] font-medium text-yellow-600">
                            {t("git.private")}
                          </span>
                        )}
                      </div>
                      {selectedRepo.description && (
                        <p className="text-xs text-muted-foreground mt-1 truncate">
                          {selectedRepo.description}
                        </p>
                      )}
                    </div>

                    {/* Clone options */}
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="githubTargetDir">{t("git.targetDirectory")}</Label>
                        <Input
                          id="githubTargetDir"
                          value={githubTargetDir}
                          onChange={(e) => setGithubTargetDir(e.target.value)}
                          placeholder={t("git.targetDirectoryPlaceholder")}
                          disabled={loading || success}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t("git.targetDirectoryHint")}
                        </p>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="githubBranch">{t("git.branch")}</Label>
                          <Input
                            id="githubBranch"
                            value={githubBranch}
                            onChange={(e) => setGithubBranch(e.target.value)}
                            placeholder={t("git.branchPlaceholder")}
                            disabled={loading || success}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="githubDepth">{t("git.depth")}</Label>
                          <Input
                            id="githubDepth"
                            type="number"
                            min={1}
                            value={githubDepth}
                            onChange={(e) => setGithubDepth(e.target.value)}
                            placeholder={t("git.depthPlaceholder")}
                            disabled={loading || success}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex justify-end gap-2 mt-auto">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleCancelCloneConfirm}
                        disabled={loading}
                      >
                        {t("common.cancel")}
                      </Button>
                      <Button
                        onClick={handleConfirmCloneGitHubRepo}
                        disabled={loading || success}
                      >
                        {loading ? (
                          <>
                            <HugeiconsIcon icon={Loading02Icon} className="mr-2 h-4 w-4 animate-spin" />
                            {t("git.cloning")}
                          </>
                        ) : (
                          t("git.cloneRepoBtn")
                        )}
                      </Button>
                    </div>
                  </div>
                ) : (
                  // Repo list
                  <>
                    <div className="relative">
                      <HugeiconsIcon
                        icon={Search01Icon}
                        className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                      />
                      <Input
                        value={searchQuery}
                        onChange={(e) => handleSearch(e.target.value)}
                        placeholder={t("git.searchRepos")}
                        className="pl-9"
                      />
                    </div>

                    {/* Repo list */}
                    <div className="flex-1 overflow-auto border rounded-md">
                  {githubLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <HugeiconsIcon icon={Loading02Icon} className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : githubRepos.length === 0 ? (
                    <div className="py-8 text-center text-sm text-muted-foreground">
                      {t("git.noReposFound")}
                    </div>
                  ) : (
                    <div className="divide-y">
                      {githubRepos.map((repo) => (
                        <button
                          key={repo.id}
                          onClick={() => handleSelectGitHubRepo(repo)}
                          disabled={loading && selectedRepo?.id === repo.id}
                          className={cn(
                            "flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors hover:bg-muted/50",
                            (loading && selectedRepo?.id === repo.id) && "opacity-50"
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{repo.full_name}</span>
                            {repo.private && (
                              <span className="rounded bg-yellow-500/20 px-1 text-[10px] font-medium text-yellow-600">
                                {t("git.private")}
                              </span>
                            )}
                            {repo.fork && (
                              <span className="rounded bg-blue-500/20 px-1 text-[10px] font-medium text-blue-600">
                                fork
                              </span>
                            )}
                            {loading && selectedRepo?.id === repo.id && (
                              <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin ml-auto" />
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            {repo.language && (
                              <span className="flex items-center gap-1">
                                <span className="h-2 w-2 rounded-full bg-blue-500" />
                                {repo.language}
                              </span>
                            )}
                            <span className="flex items-center gap-1">
                              <HugeiconsIcon icon={StarIcon} className="h-3 w-3" />
                              {formatNumber(repo.stargazers_count)}
                            </span>
                            <span className="flex items-center gap-1">
                              <HugeiconsIcon icon={ForkIcon} className="h-3 w-3" />
                              {formatNumber(repo.forks_count)}
                            </span>
                            {repo.description && (
                              <span className="truncate flex-1 text-right">{repo.description}</span>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                  </>
                )}
              </>
            )}
          </div>
        ) : (
          // Local, Clone, Init, Link modes
          <form onSubmit={handleSubmit} className="space-y-4 flex-1 overflow-auto">
            {mode === "init" ? (
              // Init mode - initialize git in current project
              <div className="space-y-4">
                <div className="rounded-md bg-muted/50 px-3 py-3 text-sm">
                  <p className="text-muted-foreground mb-2">{t("git.initDesc")}</p>
                  <p className="font-mono text-xs bg-background/50 rounded px-2 py-1">{currentProjectPath}</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("git.initHint")}
                </p>
              </div>
            ) : mode === "link" ? (
              // Link mode - link current project to remote
              <div className="space-y-4">
                <div className="rounded-md bg-muted/50 px-3 py-3 text-sm">
                  <p className="text-muted-foreground mb-2">{t("git.linkDesc")}</p>
                  <p className="font-mono text-xs bg-background/50 rounded px-2 py-1">{currentProjectPath}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="linkRemoteUrl">{t("git.remoteUrl")}</Label>
                  <Input
                    id="linkRemoteUrl"
                    value={linkRemoteUrl}
                    onChange={(e) => setLinkRemoteUrl(e.target.value)}
                    placeholder="https://github.com/user/repo.git"
                    disabled={loading || success}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="linkBranch">{t("git.branch")}</Label>
                  <Input
                    id="linkBranch"
                    value={linkBranch}
                    onChange={(e) => setLinkBranch(e.target.value)}
                    placeholder="main"
                    disabled={loading || success}
                  />
                </div>
              </div>
            ) : mode === "local" ? (
              <div className="space-y-2">
                <Label htmlFor="localPath">{t("git.repoPath")}</Label>
                <Input
                  id="localPath"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  placeholder={t("git.repoPathPlaceholder")}
                  disabled={loading || success}
                />
                <p className="text-xs text-muted-foreground">
                  {t("git.repoPathHint")}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="cloneUrl">{t("git.repoUrl")}</Label>
                  <Input
                    id="cloneUrl"
                    value={cloneUrl}
                    onChange={(e) => setCloneUrl(e.target.value)}
                    placeholder="https://github.com/user/repo.git"
                    disabled={loading || success}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="cloneTargetDir">{t("git.targetDirectory")}</Label>
                  <Input
                    id="cloneTargetDir"
                    value={cloneTargetDir}
                    onChange={(e) => setCloneTargetDir(e.target.value)}
                    placeholder={t("git.targetDirectoryPlaceholder")}
                    disabled={loading || success}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("git.targetDirectoryHint")}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="cloneBranch">{t("git.branch")}</Label>
                    <Input
                      id="cloneBranch"
                      value={cloneBranch}
                      onChange={(e) => setCloneBranch(e.target.value)}
                      placeholder={t("git.branchPlaceholder")}
                      disabled={loading || success}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="cloneDepth">{t("git.depth")}</Label>
                    <Input
                      id="cloneDepth"
                      type="number"
                      min={1}
                      value={cloneDepth}
                      onChange={(e) => setCloneDepth(e.target.value)}
                      placeholder={t("git.depthPlaceholder")}
                      disabled={loading || success}
                    />
                  </div>
                </div>
              </div>
            )}
          </form>
        )}

        {/* Error message */}
        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Success indicator */}
        {success && (
          <div className="flex items-center gap-2 rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-600 dark:text-green-400">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} className="h-4 w-4" />
            {t("git.repoAddedSuccess")}
          </div>
        )}

        {/* Footer for non-github modes */}
        {mode !== "github" && (
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleClose(false)}
              disabled={loading}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={
                mode === "local" ? handleAddLocal :
                mode === "clone" ? handleClone :
                mode === "init" ? handleInit :
                handleLink
              }
              disabled={loading || success}
            >
              {loading ? (
                <>
                  <HugeiconsIcon icon={Loading02Icon} className="mr-2 h-4 w-4 animate-spin" />
                  {mode === "local" ? t("git.adding") :
                   mode === "clone" ? t("git.cloning") :
                   mode === "init" ? t("git.initializing") :
                   t("git.linking")}
                </>
              ) : (
                mode === "local" ? t("git.addRepo") :
                mode === "clone" ? t("git.cloneRepoBtn") :
                mode === "init" ? t("git.initRepoBtn") :
                t("git.linkRemoteBtn")
              )}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
