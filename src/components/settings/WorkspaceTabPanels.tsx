"use client";

import { Button } from "@/components/ui/button";
import { SpinnerGap } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import type { FileStatus, TaxonomyCategoryInfo, IndexStats } from "./workspace-types";

const FILE_LABELS: Record<string, string> = {
  claude: "claude.md",
  soul: "soul.md",
  user: "user.md",
  memory: "memory.md",
};

// ── Files Tab ──

interface FilesTabPanelProps {
  files: Record<string, FileStatus>;
  refreshingDocs: boolean;
  onRefreshDocs: () => void;
}

export function FilesTabPanel({ files, refreshingDocs, onRefreshDocs }: FilesTabPanelProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      {Object.entries(FILE_LABELS).map(([key, label]) => {
        const file = files[key];
        return (
          <div key={key} className="flex items-center justify-between text-sm">
            <span className="font-mono text-xs">{label}</span>
            <div className="flex items-center gap-2">
              {file?.exists ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    {t('assistant.fileChars', { count: String(file.chars) })}
                  </span>
                  <span className="h-2 w-2 rounded-full bg-status-success" />
                  <span className="text-xs text-status-success-foreground">{t('assistant.fileExists')}</span>
                </>
              ) : (
                <>
                  <span className="h-2 w-2 rounded-full bg-status-warning" />
                  <span className="text-xs text-status-warning-foreground">{t('assistant.fileMissing')}</span>
                </>
              )}
            </div>
          </div>
        );
      })}
      <div className="flex items-center justify-end mt-3">
        <Button
          variant="outline"
          size="sm"
          onClick={onRefreshDocs}
          disabled={refreshingDocs}
        >
          {refreshingDocs ? (
            <>
              <SpinnerGap size={14} className="animate-spin mr-1" />
              {t('assistant.refreshingDocs')}
            </>
          ) : (
            t('assistant.refreshDocs')
          )}
        </Button>
      </div>
    </div>
  );
}

// ── Taxonomy Tab ──

interface TaxonomyTabPanelProps {
  taxonomy: TaxonomyCategoryInfo[];
}

export function TaxonomyTabPanel({ taxonomy }: TaxonomyTabPanelProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t('assistant.taxonomyDesc')}</p>
      {taxonomy.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">{t('assistant.taxonomyEmpty')}</p>
      ) : (
        <div className="space-y-1.5">
          {taxonomy.map(cat => (
            <div key={cat.id} className="flex items-center justify-between text-xs border border-border/30 rounded px-2 py-1.5">
              <div>
                <span className="font-medium">{cat.label}</span>
                <span className="text-muted-foreground ml-2">{t('assistant.taxonomyRole')}: {cat.role}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{t('assistant.taxonomySource')}: {cat.source}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                  cat.confidence > 0.7 ? 'bg-status-success-muted text-status-success-foreground' :
                  cat.confidence > 0.4 ? 'bg-status-warning-muted text-status-warning-foreground' :
                  'bg-status-error-muted text-status-error-foreground'
                }`}>
                  {Math.round(cat.confidence * 100)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Index Tab ──

interface IndexTabPanelProps {
  indexStats: IndexStats | null;
  reindexing: boolean;
  onReindex: () => void;
}

export function IndexTabPanel({ indexStats, reindexing, onReindex }: IndexTabPanelProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t('assistant.indexDesc')}</p>
      {indexStats ? (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="border border-border/30 rounded px-2 py-1.5">
            <span className="text-muted-foreground">{t('assistant.indexFiles', { count: String(indexStats.fileCount) })}</span>
          </div>
          <div className="border border-border/30 rounded px-2 py-1.5">
            <span className="text-muted-foreground">{t('assistant.indexChunks', { count: String(indexStats.chunkCount) })}</span>
          </div>
          <div className="border border-border/30 rounded px-2 py-1.5">
            <span className="text-muted-foreground">{t('assistant.indexStale', { count: String(indexStats.staleCount) })}</span>
          </div>
          <div className="border border-border/30 rounded px-2 py-1.5">
            <span className="text-muted-foreground">
              {t('assistant.indexLastIndexed')}: {indexStats.lastIndexed ? new Date(indexStats.lastIndexed).toLocaleString() : 'never'}
            </span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic">{t('common.loading')}</p>
      )}
      <div className="flex items-center justify-end mt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onReindex}
          disabled={reindexing}
        >
          {reindexing ? (
            <>
              <SpinnerGap size={14} className="animate-spin mr-1" />
              {t('assistant.indexReindexing')}
            </>
          ) : (
            t('assistant.indexReindex')
          )}
        </Button>
      </div>
    </div>
  );
}

// ── Organize Tab ──

interface OrganizeTabPanelProps {
  archiving: boolean;
  onArchive: () => void;
}

export function OrganizeTabPanel({ archiving, onArchive }: OrganizeTabPanelProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t('assistant.organizeDesc')}</p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onArchive}
          disabled={archiving}
        >
          {archiving ? (
            <>
              <SpinnerGap size={14} className="animate-spin mr-1" />
              {t('assistant.organizeArchiving')}
            </>
          ) : (
            t('assistant.organizeArchive')
          )}
        </Button>
      </div>
    </div>
  );
}
