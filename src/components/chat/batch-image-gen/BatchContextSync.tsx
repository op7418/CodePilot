'use client';

import { useState } from 'react';
import { useBatchImageGen } from '@/hooks/useBatchImageGen';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import { Button } from '@/components/ui/button';

export function BatchContextSync() {
  const { state, syncToLlm, resetJob } = useBatchImageGen();
  const { t } = useTranslation();
  const [synced, setSynced] = useState(false);

  if (state.phase !== 'completed' && state.phase !== 'syncing') return null;

  const handleSync = async (syncMode: 'manual' | 'auto_batch' = 'manual') => {
    await syncToLlm(syncMode);
    setSynced(true);
  };

  const isSyncing = state.phase === 'syncing';
  const { progress } = state;

  return (
    <div className="rounded-xl border border-purple-500/20 bg-card overflow-hidden">
      <div className="px-4 py-3 bg-purple-500/5">
        <h3 className="text-sm font-medium text-foreground">
          {t('batchImageGen.completed' as TranslationKey)}
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          {t('batchImageGen.completedStats' as TranslationKey)
            .replace('{completed}', String(progress.completed))
            .replace('{total}', String(progress.total))
          }
        </p>
      </div>

      <div className="px-4 py-3 flex items-center gap-2">
        {!synced ? (
          <>
            <Button
              size="sm"
              onClick={() => handleSync('manual')}
              disabled={isSyncing}
              className="text-xs bg-purple-600 text-white hover:bg-purple-700"
            >
              {isSyncing ? '...' : t('batchImageGen.syncToChat' as TranslationKey)}
            </Button>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={resetJob}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {t('common.close' as TranslationKey)}
            </Button>
          </>
        ) : (
          <>
            <span className="text-xs text-status-success-foreground">
              {t('batchImageGen.syncComplete' as TranslationKey)}
            </span>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={resetJob}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {t('common.close' as TranslationKey)}
            </Button>
          </>
        )}

        {state.error && (
          <p className="text-xs text-status-error-foreground">{state.error}</p>
        )}
      </div>
    </div>
  );
}
