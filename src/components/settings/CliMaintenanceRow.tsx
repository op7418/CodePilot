"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  ArrowClockwise,
  ArrowsClockwise,
  CheckCircle,
  SpinnerGap,
  XCircle,
} from "@/components/ui/icon";
import { cliMaintenanceErrorCopy } from "@/hooks/useCliMaintenance";
import { useTranslation } from "@/hooks/useTranslation";
import type { CliMaintenanceSnapshot } from "@/lib/cli-maintenance-contract";

const CHANNEL_LABELS: Record<CliMaintenanceSnapshot["installChannel"], string> = {
  native: "Native",
  standalone: "Standalone",
  desktop_bundle: "Desktop App",
  homebrew: "Homebrew",
  npm: "npm",
  bun: "bun",
  pnpm: "pnpm",
  winget: "WinGet",
  unknown: "Unknown",
};

interface CliMaintenanceRowProps {
  snapshot: CliMaintenanceSnapshot;
  supported: boolean;
  missingAction?: ReactNode;
  onCheck: () => void;
  onUpdate: () => void;
  onCancel: () => void;
}

export function CliMaintenanceRow({
  snapshot,
  supported,
  missingAction,
  onCheck,
  onUpdate,
  onCancel,
}: CliMaintenanceRowProps) {
  const { locale, t } = useTranslation();
  const busy = snapshot.phase === "checking" || snapshot.phase === "queued" || snapshot.phase === "running";
  const running = snapshot.phase === "queued" || snapshot.phase === "running";
  const shouldOfferUpdate = snapshot.canOneClickUpdate && (
    snapshot.updateAvailability === "update_available"
    || snapshot.updateAvailability === "managed_auto"
    || snapshot.updateAvailability === "manual_check"
  );
  const errorCopy = cliMaintenanceErrorCopy(snapshot.errorCode, t);
  const channel = CHANNEL_LABELS[snapshot.installChannel];
  const checkedLabel = snapshot.checkedAt
    ? new Date(snapshot.checkedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div className="rounded-md bg-muted/40 px-3.5 divide-y divide-border/50">
      <div className="py-2.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="block text-[11px] text-muted-foreground">
            {t("cliMaintenance.settings.sectionLabel")}
          </span>
          {snapshot.installed && (
            <span className="block text-[10px] text-muted-foreground mt-0.5">
              {channel}
              {snapshot.latestVersion
                ? ` · ${t("cliMaintenance.settings.verifiedLatest")} v${snapshot.latestVersion}`
                : snapshot.installChannel === "desktop_bundle"
                  ? ` · ${t("cliMaintenance.settings.managedByDesktopApp")}`
                  : snapshot.updateAvailability === "managed_auto"
                    ? ` · ${t("cliMaintenance.settings.managedAuto")}`
                    : snapshot.updateAvailability === "manual_check"
                      ? ` · ${t("cliMaintenance.settings.sameChannelRequired")}`
                      : ""}
            </span>
          )}
          {snapshot.compatibility === "below_minimum" && snapshot.minimumVersion && (
            <span className="block text-[10px] text-status-warning-foreground mt-0.5">
              {t("cliMaintenance.settings.belowMinimum", { version: snapshot.minimumVersion })}
            </span>
          )}
          {checkedLabel && (
            <span className="block text-[10px] text-muted-foreground mt-0.5">
              {t("cliMaintenance.settings.checked", { date: checkedLabel })}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {snapshot.installed ? (
            <>
              <CheckCircle size={14} className="text-status-success-foreground" />
              <span className="text-xs text-muted-foreground font-mono">
                {snapshot.currentVersion ? `v${snapshot.currentVersion}` : t("cliMaintenance.settings.unknownVersion")}
              </span>
              {running ? (
                <Button variant="outline" size="sm" className="h-6 text-xs" onClick={onCancel}>
                  {t("cliMaintenance.settings.cancel")}
                </Button>
              ) : shouldOfferUpdate ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-xs gap-1"
                  onClick={onUpdate}
                  disabled={!supported || busy}
                >
                  {busy ? <SpinnerGap size={12} className="animate-spin" /> : <ArrowsClockwise size={12} />}
                  {t("cliMaintenance.settings.update")}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={onCheck}
                  disabled={!supported || busy}
                  aria-label={t("cliMaintenance.settings.checkAria")}
                >
                  {busy ? <SpinnerGap size={12} className="animate-spin" /> : <ArrowClockwise size={12} />}
                </Button>
              )}
            </>
          ) : (
            <>
              <XCircle size={14} className="text-status-error-foreground" />
              <span className="text-xs text-muted-foreground">{t("cliMaintenance.settings.notInstalled")}</span>
              {missingAction}
            </>
          )}
        </div>
      </div>

      {(errorCopy || snapshot.phase === "succeeded") && (
        <div
          className={snapshot.phase === "succeeded"
            ? "py-2 text-[11px] text-status-success-foreground"
            : "py-2 text-[11px] text-status-warning-foreground"}
          role="status"
        >
          {snapshot.phase === "succeeded"
            ? t("cliMaintenance.settings.success")
            : errorCopy}
        </div>
      )}
    </div>
  );
}
