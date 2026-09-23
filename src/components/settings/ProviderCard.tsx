"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DotsThree } from "@/components/ui/icon";
import { CodePilotIcon } from "@/components/ui/semantic-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { compatLabel, compatDotColor, compatTooltip } from "@/lib/runtime-compat";

/**
 * Provider Card v3 — compact pattern.
 *
 * Header carries name + status pill on the left, primary/edit/delete actions
 * inline on the right (no separate footer). Sub-info renders as a single
 * combined sub-card with divider lines between rows — same compact
 * info-card pattern used across provider cards.
 */

export type ProviderCardStatus =
  | "available"
  | "needs-config"
  | "error"
  | "unknown";

export interface ProviderCardInfoRow {
  label: string;
  value: string;
  /** Optional hover-tooltip on the value cell. Use when the value is a
   *  bucketed/relative form (e.g. "5 min ago") and the absolute form
   *  belongs in the tooltip ("2026-04-26 14:32:01 UTC"). */
  title?: string;
}

export interface ProviderCardData {
  icon: ReactNode;
  name: string;
  status: ProviderCardStatus;
  statusLabel?: string;
  /** Runtime compatibility — drives the secondary pill in the card header.
   *  Computed via `getProviderCompat` in `src/lib/runtime-compat.ts`. */
  compat?: import('@/types').ProviderRuntimeCompat;
  provider?: Pick<import('@/types').ApiProvider, 'base_url' | 'protocol'>;
  /** Rows shown as a single combined sub-card with `divide-y` between them.
   *  Skip entries with no real data — don't pad with "未检测". */
  info?: ProviderCardInfoRow[];
}

interface ProviderCardProps {
  data: ProviderCardData;
  isZh?: boolean;
  /** Inline action (e.g. Login button, Settings link). Sits left of edit/delete. */
  primaryAction?: ReactNode;
  /** Custom slot rendered below info rows (e.g. image-family sub-rows). */
  children?: ReactNode;

  /* Inline header actions (right side).
   *
   * Phase 1 Step 2 收敛 (2026-05-06): "Manage models" / "Refresh models"
   * inline actions removed per Codex's Models / Providers experience
   * spec — Provider cards are for connecting services, not managing
   * models. Model management lives on the Models page; refresh decisions
   * are made there too (and only shown for providers where
   * `canReliablyFetchModels` returns true). */
  onEdit?: () => void;
  onDelete?: () => void;

  /* Collapsed into kebab */
  onDiagnose?: () => void;
  onSyncToClaudeCode?: () => void;
}

const STATUS_TONE: Record<ProviderCardStatus, string> = {
  available: "bg-status-success-muted text-status-success-foreground",
  "needs-config": "bg-status-warning-muted text-status-warning-foreground",
  error: "bg-status-error-muted text-status-error-foreground",
  unknown: "bg-muted text-muted-foreground",
};

const STATUS_LABEL_ZH: Record<ProviderCardStatus, string> = {
  available: "可用",
  "needs-config": "需配置",
  error: "异常",
  unknown: "未诊断",
};

const STATUS_LABEL_EN: Record<ProviderCardStatus, string> = {
  available: "Available",
  "needs-config": "Needs config",
  error: "Error",
  unknown: "Not checked",
};

export function ProviderCard({
  data,
  isZh = false,
  primaryAction,
  children,
  onEdit,
  onDelete,
  onDiagnose,
  onSyncToClaudeCode,
}: ProviderCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  const statusLabel =
    data.statusLabel ?? (isZh ? STATUS_LABEL_ZH[data.status] : STATUS_LABEL_EN[data.status]);

  const hasKebabActions = !!(onDiagnose || onSyncToClaudeCode);

  return (
    <div className="rounded-lg bg-card border border-border/50 p-5 flex flex-col gap-4 h-full">
      {/* Header — icon + name + actions on row 1; status / compat pills move
          to row 2 so they own the full inner width and never have to wrap
          mid-character (the previous layout shared row 1 with actions, which
          squeezed long compat labels like "Claude Code 兼容" into a 2-line
          break that hard-cut the middle of the word). */}
      <div className="flex items-start gap-3">
        <div className="shrink-0 size-9 rounded-md bg-muted/60 flex items-center justify-center">
          {data.icon}
        </div>
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          {/* Row 1: name + inline actions on the same baseline */}
          <div className="flex items-center gap-2">
            <h3 className="flex-1 min-w-0 text-sm font-semibold truncate leading-tight">{data.name}</h3>
            <div className="shrink-0 flex items-center gap-1">
              {primaryAction}
              {onEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onEdit}
                  className="h-8 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  {isZh ? "编辑" : "Edit"}
                </Button>
              )}
              {onDelete && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onDelete}
                  className="h-8 px-2.5 text-xs text-muted-foreground hover:text-destructive"
                >
                  {isZh ? "断开" : "Disconnect"}
                </Button>
              )}
              {hasKebabActions && (
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={isZh ? '更多操作' : 'More actions'}
                      title={isZh ? '更多操作' : 'More actions'}
                    >
                      <DotsThree size={16} weight="bold" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[180px]">
                    {onDiagnose && (
                      <DropdownMenuItem onClick={onDiagnose}>
                        <CodePilotIcon name="diagnose" size="sm" aria-hidden />
                        <span>{isZh ? "诊断" : "Diagnose"}</span>
                      </DropdownMenuItem>
                    )}
                    {onSyncToClaudeCode && (
                      <DropdownMenuItem onClick={onSyncToClaudeCode}>
                        <span>{isZh ? "同步到 Claude Code" : "Sync to Claude Code"}</span>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
          {/* Row 2: status + compat pills — own the full inner width */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
              STATUS_TONE[data.status],
            )}>
              <span className={cn(
                "size-1.5 rounded-full",
                data.status === "available" && "bg-status-success-foreground",
                data.status === "needs-config" && "bg-status-warning-foreground",
                data.status === "error" && "bg-status-error-foreground",
                data.status === "unknown" && "bg-muted-foreground",
              )} />
              {statusLabel}
            </span>
            {/* Phase 1 Step 2 收敛 round 4 + 5 (2026-05-06): compat tag
                keeps the pill shape (rounded-full + padding + small
                font) but uses a neutral muted background — the compat
                tier is conveyed by a small colored dot inside the pill
                rather than a full colored fill. Status pill above
                follows the same pattern but stays on its colored bg
                because status (available / needs-config / error) is a
                stronger signal that earns the louder treatment. */}
            {data.compat && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground cursor-help whitespace-nowrap">
                    <span className={cn("size-1.5 rounded-full", compatDotColor(data.compat))} aria-hidden />
                    {compatLabel(data.compat, isZh, data.provider)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{compatTooltip(data.compat, isZh, data.provider)}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      {/* Combined info sub-card — inset dividers between rows */}
      {data.info && data.info.length > 0 && (
        <div className="rounded-md bg-muted/40">
          <div className="px-3.5 divide-y divide-border/50">
            {data.info.map((row) => (
              <div
                key={row.label}
                className="py-2.5 flex items-center justify-between gap-3"
              >
                <span className="text-[11px] text-muted-foreground shrink-0">{row.label}</span>
                <span
                  className="text-xs text-foreground/85 truncate text-right"
                  title={row.title}
                >
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Custom slot (e.g. image-family sub-rows). */}
      {children}
    </div>
  );
}
