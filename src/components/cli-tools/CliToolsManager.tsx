"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import type { CliToolDefinition, CliToolRuntimeInfo, CustomCliTool } from "@/types";
import { CliToolCard, computeAgentScore } from "./CliToolCard";
import { CliToolDetailDialog } from "./CliToolDetailDialog";
import { CliToolExtraDetailDialog } from "./CliToolExtraDetailDialog";
// CliToolInstallDialog removed — install now goes through chat AI
import { CliToolBatchDescribeDialog } from "./CliToolBatchDescribeDialog";
import { SpinnerGap, Sparkle, ArrowSquareOut, Warning, Plus, Trash, Star } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { EXTRA_WELL_KNOWN_BINS } from "@/lib/cli-tools-catalog";

type AutoDescCache = Record<string, { zh: string; en: string; structured?: unknown }>;

export function CliToolsManager() {
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

  // Tool IDs for batch describe: extra + custom (catalog tools already have built-in descriptions)
  const batchDescribeToolIds = [
    ...extraDetected.map(e => e.id),
    ...customTools.map(ct => ct.id),
  ];

  const handleInstall = (tool: CliToolDefinition, method: string) => {
    const installMethod = tool.installMethods.find(m => m.method === method);
    const installCmd = installMethod?.command || `${method} install ${tool.id}`;
    const isZh = locale === 'zh';

    const lines: string[] = [];
    lines.push(isZh
      ? `帮我安装 ${tool.name} 并添加到工具库。`
      : `Install ${tool.name} and add it to the tool library.`);
    lines.push(isZh ? `安装命令：${installCmd}` : `Install command: ${installCmd}`);
    lines.push(isZh ? '如果权限不足请用 sudo 重试。' : 'If permission denied, retry with sudo.');

    // Include required post-install commands (e.g. skills install) that AI can't discover from --help
    if (tool.postInstallCommands && tool.postInstallCommands.length > 0) {
      lines.push('');
      lines.push(isZh ? '安装后还需要执行：' : 'After installing, also run:');
      tool.postInstallCommands.forEach(cmd => lines.push(cmd));
    }

    // For tools that need auth, hint that setup is needed — let AI determine steps from --help
    if (tool.setupType === 'needs_auth') {
      lines.push('');
      lines.push(isZh
        ? '注意：这个工具安装后需要登录或配置认证才能使用，请安装完成后引导我完成认证设置。'
        : 'Note: This tool requires login or auth configuration after installation. Please guide me through the setup after installing.');
    }

    window.location.href = `/chat?prefill=${encodeURIComponent(lines.join('\n'))}`;
  };

  const handleAddTool = () => {
    const prefill = locale === 'zh'
      ? '我想安装一个新的 CLI 工具并添加到工具库。\n工具名称：\n安装命令（如 brew install xxx）：'
      : 'I want to install a new CLI tool and add it to my tool library.\nTool name: \nInstall command (e.g. brew install xxx): ';
    // Use hard navigation to ensure the new page reads the prefill param fresh
    window.location.href = `/chat?prefill=${encodeURIComponent(prefill)}`;
  };

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

  return (
    <div className="flex h-full flex-col">
      {/* Fixed header */}
      <div className="shrink-0 border-b border-border/50 px-6 pt-4 pb-4">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold">{t('cliTools.title')}</h1>
            <p className="text-sm text-muted-foreground mt-1">{t('cliTools.description')}</p>
          </div>
          <Button
            size="sm"
            className="gap-1.5 shrink-0"
            onClick={handleAddTool}
          >
            <Plus size={14} />
            {t('cliTools.addTool' as TranslationKey)}
          </Button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-6">
      <div className="flex flex-col gap-6">

      {/* Installed — catalog tools + extra system-detected tools + custom tools */}
      {(installedCatalogTools.length > 0 || extraDetected.length > 0 || customTools.length > 0) && (
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
                <Sparkle size={14} />
                {t('cliTools.batchDescribe')}
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {/* Catalog tools that are installed */}
            {installedCatalogTools.map(tool => (
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
            {extraDetected.map(info => {
              const entry = EXTRA_WELL_KNOWN_BINS.find(([eid]) => eid === info.id);
              const displayName = entry?.[1] ?? info.id;
              const desc = autoDescriptions[info.id];
              const compat = (desc?.structured as Record<string, unknown>)?.agentCompat as Record<string, boolean> | undefined;
              return (
                <div
                  key={info.id}
                  className="flex items-center gap-3 rounded-lg border border-border/40 px-3 py-2.5 hover:bg-muted/50 cursor-pointer transition-colors"
                  onClick={() => setExtraDetailTool({ displayName, runtimeInfo: info })}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-sm truncate">{displayName}</h3>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0">
                        {t('cliTools.systemDetected')}
                      </span>
                      {info.version && (
                        <span className="text-xs text-muted-foreground shrink-0">
                          v{info.version}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {desc
                        ? (locale === 'zh' ? desc.zh : desc.en)
                        : t('cliTools.noDescription' as TranslationKey)}
                    </p>
                    {compat && (() => {
                      const score = computeAgentScore(compat);
                      if (score === 0) return null;
                      return (
                        <div className="flex items-center gap-1 mt-1">
                          <span className="text-xs text-muted-foreground">{t('cliTools.agentFriendliness' as TranslationKey)}</span>
                          <div className="flex gap-0.5">
                            {[1,2,3,4,5].map(i => (
                              <Star key={i} size={10} weight={i <= score ? 'fill' : 'regular'} className={i <= score ? 'text-primary' : 'text-muted-foreground/30'} />
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
            {/* Custom user-added tools */}
            {customTools.map(ct => {
              const desc = autoDescriptions[ct.id];
              const compat = (desc?.structured as Record<string, unknown>)?.agentCompat as Record<string, boolean> | undefined;
              return (
                <div
                  key={ct.id}
                  className="flex items-center gap-3 rounded-lg border border-border/40 px-3 py-2.5 hover:bg-muted/50 cursor-pointer transition-colors group"
                  onClick={() => setExtraDetailTool({
                    displayName: ct.name,
                    runtimeInfo: { id: ct.id, status: 'installed', version: ct.version, binPath: ct.binPath },
                  })}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-sm truncate">{ct.name}</h3>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0">
                        {t('cliTools.customTool' as TranslationKey)}
                      </span>
                      {ct.version && (
                        <span className="text-xs text-muted-foreground shrink-0">
                          v{ct.version}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {desc
                        ? (locale === 'zh' ? desc.zh : desc.en)
                        : ct.binPath}
                    </p>
                    {compat && (() => {
                      const score = computeAgentScore(compat);
                      if (score === 0) return null;
                      return (
                        <div className="flex items-center gap-1 mt-1">
                          <span className="text-xs text-muted-foreground">{t('cliTools.agentFriendliness' as TranslationKey)}</span>
                          <div className="flex gap-0.5">
                            {[1,2,3,4,5].map(i => (
                              <Star key={i} size={10} weight={i <= score ? 'fill' : 'regular'} className={i <= score ? 'text-primary' : 'text-muted-foreground/30'} />
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => { e.stopPropagation(); handleDeleteCustomTool(ct.id); }}
                    className="opacity-0 group-hover:opacity-100 shrink-0 h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                    title={t('cliTools.removeCustomTool' as TranslationKey)}
                  >
                    <Trash size={14} />
                  </Button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Recommended (not installed) */}
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

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          {recommendedTools.map(tool => (
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

      {/* Docs link */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground pt-2">
        <ArrowSquareOut size={12} />
        <a
          href={locale === 'zh' ? 'https://www.codepilot.sh/zh/docs' : 'https://www.codepilot.sh/docs'}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground hover:underline transition-colors"
        >
          {t('cliTools.viewDocs')}
        </a>
      </div>

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
      </div>
    </div>
  );
}
