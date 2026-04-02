'use client';

import { useTranslation } from '@/hooks/useTranslation';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Code, NotePencil } from '@/components/ui/icon';

interface ModeIndicatorProps {
  mode: 'code' | 'plan' | string;
  onModeChange: (mode: string) => void;
  disabled?: boolean;
}

export function ModeIndicator({ mode, onModeChange, disabled }: ModeIndicatorProps) {
  const { t } = useTranslation();

  return (
    <Tabs value={mode} onValueChange={onModeChange}>
      <TabsList className="!h-7 p-0.5 text-xs rounded-md">
        <TabsTrigger value="code" disabled={disabled} className="!h-5 rounded-sm px-1.5 py-0 text-xs gap-1">
          <Code size={12} />
          {t('messageInput.modeCode')}
        </TabsTrigger>
        <TabsTrigger value="plan" disabled={disabled} className="!h-5 rounded-sm px-1.5 py-0 text-xs gap-1">
          <NotePencil size={12} />
          {t('messageInput.modePlan')}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
