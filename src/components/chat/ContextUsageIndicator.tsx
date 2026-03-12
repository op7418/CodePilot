'use client';

import type { Message } from '@/types';
import { useContextUsage } from '@/hooks/useContextUsage';
import { useTranslation } from '@/hooks/useTranslation';
import { Button } from '@/components/ui/button';
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from '@/components/ui/hover-card';

interface ContextUsageIndicatorProps {
  messages: Message[];
  modelName: string;
}

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

export function ContextUsageIndicator({ messages, modelName }: ContextUsageIndicatorProps) {
  const { t } = useTranslation();
  const usage = useContextUsage(messages, modelName);

  const size = 16;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - usage.ratio * circumference;

  // Color based on usage ratio — used portion is dark gray by default
  let strokeColor = 'text-muted-foreground';
  if (usage.hasData) {
    if (usage.ratio > 0.8) strokeColor = 'text-status-error-foreground';
    else if (usage.ratio > 0.6) strokeColor = 'text-status-warning-foreground';
    else strokeColor = 'text-zinc-600 dark:text-zinc-400';
  }

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Button variant="ghost" size="icon-xs" className="p-1">
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block">
            {/* Background circle */}
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={strokeWidth}
              className="stroke-muted"
            />
            {/* Usage arc */}
            {usage.hasData && usage.ratio > 0 && (
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                strokeWidth={strokeWidth}
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                strokeLinecap="round"
                className={`${strokeColor} transition-all`}
                style={{ stroke: 'currentColor' }}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />
            )}
          </svg>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="center" className="w-56 p-3 text-xs">
        {!usage.hasData ? (
          <p className="text-muted-foreground">{t('context.noData')}</p>
        ) : (
          <div className="space-y-1.5">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('context.model')}</span>
              <span className="font-medium">{usage.modelName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('context.used')}</span>
              <span className="font-medium">{formatTokens(usage.used)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('context.total')}</span>
              <span className="font-medium">
                {usage.contextWindow ? formatTokens(usage.contextWindow) : t('context.unknown')}
              </span>
            </div>
            {usage.contextWindow && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('context.percentage')}</span>
                <span className="font-medium">{(usage.ratio * 100).toFixed(1)}%</span>
              </div>
            )}
            <div className="border-t border-border pt-1.5 mt-1.5 space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('context.cacheRead')}</span>
                <span>{formatTokens(usage.cacheReadTokens)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('context.cacheCreation')}</span>
                <span>{formatTokens(usage.cacheCreationTokens)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('context.outputTokens')}</span>
                <span>{formatTokens(usage.outputTokens)}</span>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground pt-1 border-t border-border">
              {t('context.estimate')}
            </p>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
