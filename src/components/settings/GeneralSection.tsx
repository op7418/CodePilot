"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { ArrowClockwise, SpinnerGap } from "@/components/ui/icon";
import { useUpdate } from "@/hooks/useUpdate";
import { useTranslation } from "@/hooks/useTranslation";
import { useAccountInfo } from "@/hooks/useAccountInfo";
import { SUPPORTED_LOCALES, type Locale } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingsCard } from "@/components/patterns/SettingsCard";
import { FieldRow } from "@/components/patterns/FieldRow";
import { StatusBanner } from "@/components/patterns/StatusBanner";
import { AppearanceSection } from "./AppearanceSection";

function UpdateCard() {
  const { updateInfo, checking, checkForUpdates, downloadUpdate, quitAndInstall, setShowDialog } = useUpdate();
  const { t } = useTranslation();
  const currentVersion = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";

  const isDownloading = updateInfo?.isNativeUpdate && !updateInfo.readyToInstall
    && updateInfo.downloadProgress != null;

  return (
    <SettingsCard>
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
              <SpinnerGap size={14} className="animate-spin" />
            ) : (
              <ArrowClockwise size={14} />
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
                <span className={`h-2 w-2 rounded-full ${updateInfo.readyToInstall ? 'bg-status-success' : isDownloading ? 'bg-status-warning animate-pulse' : 'bg-primary'}`} />
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
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${Math.min(updateInfo.downloadProgress!, 100)}%` }}
                  />
                </div>
              )}
              {updateInfo.lastError && (
                <p className="text-xs text-status-error-foreground">
                  {updateInfo.lastError}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('settings.latestVersion')}</p>
          )}
        </div>
      )}
    </SettingsCard>
  );
}

export function GeneralSection() {
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [showSkipPermWarning, setShowSkipPermWarning] = useState(false);
  const [skipPermSaving, setSkipPermSaving] = useState(false);
  const [generativeUI, setGenerativeUI] = useState(true);
  const [generativeUISaving, setGenerativeUISaving] = useState(false);
  const [cliPath, setCliPath] = useState("");
  const [configDir, setConfigDir] = useState("");
  const [cliPathValidation, setCliPathValidation] = useState<{
    valid: boolean;
    resolved?: string;
  } | null>(null);
  const [configDirValidation, setConfigDirValidation] = useState<{
    valid: boolean;
    resolved?: string;
  } | null>(null);
  const [pathSaving, setPathSaving] = useState(false);
  const cliPathTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configDirTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { accountInfo } = useAccountInfo();
  const { t, locale, setLocale } = useTranslation();

  const fetchAppSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/app");
      if (res.ok) {
        const data = await res.json();
        const appSettings = data.settings || {};
        setSkipPermissions(appSettings.dangerously_skip_permissions === "true");
        // generative_ui_enabled defaults to true when not set
        setGenerativeUI(appSettings.generative_ui_enabled !== "false");
        if (appSettings.claude_cli_path) setCliPath(appSettings.claude_cli_path);
        if (appSettings.claude_config_dir) setConfigDir(appSettings.claude_config_dir);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchAppSettings();
  }, [fetchAppSettings]);

  const savePathSetting = async (key: string, value: string) => {
    setPathSaving(true);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { [key]: value } }),
      });
      const data = await res.json();
      if (res.ok) {
        if (key === 'claude_cli_path') {
          setCliPathValidation(value ? { valid: true } : null);
        } else {
          setConfigDirValidation(value ? { valid: true } : null);
        }
      } else {
        if (key === 'claude_cli_path') {
          setCliPathValidation({ valid: false, resolved: data.error });
        } else {
          setConfigDirValidation({ valid: false, resolved: data.error });
        }
      }
    } catch {
      // ignore
    } finally {
      setPathSaving(false);
    }
  };

  const handleCliPathChange = (value: string) => {
    setCliPath(value);
    setCliPathValidation(null);
    if (cliPathTimer.current) clearTimeout(cliPathTimer.current);
    cliPathTimer.current = setTimeout(() => savePathSetting('claude_cli_path', value), 800);
  };

  const handleConfigDirChange = (value: string) => {
    setConfigDir(value);
    setConfigDirValidation(null);
    if (configDirTimer.current) clearTimeout(configDirTimer.current);
    configDirTimer.current = setTimeout(() => savePathSetting('claude_config_dir', value), 800);
  };

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

  const handleGenerativeUIToggle = async (checked: boolean) => {
    setGenerativeUISaving(true);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { generative_ui_enabled: checked ? "" : "false" },
        }),
      });
      if (res.ok) {
        setGenerativeUI(checked);
      }
    } catch {
      // ignore
    } finally {
      setGenerativeUISaving(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <UpdateCard />

      {/* General settings card */}
      <SettingsCard className={skipPermissions ? "border-status-warning-border bg-status-warning-muted" : undefined}>
        {/* Auto-approve toggle */}
        <FieldRow
          label={t('settings.autoApproveTitle')}
          description={t('settings.autoApproveDesc')}
        >
          <Switch
            checked={skipPermissions}
            onCheckedChange={handleSkipPermToggle}
            disabled={skipPermSaving}
          />
        </FieldRow>
        {skipPermissions && (
          <StatusBanner variant="warning">
            <span className="h-2 w-2 shrink-0 rounded-full bg-status-warning inline-block mr-1" />
            {t('settings.autoApproveWarning')}
          </StatusBanner>
        )}

        {/* Generative UI toggle */}
        <FieldRow
          label={t('settings.generativeUITitle')}
          description={t('settings.generativeUIDesc')}
          separator
        >
          <Switch
            checked={generativeUI}
            onCheckedChange={handleGenerativeUIToggle}
            disabled={generativeUISaving}
          />
        </FieldRow>

        {/* Language picker */}
        <FieldRow
          label={t('settings.language')}
          description={t('settings.languageDesc')}
          separator
        >
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
        </FieldRow>

        {/* Setup Center */}
        <FieldRow
          label={t('setup.openSetupCenter')}
          description={t('setup.openSetupCenterDesc')}
          separator
        >
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={() => window.dispatchEvent(new CustomEvent('open-setup-center'))}
          >
            {t('setup.open')}
          </Button>
        </FieldRow>

        {/* Custom CLI path */}
        <FieldRow
          label={t('settings.cliPathTitle' as TranslationKey)}
          description={t('settings.cliPathDesc' as TranslationKey)}
          separator
        >
          <div className="w-full space-y-1">
            <Input
              value={cliPath}
              onChange={(e) => handleCliPathChange(e.target.value)}
              placeholder="e.g. ~/.claude-internal/local/claude"
              className="text-sm"
              disabled={pathSaving}
            />
            {cliPathValidation && (
              <p className={`text-xs ${cliPathValidation.valid ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {cliPathValidation.valid ? t('settings.pathValid' as TranslationKey) : cliPathValidation.resolved}
              </p>
            )}
          </div>
        </FieldRow>

        {/* Custom config directory */}
        <FieldRow
          label={t('settings.configDirTitle' as TranslationKey)}
          description={t('settings.configDirDesc' as TranslationKey)}
          separator
        >
          <div className="w-full space-y-1">
            <Input
              value={configDir}
              onChange={(e) => handleConfigDirChange(e.target.value)}
              placeholder="e.g. ~/.claude-internal"
              className="text-sm"
              disabled={pathSaving}
            />
            {configDirValidation && (
              <p className={`text-xs ${configDirValidation.valid ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {configDirValidation.valid ? t('settings.pathValid' as TranslationKey) : configDirValidation.resolved}
              </p>
            )}
          </div>
        </FieldRow>
      </SettingsCard>

      {/* Appearance */}
      <AppearanceSection />

      {/* Account info */}
      {accountInfo && (
        <SettingsCard title={t('settings.accountInfo' as TranslationKey)}>
          <div className="space-y-1">
            {accountInfo.email && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{t('settings.email' as TranslationKey)}:</span> {accountInfo.email}
              </p>
            )}
            {accountInfo.organization && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{t('settings.organization' as TranslationKey)}:</span> {accountInfo.organization}
              </p>
            )}
            {accountInfo.subscriptionType && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{t('settings.subscription' as TranslationKey)}:</span> {accountInfo.subscriptionType}
              </p>
            )}
          </div>
        </SettingsCard>
      )}

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
                <p className="font-medium text-status-warning-foreground">
                  {t('settings.autoApproveTrustWarning')}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => saveSkipPermissions(true)}
              className="bg-status-warning hover:bg-status-warning/80 text-white"
            >
              {t('settings.enableAutoApprove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
