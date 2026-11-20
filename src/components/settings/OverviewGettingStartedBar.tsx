"use client";

/**
 * Top-of-Overview onboarding checklist.
 *
 * Pure presentational. Each item carries its own jump action so the
 * user can pick whichever step they want, not a forced order. Pending
 * items get a dark CTA + warning-muted row tint; done items get a
 * green check + muted text + no CTA. The bar is mounted only when at
 * least one item is pending — see `OverviewSection` for the gate.
 */

import { Button } from "@/components/ui/button";
import { CheckCircle, Circle } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/i18n";

export interface ChecklistItem {
  id: string;
  label: string;
  desc: string;
  done: boolean;
  actionLabel: string;
  onAction: () => void;
}

export function OverviewGettingStartedBar({
  items,
  t,
}: {
  items: ChecklistItem[];
  isZh?: boolean;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}) {
  const total = items.length;
  const done = items.filter((i) => i.done).length;

  return (
    <div className="rounded-lg border border-border/50 bg-card overflow-hidden">
      {/* Header — title + N/M completed counter */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border/40">
        <h3 className="text-sm font-semibold">
          {t("overview.gettingStarted" as TranslationKey)}
        </h3>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {t("overview.completed" as TranslationKey, { done, total })}
        </span>
      </div>

      {/* Items — pending first (so the user sees what's left), then done */}
      <ul className="divide-y divide-border/40">
        {[...items].sort((a, b) => Number(a.done) - Number(b.done)).map((item) => (
          <li
            key={item.id}
            className={cn(
              "flex items-center gap-3 px-4 py-2.5",
              item.done ? "bg-transparent" : "bg-status-warning-muted/20",
            )}
          >
            <span className="shrink-0">
              {item.done ? (
                <CheckCircle
                  size={16}
                  weight="fill"
                  className="text-status-success-foreground"
                />
              ) : (
                <Circle size={16} className="text-muted-foreground" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-xs font-medium leading-tight",
                  item.done ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {item.label}
              </p>
              {!item.done && (
                <p className="text-sm text-muted-foreground mt-1.5">
                  {item.desc}
                </p>
              )}
            </div>
            {!item.done && (
              <Button
                size="sm"
                onClick={item.onAction}
                className="h-7 px-3 text-[11px] shrink-0"
              >
                {item.actionLabel}
              </Button>
            )}
          </li>
        ))}
      </ul>

      {/* Optional footer when all done — but the bar is hidden in that case */}
      {done === total && (
        <div className="px-4 py-2.5 text-[11px] text-status-success-foreground bg-status-success-muted/30">
          {t("overview.allSet")}
        </div>
      )}
    </div>
  );
}
