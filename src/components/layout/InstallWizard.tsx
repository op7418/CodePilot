"use client";

import { useEffect, useState, useRef, useCallback } from "react";
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
import {
  Check,
  X,
  Minus,
  SpinnerGap,
  Circle,
  Copy,
  DownloadSimple,
} from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";

interface InstallProgress {
  status: "idle" | "running" | "success" | "failed" | "cancelled";
  currentStep: string | null;
  steps: Array<{
    id: string;
    label: string;
    status: "pending" | "running" | "success" | "failed" | "skipped";
    error?: string;
  }>;
  logs: string[];
}

interface InstallWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstallComplete?: () => void;
}

type WizardPhase =
  | "checking"
  | "confirm"
  | "already-installed"
  | "installing"
  | "success"
  | "failed";

interface PrereqResult {
  hasNode: boolean;
  nodeVersion?: string;
  hasClaude: boolean;
  claudeVersion?: string;
  hasHomebrew?: boolean;
  platform?: string;
}

function getInstallAPI() {
  if (typeof window !== "undefined") {
    return window.electronAPI?.install;
  }
  return undefined;
}

function StepIcon({ status }: { status: string }) {
  switch (status) {
    case "success":
      return <Check size={16} className="text-status-success-foreground" />;
    case "running":
      return <SpinnerGap size={16} className="text-primary animate-spin" />;
    case "failed":
      return <X size={16} className="text-status-error-foreground" />;
    case "skipped":
      return <Minus size={16} className="text-muted-foreground" />;
    default:
      return <Circle size={14} className="text-muted-foreground/40" />;
  }
}

