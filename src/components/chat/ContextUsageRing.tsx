import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DEFAULT_MAX_CONTEXT,
  RING_CIRCUMFERENCE,
  getContextUsageColor,
  getContextUsageRatio,
  getContextUsageTooltip,
} from './context-usage';
import type { TranslationKey } from '@/i18n';

interface ContextUsageRingProps {
  contextTokens?: number;
  contextStale?: boolean;
  maxContext?: number;
  isCompacting?: boolean;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export function ContextUsageRing({
  contextTokens = 0,
  contextStale = false,
  maxContext = DEFAULT_MAX_CONTEXT,
  isCompacting = false,
  t,
}: ContextUsageRingProps) {
  const isContextStale = contextStale && !isCompacting;
  const ratio = getContextUsageRatio(contextTokens, maxContext, isContextStale);
  const offset = RING_CIRCUMFERENCE * (1 - ratio);
  const color = getContextUsageColor(ratio, isCompacting, isContextStale);
  const tooltipText = getContextUsageTooltip(contextTokens, maxContext, isCompacting, isContextStale, t);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-accent/50">
          <svg width="20" height="20" viewBox="0 0 20 20" className="-rotate-90">
            <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground/15" />
            <circle
              cx="10"
              cy="10"
              r="8"
              fill="none"
              stroke={color}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={isContextStale ? `${RING_CIRCUMFERENCE * 0.35} ${RING_CIRCUMFERENCE}` : `${RING_CIRCUMFERENCE}`}
              strokeDashoffset={isCompacting ? RING_CIRCUMFERENCE * 0.25 : offset}
              style={{
                transition: 'stroke-dashoffset 0.4s ease, stroke 0.4s ease',
                ...(isCompacting ? { animation: 'spin 1.5s linear infinite', transformOrigin: 'center' } : {}),
              }}
            />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span className="text-xs">{tooltipText}</span>
      </TooltipContent>
    </Tooltip>
  );
}
