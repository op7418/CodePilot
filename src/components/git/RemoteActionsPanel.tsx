"use client";

import { useState, useEffect } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Upload03Icon,
  Download03Icon,
  RefreshIcon,
  Link01Icon,
  Loading02Icon,
  GithubIcon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useTranslation } from "@/hooks/useTranslation";

interface GitHubUser {
  login: string;
  name: string | null;
  avatar_url: string | null;
}

interface RemoteActionsPanelProps {
  repoPath: string;
  repoName?: string;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  onRefresh: () => void;
}

export function RemoteActionsPanel({
  repoPath,
  repoName,
  ahead,
  behind,
  hasRemote,
  onRefresh,
}: RemoteActionsPanelProps) {
  const { t } = useTranslation();
  const [isPushing, setIsPushing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isFetching, setIsFetching] = useState(false);

  // Publish to GitHub state
  const [showPublish, setShowPublish] = useState(false);
  const [githubUser, setGithubUser] = useState<GitHubUser | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoDesc, setNewRepoDesc] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check GitHub auth on mount
  useEffect(() => {
    checkGitHubAuth();
  }, []);

  // Set default repo name from repoPath
  useEffect(() => {
    if (repoPath) {
      const name = repoName || repoPath.split("/").pop() || "my-repo";
      setNewRepoName(name);
    }
  }, [repoPath, repoName]);

  const checkGitHubAuth = async () => {
    setIsCheckingAuth(true);
    try {
      const res = await fetch("/api/github/user");
      const data = await res.json();
      if (data.authenticated && data.user) {
        setGithubUser(data.user);
      } else {
        setGithubUser(null);
      }
    } catch {
      setGithubUser(null);
    } finally {
      setIsCheckingAuth(false);
    }
  };

  const handlePush = async () => {
    setIsPushing(true);
    try {
      const res = await fetch("/api/git/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: repoPath, setUpstream: true }),
      });
      const data = await res.json();
      console.log("Push result:", data);
      onRefresh();
    } catch (error) {
      console.error("Failed to push:", error);
    } finally {
      setIsPushing(false);
    }
  };

  const handlePull = async () => {
    setIsPulling(true);
    try {
      const res = await fetch("/api/git/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: repoPath }),
      });
      const data = await res.json();
      console.log("Pull result:", data);
      onRefresh();
    } catch (error) {
      console.error("Failed to pull:", error);
    } finally {
      setIsPulling(false);
    }
  };

  const handleFetch = async () => {
    setIsFetching(true);
    try {
      const res = await fetch("/api/git/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: repoPath }),
      });
      const data = await res.json();
      console.log("Fetch result:", data);
      onRefresh();
    } catch (error) {
      console.error("Failed to fetch:", error);
    } finally {
      setIsFetching(false);
    }
  };

  const handlePublishToGitHub = async () => {
    if (!newRepoName.trim()) {
      setError(t("git.newRepoName"));
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      // 1. Create repo on GitHub
      const createRes = await fetch("/api/github/create-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newRepoName,
          description: newRepoDesc,
          isPrivate,
        }),
      });
      const createData = await createRes.json();

      if (!createData.success) {
        setError(createData.error || t("git.createRepoFailed"));
        setIsCreating(false);
        return;
      }

      // 2. Add remote
      const remoteUrl = createData.repo.clone_url;
      const addRemoteRes = await fetch("/api/git/remote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: repoPath,
          name: "origin",
          url: remoteUrl,
        }),
      });
      const addRemoteData = await addRemoteRes.json();

      if (!addRemoteData.success) {
        setError(addRemoteData.error || t("git.addRemoteFailed"));
        setIsCreating(false);
        return;
      }

      // 3. Push to remote
      const pushRes = await fetch("/api/git/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: repoPath,
          remote: "origin",
          setUpstream: true,
        }),
      });
      const pushData = await pushRes.json();

      setShowPublish(false);
      onRefresh();
    } catch (err) {
      console.error("Failed to publish:", err);
      setError(t("git.publishFailed"));
    } finally {
      setIsCreating(false);
    }
  };

  const handleLoginGitHub = () => {
    // Navigate to GitHub settings
    window.location.href = "/settings?tab=git";
  };

  // No remote: show "Publish" button
  if (!hasRemote) {
    return (
      <>
        <Dialog open={showPublish} onOpenChange={setShowPublish}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1">
              <HugeiconsIcon icon={GithubIcon} className="h-3.5 w-3.5" />
              <span>{t("git.publish")}</span>
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>{t("git.publishToGithub")}</DialogTitle>
              <DialogDescription>
                {t("git.publishToGithubDesc")}
              </DialogDescription>
            </DialogHeader>

            {isCheckingAuth ? (
              <div className="flex items-center justify-center py-8">
                <HugeiconsIcon icon={Loading02Icon} className="h-6 w-6 animate-spin" />
              </div>
            ) : !githubUser ? (
              <div className="py-6 text-center space-y-4">
                <p className="text-sm text-muted-foreground">
                  {t("git.loginToPublish")}
                </p>
                <Button onClick={handleLoginGitHub} className="gap-2">
                  <HugeiconsIcon icon={GithubIcon} className="h-4 w-4" />
                  {t("git.loginWithGithub")}
                </Button>
              </div>
            ) : (
              <div className="space-y-4 py-4">
                {/* User info */}
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  {githubUser.avatar_url && (
                    <img
                      src={githubUser.avatar_url}
                      alt={githubUser.login}
                      className="h-5 w-5 rounded-full"
                    />
                  )}
                  <span>@{githubUser.login}</span>
                </div>

                {/* Repo name */}
                <div className="space-y-2">
                  <Label htmlFor="repo-name">{t("git.newRepoName")}</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      {githubUser.login}/
                    </span>
                    <Input
                      id="repo-name"
                      value={newRepoName}
                      onChange={(e) => setNewRepoName(e.target.value)}
                      placeholder="my-awesome-project"
                      className="flex-1"
                    />
                  </div>
                </div>

                {/* Description */}
                <div className="space-y-2">
                  <Label htmlFor="repo-desc">{t("git.repoDesc")}</Label>
                  <Textarea
                    id="repo-desc"
                    value={newRepoDesc}
                    onChange={(e) => setNewRepoDesc(e.target.value)}
                    placeholder={t("git.repoDescPlaceholder")}
                    rows={2}
                  />
                </div>

                {/* Private toggle */}
                <div className="flex items-center justify-between">
                  <div>
                    <Label>{t("git.visibility")}</Label>
                    <p className="text-xs text-muted-foreground">
                      {isPrivate ? t("git.privateHint") : t("git.publicHint")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs">{t("git.visibilityPublic")}</span>
                    <Switch
                      checked={isPrivate}
                      onCheckedChange={setIsPrivate}
                    />
                    <span className="text-xs">{t("git.visibilityPrivate")}</span>
                  </div>
                </div>

                {error && (
                  <div className="text-sm text-destructive">{error}</div>
                )}
              </div>
            )}

            {githubUser && !isCheckingAuth && (
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowPublish(false)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  onClick={handlePublishToGitHub}
                  disabled={isCreating || !newRepoName.trim()}
                >
                  {isCreating ? (
                    <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
                  ) : (
                    t("git.publishRepo")
                  )}
                </Button>
              </DialogFooter>
            )}
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // Has remote: show Push/Pull/Fetch buttons
  return (
    <div className="flex items-center gap-2">
      {/* Push */}
      <Button
        variant="outline"
        size="sm"
        onClick={handlePush}
        disabled={isPushing || ahead === 0}
        className="gap-1"
      >
        <HugeiconsIcon icon={Upload03Icon} className="h-3.5 w-3.5" />
        <span>Push</span>
        {ahead > 0 && (
          <span className="rounded bg-green-500/20 px-1 text-[10px] font-medium text-green-600">
            {ahead}
          </span>
        )}
      </Button>

      {/* Pull */}
      <Button
        variant="outline"
        size="sm"
        onClick={handlePull}
        disabled={isPulling || behind === 0}
        className="gap-1"
      >
        <HugeiconsIcon icon={Download03Icon} className="h-3.5 w-3.5" />
        <span>Pull</span>
        {behind > 0 && (
          <span className="rounded bg-blue-500/20 px-1 text-[10px] font-medium text-blue-600">
            {behind}
          </span>
        )}
      </Button>

      {/* Fetch */}
      <Button
        variant="ghost"
        size="icon"
        onClick={handleFetch}
        disabled={isFetching}
        title={t("git.fetch")}
      >
        <HugeiconsIcon icon={RefreshIcon} className="h-4 w-4" />
      </Button>
    </div>
  );
}
