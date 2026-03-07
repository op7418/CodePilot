"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { HugeiconsIcon } from "@hugeicons/react";
import { ReloadIcon, Loading02Icon, CheckmarkCircle02Icon, Link01Icon } from "@hugeicons/core-free-icons";
import { Input } from "@/components/ui/input";
import { useUpdate } from "@/hooks/useUpdate";
import { useTranslation } from "@/hooks/useTranslation";
import { SUPPORTED_LOCALES, type Locale } from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function UpdateCard() {
  const { updateInfo, checking, checkForUpdates, downloadUpdate, quitAndInstall, setShowDialog } = useUpdate();
  const { t } = useTranslation();
  const currentVersion = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";

  const isDownloading = updateInfo?.isNativeUpdate && !updateInfo.readyToInstall
    && updateInfo.downloadProgress != null;

  return (
    <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">{t('settings.codepilot')}</h2>
          <p className="text-xs text-muted-foreground">{t('settings.version', { version: currentVersion })}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Show install/restart button when update available */}
          {updateInfo?.updateAvailable && !checking && (
            updateInfo.readyToInstall ? (
              <Button size="sm" onClick={quitAndInstall}>
                {t('update.restartToUpdate')}
              </Button>
            ) : updateInfo.isNativeUpdate && !isDownloading ? (
              <Button size="sm" onClick={downloadUpdate}>
                {t('update.installUpdate')}
              </Button>
            ) : !updateInfo.isNativeUpdate ? (
              <Button size="sm" variant="outline" onClick={() => window.open(updateInfo.releaseUrl, "_blank")}>
                {t('settings.viewRelease')}
              </Button>
            ) : null
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={checkForUpdates}
            disabled={checking}
            className="gap-2"
          >
            {checking ? (
              <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <HugeiconsIcon icon={ReloadIcon} className="h-3.5 w-3.5" />
            )}
            {checking ? t('settings.checking') : t('settings.checkForUpdates')}
          </Button>
        </div>
      </div>

      {updateInfo && !checking && (
        <div className="mt-3">
          {updateInfo.updateAvailable ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${updateInfo.readyToInstall ? 'bg-green-500' : isDownloading ? 'bg-yellow-500 animate-pulse' : 'bg-blue-500'}`} />
                <span className="text-sm">
                  {updateInfo.readyToInstall
                    ? t('update.readyToInstall', { version: updateInfo.latestVersion })
                    : isDownloading
                      ? `${t('update.downloading')} ${Math.round(updateInfo.downloadProgress!)}%`
                      : t('settings.updateAvailable', { version: updateInfo.latestVersion })}
                </span>
                {updateInfo.releaseNotes && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs text-muted-foreground"
                    onClick={() => setShowDialog(true)}
                  >
                    {t('gallery.viewDetails')}
                  </Button>
                )}
              </div>
              {/* Download progress bar */}
              {isDownloading && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all"
                    style={{ width: `${Math.min(updateInfo.downloadProgress!, 100)}%` }}
                  />
                </div>
              )}
              {updateInfo.lastError && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  {updateInfo.lastError}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('settings.latestVersion')}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function GeneralSection() {
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [showSkipPermWarning, setShowSkipPermWarning] = useState(false);
  const [skipPermSaving, setSkipPermSaving] = useState(false);
  const [githubToken, setGithubToken] = useState("");
  const [githubSaving, setGithubSaving] = useState(false);
  const [githubVerifying, setGithubVerifying] = useState(false);
  const [githubVerified, setGithubVerified] = useState(false);
  const { t, locale, setLocale } = useTranslation();

  const fetchAppSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/app");
      if (res.ok) {
        const data = await res.json();
        const appSettings = data.settings || {};
        setSkipPermissions(appSettings.dangerously_skip_permissions === "true");
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchGithubSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        const token = data.settings?.githubToken || "";
        setGithubToken(token);
        // If token exists, mark as verified
        if (token) {
          setGithubVerified(true);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchAppSettings();
    fetchGithubSettings();
  }, [fetchAppSettings, fetchGithubSettings]);

  const handleSkipPermToggle = (checked: boolean) => {
    if (checked) {
      setShowSkipPermWarning(true);
    } else {
      saveSkipPermissions(false);
    }
  };

  const saveSkipPermissions = async (enabled: boolean) => {
    setSkipPermSaving(true);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { dangerously_skip_permissions: enabled ? "true" : "" },
        }),
      });
      if (res.ok) {
        setSkipPermissions(enabled);
      }
    } catch {
      // ignore
    } finally {
      setSkipPermSaving(false);
      setShowSkipPermWarning(false);
    }
  };

  const saveGithubToken = async (token: string) => {
    setGithubSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { githubToken: token },
        }),
      });
      if (res.ok) {
        setGithubToken(token);
        setGithubVerified(false); // Reset verified status when token changes
      }
    } catch {
      // ignore
    } finally {
      setGithubSaving(false);
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
      const data = await res.json();
      if (data.success) {
        setGithubVerified(true);
      } else {
        setGithubVerified(false);
      }
    } catch {
      setGithubVerified(false);
    } finally {
      setGithubVerifying(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <UpdateCard />

      {/* Auto-approve toggle */}
      <div className={`rounded-lg border p-4 transition-shadow hover:shadow-sm ${skipPermissions ? "border-orange-500/50 bg-orange-500/5" : "border-border/50"}`}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">{t('settings.autoApproveTitle')}</h2>
            <p className="text-xs text-muted-foreground">
              {t('settings.autoApproveDesc')}
            </p>
          </div>
          <Switch
            checked={skipPermissions}
            onCheckedChange={handleSkipPermToggle}
            disabled={skipPermSaving}
          />
        </div>
        {skipPermissions && (
          <div className="mt-3 flex items-center gap-2 rounded-md bg-orange-500/10 px-3 py-2 text-xs text-orange-600 dark:text-orange-400">
            <span className="h-2 w-2 shrink-0 rounded-full bg-orange-500" />
            {t('settings.autoApproveWarning')}
          </div>
        )}
      </div>

      {/* Language picker */}
      <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">{t('settings.language')}</h2>
            <p className="text-xs text-muted-foreground">{t('settings.languageDesc')}</p>
          </div>
          <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LOCALES.map((l) => (
                <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* GitHub Token */}
      <div className={`rounded-lg border p-4 transition-shadow hover:shadow-sm ${githubVerified ? "border-green-500/50 bg-green-500/5" : "border-border/50"}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium">{t('settings.github')}</h2>
              {githubVerified && (
                <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} className="h-3 w-3" />
                  {t('settings.githubConfigured')}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t('settings.githubTokenHint')}
            </p>
            <div className="flex items-center gap-2 mt-3">
              <Input
                value={githubToken}
                onChange={(e) => {
                  setGithubToken(e.target.value);
                  setGithubVerified(false);
                }}
                placeholder={t('settings.githubTokenPlaceholder')}
                disabled={githubSaving || githubVerifying}
                className="flex-1"
                type="password"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={verifyGithubToken}
                disabled={!githubToken || githubVerifying}
                className="shrink-0"
              >
                {githubVerifying ? (
                  <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t('settings.githubVerify') || 'Verify'
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open("https://github.com/settings/tokens/new?scopes=repo,read:user", "_blank")}
                className="shrink-0"
              >
                <HugeiconsIcon icon={Link01Icon} className="h-3.5 w-3.5 mr-1" />
                {t('settings.githubHowToSetup')}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Skip-permissions warning dialog */}
      <AlertDialog open={showSkipPermWarning} onOpenChange={setShowSkipPermWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.autoApproveDialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {t('settings.autoApproveDialogDesc')}
                </p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>{t('settings.autoApproveShellCommands')}</li>
                  <li>{t('settings.autoApproveFileOps')}</li>
                  <li>{t('settings.autoApproveNetwork')}</li>
                </ul>
                <p className="font-medium text-orange-600 dark:text-orange-400">
                  {t('settings.autoApproveTrustWarning')}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => saveSkipPermissions(true)}
              className="bg-orange-600 hover:bg-orange-700 text-white"
            >
              {t('settings.enableAutoApprove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
