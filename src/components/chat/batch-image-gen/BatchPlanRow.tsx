'use client';

import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import type { PlannerItem } from '@/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '21:9'];
const RESOLUTIONS = ['1K', '2K', '4K'];

interface BatchPlanRowProps {
  item: PlannerItem;
  index: number;
  onUpdate: (index: number, updates: Partial<PlannerItem>) => void;
  onRemove: (index: number) => void;
  disabled?: boolean;
}

export function BatchPlanRow({ item, index, onUpdate, onRemove, disabled }: BatchPlanRowProps) {
  const { t } = useTranslation();

  return (
    <div className="group rounded-lg border border-border/60 bg-background p-3 space-y-2 hover:border-border transition-colors">
      <div className="flex items-start gap-2">
        <span className="mt-1 text-xs text-muted-foreground font-mono shrink-0 w-6 text-right">
          #{index + 1}
        </span>
        <div className="flex-1 min-w-0">
          {/* Prompt */}
          <Textarea
            value={item.prompt}
            onChange={e => onUpdate(index, { prompt: e.target.value })}
            className="border-border/40 bg-transparent px-2 py-1.5 text-sm resize-none"
            rows={2}
            disabled={disabled}
            placeholder={t('batchImageGen.prompt' as TranslationKey)}
          />

          {/* Controls Row */}
          <div className="flex items-center gap-2 mt-1.5">
            {/* Aspect Ratio — native select for compact inline use */}
            {/* eslint-disable-next-line no-restricted-syntax */}
            <select
              value={item.aspectRatio}
              onChange={e => onUpdate(index, { aspectRatio: e.target.value })}
              className="rounded-md border border-border/40 bg-transparent px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
              disabled={disabled}
            >
              {ASPECT_RATIOS.map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>

            {/* Resolution — native select for compact inline use */}
            {/* eslint-disable-next-line no-restricted-syntax */}
            <select
              value={item.resolution}
              onChange={e => onUpdate(index, { resolution: e.target.value })}
              className="rounded-md border border-border/40 bg-transparent px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
              disabled={disabled}
            >
              {RESOLUTIONS.map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>

            {/* Tags */}
            {item.tags.length > 0 && (
              <div className="flex items-center gap-1 overflow-hidden">
                {item.tags.map((tag, i) => (
                  <span key={i} className="inline-block rounded-full bg-purple-500/10 text-purple-600 dark:text-purple-400 px-1.5 py-0 text-[10px]">
                    {tag}
                  </span>
                ))}
              </div>
            )}

            <div className="flex-1" />

            {/* Remove */}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onRemove(index)}
              disabled={disabled}
              className="text-[10px] text-muted-foreground hover:text-status-error-foreground opacity-0 group-hover:opacity-100 disabled:opacity-0 h-auto p-0"
            >
              {t('batchImageGen.removeItem' as TranslationKey)}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
