"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getLocalDateString } from "@/lib/utils";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/useTranslation";
import { OverviewHeatmap } from "./OverviewHeatmap";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UsageStatsResponse {
  summary: {
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost: number | null;
    total_sessions: number;
    usage_turns: number;
    cost_known_turns: number;
    cost_legacy_turns: number;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    uncached_input_tokens: number | null;
    cache_eligible_turns: number;
    cache_rate_complete: boolean;
  };
  daily: Array<{
    date: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost: number | null;
    cost_legacy: boolean;
    cohort: 'stable_owner' | 'handoff';
  }>;
}

// Recharts v3 Payload — only the fields we actually read
interface RechartsPayloadItem {
  name?: string | number;
  dataKey?: string | number;
  value?: number;
  color?: string;
  fill?: string;
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Number formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a token count for display.
 *   0          → "0"
 *   999        → "999"
 *   1_234      → "1,234"
 *   9_999      → "9,999"
 *   10_000     → "10.0K"
 *   1_234_567  → "1.23M"
 *   1_200_000_000 → "1.20B"
 */
function formatTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 0) return "-" + formatTokens(-n);

  if (n < 10_000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return (n / 1_000).toFixed(1) + "K";
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(2) + "M";
  return (n / 1_000_000_000).toFixed(2) + "B";
}

/**
 * Format a USD cost for display.
 *   0         → "$0.00"
 *   0.00015   → "$0.0002"
 *   0.0052    → "$0.0052"
 *   0.12      → "$0.12"
 *   1.5       → "$1.50"
 *   1234.5    → "$1,234.50"
 */
function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "$" + n.toFixed(4);
  if (n >= 1000) return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return "$" + n.toFixed(2);
}

/**
 * Format a percentage.
 *   NaN / undefined → "N/A"
 *   0              → "0%"
 *   0.456          → "0.5%"
 *   12.345         → "12.3%"
 *   100            → "100%"
 */
function formatPercent(n: number | undefined): string {
  if (n === undefined || isNaN(n)) return "N/A";
  if (n === 0) return "0%";
  if (n === 100) return "100%";
  return n.toFixed(1) + "%";
}

/** Short date for chart x-axis: "2/24" */
function shortDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ---------------------------------------------------------------------------
// Stable model → color mapping
// ---------------------------------------------------------------------------

const COLOR_PALETTE = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

/**
 * Assign a stable color to each unique model key (e.g. "sonnet", "Kimi/sonnet").
 * Uses the index in the sorted model list so each distinct key gets its own color.
 */
function getModelColor(_model: string, idx: number): string {
  return COLOR_PALETTE[idx % COLOR_PALETTE.length];
}

