"use client";

/**
 * Overview → Token usage heatmap.
 *
 * GitHub-contribution-style 7×N grid summarising daily token consumption
 * over the past 365 days. Reuses the existing `/api/usage/stats?days=365`
 * endpoint — no new backend.
 *
 * Layout: title + month-labelled grid + day-of-week axis + stats row +
 * jump-to-Usage link. The grid is fluid: cell width tracks the card's
 * available width via `aspect-ratio: cols / 7` + `1fr` columns, so the
 * heatmap fills whatever space the parent gives it (no fixed 12px cells,
 * no horizontal scroll).
 *
 * Bucket scaling is relative to the window's max non-zero day, so users
 * with low overall volume still see contrast (a "good day" lights up
 * even if it's only ~50K tokens).
 */

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { Button } from "@/components/ui/button";
import { CaretRight } from "@/components/ui/icon";
import { cn, getLocalDateString } from "@/lib/utils";
import type { TranslationKey } from "@/i18n";

interface DailyRow {
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost: number | null;
  cost_legacy?: boolean;
  cohort?: 'stable_owner' | 'handoff';
}

interface UsageStatsResponse {
  summary: {
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost: number | null;
    total_sessions: number;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
  };
  daily: DailyRow[];
}

/** Fixed 365-day window — the only sensible heatmap horizon. */
const WINDOW_DAYS = 365;

type GridCell = {
  col: number;
  row: number;
  date: Date;
  dateStr: string;
  tokens: number;
  inWindow: boolean;
};

function formatTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 0) return "-" + formatTokens(-n);
  if (n < 10_000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return (n / 1_000).toFixed(1) + "K";
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(2) + "M";
  return (n / 1_000_000_000).toFixed(2) + "B";
}

/**
 * Five-bucket scale relative to the window's max non-zero day. Returns
 * the Tailwind class for the cell. Bucket 0 is "no activity", buckets
 * 1–4 ramp up in opacity over `bg-status-success`.
 */
function bucketClass(tokens: number, max: number): string {
  if (tokens <= 0 || max <= 0) return "bg-muted/40";
  const ratio = tokens / max;
  if (ratio <= 0.25) return "bg-status-success/15";
  if (ratio <= 0.5) return "bg-status-success/35";
  if (ratio <= 0.75) return "bg-status-success/65";
  return "bg-status-success/95";
}

function localiseDate(d: Date, isZh: boolean): string {
  return d.toLocaleDateString(isZh ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Build the column-major grid for the chosen window. We pad the first
 * column to align with Sunday so each row is a consistent day-of-week.
 * Cells before windowStart or after today are kept in the grid but
 * marked `inWindow: false` so they render invisibly without disturbing
 * the layout.
 */
function buildGrid(days: number, dataByDate: Map<string, number>): {
  cells: GridCell[];
  cols: number;
} {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const windowStart = new Date(today);
  windowStart.setDate(windowStart.getDate() - (days - 1));

  const firstColStart = new Date(windowStart);
  firstColStart.setDate(firstColStart.getDate() - windowStart.getDay());

  const oneDayMs = 86_400_000;
  const totalDays =
    Math.round((today.getTime() - firstColStart.getTime()) / oneDayMs) + 1;
  const cols = Math.ceil(totalDays / 7);

  const cells: GridCell[] = [];
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < 7; row++) {
      const cellDate = new Date(firstColStart);
      cellDate.setDate(cellDate.getDate() + col * 7 + row);
      const inWindow = cellDate >= windowStart && cellDate <= today;
      const dateStr = getLocalDateString(cellDate);
      const tokens = dataByDate.get(dateStr) ?? 0;
      cells.push({ col, row, date: cellDate, dateStr, tokens, inWindow });
    }
  }
  return { cells, cols };
}

/**
 * Pick column indices where the month label should appear: the first
 * column whose first in-window cell starts a new month (or is column 0).
 *
 * Min-spacing filter: when two month labels would land in adjacent
 * columns (happens at the start of the window when it falls mid-week
 * straddling a month boundary), drop the earlier one — its label would
 * collide with the next month's text. We keep the later label because
 * it's closer to "today" and more useful as orientation.
 */
const MIN_MONTH_LABEL_SPACING = 3;

function buildMonthLabels(cells: GridCell[], cols: number, isZh: boolean): {
  col: number;
  label: string;
}[] {
  const candidates: { col: number; label: string }[] = [];
  let lastMonth = -1;
  for (let col = 0; col < cols; col++) {
    const firstInWindow = cells.find((c) => c.col === col && c.inWindow);
    if (!firstInWindow) continue;
    const m = firstInWindow.date.getMonth();
    if (m !== lastMonth) {
      candidates.push({
        col,
        label: firstInWindow.date.toLocaleDateString(
          isZh ? "zh-CN" : "en-US",
          { month: "short" },
        ),
      });
      lastMonth = m;
    }
  }

  const filtered: { col: number; label: string }[] = [];
  for (const cand of candidates) {
    while (
      filtered.length > 0 &&
      cand.col - filtered[filtered.length - 1].col < MIN_MONTH_LABEL_SPACING
    ) {
      filtered.pop();
    }
    filtered.push(cand);
  }
  return filtered;
}

