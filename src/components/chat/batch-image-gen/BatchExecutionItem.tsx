'use client';

import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import type { MediaJobItem } from '@/types';

interface BatchExecutionItemProps {
  item: MediaJobItem;
}

export function BatchExecutionItem({ item }: BatchExecutionItemProps) {
  const { t } = useTranslation();

  const statusColor = {
    pending: 'text-muted-foreground',
    processing: 'text-primary',
    completed: 'text-status-success-foreground',
    failed: 'text-status-error-foreground',
    cancelled: 'text-muted-foreground',
  }[item.status];

  const statusLabel = {
    pending: t('batchImageGen.itemPending' as TranslationKey),
    processing: t('batchImageGen.itemProcessing' as TranslationKey),
    completed: t('batchImageGen.itemCompleted' as TranslationKey),
    failed: t('batchImageGen.itemFailed' as TranslationKey),
    cancelled: t('batchImageGen.cancel' as TranslationKey),
  }[item.status];

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/40 bg-background px-3 py-2">
      {/* Index */}
      <span className="text-xs text-muted-foreground font-mono w-6 text-right shrink-0">
        #{item.idx + 1}
      </span>

      {/* Status indicator */}
      <div className="shrink-0">
        {item.status === 'processing' ? (
          <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        ) : item.status === 'completed' ? (
          <div className="w-4 h-4 rounded-full bg-status-success-muted flex items-center justify-center">
            <svg className="w-2.5 h-2.5 text-status-success-foreground" viewBox="0 0 12 12" fill="none">
              <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        ) : item.status === 'failed' ? (
          <div className="w-4 h-4 rounded-full bg-status-error-muted flex items-center justify-center">
            <svg className="w-2.5 h-2.5 text-status-error-foreground" viewBox="0 0 12 12" fill="none">
              <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        ) : (
          <div className="w-4 h-4 rounded-full bg-muted" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-xs text-foreground truncate">{item.prompt}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-muted-foreground">{item.aspect_ratio}</span>
          <span className="text-[10px] text-muted-foreground">{item.image_size}</span>
          <span className={`text-[10px] font-medium ${statusColor}`}>{statusLabel}</span>
          {item.error && (
            <span className="text-[10px] text-status-error-foreground truncate">{item.error}</span>
          )}
        </div>
      </div>

      {/* Retry count */}
      {item.retry_count > 0 && (
        <span className="text-[10px] text-muted-foreground shrink-0">
          retry {item.retry_count}
        </span>
      )}
    </div>
  );
}