export function InstallWizard({
  open,
  onOpenChange,
  onInstallComplete,
}: InstallWizardProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<WizardPhase>("checking");
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [copiedBrew, setCopiedBrew] = useState(false);
  const [prereqs, setPrereqs] = useState<PrereqResult | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const scrollToBottom = useCallback(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [logs, scrollToBottom]);

  // Cancel backend install and clean up listener
  const cancelInstall = useCallback(async () => {
    const api = getInstallAPI();
    if (!api) return;
    try {
      await api.cancel();
    } catch {
      // ignore cancel errors
    }
  }, []);

  const startInstall = useCallback(async (options?: { includeNode?: boolean }) => {
    const api = getInstallAPI();
    if (!api) return;

    setPhase("installing");

    // Subscribe to progress updates
    if (cleanupRef.current) cleanupRef.current();
    cleanupRef.current = api.onProgress((p) => {
      setProgress(p);
      setLogs(p.logs);

      if (p.status === "success") {
        setPhase("success");
      } else if (p.status === "failed" || p.status === "cancelled") {
        setPhase("failed");
      }
    });

    try {
      await api.start(options);
    } catch (err: unknown) {
      setPhase("failed");
      const msg = err instanceof Error ? err.message : String(err);
      setLogs((prev) => [...prev, `Installation error: ${msg}`]);
    }
  }, []);

  const checkPrereqs = useCallback(async () => {
    const api = getInstallAPI();
    if (!api) return;

    setPhase("checking");
    setLogs(["Checking environment..."]);
    setProgress(null);
    setPrereqs(null);

    try {
      const result = await api.checkPrerequisites();
      setPrereqs(result);

      if (result.hasClaude) {
        setLogs((prev) => [
          ...prev,
          `Node.js ${result.nodeVersion} found.`,
          `Claude Code ${result.claudeVersion} already installed.`,
        ]);
        setPhase("already-installed");
        return;
      }

      // Don't auto-install — show confirmation first
      if (result.hasNode) {
        setLogs((prev) => [
          ...prev,
          `Node.js ${result.nodeVersion} found.`,
          "Claude Code CLI not detected.",
        ]);
      } else {
        setLogs((prev) => [
          ...prev,
          "Node.js not found.",
          "Claude Code CLI not detected.",
        ]);
      }
      setPhase("confirm");
    } catch (err: unknown) {
      setPhase("failed");
      const msg = err instanceof Error ? err.message : String(err);
      setLogs((prev) => [...prev, `Error checking prerequisites: ${msg}`]);
    }
  }, []);

  // User explicitly clicks "Install" — only then start the actual install
  const handleConfirmInstall = useCallback(() => {
    const needsNode = prereqs ? !prereqs.hasNode : false;
    startInstall({ includeNode: needsNode });
  }, [prereqs, startInstall]);

  const handleCopyLogs = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(logs.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  }, [logs]);

  const handleDone = useCallback(() => {
    onOpenChange(false);
    onInstallComplete?.();
  }, [onOpenChange, onInstallComplete]);

  // [P1] Close dialog = cancel running install
  const handleOpenChange = useCallback(
    async (nextOpen: boolean) => {
      if (!nextOpen && phase === "installing") {
        await cancelInstall();
      }
      onOpenChange(nextOpen);
    },
    [phase, cancelInstall, onOpenChange]
  );

  // Auto-check when dialog opens
  useEffect(() => {
    if (open) {
      setPhase("checking"); // eslint-disable-line react-hooks/set-state-in-effect -- reset state before async check
      setLogs([]);  
      setProgress(null);  
      setCopied(false);  
      setCopiedBrew(false);  
      setPrereqs(null);  
      checkPrereqs();
    }
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [open, checkPrereqs]);

  const steps = progress?.steps ?? [];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('install.title')}</DialogTitle>
          <DialogDescription>
            {phase === "confirm"
              ? "Claude Code CLI was not detected. Install it now?"
              : "Automatically install Claude Code CLI"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Step list (only during/after install) */}
          {steps.length > 0 && (
            <div className="space-y-2">
              {steps.map((step) => (
                <div
                  key={step.id}
                  className="flex items-center gap-2.5 text-sm"
                >
                  <StepIcon status={step.status} />
                  <span
                    className={cn(
                      step.status === "pending" && "text-muted-foreground",
                      step.status === "running" && "text-foreground font-medium",
                      step.status === "success" && "text-status-success-foreground",
                      step.status === "failed" && "text-status-error-foreground",
                      step.status === "skipped" && "text-muted-foreground"
                    )}
                  >
                    {step.label}
                  </span>
                  {step.error && (
                    <span className="text-xs text-status-error-foreground ml-auto truncate max-w-[200px]">
                      {step.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Phase: checking */}
          {phase === "checking" && steps.length === 0 && (
            <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <SpinnerGap size={16} className="animate-spin" />
              <span>{t('install.checkingPrereqs')}</span>
            </div>
          )}

          {/* Phase: confirm — ask user before installing */}
          {phase === "confirm" && prereqs && !prereqs.hasNode && !prereqs.hasHomebrew && prereqs.platform === "darwin" && (
            <div className="space-y-3">
              <div className="rounded-lg bg-status-warning-muted px-4 py-3 text-sm space-y-1.5">
                <p className="text-status-warning-foreground font-medium">
                  {t('install.homebrewRequired')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('install.homebrewDescription')}
                </p>
              </div>
              <div className="rounded-md bg-zinc-950 dark:bg-zinc-900 border border-zinc-800 px-3 py-2.5 flex items-center gap-2">
                <code className="flex-1 text-xs text-zinc-300 break-all select-all">
                  /bin/bash -c &quot;$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)&quot;
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 h-7 px-2"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
                      setCopiedBrew(true);
                      setTimeout(() => setCopiedBrew(false), 2000);
                    } catch { /* clipboard not available */ }
                  }}
                >
                  <Copy size={14} />
                  <span className="text-xs">{copiedBrew ? t('install.copied') : t('install.copy')}</span>
                </Button>
              </div>
              <div className="text-sm text-muted-foreground space-y-1">
                <p>{t('install.homebrewSteps')}</p>
                <ol className="list-decimal list-inside space-y-0.5 text-xs">
                  <li>{t('install.homebrewStep1')}</li>
                  <li>{t('install.homebrewStep2')}</li>
                  <li>{t('install.homebrewStep3')}</li>
                  <li>{t('install.homebrewStep4')}</li>
                </ol>
              </div>
            </div>
          )}
          {phase === "confirm" && !(prereqs && !prereqs.hasNode && !prereqs.hasHomebrew && prereqs.platform === "darwin") && (
            <div className="space-y-3">
              <div className="rounded-lg bg-status-warning-muted px-4 py-3 text-sm space-y-1.5">
                {prereqs && !prereqs.hasNode && (
                  <p className="text-status-warning-foreground">
                    Node.js — not found (will be installed via {prereqs.platform === "win32" ? "winget" : "Homebrew"})
                  </p>
                )}
                {prereqs?.hasNode && (
                  <p className="text-status-success-foreground">
                    Node.js {prereqs.nodeVersion} — found
                  </p>
                )}
                <p className="text-status-warning-foreground">
                  Claude Code CLI — not found
                </p>
              </div>
              <p className="text-sm text-muted-foreground">
                Click <strong>Install</strong> to automatically set up{" "}
                {prereqs && !prereqs.hasNode ? "Node.js and " : ""}Claude Code CLI.
              </p>
            </div>
          )}

          {/* Phase: already-installed */}
          {phase === "already-installed" && (
            <div className="flex items-center gap-3 rounded-lg bg-status-success-muted px-4 py-3">
              <Check size={20} className="text-status-success-foreground shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-status-success-foreground">
                  Already installed
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('install.alreadyInstalled')}
                </p>
              </div>
            </div>
          )}

          {/* Phase: success */}
          {phase === "success" && (
            <div className="flex items-center gap-3 rounded-lg bg-status-success-muted px-4 py-3">
              <Check size={20} className="text-status-success-foreground shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-status-success-foreground">
                  {t('install.complete')}
                </p>
                <p className="text-muted-foreground text-xs">
                  Claude Code CLI has been installed successfully.
                </p>
              </div>
            </div>
          )}

          {/* Log output */}
          {logs.length > 0 && (
            <div className="rounded-md bg-zinc-950 dark:bg-zinc-900 border border-zinc-800 max-h-48 overflow-y-auto">
              <div className="p-3 font-mono text-xs text-zinc-300 space-y-0.5">
                {logs.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all">
                    {line}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {logs.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyLogs}
            >
              <Copy size={16} />
              {copied ? t('install.copied') : t('install.copyLogs')}
            </Button>
          )}

          {/* Confirm phase: "Recheck" when Homebrew missing on macOS, otherwise "Install" */}
          {phase === "confirm" && prereqs && !prereqs.hasNode && !prereqs.hasHomebrew && prereqs.platform === "darwin" && (
            <Button size="sm" onClick={checkPrereqs}>
              {t('install.recheck')}
            </Button>
          )}
          {phase === "confirm" && !(prereqs && !prereqs.hasNode && !prereqs.hasHomebrew && prereqs.platform === "darwin") && (
            <Button size="sm" onClick={handleConfirmInstall}>
              <DownloadSimple size={16} />
              {t('install.install')}
            </Button>
          )}

          {/* Installing: cancel button */}
          {phase === "installing" && (
            <Button variant="destructive" size="sm" onClick={cancelInstall}>
              {t('install.cancel')}
            </Button>
          )}

          {/* Failed: retry */}
          {phase === "failed" && (
            <Button size="sm" onClick={checkPrereqs}>
              {t('install.retry')}
            </Button>
          )}

          {/* Success / already-installed: done */}
          {(phase === "success" || phase === "already-installed") && (
            <Button size="sm" onClick={handleDone}>
              {t('install.done')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