interface DerivedStats {
  totalTokens: number;
  mostActiveDate: string | null;
  mostActiveTokens: number;
  currentStreak: number;
  longestStreak: number;
}

function deriveStats(daily: DailyRow[], days: number): DerivedStats {
  const byDate = new Map<string, number>();
  for (const row of daily) {
    const t = (row.input_tokens || 0) + (row.output_tokens || 0);
    byDate.set(row.date, (byDate.get(row.date) ?? 0) + t);
  }

  let totalTokens = 0;
  for (const t of byDate.values()) totalTokens += t;

  let mostActiveDate: string | null = null;
  let mostActiveTokens = 0;
  for (const [date, t] of byDate.entries()) {
    if (t > mostActiveTokens) {
      mostActiveDate = date;
      mostActiveTokens = t;
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let currentStreak = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const ds = getLocalDateString(d);
    if ((byDate.get(ds) ?? 0) > 0) currentStreak += 1;
    else break;
  }

  let longestStreak = 0;
  let running = 0;
  const windowStart = new Date(today);
  windowStart.setDate(windowStart.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const d = new Date(windowStart);
    d.setDate(d.getDate() + i);
    const ds = getLocalDateString(d);
    if ((byDate.get(ds) ?? 0) > 0) {
      running += 1;
      if (running > longestStreak) longestStreak = running;
    } else {
      running = 0;
    }
  }

  return { totalTokens, mostActiveDate, mostActiveTokens, currentStreak, longestStreak };
}

interface HeatmapProps {
  isZh: boolean;
  /** Optional — Overview page passes this to drive the bottom CTA. When the
   *  component is embedded in `/settings/usage` (which IS the details page),
   *  the host omits the handler and `hideViewDetails` is set to true. */
  onJumpToDetails?: () => void;
  /** When true, the bottom "View details →" link is hidden. */
  hideViewDetails?: boolean;
}

export function OverviewHeatmap({ isZh, onJumpToDetails, hideViewDetails = false }: HeatmapProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<UsageStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const fetchStats = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const res = await fetch(`/api/usage/stats?days=${WINDOW_DAYS}`, {
        signal: controller.signal,
      });
      if (res.ok) setData(await res.json());
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        // Silent fallback — Overview is a dashboard, not a detail page.
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // setState lands on a microtask after `await fetch()` — the
    // `react-hooks/set-state-in-effect` rule false-flags fetch-on-mount.
     
    fetchStats();
    return () => abortRef.current?.abort();
  }, [fetchStats]);

  const dataByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of data?.daily ?? []) {
      const t = (row.input_tokens || 0) + (row.output_tokens || 0);
      m.set(row.date, (m.get(row.date) ?? 0) + t);
    }
    return m;
  }, [data]);

  const maxDayTokens = useMemo(() => {
    let max = 0;
    for (const t of dataByDate.values()) if (t > max) max = t;
    return max;
  }, [dataByDate]);

  const { cells, cols } = useMemo(
    () => buildGrid(WINDOW_DAYS, dataByDate),
    [dataByDate],
  );
  const monthLabels = useMemo(
    () => buildMonthLabels(cells, cols, isZh),
    [cells, cols, isZh],
  );
  const stats = useMemo(() => deriveStats(data?.daily ?? [], WINDOW_DAYS), [data]);

  const empty = !loading && stats.totalTokens === 0;

  // Single accessible summary for the whole heatmap so screen readers don't
  // walk through 365 cells. Pairs with `role="img"` + `aria-hidden` on the
  // visual grid below.
  const heatmapAriaLabel = isZh
    ? `Token 用量活跃度图，过去 ${WINDOW_DAYS} 天。总用量 ${formatTokens(stats.totalTokens)} tokens。${
        stats.mostActiveDate
          ? `最活跃 ${localiseDate(new Date(stats.mostActiveDate + "T00:00:00"), true)}，${formatTokens(stats.mostActiveTokens)} tokens。`
          : ""
      }最长连续 ${stats.longestStreak} 天，当前连续 ${stats.currentStreak} 天。`
    : `Token usage activity heatmap, past ${WINDOW_DAYS} days. Total ${formatTokens(stats.totalTokens)} tokens. ${
        stats.mostActiveDate
          ? `Most active ${localiseDate(new Date(stats.mostActiveDate + "T00:00:00"), false)} with ${formatTokens(stats.mostActiveTokens)} tokens. `
          : ""
      }Longest streak ${stats.longestStreak} days, current streak ${stats.currentStreak} days.`;

  return (
    <div className="rounded-lg border border-border/50 bg-card p-5">
      {/* Header — title only (range fixed at 365 days) */}
      <div>
        <h3 className="text-sm font-semibold">
          {t("overview.heatmapTitle" as TranslationKey)}
        </h3>
        <p className="text-sm text-muted-foreground mt-1.5">
          {isZh
            ? `过去 ${WINDOW_DAYS} 天的每日 token 消耗`
            : `Daily token usage over the past ${WINDOW_DAYS} days`}
        </p>
      </div>

      {/* Grid — fluid: cells size to fill the card width.
          `role="img"` + a single aria-label collapses 365 cells / month
          labels / day axis / legend into one image for assistive tech,
          while sighted users still see (and hover) every cell. */}
      <div className="mt-4" role="img" aria-label={heatmapAriaLabel}>
        <div aria-hidden="true">
          {/* Month labels — same column template as the cell grid below
              so each label sits on top of the column it belongs to. */}
          <div
            className="flex gap-1.5 mb-1.5"
          >
            <div className="w-5 shrink-0" />
            <div
              className="flex-1 grid"
              style={{
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                columnGap: "2px",
              }}
            >
              {Array.from({ length: cols }, (_, col) => {
                const lbl = monthLabels.find((m) => m.col === col);
                return (
                  // No truncate / overflow-hidden — let the label flow into
                  // the next (empty) column's span. GitHub does the same.
                  <span
                    key={col}
                    className="text-[10px] text-muted-foreground leading-none whitespace-nowrap"
                  >
                    {lbl?.label ?? ""}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="flex gap-1.5">
            {/* Day-of-week axis — flex-stretches to match the cell grid's
                computed height (which depends on width via aspect-ratio). */}
            <div
              className="w-5 shrink-0 grid"
              style={{
                gridTemplateRows: "repeat(7, minmax(0, 1fr))",
                rowGap: "2px",
              }}
            >
              {[0, 1, 2, 3, 4, 5, 6].map((row) => (
                <span
                  key={row}
                  className="text-[9px] text-muted-foreground text-right leading-none flex items-center justify-end"
                >
                  {row === 1
                    ? isZh ? "一" : "M"
                    : row === 3
                      ? isZh ? "三" : "W"
                      : row === 5
                        ? isZh ? "五" : "F"
                        : ""}
                </span>
              ))}
            </div>

            {/* Cell grid — fluid. `aspect-ratio: cols / 7` makes the grid's
                height track `width * 7 / cols`, and `1fr` columns/rows make
                each cell a square that scales with the card width. */}
            <div
              className="flex-1 grid"
              style={{
                gridTemplateRows: "repeat(7, minmax(0, 1fr))",
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gridAutoFlow: "column",
                gap: "2px",
                aspectRatio: `${cols} / 7`,
              }}
            >
              {cells.map((cell) => (
                <div
                  key={`${cell.col}-${cell.row}`}
                  className={cn(
                    "rounded-[2px]",
                    cell.inWindow ? bucketClass(cell.tokens, maxDayTokens) : "opacity-0",
                  )}
                  title={
                    cell.inWindow
                      ? `${cell.dateStr} · ${formatTokens(cell.tokens)} tokens`
                      : undefined
                  }
                />
              ))}
            </div>
          </div>

          {/* Legend */}
          <div className="mt-3 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>{isZh ? "少" : "Less"}</span>
            <div className="size-[10px] rounded-[2px] bg-muted/40" />
            <div className="size-[10px] rounded-[2px] bg-status-success/15" />
            <div className="size-[10px] rounded-[2px] bg-status-success/35" />
            <div className="size-[10px] rounded-[2px] bg-status-success/65" />
            <div className="size-[10px] rounded-[2px] bg-status-success/95" />
            <span>{isZh ? "多" : "More"}</span>
          </div>
        </div>
      </div>

      {/* Stats row */}
      {empty ? (
        <p className="mt-5 text-xs text-muted-foreground">
          {t("overview.heatmapEmpty" as TranslationKey)}
        </p>
      ) : (
        <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <Stat
            label={t("overview.heatmapTotal" as TranslationKey)}
            value={loading ? "–" : formatTokens(stats.totalTokens)}
          />
          <Stat
            label={t("overview.heatmapMostActive" as TranslationKey)}
            value={
              loading || !stats.mostActiveDate
                ? "–"
                : localiseDate(new Date(stats.mostActiveDate + "T00:00:00"), isZh)
            }
            sub={
              !loading && stats.mostActiveTokens > 0
                ? formatTokens(stats.mostActiveTokens) + " tokens"
                : undefined
            }
          />
          <Stat
            label={t("overview.heatmapLongestStreak" as TranslationKey)}
            value={loading ? "–" : `${stats.longestStreak} ${isZh ? "天" : "days"}`}
          />
          <Stat
            label={t("overview.heatmapCurrentStreak" as TranslationKey)}
            value={loading ? "–" : `${stats.currentStreak} ${isZh ? "天" : "days"}`}
          />
        </div>
      )}

      {/* Jump-to-details — only when not already on the details page */}
      {!hideViewDetails && onJumpToDetails && (
        <div className="mt-4 pt-3 border-t border-border/40">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={onJumpToDetails}
          >
            {t("overview.heatmapViewDetails" as TranslationKey)}
            <CaretRight size={12} weight="bold" />
          </Button>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md bg-muted/30 px-3 py-2">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground/90">
        {value}
      </p>
      {sub && (
        <p className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{sub}</p>
      )}
    </div>
  );
}
