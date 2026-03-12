'use client';

import { cn } from '@/lib/utils';
import { useImageGen } from '@/hooks/useImageGen';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export function ImageGenToggle() {
  const { state, setEnabled } = useImageGen();
  const { t } = useTranslation();

  const handleToggle = () => {
    setEnabled(!state.enabled);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          onClick={handleToggle}
          className={cn(
            'rounded-full px-2.5 h-7 text-xs font-medium border transition-all',
            state.enabled
              ? 'bg-primary/15 text-primary border-primary/30'
              : 'text-muted-foreground border-border/60 hover:text-foreground hover:border-foreground/30 hover:bg-accent/50'
          )}
        >
          {t('composer.designAgent' as TranslationKey)}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {t('composer.designAgentTooltip' as TranslationKey)}
      </TooltipContent>
    </Tooltip>
  );
}
