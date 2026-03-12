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

import { useTranslation } from "@/hooks/useTranslation";
import { InstallWizard } from "@/components/layout/InstallWizard";

interface ClaudeStatus {
  connected: boolean;
  version: string | null;
}

const BASE_INTERVAL = 30_000; // 30s
const BACKED_OFF_INTERVAL = 60_000; // 60s after 3 consecutive stable results
const STABLE_THRESHOLD = 3;

export function ConnectionStatus() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);

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
    checkStatus(); // eslint-disable-line react-hooks/set-state-in-effect -- setState is called asynchronously after fetch
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [checkStatus]);

  const handleManualRefresh = useCallback(() => {
    stableCountRef.current = 0;
    checkStatus();
  }, [checkStatus]);

  // Auto-prompt install wizard on first disconnect detection (Electron only)
  useEffect(() => {
    if (
      status !== null &&
      !status.connected &&
      isElectron &&
      !autoPromptedRef.current &&
      !dialogOpen &&
      !wizardOpen
    ) {
      const dismissed = localStorage.getItem("codepilot:install-wizard-dismissed");
      if (!dismissed) {
        autoPromptedRef.current = true;
        setWizardOpen(true); // eslint-disable-line react-hooks/set-state-in-effect -- intentional: auto-prompt on first disconnect
      }
    }
  }, [status, isElectron, dialogOpen, wizardOpen]);

  const handleWizardOpenChange = useCallback((open: boolean) => {
    setWizardOpen(open);
    if (!open) {
      // Remember that user dismissed the wizard so we don't auto-prompt again
      localStorage.setItem("codepilot:install-wizard-dismissed", "1");
    }
  }, []);

  const connected = status?.connected ?? false;

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
              ? "bg-status-success-muted text-status-success-foreground"
              : "bg-status-error-muted text-status-error-foreground"
        )}
      >
        <span
          className={cn(
            "block h-1.5 w-1.5 shrink-0 rounded-full",
            status === null
              ? "bg-muted-foreground/40"
              : connected
                ? "bg-status-success"
                : "bg-status-error"
          )}
        />
        {status === null
          ? t('connection.checking')
          : connected
            ? t('connection.connected')
            : t('connection.disconnected')}
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {connected ? t('connection.installed') : t('connection.notInstalled')}
            </DialogTitle>
            <DialogDescription>
              {connected
                ? `Claude Code CLI v${status?.version} is running and ready.`
                : "Claude Code CLI is required to use this application."}
            </DialogDescription>
          </DialogHeader>

          {connected ? (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-3 rounded-lg bg-status-success-muted px-4 py-3">
                <span className="block h-2.5 w-2.5 shrink-0 rounded-full bg-status-success" />
                <div>
                  <p className="font-medium text-status-success-foreground">Active</p>
                  <p className="text-xs text-muted-foreground">{t('connection.version', { version: status?.version ?? '' })}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="flex items-center gap-3 rounded-lg bg-status-error-muted px-4 py-3">
                <span className="block h-2.5 w-2.5 shrink-0 rounded-full bg-status-error" />
                <p className="font-medium text-status-error-foreground">Not detected</p>
              </div>

              <div>
                <h4 className="font-medium mb-1.5">1. {t('connection.installClaude')}</h4>
                <code className="block rounded-md bg-muted px-3 py-2 text-xs">
                  npm install -g @anthropic-ai/claude-code
                </code>
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
                <div className="pt-2 border-t">
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
        onInstallComplete={handleManualRefresh}
      />
    </>
  );
}
