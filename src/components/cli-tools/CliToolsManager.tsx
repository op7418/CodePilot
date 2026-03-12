"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import type { CliToolDefinition, CliToolRuntimeInfo } from "@/types";
import { CliToolCard } from "./CliToolCard";
import { CliToolDetailDialog } from "./CliToolDetailDialog";
import { CliToolExtraDetailDialog } from "./CliToolExtraDetailDialog";
import { CliToolInstallDialog } from "./CliToolInstallDialog";
import { CliToolBatchDescribeDialog } from "./CliToolBatchDescribeDialog";
import { SpinnerGap, Sparkle, ArrowSquareOut, Warning } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { EXTRA_WELL_KNOWN_BINS } from "@/lib/cli-tools-catalog";

type AutoDescCache = Record<string, { zh: string; en: string }>;

export function CliToolsManager() {
  const { t, locale } = useTranslation();
  const [catalog, setCatalog] = useState<CliToolDefinition[]>([]);
  const [runtimeInfos, setRuntimeInfos] = useState<CliToolRuntimeInfo[]>([]);
  const [extraDetected, setExtraDetected] = useState<CliToolRuntimeInfo[]>([]);
  const [platform, setPlatform] = useState<string>('');
  const [hasBrew, setHasBrew] = useState(true);
  const [loading, setLoading] = useState(true);
  const [autoDescriptions, setAutoDescriptions] = useState<AutoDescCache>({});

  // Dialog state
  const [detailTool, setDetailTool] = useState<{ tool: CliToolDefinition; canInstall: boolean } | null>(null);
  const [extraDetailTool, setExtraDetailTool] = useState<{ displayName: string; runtimeInfo: CliToolRuntimeInfo } | null>(null);
  const [installTool, setInstallTool] = useState<{ tool: CliToolDefinition; method: string } | null>(null);
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
    } catch (err) {
      console.error('Failed to fetch CLI tools data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    // Load cached auto-descriptions from localStorage
    try {
      const cached = localStorage.getItem('cli-tools-auto-desc');
      if (cached) setAutoDescriptions(JSON.parse(cached));
    } catch { /* ignore */ }
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

  // Only extra-detected tool IDs for batch describe (catalog tools already have descriptions)
  const extraToolIds = extraDetected.map(e => e.id);

  const handleInstall = (tool: CliToolDefinition, method: string) => {
    setInstallTool({ tool, method });
  };

  const handleInstallComplete = () => {
    setInstallTool(null);
    fetchData();
  };

  const handleBatchDescribeComplete = (results: AutoDescCache) => {
    const merged = { ...autoDescriptions, ...results };
    setAutoDescriptions(merged);
    localStorage.setItem('cli-tools-auto-desc', JSON.stringify(merged));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <SpinnerGap size={24} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 overflow-y-auto">
      <div>
        <h1 className="text-xl font-semibold">{t('cliTools.title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t('cliTools.description')}</p>
      </div>

      {/* Installed — catalog tools + extra system-detected tools merged */}
      {(installedCatalogTools.length > 0 || extraDetected.length > 0) && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-muted-foreground">{t('cliTools.installed')}</h2>
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
              return (
                <div
                  key={info.id}
                  className="flex items-center gap-3 rounded-lg border border-border/40 px-3 py-2.5 hover:bg-muted/50 cursor-pointer transition-colors"
                  onClick={() => setExtraDetailTool({ displayName, runtimeInfo: info })}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-sm truncate">{displayName}</h3>
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
                  </div>
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

      {/* Install dialog */}
      {installTool && (
        <CliToolInstallDialog
          open={!!installTool}
          onOpenChange={(open) => !open && setInstallTool(null)}
          tool={installTool.tool}
          method={installTool.method}
          onComplete={handleInstallComplete}
        />
      )}

      {/* Batch AI describe dialog */}
      <CliToolBatchDescribeDialog
        open={batchDescribeOpen}
        onOpenChange={setBatchDescribeOpen}
        toolIds={extraToolIds}
        existingDescriptions={autoDescriptions}
        onComplete={handleBatchDescribeComplete}
      />
    </div>
  );
}
