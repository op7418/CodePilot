'use client';

import { useBatchImageGen } from '@/hooks/useBatchImageGen';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import { Button } from '@/components/ui/button';
import { BatchExecutionItem } from './BatchExecutionItem';

export function BatchExecutionDashboard() {
  const { state, pauseJob, resumeJob, cancelJob, retryFailed } = useBatchImageGen();
  const { t } = useTranslation();

  if (state.phase !== 'executing' && state.phase !== 'completed') return null;

  const { progress, items, currentJob } = state;
  const isPaused = currentJob?.status === 'paused';
  const isRunning = currentJob?.status === 'running';
  const isCompleted = state.phase === 'completed';
  const progressPercent = progress.total > 0
    ? Math.round(((progress.completed + progress.failed) / progress.total) * 100)
    : 0;

  const hasFailedItems = items.some(i => i.status === 'failed');

  return (
    <div className="rounded-xl border border-purple-500/20 bg-card overflow-hidden">
      {/* Header with progress */}
      <div className="px-4 py-3 border-b border-border/40 bg-purple-500/5">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-foreground">
            {t('batchImageGen.totalProgress' as TranslationKey)}
          </h3>
          <span className="text-xs text-muted-foreground">
            {progress.completed}/{progress.total}
            {progress.failed > 0 && (
              <span className="text-status-error-foreground ml-1">({progress.failed} failed)</span>
            )}
          </span>
        </div>

        {/* Progress bar */}
        <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${progressPercent}%`,
              background: progress.failed > 0
                ? 'linear-gradient(90deg, rgb(168, 85, 247) 0%, rgb(239, 68, 68) 100%)'
                : 'rgb(168, 85, 247)',
            }}
          />
        </div>
      </div>

      {/* Item list */}
      <div className="p-3 space-y-1.5 max-h-[400px] overflow-y-auto">
        {items.map(item => (
          <BatchExecutionItem key={item.id} item={item} />
        ))}
      </div>

      {/* Controls */}
      <div className="px-4 py-3 border-t border-border/40 flex items-center gap-2">
        {isRunning && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={pauseJob}
              className="text-xs border-border/40 hover:bg-accent/50"
            >
              {t('batchImageGen.pause' as TranslationKey)}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={cancelJob}
              className="text-xs border-status-error-border text-status-error-foreground hover:bg-status-error-muted"
            >
              {t('batchImageGen.cancel' as TranslationKey)}
            </Button>
          </>
        )}

        {isPaused && (
          <>
            <Button
              size="sm"
              onClick={resumeJob}
              className="text-xs bg-purple-600 text-white hover:bg-purple-700"
            >
              {t('batchImageGen.resume' as TranslationKey)}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={cancelJob}
              className="text-xs border-status-error-border text-status-error-foreground hover:bg-status-error-muted"
            >
              {t('batchImageGen.cancel' as TranslationKey)}
            </Button>
          </>
        )}

        {isCompleted && hasFailedItems && (
          <Button
            variant="outline"
            size="sm"
            onClick={retryFailed}
            className="text-xs border-border/40 hover:bg-accent/50"
          >
            {t('batchImageGen.retryFailed' as TranslationKey)}
          </Button>
        )}

        {state.error && (
          <p className="text-xs text-status-error-foreground ml-2">{state.error}</p>
        )}
      </div>
    </div>
  );
}
