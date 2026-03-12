'use client';

import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import { Lightning } from '@/components/ui/icon';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { PromptInputButton } from '@/components/ai-elements/prompt-input';

interface SlashCommandButtonProps {
  onInsertSlash: () => void;
}

export function SlashCommandButton({ onInsertSlash }: SlashCommandButtonProps) {
  const { t } = useTranslation();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <PromptInputButton onClick={onInsertSlash}>
          <Lightning size={16} />
        </PromptInputButton>
      </TooltipTrigger>
      <TooltipContent>
        {t('composer.slashCommandTooltip' as TranslationKey)}
      </TooltipContent>
    </Tooltip>
  );
}
