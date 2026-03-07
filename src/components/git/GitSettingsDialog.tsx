"use client";

import { useState, useEffect } from "react";
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
  FolderOpenIcon,
  CheckmarkCircle02Icon,
  Loading02Icon,
} from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";

interface GitSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GitSettingsDialog({ open, onOpenChange }: GitSettingsDialogProps) {
  const { t } = useTranslation();
  const [defaultCloneDir, setDefaultCloneDir] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [githubVerified, setGithubVerified] = useState(false);
  const [githubVerifying, setGithubVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  // Load settings on mount
  useEffect(() => {
    if (open) {
      loadSettings();
    }
  }, [open]);

  const loadSettings = async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        setDefaultCloneDir(data.settings?.defaultCloneDir || "");
        setGithubToken(data.settings?.githubToken || "");
        setGithubVerified(!!data.settings?.githubToken);
      }
    } catch {
      // ignore
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            defaultCloneDir: defaultCloneDir.trim() || undefined,
            githubToken: githubToken.trim() || undefined,
          },
        }),
      });
      if (res.ok) {
        setSuccess(true);
        setTimeout(() => {
          setSuccess(false);
          onOpenChange(false);
        }, 800);
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const verifyGithubToken = async () => {
    if (!githubToken) return;
    setGithubVerifying(true);
    try {
      const res = await fetch("/api/github/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: githubToken }),
      });
      if (res.ok) {
        const data = await res.json();
        setGithubVerified(data.success);
      } else {
        setGithubVerified(false);
      }
    } catch {
      setGithubVerified(false);
    } finally {
      setGithubVerifying(false);
    }
  };

  const handleBrowseFolder = async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const electronAPI = (window as any).electronAPI;
      if (electronAPI?.dialog?.openFolder) {
        const result = await electronAPI.dialog.openFolder({
          defaultPath: defaultCloneDir || undefined,
          title: t("git.selectCloneDir"),
        });
        if (!result.canceled && result.filePaths[0]) {
          setDefaultCloneDir(result.filePaths[0]);
        }
      }
    } catch {
      // ignore
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("git.gitSettings")}</DialogTitle>
          <DialogDescription>
            {t("git.gitSettingsDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Default Clone Directory */}
          <div className="space-y-2">
            <Label htmlFor="defaultCloneDir">{t("git.defaultCloneDir")}</Label>
            <div className="flex gap-2">
              <Input
                id="defaultCloneDir"
                value={defaultCloneDir}
                onChange={(e) => setDefaultCloneDir(e.target.value)}
                placeholder={t("git.defaultCloneDirPlaceholder")}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleBrowseFolder}
                title={t("git.browse")}
              >
                <HugeiconsIcon icon={FolderOpenIcon} className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("git.defaultCloneDirHint")}
            </p>
          </div>

          {/* GitHub Token */}
          <div className="space-y-2">
            <Label htmlFor="githubToken">{t("settings.githubToken")}</Label>
            <div className="flex gap-2">
              <Input
                id="githubToken"
                type="password"
                value={githubToken}
                onChange={(e) => {
                  setGithubToken(e.target.value);
                  setGithubVerified(false);
                }}
                placeholder={t("settings.githubTokenPlaceholder")}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={verifyGithubToken}
                disabled={!githubToken || githubVerifying}
              >
                {githubVerifying ? (
                  <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
                ) : githubVerified ? (
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} className="h-4 w-4 text-green-500" />
                ) : (
                  t("settings.githubVerify")
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settings.githubTokenHint")}
            </p>
          </div>
        </div>

        {/* Success message */}
        {success && (
          <div className="flex items-center gap-2 rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-600 dark:text-green-400">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} className="h-4 w-4" />
            {t("git.settingsSaved")}
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <HugeiconsIcon icon={Loading02Icon} className="mr-2 h-4 w-4 animate-spin" />
                {t("git.saving")}
              </>
            ) : (
              t("common.save")
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
