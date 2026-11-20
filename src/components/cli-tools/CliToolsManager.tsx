"use client";

import { useState, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import type { CliToolDefinition, CliToolRuntimeInfo, CustomCliTool } from "@/types";
import { CliToolCard, computeAgentScore } from "./CliToolCard";
import { CliToolDetailDialog } from "./CliToolDetailDialog";
import { CliToolExtraDetailDialog } from "./CliToolExtraDetailDialog";
// CliToolInstallDialog removed — install now goes through chat AI
import { CliToolBatchDescribeDialog } from "./CliToolBatchDescribeDialog";
import { SpinnerGap, Warning } from "@/components/ui/icon";
import { CodePilotIcon } from "@/components/ui/semantic-icon";
import { Button } from "@/components/ui/button";
import { EXTRA_WELL_KNOWN_BINS } from "@/lib/cli-tools-catalog";

type AutoDescCache = Record<string, { zh: string; en: string; structured?: unknown }>;

interface CliToolsManagerProps {
  /**
   * `standalone` (default) renders the legacy page chrome (title +
   * description + Add Tool button). `embedded` strips that — the
   * unified `/plugins` ExtensionsPage owns the surrounding layout
   * (title, search, create dropdown) and triggers add via the
   * imperative ref.
   */
  variant?: "standalone" | "embedded";
  /**
   * Reports the installed-tool count (catalog installed + extra
   * detected + custom) to the host page so the unified filter pill
   * can render "CLI (N)". Recommended (not-installed) tools are
   * excluded — the user views them as "available", not "owned".
   */
  onCountChange?: (count: number) => void;
  /**
   * Free-text filter from the unified ExtensionsPage search box.
   * Filters installed (catalog + system-detected + custom) and
   * recommended lists by name + description. Empty = show everything.
   */
  search?: string;
}

export interface CliToolsManagerHandle {
  /** Trigger the add-tool flow (currently a chat prefill nav). */
  addTool: () => void;
}

export const CliToolsManager = forwardRef<CliToolsManagerHandle, CliToolsManagerProps>(function CliToolsManager(
  { variant = "standalone", onCountChange, search = "" },
  ref,
) {
  const { t, locale } = useTranslation();
  const router = useRouter();
  const [catalog, setCatalog] = useState<CliToolDefinition[]>([]);
  const [runtimeInfos, setRuntimeInfos] = useState<CliToolRuntimeInfo[]>([]);
  const [extraDetected, setExtraDetected] = useState<CliToolRuntimeInfo[]>([]);
  const [platform, setPlatform] = useState<string>('');
  const [hasBrew, setHasBrew] = useState(true);
  const [loading, setLoading] = useState(true);
  const [autoDescriptions, setAutoDescriptions] = useState<AutoDescCache>({});
  const [customTools, setCustomTools] = useState<CustomCliTool[]>([]);

  // Dialog state
  const [detailTool, setDetailTool] = useState<{ tool: CliToolDefinition; canInstall: boolean } | null>(null);
  const [extraDetailTool, setExtraDetailTool] = useState<{ displayName: string; runtimeInfo: CliToolRuntimeInfo } | null>(null);
  // installTool state removed — install now navigates to chat
  const [batchDescribeOpen, setBatchDescribeOpen] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [catalogRes, installedRes] = await Promise.all([
        fetch('/api/cli-tools/catalog'),
        fetch('/api/cli-tools/installed'),
      ]);
      const catalogData = await catalogRes.json();
      const installedData = await installedRes.json();
      setCatalog(catalogData.tools || []);
      setRuntimeInfos(installedData.tools || []);
      setExtraDetected(installedData.extra || []);
      setPlatform(installedData.platform || '');
      setHasBrew(installedData.hasBrew !== false);
      setCustomTools(installedData.custom || []);

      // Load descriptions from DB (returned by installed API)
      const dbDescs: AutoDescCache = installedData.descriptions || {};
      setAutoDescriptions(dbDescs);

      // One-time migration: if localStorage still has cached descriptions, push them to DB
      try {
        const cached = localStorage.getItem('cli-tools-auto-desc');
        if (cached) {
          const localDescs = JSON.parse(cached) as AutoDescCache;
          // Merge: local descriptions that are not yet in DB
          const toMigrate: AutoDescCache = {};
          for (const [id, desc] of Object.entries(localDescs)) {
            if (!dbDescs[id] && desc?.zh && desc?.en) {
              toMigrate[id] = desc;
            }
          }
          if (Object.keys(toMigrate).length > 0) {
            const migrateRes = await fetch('/api/cli-tools/descriptions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ descriptions: toMigrate }),
            });
            if (migrateRes.ok) {
              setAutoDescriptions(prev => ({ ...prev, ...toMigrate }));
              localStorage.removeItem('cli-tools-auto-desc');
            }
            // If migration failed, keep localStorage intact for next attempt
          } else {
            // Nothing to migrate — all already in DB, safe to clean up
            localStorage.removeItem('cli-tools-auto-desc');
          }
        }
      } catch { /* migration is best-effort */ }
    } catch (err) {
      console.error('Failed to fetch CLI tools data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const getRuntimeInfo = (toolId: string): CliToolRuntimeInfo | undefined => {
    return runtimeInfos.find(r => r.id === toolId);
  };

  const installedCatalogTools = catalog.filter(t => {
    const info = getRuntimeInfo(t.id);
    return info && info.status !== 'not_installed';
  });

  const recommendedTools = catalog.filter(t => {
    const info = getRuntimeInfo(t.id);
    return !info || info.status === 'not_installed';
  });

  // Search filter — runs against name + summary (catalog) or
  // displayName + id + AI-generated description (extra/custom). The
  // global ExtensionsPage search box scopes to whatever the active tab
  // shows, so the filter is per-list.
  const query = search.trim().toLowerCase();
  const matchesQuery = (...fields: Array<string | undefined>) => {
    if (!query) return true;
    return fields.some(f => f && f.toLowerCase().includes(query));
  };
  const filteredInstalledCatalog = installedCatalogTools.filter(tool =>
    matchesQuery(tool.name, tool.summaryZh, tool.summaryEn, tool.id)
  );
  const filteredExtraDetected = extraDetected.filter(info => {
    const entry = EXTRA_WELL_KNOWN_BINS.find(([eid]) => eid === info.id);
    const displayName = entry?.[1] ?? info.id;
    const desc = autoDescriptions[info.id];
    return matchesQuery(displayName, info.id, desc?.zh, desc?.en);
  });
  const filteredCustomTools = customTools.filter(ct => {
    const desc = autoDescriptions[ct.id];
    return matchesQuery(ct.name, ct.id, ct.binPath, desc?.zh, desc?.en);
  });
  const filteredRecommended = recommendedTools.filter(tool =>
    matchesQuery(tool.name, tool.summaryZh, tool.summaryEn, tool.id)
  );
  const installedHasMatches =
    filteredInstalledCatalog.length + filteredExtraDetected.length + filteredCustomTools.length > 0;

  // Report installed count to the host page so the unified
  // ExtensionsPage filter pill can render "CLI (N)". Sums catalog
  // installs + system-detected extras + user-added custom tools.
  // Gated on `!loading` to avoid a cold mount shipping 0 to the host
  // before the catalog/installed fetch returns.
  const installedCount = installedCatalogTools.length + extraDetected.length + customTools.length;
  useEffect(() => {
    if (loading) return;
    onCountChange?.(installedCount);
  }, [installedCount, loading, onCountChange]);

  // Tool IDs for batch describe: extra + custom (catalog tools already have built-in descriptions)
  const batchDescribeToolIds = [
    ...extraDetected.map(e => e.id),
    ...customTools.map(ct => ct.id),
  ];

  const handleInstall = (tool: CliToolDefinition, method: string) => {
    const installMethod = tool.installMethods.find(m => m.method === method);
    const installCmd = installMethod?.command || `${method} install ${tool.id}`;

    const lines: string[] = [];
    lines.push(t('cliTools.installPrefillTitle', { name: tool.name }));
    lines.push(t('cliTools.installPrefillCmd', { cmd: installCmd }));
    lines.push(t('cliTools.installPrefillSudo'));

    // Include required post-install commands (e.g. skills install) that AI can't discover from --help
    if (tool.postInstallCommands && tool.postInstallCommands.length > 0) {
      lines.push('');
      lines.push(t('cliTools.installPrefillPost'));
      tool.postInstallCommands.forEach(cmd => lines.push(cmd));
    }

    // For tools that need auth, hint that setup is needed — let AI determine steps from --help
    if (tool.setupType === 'needs_auth') {
      lines.push('');
      lines.push(t('cliTools.installPrefillAuthNote'));
    }

    window.location.href = `/chat?prefill=${encodeURIComponent(lines.join('\n'))}`;
  };

  const handleAddTool = useCallback(() => {
    const prefill = t('cliTools.addToolPrefill');
    // Use hard navigation to ensure the new page reads the prefill param fresh
    window.location.href = `/chat?prefill=${encodeURIComponent(prefill)}`;
  }, [t]);

  // Imperative API consumed by ExtensionsPage's create dropdown.
  useImperativeHandle(ref, () => ({ addTool: handleAddTool }), [handleAddTool]);

  const isEmbedded = variant === "embedded";

  const handleDeleteCustomTool = async (id: string) => {
    try {
      await fetch(`/api/cli-tools/custom/${id}`, { method: 'DELETE' });
      fetchData();
    } catch (err) {
      console.error('Failed to delete custom tool:', err);
    }
  };

  const handleBatchDescribeComplete = (results: AutoDescCache) => {
    // Descriptions are already persisted by the describe API route.
    // Merge into local state for immediate UI update.
    setAutoDescriptions(prev => ({ ...prev, ...results }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <SpinnerGap size={24} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isEmbedded) {
    // ExtensionsPage owns title / description / add button; we only
    // render the body. No outer flex column either — the parent
    // already provides scroll + padding.
    return (
      <div className="flex flex-col gap-6">

      {/* Installed — catalog tools + extra system-detected tools + custom tools.
          When a search filters everything out, swallow the section
          entirely so an empty header doesn't read as broken. */}
      {(installedCatalogTools.length > 0 || extraDetected.length > 0 || customTools.length > 0) && (query ? installedHasMatches : true) && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-muted-foreground">{t('cliTools.installed')}</h2>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={() => setBatchDescribeOpen(true)}
              >
                <CodePilotIcon name="assistant" size="sm" aria-hidden />
                {t('cliTools.batchDescribe')}
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Catalog tools that are installed */}
            {filteredInstalledCatalog.map(tool => (
              <CliToolCard
                key={tool.id}
                tool={tool}
                runtimeInfo={getRuntimeInfo(tool.id)!}
                variant="installed"
                autoDescription={autoDescriptions[tool.id]}
                onDetail={() => setDetailTool({ tool, canInstall: false })}
                locale={locale}
                platform={platform}
              />
            ))}
            {/* Extra system-detected tools (not in catalog) */}
            {filteredExtraDetected.map(info => {
              const entry = EXTRA_WELL_KNOWN_BINS.find(([eid]) => eid === info.id);
              const displayName = entry?.[1] ?? info.id;
              const desc = autoDescriptions[info.id];
              const compat = (desc?.structured as Record<string, unknown>)?.agentCompat as Record<string, boolean> | undefined;
              const score = compat ? computeAgentScore(compat) : 0;
              return (
                <div
                  key={info.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setExtraDetailTool({ displayName, runtimeInfo: info })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setExtraDetailTool({ displayName, runtimeInfo: info });
                    }
                  }}
                  aria-label={`${displayName} — ${desc ? (locale === 'zh' ? desc.zh : desc.en) : t('cliTools.systemDetected')}`}
                  className="rounded-lg bg-card border border-border/50 p-5 cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium text-sm truncate min-w-0 max-w-full">{displayName}</h3>
                    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0">
                      {t('cliTools.systemDetected')}
                    </span>
                    {info.version && (
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        v{info.version}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed line-clamp-3">
                    {desc
                      ? (locale === 'zh' ? desc.zh : desc.en)
                      : t('cliTools.noDescription' as TranslationKey)}
                  </p>
                  {score > 0 && (
                    <div className="flex items-center gap-1 mt-3">
                      <span className="text-[10px] text-muted-foreground">{t('cliTools.agentFriendliness' as TranslationKey)}</span>
                      <div className="flex gap-0.5">
                        {[1, 2, 3, 4, 5].map(i => (
                          <CodePilotIcon key={i} name="rating" size={10} strokeWidth={i <= score ? 2 : undefined} className={i <= score ? 'text-primary' : 'text-muted-foreground/30'} aria-hidden />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {/* Custom user-added tools */}
            {filteredCustomTools.map(ct => {
              const desc = autoDescriptions[ct.id];
              const compat = (desc?.structured as Record<string, unknown>)?.agentCompat as Record<string, boolean> | undefined;
              const openCustomDetail = () => setExtraDetailTool({
                displayName: ct.name,
                runtimeInfo: { id: ct.id, status: 'installed', version: ct.version, binPath: ct.binPath },
              });
              const score = compat ? computeAgentScore(compat) : 0;
              return (
                <div
                  key={ct.id}
                  role="button"
                  tabIndex={0}
                  onClick={openCustomDetail}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openCustomDetail();
                    }
                  }}
                  aria-label={`${ct.name} — ${desc ? (locale === 'zh' ? desc.zh : desc.en) : ct.binPath}`}
                  className="group rounded-lg bg-card border border-border/50 p-5 cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium text-sm truncate min-w-0 max-w-full">{ct.name}</h3>
                    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0">
                      {t('cliTools.customTool' as TranslationKey)}
                    </span>
                    {ct.version && (
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        v{ct.version}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed line-clamp-3">
                    {desc
                      ? (locale === 'zh' ? desc.zh : desc.en)
                      : ct.binPath}
                  </p>
                  <div className="flex items-center justify-between mt-3 gap-2">
                    {score > 0 ? (
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-muted-foreground">{t('cliTools.agentFriendliness' as TranslationKey)}</span>
                        <div className="flex gap-0.5">
                          {[1, 2, 3, 4, 5].map(i => (
                            <CodePilotIcon key={i} name="rating" size={10} strokeWidth={i <= score ? 2 : undefined} className={i <= score ? 'text-primary' : 'text-muted-foreground/30'} aria-hidden />
                          ))}
                        </div>
                      </div>
                    ) : (
                      <span />
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => { e.stopPropagation(); handleDeleteCustomTool(ct.id); }}
                      className="opacity-0 group-hover:opacity-100 shrink-0 h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                      title={`${t('cliTools.removeCustomTool' as TranslationKey)} ${ct.name}`}
                      aria-label={`${t('cliTools.removeCustomTool' as TranslationKey)} ${ct.name}`}
                    >
                      <CodePilotIcon name="delete" size="sm" aria-hidden />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Recommended (not installed). Hidden when search filters
          everything out so we don't show an empty 推荐 header. */}
      {(query ? filteredRecommended.length > 0 : true) && (
      <section>
        <h2 className="text-sm font-medium text-muted-foreground mb-3">{t('cliTools.recommended')}</h2>

        {/* Brew not installed warning */}
        {!hasBrew && (platform === 'darwin' || platform === 'linux') && (
          <div className="flex items-start gap-2 rounded-lg border border-status-warning-border bg-status-warning-muted px-3 py-2.5 mb-3">
            <Warning size={16} className="text-status-warning-foreground shrink-0 mt-0.5" />
            <div className="text-xs text-muted-foreground">
              <p className="font-medium text-foreground mb-1">{t('cliTools.brewNotInstalled')}</p>
              <p>{t('cliTools.brewInstallGuide')}</p>
              <code className="block mt-1.5 bg-muted/50 rounded px-2 py-1 text-[11px] font-mono select-all">
                /bin/bash -c &quot;$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)&quot;
              </code>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredRecommended.map(tool => (
            <CliToolCard
              key={tool.id}
              tool={tool}
              runtimeInfo={getRuntimeInfo(tool.id)}
              variant="recommended"
              onDetail={() => setDetailTool({ tool, canInstall: true })}
              onInstall={handleInstall}
              locale={locale}
              platform={platform}
            />
          ))}
        </div>
        {recommendedTools.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('cliTools.allInstalled')}</p>
        )}
      </section>
      )}

      {/* When search hides every section, render a single empty-state
          line so the user knows the search is the cause. */}
      {query && !installedHasMatches && filteredRecommended.length === 0 && (
        <p className="text-sm text-muted-foreground py-8 text-center">
          {t('plugins.search.noResults' as TranslationKey)}
        </p>
      )}

      {/* Detail dialog */}
      {detailTool && (
        <CliToolDetailDialog
          open={!!detailTool}
          onOpenChange={(open) => !open && setDetailTool(null)}
          tool={detailTool.tool}
          locale={locale}
          onInstall={detailTool.canInstall ? handleInstall : undefined}
          platform={platform}
        />
      )}

      {/* Extra tool detail dialog */}
      {extraDetailTool && (
        <CliToolExtraDetailDialog
          open={!!extraDetailTool}
          onOpenChange={(open) => !open && setExtraDetailTool(null)}
          displayName={extraDetailTool.displayName}
          runtimeInfo={extraDetailTool.runtimeInfo}
          autoDescription={autoDescriptions[extraDetailTool.runtimeInfo.id]}
          locale={locale}
        />
      )}


      {/* Batch AI describe dialog */}
      <CliToolBatchDescribeDialog
        open={batchDescribeOpen}
        onOpenChange={setBatchDescribeOpen}
        toolIds={batchDescribeToolIds}
        existingDescriptions={autoDescriptions}
        onComplete={handleBatchDescribeComplete}
      />

      </div>
    );
  }

  // Standalone path — only reached if a future caller mounts without
  // `variant="embedded"`. /cli-tools redirects to /plugins#cli already,
  // so this is just a defensive fallback that wraps the embedded body.
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border/50 px-6 pt-4 pb-4">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold">{t('cliTools.title')}</h1>
            <p className="text-sm text-muted-foreground mt-1">{t('cliTools.description')}</p>
          </div>
          <Button size="sm" className="gap-1.5 shrink-0" onClick={handleAddTool}>
            <CodePilotIcon name="plus" size="sm" aria-hidden />
            {t('cliTools.addTool' as TranslationKey)}
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <p className="text-xs text-muted-foreground italic">
          Standalone CLI Tools view is deprecated — use /plugins#cli.
        </p>
      </div>
    </div>
  );
});
