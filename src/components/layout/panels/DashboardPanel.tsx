"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { X, ArrowClockwise, CaretUp, CaretDown, ChartBar, Trash, DownloadSimple, Heart, Brain, Clock, Check, Warning, Gear } from "@/components/ui/icon";
import { showToast } from "@/hooks/useToast";
import { Button } from "@/components/ui/button";
import { usePanel } from "@/hooks/usePanel";
import { useTranslation } from "@/hooks/useTranslation";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import { WidgetRenderer } from "@/components/chat/WidgetRenderer";
import type { DashboardConfig, DashboardWidget } from "@/types/dashboard";
import type { TranslationKey } from "@/i18n";
import { cn } from "@/lib/utils";
import { RARITY_DISPLAY, STAT_LABEL, SPECIES_LABEL, rarityColor, getBuddyTitle, SPECIES_IMAGE_URL, EGG_IMAGE_URL, RARITY_BG_GRADIENT, type BuddyData, type Species, type Rarity } from "@/lib/buddy";

const DASHBOARD_MIN_WIDTH = 320;
const DASHBOARD_MAX_WIDTH = 800;
const DASHBOARD_DEFAULT_WIDTH = 480;

interface AssistantSummary {
  configured: boolean;
  name: string;
  styleHint?: string;
  onboardingComplete: boolean;
  lastHeartbeatDate: string | null;
  heartbeatEnabled: boolean;
  memoryCount: number;
  recentDailyDates?: string[];
  fileHealth?: Record<string, boolean>;
  taskCount?: number;
  buddy?: BuddyData;
}

