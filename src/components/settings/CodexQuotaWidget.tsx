"use client";

/**
 * Codex Account quota widget — Phase 5 Phase 6 IA correction (2026-05-14).
 *
 * Renders the rate-limit snapshot from /api/codex/rate-limits inside the
 * Providers' virtual Codex Account card. Codex's `account/rateLimits/read`
 * gives `usedPercent + resetsAt` per window (no absolute remaining tokens),
 * so the widget text must read "已用 X%" / "rolls over in Y", never
 * "remaining N tokens" — the latter doesn't exist upstream.
 *
 * Layout:
 *   ┌─────────────────────────────────┐
 *   │  使用配额                       │
 *   │  5 小时窗口        已用 1%     │
 *   │  ▓░░░░░░░░░░░░░░  4 小时后重置  │
 *   │  7 天窗口          已用 7%     │
 *   │  ▓░░░░░░░░░░░░░░  6 天后重置    │
 *   │  余额: $0.42  (only if credits present) │
 *   └─────────────────────────────────┘
 */

import type { CodexRateLimitSnapshot, CodexRateLimitWindow } from "@/lib/codex/types";
import { cn } from "@/lib/utils";
import { Warning } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";

type TranslateFn = (key: TranslationKey, params?: Record<string, string | number>) => string;

function formatWindowLabel(mins: number | undefined, t: TranslateFn): string {
  if (!mins || mins <= 0) return t("provider.codexQuota.window");
  if (mins < 120) return t("provider.codexQuota.windowMin", { n: mins });
  if (mins < 60 * 24) {
    const hrs = Math.round(mins / 60);
    return t("provider.codexQuota.windowHour", { n: hrs });
  }
  const days = Math.round(mins / 60 / 24);
  return t("provider.codexQuota.windowDay", { n: days });
}

function formatResetsAt(epochSec: number | undefined, t: TranslateFn): string {
  if (!epochSec) return "";
  const nowMs = Date.now();
  const diffMs = epochSec * 1000 - nowMs;
  if (diffMs <= 0) return t("provider.codexQuota.rolledOver");
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return t("provider.codexQuota.resetsInMin", { n: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return t("provider.codexQuota.resetsInHour", { n: hrs });
  const days = Math.round(hrs / 24);
  return t("provider.codexQuota.resetsInDay", { n: days });
}

function tone(usedPercent: number): { bar: string; pct: string } {
  // 0-60: success, 60-85: warning, 85+: error
  if (usedPercent >= 85) {
    return {
      bar: "bg-status-error-foreground",
      pct: "text-status-error-foreground",
    };
  }
  if (usedPercent >= 60) {
    return {
      bar: "bg-status-warning-foreground",
      pct: "text-status-warning-foreground",
    };
  }
  return {
    bar: "bg-status-success-foreground",
    pct: "text-status-success-foreground",
  };
}

function WindowRow({ label, window, t }: { label: string; window: CodexRateLimitWindow; t: TranslateFn }) {
  const pct = Math.max(0, Math.min(100, window.usedPercent));
  const barTone = tone(pct);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("font-mono font-medium", barTone.pct)}>
          {t("provider.codexQuota.usedPercent", { pct: pct.toFixed(0) })}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={cn("h-full transition-all", barTone.bar)} style={{ width: `${pct}%` }} />
      </div>
      {window.resetsAt && (
        <div className="text-[10px] text-muted-foreground">
          {formatResetsAt(window.resetsAt, t)}
        </div>
      )}
    </div>
  );
}

interface CodexQuotaWidgetProps {
  snapshot: CodexRateLimitSnapshot;
  isZh?: boolean;
}

export function CodexQuotaWidget({ snapshot }: CodexQuotaWidgetProps) {
  const { t } = useTranslation();
  const hasPrimary = !!snapshot.primary;
  const hasSecondary = !!snapshot.secondary;
  const hasCredits = !!snapshot.credits;
  const isRateLimited = !!snapshot.rateLimitReachedType;
  if (!hasPrimary && !hasSecondary && !hasCredits && !isRateLimited) return null;
  return (
    <div className="rounded-md bg-muted/30 px-3.5 py-3 flex flex-col gap-3 mt-2">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
        {t("provider.codexQuota.title")}
      </div>
      {snapshot.primary && (
        <WindowRow
          label={formatWindowLabel(snapshot.primary.windowDurationMins, t)}
          window={snapshot.primary}
          t={t}
        />
      )}
      {snapshot.secondary && (
        <WindowRow
          label={formatWindowLabel(snapshot.secondary.windowDurationMins, t)}
          window={snapshot.secondary}
          t={t}
        />
      )}
      {snapshot.credits && (snapshot.credits.unlimited || (snapshot.credits.hasCredits && snapshot.credits.balance)) && (
        <div className="flex items-center justify-between text-[11px] pt-1 border-t border-border/40">
          <span className="text-muted-foreground">{t("provider.codexQuota.balance")}</span>
          <span className="font-mono">
            {snapshot.credits.unlimited
              ? t("provider.codexQuota.unlimited")
              : snapshot.credits.balance ?? "—"}
          </span>
        </div>
      )}
      {isRateLimited && (
        <div className="flex items-start gap-1.5 text-[11px] text-status-warning-foreground">
          <Warning size={12} weight="fill" className="shrink-0 mt-0.5" />
          <span>
            {t("provider.codexQuota.rateLimitReached")}
            <span className="font-mono">{snapshot.rateLimitReachedType}</span>
          </span>
        </div>
      )}
    </div>
  );
}
