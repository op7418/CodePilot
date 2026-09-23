"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Warning } from "@/components/ui/icon";

import { useTranslation } from "@/hooks/useTranslation";
import { cliMaintenanceErrorCopy, useCliMaintenance } from "@/hooks/useCliMaintenance";
import { InstallWizard } from "@/components/layout/InstallWizard";
import { useRouter } from "next/navigation";

interface ClaudeInstallInfo {
  path: string;
  version: string | null;
  type: "native" | "homebrew" | "npm" | "bun" | "unknown";
}

interface ClaudeStatus {
  connected: boolean;
  version: string | null;
  binaryPath?: string | null;
  installType?: string | null;
  otherInstalls?: ClaudeInstallInfo[];
  missingGit?: boolean;
  warnings?: string[];
}

const BASE_INTERVAL = 30_000; // 30s
const BACKED_OFF_INTERVAL = 60_000; // 60s after 3 consecutive stable results
const STABLE_THRESHOLD = 3;

/** Extract pure semver from strings like "2.1.90 (Claude Code)" → "2.1.90" */
function extractVersion(v: string): string {
  const match = v.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : v;
}

const INSTALL_TYPE_LABELS: Record<string, string> = {
  native: "Native",
  homebrew: "Homebrew",
  npm: "npm (deprecated)",
  bun: "bun",
  winget: "WinGet",
  unknown: "Unknown",
};

function getUninstallAdvice(type: string): string | null {
  switch (type) {
    case 'npm': return 'npm uninstall -g @anthropic-ai/claude-code';
    case 'bun': return 'bun remove -g @anthropic-ai/claude-code';
    case 'homebrew': return 'brew uninstall --cask claude-code';
    default: return null;
  }
}