export function DashboardPanel() {
  const { setDashboardPanelOpen, workingDirectory, isAssistantWorkspace } = usePanel();
  const { t } = useTranslation();
  const [width, setWidth] = useState(DASHBOARD_DEFAULT_WIDTH);
  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(false);
  const initialLoadDone = useRef(false);
  const [assistantSummary, setAssistantSummary] = useState<AssistantSummary | null>(null);

  // Load assistant summary for assistant workspace dashboards
  useEffect(() => {
    if (!isAssistantWorkspace) { setAssistantSummary(null); return; }
    fetch('/api/workspace/summary')
      .then(r => r.ok ? r.json() : null)
      .then(data => setAssistantSummary(data))
      .catch(() => {});
  }, [isAssistantWorkspace]);

  const handleResize = useCallback((delta: number) => {
    setWidth((w) => Math.min(DASHBOARD_MAX_WIDTH, Math.max(DASHBOARD_MIN_WIDTH, w - delta)));
  }, []);

  // Load dashboard config
  const loadDashboard = useCallback(async () => {
    if (!workingDirectory) return;
    try {
      const res = await fetch(`/api/dashboard?dir=${encodeURIComponent(workingDirectory)}`);
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
        setAutoRefresh(data.settings?.autoRefreshOnOpen ?? false);
      }
    } catch (e) {
      console.error('[DashboardPanel] Failed to load:', e);
    } finally {
      setLoading(false);
    }
  }, [workingDirectory]);

  // Load on mount
  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  // Auto-refresh on open
  useEffect(() => {
    if (!initialLoadDone.current && config && autoRefresh && config.widgets.length > 0) {
      initialLoadDone.current = true;
      handleRefreshAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, autoRefresh]);

  // Poll for changes during streaming (MCP tools execute during streaming).
  // Also do a one-shot re-fetch 1s after streaming ends to catch the final state.
  const { activeStreamingSessions } = usePanel();
  const isAnyStreaming = activeStreamingSessions.size > 0;
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (!workingDirectory) return;
    if (isAnyStreaming) {
      wasStreamingRef.current = true;
      const knownCount = config?.widgets.length ?? 0;
      const interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/dashboard?dir=${encodeURIComponent(workingDirectory)}`);
          if (res.ok) {
            const data = await res.json();
            if ((data.widgets?.length ?? 0) !== knownCount) {
              setConfig(data);
            }
          }
        } catch { /* ignore */ }
      }, 3000);
      return () => clearInterval(interval);
    } else if (wasStreamingRef.current) {
      // Streaming just ended — do a final fetch to catch any last-moment changes
      wasStreamingRef.current = false;
      loadDashboard();
    }
  }, [workingDirectory, isAnyStreaming, config?.widgets.length, loadDashboard]);

  // Cross-widget communication relay: scoped to dashboard panel only.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const { topic, data, sourceIframe } = (e as CustomEvent).detail || {};
      if (!panelRef.current) return;
      // Ignore events from iframes outside the dashboard panel
      if (sourceIframe && !panelRef.current.contains(sourceIframe)) return;
      const iframes = panelRef.current.querySelectorAll('iframe[title]');
      iframes.forEach(iframe => {
        if (iframe !== sourceIframe && (iframe as HTMLIFrameElement).contentWindow) {
          (iframe as HTMLIFrameElement).contentWindow!.postMessage(
            { type: 'widget:crossFilter', payload: { topic, data } },
            '*',
          );
        }
      });
    };
    window.addEventListener('widget-cross-publish', handler);
    return () => window.removeEventListener('widget-cross-publish', handler);
  }, []);

  const handleRefreshAll = useCallback(async () => {
    if (!workingDirectory || refreshingAll) return;
    setRefreshingAll(true);
    try {
      const res = await fetch('/api/dashboard/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDirectory }),
      });
      if (res.ok) {
        const data = await res.json();
        setConfig(data.config);
      }
    } catch (e) {
      console.error('[DashboardPanel] Refresh all failed:', e);
    } finally {
      setRefreshingAll(false);
    }
  }, [workingDirectory, refreshingAll]);

  const handleRefreshWidget = useCallback(async (widgetId: string) => {
    if (!workingDirectory || refreshingIds.has(widgetId)) return;
    setRefreshingIds(prev => new Set(prev).add(widgetId));
    try {
      const res = await fetch('/api/dashboard/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDirectory, widgetId }),
      });
      if (res.ok) {
        const data = await res.json();
        setConfig(data.config);
      }
    } catch (e) {
      console.error('[DashboardPanel] Refresh widget failed:', e);
    } finally {
      setRefreshingIds(prev => {
        const next = new Set(prev);
        next.delete(widgetId);
        return next;
      });
    }
  }, [workingDirectory, refreshingIds]);

  const handleDeleteWidget = useCallback(async (widgetId: string) => {
    if (!workingDirectory) return;
    try {
      const res = await fetch(
        `/api/dashboard?dir=${encodeURIComponent(workingDirectory)}&widgetId=${encodeURIComponent(widgetId)}`,
        { method: 'DELETE' }
      );
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
        // Notify chat widgets that a pin was removed
        // No need to notify chat Pin buttons — they are stateless triggers
      }
    } catch (e) {
      console.error('[DashboardPanel] Delete widget failed:', e);
    }
  }, [workingDirectory]);

  const handleMoveWidget = useCallback(async (widgetId: string, direction: 'up' | 'down' | 'top') => {
    if (!workingDirectory || !config) return;
    // Optimistic local update — avoids React DOM reorder which destroys iframes
    const widgets = [...config.widgets];
    const idx = widgets.findIndex(w => w.id === widgetId);
    if (idx === -1) return;
    if (direction === 'top' && idx > 0) {
      const [w] = widgets.splice(idx, 1);
      widgets.unshift(w);
    } else if (direction === 'up' && idx > 0) {
      [widgets[idx - 1], widgets[idx]] = [widgets[idx], widgets[idx - 1]];
    } else if (direction === 'down' && idx < widgets.length - 1) {
      [widgets[idx], widgets[idx + 1]] = [widgets[idx + 1], widgets[idx]];
    } else {
      return; // no change
    }
    setConfig({ ...config, widgets });
    // Persist absolute order (race-free — last write wins with correct final state)
    fetch('/api/dashboard', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDirectory, widgetOrder: widgets.map(w => w.id) }),
    }).catch(e => console.error('[DashboardPanel] Move widget failed:', e));
  }, [workingDirectory, config]);

  const handleToggleAutoRefresh = useCallback(async () => {
    if (!workingDirectory) return;
    const newValue = !autoRefresh;
    setAutoRefresh(newValue);
    try {
      await fetch('/api/dashboard', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDirectory, settings: { autoRefreshOnOpen: newValue } }),
      });
    } catch (e) {
      console.error('[DashboardPanel] Toggle auto-refresh failed:', e);
      setAutoRefresh(!newValue); // revert on failure
    }
  }, [workingDirectory, autoRefresh]);

  const widgets = config?.widgets ?? [];

  // Stable render order: sort by ID so React never reorders DOM (preserves iframes).
  // Visual order controlled by CSS `order` based on position in config.widgets.
  const stableWidgets = useMemo(() => {
    const ids = widgets.map(w => w.id).sort();
    return ids.map(id => widgets.find(w => w.id === id)!);
  }, [widgets]);

  const orderMap = useMemo(() => {
    const m = new Map<string, number>();
    widgets.forEach((w, i) => m.set(w.id, i));
    return m;
  }, [widgets]);

  return (
    <div ref={panelRef} className="flex h-full shrink-0 overflow-hidden">
      <ResizeHandle side="left" onResize={handleResize} />
      <div
        className="flex h-full flex-1 flex-col overflow-hidden border-r border-border/40 bg-background"
        style={{ width }}
      >
        {/* Header */}
        <div className="flex h-10 shrink-0 items-center justify-between px-3">
          <div className="flex items-center gap-2">
            {isAssistantWorkspace ? (
              assistantSummary?.buddy ? (
                <img
                  src={SPECIES_IMAGE_URL[assistantSummary.buddy.species as Species] || ''}
                  alt={assistantSummary.buddy.species}
                  width={24} height={24}
                  className="rounded"
                />
              ) : (
                <img src={EGG_IMAGE_URL} alt="egg" width={24} height={24} />
              )
            ) : null}
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {isAssistantWorkspace
                ? (assistantSummary?.buddy
                    ? (assistantSummary.name || t('assistant.defaultName'))
                    : t('buddy.adoptPrompt'))
                : t('dashboard.title')}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {(widgets.length > 0 || isAssistantWorkspace) && (
              <>
                {/* Auto-refresh toggle */}
                <button
                  onClick={handleToggleAutoRefresh}
                  className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span>{t('dashboard.autoRefreshLabel')}</span>
                  <span className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors ${autoRefresh ? 'bg-primary' : 'bg-muted'}`}>
                    <span className={`pointer-events-none block h-3 w-3 rounded-full bg-background shadow-sm ring-0 transition-transform mt-0.5 ${autoRefresh ? 'translate-x-3.5 ml-0' : 'translate-x-0.5'}`} />
                  </span>
                </button>
                <div className="h-4 w-px bg-border/60 mx-1" />
                {/* Refresh all */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    // Refresh widgets + assistant status
                    handleRefreshAll();
                    if (isAssistantWorkspace) {
                      fetch('/api/workspace/summary')
                        .then(r => r.ok ? r.json() : null)
                        .then(data => setAssistantSummary(data))
                        .catch(() => {});
                    }
                  }}
                  disabled={refreshingAll}
                  title={t('dashboard.refresh')}
                >
                  <ArrowClockwise size={14} className={refreshingAll ? "animate-spin" : ""} />
                  <span className="sr-only">{t('dashboard.refresh')}</span>
                </Button>
              </>
            )}
            {/* Close button — always visible */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setDashboardPanelOpen(false)}
            >
              <X size={14} />
              <span className="sr-only">{t('common.close')}</span>
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
              {t('common.loading' as TranslationKey)}
            </div>
          ) : widgets.length === 0 ? (
            <div className="flex flex-col h-full px-3 pt-3">
              {isAssistantWorkspace && assistantSummary?.configured && (
                <AssistantStatusCard summary={assistantSummary} t={t} />
              )}
              {!(isAssistantWorkspace && assistantSummary?.configured) && (
                <div className="flex flex-col items-center justify-center flex-1 text-center text-muted-foreground">
                  <ChartBar size={32} className="mb-3 opacity-40" />
                  <p className="text-sm">{t('dashboard.empty')}</p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4 p-3">
              {/* Assistant status card — always first in assistant workspace */}
              {isAssistantWorkspace && assistantSummary?.configured && (
                <AssistantStatusCard summary={assistantSummary} t={t} />
              )}
              {stableWidgets.map((widget) => {
                const displayIdx = orderMap.get(widget.id) ?? 0;
                return (
                  <DashboardWidgetCard
                    key={widget.id}
                    widget={widget}
                    style={{ order: displayIdx }}
                    refreshing={refreshingAll || refreshingIds.has(widget.id)}
                    isFirst={displayIdx === 0}
                    isLast={displayIdx === widgets.length - 1}
                    onRefresh={() => handleRefreshWidget(widget.id)}
                    onDelete={() => handleDeleteWidget(widget.id)}
                    onMove={(dir) => handleMoveWidget(widget.id, dir)}
                  />
                );
              })}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

function DashboardWidgetCard({ widget, refreshing, isFirst, isLast, style, onRefresh, onDelete, onMove }: {
  widget: DashboardWidget;
  refreshing: boolean;
  isFirst: boolean;
  isLast: boolean;
  style?: React.CSSProperties;
  onRefresh: () => void;
  onDelete: () => void;
  onMove: (direction: 'up' | 'down' | 'top') => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="group/card relative rounded-lg overflow-hidden" style={style}>
      {/* Permanent title bar */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <button
          className="text-xs font-medium text-foreground/70 truncate hover:text-foreground transition-colors text-left"
          onClick={() => window.dispatchEvent(new CustomEvent('dashboard-widget-drilldown', { detail: { title: widget.title, dataContract: widget.dataContract } }))}
          title={t('dashboard.drilldown')}
        >
          {widget.title}
        </button>
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/card:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onMove('up')}
            disabled={isFirst}
            title={t('dashboard.moveUp')}
            className="h-5 w-5"
          >
            <CaretUp size={12} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onMove('down')}
            disabled={isLast}
            title={t('dashboard.moveDown')}
            className="h-5 w-5"
          >
            <CaretDown size={12} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            disabled={refreshing}
            title={t('dashboard.refreshWidget')}
            className="h-5 w-5"
          >
            <ArrowClockwise size={12} className={refreshing ? "animate-spin" : ""} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={async () => {
              try {
                const { exportWidgetAsImage, downloadBlob } = await import('@/lib/dashboard-export');
                const blob = await exportWidgetAsImage(widget.widgetCode);
                downloadBlob(blob, `${widget.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_')}.png`);
              } catch (e) {
                console.error('[DashboardPanel] Export failed:', e);
                showToast({ type: 'error', message: t('dashboard.exportFailed' as TranslationKey) });
              }
            }}
            title={t('dashboard.exportWidget')}
            className="h-5 w-5"
          >
            <DownloadSimple size={12} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            title={t('dashboard.deleteWidget')}
            className="h-5 w-5 text-muted-foreground hover:text-destructive"
          >
            <Trash size={12} />
          </Button>
        </div>
      </div>

      {/* Shimmer overlay during refresh */}
      {refreshing && (
        <div className="absolute inset-0 z-5 bg-background/30 backdrop-blur-[1px] flex items-center justify-center">
          <div className="text-xs text-muted-foreground">{t('dashboard.refreshing')}</div>
        </div>
      )}

      {/* Widget render */}
      <WidgetRenderer widgetCode={widget.widgetCode} isStreaming={false} title={widget.title} />
    </div>
  );
}

function getNextRarity(rarity: string): string {
  const order = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const idx = order.indexOf(rarity);
  return idx < order.length - 1 ? order[idx + 1]! : rarity;
}

function getRequiredMemories(rarity: string): number {
  const reqs: Record<string, number> = { common: 10, uncommon: 30, rare: 60, epic: 100 };
  return reqs[rarity] || 100;
}

function rarityBorderClass(rarity: string): string {
  switch (rarity) {
    case 'legendary': return 'border-amber-500/30 shadow-amber-500/10 shadow-md';
    case 'epic': return 'border-purple-500/30';
    case 'rare': return 'border-blue-500/30';
    case 'uncommon': return 'border-green-500/30';
    default: return 'border-primary/10';
  }
}

/** Built-in assistant status card — injected at the top of assistant workspace dashboards. */
function AssistantStatusCard({ summary, t }: {
  summary: AssistantSummary;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const router = useRouter();
  const buddy = summary.buddy;
  const cardBorder = buddy
    ? rarityBorderClass(buddy.rarity)
    : 'border-primary/10';

  return (
    <div className={cn('rounded-lg border bg-primary/[0.03] p-3 space-y-3', cardBorder)}>
      {/* Header: 3D image + Name + Species + Rarity + Settings gear */}
      <div className="flex items-center gap-2">
        {buddy ? (
          <img
            src={SPECIES_IMAGE_URL[buddy.species as Species] || ''}
            alt={buddy.species}
            width={40} height={40}
            className="rounded-lg"
            style={{ background: RARITY_BG_GRADIENT[buddy.rarity as Rarity] || '' }}
          />
        ) : (
          <img src={EGG_IMAGE_URL} alt="egg" width={40} height={40} />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">
              {buddy
                ? (buddy.buddyName || summary.name || t('assistant.defaultName' as TranslationKey))
                : t('buddy.adoptPrompt' as TranslationKey)}
            </span>
            {buddy && (
              <span
                className={cn('inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0', rarityColor(buddy.rarity))}
                style={{ background: RARITY_BG_GRADIENT[buddy.rarity as Rarity] || '' }}
              >
                {RARITY_DISPLAY[buddy.rarity]?.stars} {RARITY_DISPLAY[buddy.rarity]?.label.zh}
              </span>
            )}
          </div>
          {buddy && (
            <div className="text-[10px] text-muted-foreground truncate">
              {getBuddyTitle(buddy as BuddyData)
                ? `${getBuddyTitle(buddy as BuddyData)} · ${SPECIES_LABEL[buddy.species]?.zh || buddy.species}`
                : SPECIES_LABEL[buddy.species]?.zh || buddy.species}
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground text-[10px] gap-1 h-6 px-1.5"
          onClick={() => router?.push('/settings#assistant')}
        >
          <Gear size={12} />
          {t('settings.title' as TranslationKey)}
        </Button>
      </div>

      {/* Stats bars (when buddy exists) */}
      {buddy && (
        <div className="space-y-1.5 mt-3">
          {Object.entries(buddy.stats).map(([stat, value]) => {
            const isPeak = stat === buddy.peakStat;
            return (
              <div key={stat} className="flex items-center gap-2 text-[11px]">
                <span className={cn('w-8 truncate', isPeak ? 'text-primary font-medium' : 'text-muted-foreground')}>
                  {t(`buddy.${stat}` as TranslationKey) || STAT_LABEL[stat]?.zh || stat}
                </span>
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn('h-full rounded-full transition-all', isPeak ? 'bg-primary' : 'bg-muted-foreground/40')}
                    style={{ width: `${value}%` }}
                  />
                </div>
                <span className={cn('w-5 text-right', isPeak ? 'text-primary font-semibold' : 'text-muted-foreground')}>{value}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Status row — compact single line */}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1">
          <Heart size={11} />
          <span className={`h-1.5 w-1.5 rounded-full ${summary.heartbeatEnabled ? 'bg-status-success' : 'bg-muted-foreground/30'}`} />
          <span>{t('assistant.panel.heartbeat' as TranslationKey)}</span>
        </div>
        <div className="flex items-center gap-1">
          <Brain size={11} />
          <span>{t('assistant.panel.memories' as TranslationKey)}</span>
          <span className="text-foreground">{summary.memoryCount}</span>
        </div>
        <div className="flex items-center gap-1">
          <Clock size={11} />
          <span>{t('tasks.title' as TranslationKey)}</span>
          <span className="text-foreground">{summary.taskCount || 0}</span>
        </div>
      </div>

      {/* File health */}
      {summary.fileHealth && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {Object.entries(summary.fileHealth).map(([key, exists]) => (
            <div key={key} className="flex items-center gap-1 text-[10px]">
              {exists ? (
                <Check size={10} className="text-status-success" />
              ) : (
                <Warning size={10} className="text-status-warning" />
              )}
              <span className={exists ? 'text-muted-foreground' : 'text-status-warning'}>
                {key}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Evolution progress (when buddy exists and can potentially evolve) */}
      {buddy && buddy.rarity !== 'legendary' && (
        <div className="border-t border-border/30 pt-2 mt-2">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
            <span>{t('buddy.evolutionProgress' as TranslationKey)}</span>
            <span>{t('buddy.nextRarity' as TranslationKey)}: {RARITY_DISPLAY[getNextRarity(buddy.rarity) as keyof typeof RARITY_DISPLAY]?.label.zh}</span>
          </div>
          {/* Simple progress indicator based on memory count vs requirement */}
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-primary/60" style={{ width: `${Math.min(100, (summary.memoryCount / getRequiredMemories(buddy.rarity)) * 100)}%` }} />
          </div>
          {/* Check + evolve button when ready */}
          <Button
            variant="ghost"
            size="sm"
            className="w-full mt-1.5 gap-1 text-[10px] h-6 text-muted-foreground"
            onClick={async () => {
              try {
                const res = await fetch('/api/workspace/evolve-buddy', { method: 'POST' });
                if (res.ok) {
                  const data = await res.json();
                  if (data.evolved) {
                    showToast({ type: 'success', message: `🌟 ${t('buddy.evolutionSuccess' as TranslationKey)}` });
                    // Refresh summary to show new rarity
                    window.location.reload();
                  } else if (data.check) {
                    const c = data.check;
                    const parts: string[] = [];
                    if (c.memoryCount < c.requiredMemories) parts.push(`${t('assistant.panel.memories' as TranslationKey)} ${c.memoryCount}/${c.requiredMemories}`);
                    if (c.daysActive < c.requiredDays) parts.push(`${t('buddy.daysActive' as TranslationKey)} ${c.daysActive}/${c.requiredDays}`);
                    showToast({ type: 'info', message: `${t('buddy.evolutionNotReady' as TranslationKey)}: ${parts.join(', ')}` });
                  }
                }
              } catch {
                showToast({ type: 'error', message: t('buddy.evolutionFailed' as TranslationKey) });
              }
            }}
          >
            {'\u{1F31F}'} {t('buddy.checkEvolution' as TranslationKey)}
          </Button>
        </div>
      )}

      {/* Hatch buddy button (when no buddy yet) */}
      {!buddy && (
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-center gap-2 text-xs h-8"
          onClick={async () => {
            try {
              const res = await fetch('/api/workspace/hatch-buddy', { method: 'POST' });
              if (res.ok) {
                // Reload summary to get new buddy data
                window.location.reload();
              }
            } catch { /* ignore */ }
          }}
        >
          🥚 {t('buddy.hatch' as TranslationKey)}
        </Button>
      )}

    </div>
  );
}