// ---------------------------------------------------------------------------
// Chart tooltip (recharts v3 compatible)
// ---------------------------------------------------------------------------

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: ReadonlyArray<RechartsPayloadItem>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;

  // Filter out entries with zero or missing values
  const items = payload.filter((p) => typeof p.value === "number" && p.value > 0);
  if (items.length === 0) return null;

  return (
    <div className="rounded-lg border border-border/50 bg-popover px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium text-popover-foreground">{label}</p>
      {items.map((p, i) => {
        const displayName = String(p.name ?? p.dataKey ?? "unknown");
        const displayColor = p.color || p.fill || "var(--color-chart-1)";
        return (
          <div key={displayName + i} className="flex items-center gap-2 text-popover-foreground/80">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: displayColor }}
            />
            <span>{displayName}</span>
            <span className="ml-auto font-mono">{formatTokens(p.value ?? 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day range selector
// ---------------------------------------------------------------------------

const RANGE_OPTIONS = [
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
  { label: "365D", days: 365 },
] as const;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function UsageStatsSection() {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<UsageStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const fetchStats = useCallback(async (d: number) => {
    // Abort any in-flight request to avoid stale data overwriting fresh data
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/usage/stats?days=${d}`, { signal: controller.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(t('usage.loadError')));
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    fetchStats(days);
    return () => abortRef.current?.abort();
  }, [days, fetchStats]);

  // Derive chart data: pivot daily rows into { date, model1: N, model2: N, ... }
  const { chartData, models } = deriveChartData(data?.daily ?? [], days);
  // Derive cost-by-day series — same date scaffold as the bar chart so
  // the two share the same x-axis tick density.
  const costData = deriveCostData(data?.daily ?? [], days);
  const isZh = t('nav.chats') === '对话';

  const summary = data?.summary;
  const totalTokens = summary
    ? summary.total_input_tokens + summary.total_output_tokens
    : 0;
  const cacheTotal = summary?.cache_rate_complete
    && summary.cache_read_tokens !== null
    && summary.uncached_input_tokens !== null
    ? summary.cache_read_tokens + summary.uncached_input_tokens
    : null;
  const cacheRate = summary?.cache_rate_complete && cacheTotal && cacheTotal > 0
    ? ((summary.cache_read_tokens ?? 0) / cacheTotal) * 100
    : undefined;

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Page title — matches other Settings sub-pages. */}
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{t('settings.usage')}</h2>
      </div>
      {/* Day range selector */}
      <div className="flex items-center gap-2">
        {RANGE_OPTIONS.map((opt) => (
          <Button
            key={opt.days}
            variant={days === opt.days ? "default" : "secondary"}
            size="sm"
            onClick={() => setDays(opt.days)}
            className={`px-3 py-1 text-xs font-medium ${
              days !== opt.days ? "text-muted-foreground hover:bg-accent" : ""
            }`}
          >
            {opt.label}
          </Button>
        ))}
      </div>

      {/* Data cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label={t('usage.totalTokens')}
          value={loading ? "–" : formatTokens(totalTokens)}
          sub={
            summary
              ? `${t('usage.input')} ${formatTokens(summary.total_input_tokens)} · ${t('usage.output')} ${formatTokens(summary.total_output_tokens)}`
              : undefined
          }
        />
        <StatCard
          label={t('usage.totalCost')}
          value={loading
            ? "–"
            : summary?.total_cost !== null && summary?.total_cost !== undefined
              ? formatCost(summary.total_cost)
              : t('usage.unknown')}
          sub={summary && summary.cost_known_turns < summary.usage_turns
            ? t('usage.partialCoverage')
            : summary && summary.cost_legacy_turns > 0
              ? t('usage.legacy')
              : undefined}
        />
        <StatCard
          label={t('usage.sessions')}
          value={loading ? "–" : String(summary?.total_sessions ?? 0)}
        />
        <StatCard
          label={t('usage.cacheHitRate')}
          value={loading ? "–" : formatPercent(cacheRate)}
          sub={
            summary && !summary.cache_rate_complete
              ? t('usage.partialCoverage')
              : summary?.cache_read_tokens !== null && summary?.cache_read_tokens !== undefined
                ? `${formatTokens(summary.cache_read_tokens)} ${t('usage.cached')}`
                : undefined
          }
        />
      </div>

      {/* Bar chart — daily token usage by model */}
      <div className="rounded-lg border border-border/50 bg-card p-5">
        <h3 className="mb-4 text-sm font-medium">{t('usage.dailyChart')}</h3>

        {loading && (
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
            {t('usage.loading')}
          </div>
        )}

        {error && (
          <div className="flex h-64 items-center justify-center text-sm text-status-error-foreground">
            {error}
          </div>
        )}

        {!loading && !error && chartData.length === 0 && (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-muted-foreground">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="opacity-40"
            >
              <path d="M18 20V10" />
              <path d="M12 20V4" />
              <path d="M6 20v-6" />
            </svg>
            <p className="text-sm">{t('usage.noData')}</p>
            <p className="text-xs">{t('usage.noDataHint')}</p>
          </div>
        )}

        {!loading && !error && chartData.length > 0 && (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="var(--color-border)"
                opacity={0.5}
              />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tickFormatter={formatTokens}
                tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                width={54}
              />
              <Tooltip
                content={(props) => <ChartTooltip {...props} />}
                cursor={{ fill: "var(--color-accent)", opacity: 0.3 }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                iconType="circle"
                iconSize={8}
              />
              {models.map((model, idx) => (
                <Bar
                  key={model}
                  name={model}
                  dataKey={model}
                  stackId="tokens"
                  fill={getModelColor(model, idx)}
                  radius={idx === models.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
                  maxBarSize={40}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Daily cost chart — fed by the same range selector. Useful to
          spot expensive days quickly without doing the math from token
          counts × per-model price. */}
      <div className="rounded-lg border border-border/50 bg-card p-5">
        <h3 className="mb-4 text-sm font-medium">{t('usage.costChart')}</h3>

        {loading && (
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
            {t('usage.loading')}
          </div>
        )}

        {!loading && !error && costData.length === 0 && (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
            <p className="text-sm">{t('usage.noData')}</p>
          </div>
        )}

        {!loading && !error && costData.length > 0 && (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={costData} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="var(--color-border)"
                opacity={0.5}
              />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tickFormatter={(v: number) => formatCost(v)}
                tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                width={64}
              />
              <Tooltip
                content={(props: { active?: boolean; payload?: ReadonlyArray<RechartsPayloadItem>; label?: string | number }) => {
                  if (!props.active || !props.payload?.length) return null;
                  const v = props.payload[0]?.value ?? 0;
                  return (
                    <div className="rounded-lg border border-border/50 bg-popover px-3 py-2 text-xs shadow-md">
                      <p className="mb-1 font-medium text-popover-foreground">{props.label}</p>
                      <p className="text-popover-foreground/80 font-mono">{formatCost(v)}</p>
                    </div>
                  );
                }}
                cursor={{ fill: "var(--color-accent)", opacity: 0.3 }}
              />
              <Bar
                dataKey="cost"
                fill="var(--color-chart-2)"
                radius={[3, 3, 0, 0]}
                maxBarSize={40}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* 365-day activity heatmap — same component the Overview page
          uses; here we hide the "View details" link since this IS the
          details page. */}
      <OverviewHeatmap isZh={isZh} hideViewDetails />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-card p-5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cost derive — sum cost per day, fill missing dates with zeros.
// ---------------------------------------------------------------------------

function deriveCostData(
  daily: UsageStatsResponse["daily"],
  days: number,
): Array<{ date: string; cost: number | null }> {
  const knownRows = daily.filter((row) => row.cost !== null);
  if (knownRows.length === 0) return [];
  const byDate = new Map<string, number>();
  for (const row of knownRows) {
    byDate.set(row.date, (byDate.get(row.date) ?? 0) + (row.cost ?? 0));
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const result: Array<{ date: string; cost: number | null }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = getLocalDateString(d);
    result.push({ date: shortDate(key), cost: byDate.get(key) ?? null });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Data transform: pivot daily array into chart-friendly format
// ---------------------------------------------------------------------------

function deriveChartData(daily: UsageStatsResponse["daily"], days: number): {
  chartData: Array<Record<string, string | number>>;
  models: string[];
} {
  if (daily.length === 0) return { chartData: [], models: [] };

  // Normalise model names: empty string → "unknown"
  const normalised = daily.map((row) => ({
    ...row,
    model: row.model || "unknown",
  }));

  // Collect all unique models
  const modelSet = new Set<string>();
  for (const row of normalised) {
    modelSet.add(row.model);
  }
  const models = Array.from(modelSet).sort();

  // Group by date
  const byDate = new Map<string, Record<string, number>>();
  for (const row of normalised) {
    const total = row.input_tokens + row.output_tokens;
    if (!byDate.has(row.date)) {
      byDate.set(row.date, {});
    }
    const entry = byDate.get(row.date)!;
    entry[row.model] = (entry[row.model] || 0) + total;
  }

  // Build a continuous date range covering the full window so x-axis has no gaps
  const allDates: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    allDates.push(getLocalDateString(d));
  }

  // Format for recharts, filling missing dates with zeros
  const chartData = allDates.map((date) => {
    const modelTokens = byDate.get(date) || {};
    const row: Record<string, string | number> = { date: shortDate(date) };
    for (const m of models) {
      row[m] = modelTokens[m] || 0;
    }
    return row;
  });

  return { chartData, models };
}