export function ConnectionStatus() {
  const { t } = useTranslation();
  const router = useRouter();
  const {
    snapshots: cliMaintenanceSnapshots,
    supported: cliMaintenanceSupported,
    update: updateCliMaintenance,
    cancel: cancelCliMaintenance,
  } = useCliMaintenance();
  const claudeMaintenance = cliMaintenanceSnapshots.claude;
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [installingGit, setInstallingGit] = useState(false);
  const [gitInstallResult, setGitInstallResult] = useState<{ success: boolean; error?: string } | null>(null);

  const isElectron =
    typeof window !== "undefined" &&
    !!window.electronAPI?.install;
  const stableCountRef = useRef(0);
  const lastConnectedRef = useRef<boolean | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoPromptedRef = useRef(false);

  // Use a ref-based approach to avoid circular deps between check and schedule
  const checkRef = useRef<() => void>(() => {});

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const interval = stableCountRef.current >= STABLE_THRESHOLD
      ? BACKED_OFF_INTERVAL
      : BASE_INTERVAL;
    timerRef.current = setTimeout(() => checkRef.current(), interval);
  }, []);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/claude-status");
      if (res.ok) {
        const data: ClaudeStatus = await res.json();
        if (lastConnectedRef.current === data.connected) {
          stableCountRef.current++;
        } else {
          stableCountRef.current = 0;
        }
        lastConnectedRef.current = data.connected;
        setStatus(data);
      }
    } catch {
      if (lastConnectedRef.current === false) {
        stableCountRef.current++;
      } else {
        stableCountRef.current = 0;
      }
      lastConnectedRef.current = false;
      setStatus({ connected: false, version: null });
    }
    schedule();
  }, [schedule]);

  useEffect(() => {
    checkRef.current = checkStatus;
  }, [checkStatus]);

  useEffect(() => {
    checkStatus();  
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [checkStatus]);

  const handleManualRefresh = useCallback(() => {
    stableCountRef.current = 0;
    checkStatus();
  }, [checkStatus]);

  // Invalidate server-side caches then refresh — called after install success
  const handleInstallComplete = useCallback(async () => {
    try {
      await fetch('/api/claude-status/invalidate', { method: 'POST' });
    } catch { /* best-effort */ }
    stableCountRef.current = 0;
    checkStatus();
  }, [checkStatus]);

  // Auto-prompt setup center on first disconnect detection (instead of install wizard)
  useEffect(() => {
    if (
      status !== null &&
      !status.connected &&
      !autoPromptedRef.current &&
      !dialogOpen
    ) {
      const dismissed = localStorage.getItem("codepilot:install-wizard-dismissed");
      if (!dismissed) {
        autoPromptedRef.current = true;
        window.dispatchEvent(new CustomEvent('open-setup-center', { detail: { initialCard: 'claude' } }));
        localStorage.setItem("codepilot:install-wizard-dismissed", "1");  
      }
    }
  }, [status, dialogOpen]);

  const handleWizardOpenChange = useCallback((open: boolean) => {
    setWizardOpen(open);
    if (!open) {
      // Remember that user dismissed the wizard so we don't auto-prompt again
      localStorage.setItem("codepilot:install-wizard-dismissed", "1");
    }
  }, []);

  const handleInstallGit = useCallback(async () => {
    if (!window.electronAPI?.install?.installGit) return;
    setInstallingGit(true);
    setGitInstallResult(null);
    try {
      const result = await window.electronAPI.install.installGit();
      setGitInstallResult(result);
      if (result.success) {
        // Refresh status to pick up newly installed Git
        try { await fetch('/api/claude-status/invalidate', { method: 'POST' }); } catch { /* best-effort */ }
        stableCountRef.current = 0;
        checkStatus();
      }
    } catch (err) {
      setGitInstallResult({ success: false, error: String(err) });
    } finally {
      setInstallingGit(false);
    }
  }, [checkStatus]);

  const handleUpgrade = useCallback(async () => {
    const result = await updateCliMaintenance('claude');
    if (result?.phase === 'succeeded' || result?.phase === 'unchanged') {
      try { await fetch('/api/claude-status/invalidate', { method: 'POST' }); } catch { /* best-effort */ }
      stableCountRef.current = 0;
      checkStatus();
    }
  }, [checkStatus, updateCliMaintenance]);

  const connected = status?.connected ?? false;
  const hasConflicts = (status?.otherInstalls?.length ?? 0) > 0;
  const missingGit = status?.missingGit ?? false;
  const updateAvailable = claudeMaintenance.updateAvailability === 'update_available';
  const manualUpdateChannel = claudeMaintenance.updateAvailability === 'manual_check'
    || claudeMaintenance.updateAvailability === 'managed_auto';
  const upgradeRunning = claudeMaintenance.phase === 'queued' || claudeMaintenance.phase === 'running';
  const showUpgrade = cliMaintenanceSupported && claudeMaintenance.installed && (
    updateAvailable
    || manualUpdateChannel
    || upgradeRunning
    || claudeMaintenance.phase === 'unchanged'
    || claudeMaintenance.phase === 'error'
  );
  const maintenanceMessage = cliMaintenanceErrorCopy(claudeMaintenance.errorCode, t);
  const maintenanceChannel = claudeMaintenance.installChannel === 'unknown'
    ? status?.installType ?? 'unknown'
    : claudeMaintenance.installChannel;
  const hasWarnings = hasConflicts || missingGit || updateAvailable;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setDialogOpen(true)}
        className={cn(
          "h-7 rounded-full px-2.5 text-[11px] font-medium gap-1.5",
          status === null
            ? "bg-muted text-muted-foreground"
            : connected
              ? missingGit
                ? "bg-status-error-muted text-status-error-foreground"
                : hasWarnings
                  ? "bg-status-warning-muted text-status-warning-foreground"
                  : "bg-status-success-muted text-status-success-foreground"
              : "bg-status-error-muted text-status-error-foreground"
        )}
      >
        <span
          className={cn(
            "block h-1.5 w-1.5 shrink-0 rounded-full",
            status === null
              ? "bg-muted-foreground/40"
              : connected
                ? missingGit
                  ? "bg-status-error"
                  : hasWarnings
                    ? "bg-status-warning"
                    : "bg-status-success"
                : "bg-status-error"
          )}
        />
        {status === null
          ? t('connection.checking')
          : connected
            ? missingGit
              ? t('connection.missingGit')
              : updateAvailable
                ? t('connection.updateAvailable')
                : hasConflicts
                  ? t('connection.conflict')
                  : t('connection.connected')
            : t('connection.disconnected')}
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {connected
                ? missingGit
                  ? t('connection.missingGitTitle')
                  : t('connection.installed')
                : t('connection.notInstalled')}
            </DialogTitle>
            <DialogDescription>
              {connected
                ? missingGit
                  ? t('connection.missingGitDesc')
                  : t('connection.readyDesc', { version: status?.version ?? '' })
                : t('connection.requiredDesc')}
            </DialogDescription>
          </DialogHeader>

          {connected ? (
            <div className="space-y-3 text-sm">
              <div className={cn(
                "flex items-center gap-3 rounded-lg px-4 py-3",
                updateAvailable ? "bg-status-warning-muted" : "bg-status-success-muted"
              )}>
                <span className={cn(
                  "block h-2.5 w-2.5 shrink-0 rounded-full",
                  updateAvailable ? "bg-status-warning" : "bg-status-success"
                )} />
                <div className="flex-1 min-w-0">
                  <p className={cn("font-medium", updateAvailable ? "text-status-warning-foreground" : "text-status-success-foreground")}>
                    {updateAvailable ? t('connection.updateAvailable') : t('connection.active')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {updateAvailable && claudeMaintenance.latestVersion
                      ? t('connection.versionCompare', {
                          current: extractVersion(claudeMaintenance.currentVersion ?? status?.version ?? ''),
                          latest: extractVersion(claudeMaintenance.latestVersion),
                        })
                      : t('connection.version', { version: claudeMaintenance.currentVersion ?? status?.version ?? '' })}
                    {` (${INSTALL_TYPE_LABELS[maintenanceChannel] || maintenanceChannel})`}
                  </p>
                  {status?.binaryPath && (
                    <p className="text-xs text-muted-foreground font-mono">{status.binaryPath}</p>
                  )}
                </div>
              </div>

              {/* Upgrade section — shown for npm/bun (confirmed update) or homebrew/winget (manual channel) */}
              {showUpgrade && (
                <div className="space-y-2">
                  {!updateAvailable && manualUpdateChannel && (
                    <p className="text-xs text-muted-foreground">
                      {t('connection.manualUpdateHint')}
                    </p>
                  )}
                  {maintenanceMessage && (
                    <div className="rounded-lg bg-status-warning-muted px-4 py-3 text-xs text-status-warning-foreground" role="status">
                      {maintenanceMessage}
                    </div>
                  )}
                  {upgradeRunning ? (
                    <Button
                      onClick={() => void cancelCliMaintenance('claude')}
                      className="w-full"
                      size="sm"
                      variant="outline"
                    >
                      {t('cliMaintenance.connection.cancelUpdate')}
                    </Button>
                  ) : claudeMaintenance.canOneClickUpdate ? (
                    <Button onClick={() => void handleUpgrade()} className="w-full" size="sm">
                      {t(updateAvailable ? 'connection.upgradeButton' : 'connection.checkUpgrade')}
                    </Button>
                  ) : (
                    <Button onClick={() => router.push('/settings/runtime')} className="w-full" size="sm" variant="outline">
                      {t('cliMaintenance.connection.reviewOptions')}
                    </Button>
                  )}
                </div>
              )}

              {/* Conflict warning */}
              {hasConflicts && (
                <div className="rounded-lg bg-status-warning-muted px-4 py-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Warning size={16} className="text-status-warning-foreground shrink-0" />
                    <p className="font-medium text-status-warning-foreground text-xs">
                      {t('connection.conflictWarning')}
                    </p>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-1">
                    {status?.otherInstalls?.map((inst, i) => {
                      const advice = getUninstallAdvice(inst.type);
                      return (
                        <div key={i} className="space-y-0.5">
                          <p>
                            <code className="bg-muted px-1 rounded">{inst.path}</code>
                            {" "}({INSTALL_TYPE_LABELS[inst.type]} {inst.version})
                          </p>
                          {advice && (
                            <p>{t('connection.conflictRemove')}: <code className="bg-muted px-1 rounded">{advice}</code></p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Git Bash missing — critical on Windows, causes exit code 1 */}
              {missingGit && (
                <div className="rounded-lg bg-status-error-muted px-4 py-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Warning size={16} className="text-status-error-foreground shrink-0" />
                    <p className="font-medium text-status-error-foreground text-xs">
                      {t('connection.missingGitTitle')}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('connection.missingGitDesc')}
                  </p>
                  {gitInstallResult ? (
                    <div className={cn(
                      "rounded-md px-3 py-2 text-xs",
                      gitInstallResult.success ? "bg-status-success-muted text-status-success-foreground" : "bg-muted text-muted-foreground"
                    )}>
                      <p className="font-medium">
                        {gitInstallResult.success ? t('connection.gitInstallSuccess') : t('connection.gitInstallFailed')}
                      </p>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      {isElectron && (
                        <Button
                          size="sm"
                          className="flex-1"
                          onClick={handleInstallGit}
                          disabled={installingGit}
                        >
                          {installingGit ? t('connection.gitInstalling') : t('connection.installGit')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className={isElectron ? "" : "flex-1"}
                        onClick={() => window.open('https://git-scm.com/downloads/win', '_blank')}
                      >
                        {t('connection.downloadGit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleManualRefresh}
                      >
                        {t('connection.recheck')}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="flex items-center gap-3 rounded-lg bg-status-error-muted px-4 py-3">
                <span className="block h-2.5 w-2.5 shrink-0 rounded-full bg-status-error" />
                <p className="font-medium text-status-error-foreground">{t('connection.notDetected')}</p>
              </div>

              <div>
                <h4 className="font-medium mb-1.5">1. {t('connection.installClaude')}</h4>
                {navigator.platform?.startsWith('Win') ? (
                  <code className="block rounded-md bg-muted px-3 py-2 text-xs">
                    irm https://claude.ai/install.ps1 | iex
                  </code>
                ) : (
                  <code className="block rounded-md bg-muted px-3 py-2 text-xs">
                    curl -fsSL https://claude.ai/install.sh | bash
                  </code>
                )}
              </div>

              <div>
                <h4 className="font-medium mb-1.5">2. Authenticate</h4>
                <code className="block rounded-md bg-muted px-3 py-2 text-xs">
                  claude login
                </code>
              </div>

              <div>
                <h4 className="font-medium mb-1.5">3. Verify Installation</h4>
                <code className="block rounded-md bg-muted px-3 py-2 text-xs">
                  claude --version
                </code>
              </div>

              {isElectron && (
                <div className="pt-3">
                  <Button
                    onClick={() => {
                      setDialogOpen(false);
                      setWizardOpen(true);
                    }}
                    className="w-full"
                  >
                    {t('connection.installAuto')}
                  </Button>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleManualRefresh}
            >
              {t('connection.refresh')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <InstallWizard
        open={wizardOpen}
        onOpenChange={handleWizardOpenChange}
        onInstallComplete={handleInstallComplete}
      />
    </>
  );
}
