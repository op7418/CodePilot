'use client';

import { useEffect, useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Sparkle } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';

interface QuickActionsProps {
  /** Whether assistant workspace is configured */
  isAssistantProject: boolean;
  /** Whether the session has messages */
  hasMessages: boolean;
  /** Callback when user clicks an action */
  onAction: (text: string) => void;
  className?: string;
}

export function QuickActions({
  isAssistantProject,
  hasMessages,
  onAction,
  className,
}: QuickActionsProps) {
  const { t } = useTranslation();
  const [fetchedActions, setFetchedActions] = useState<string[]>([]);
  const shouldShow = isAssistantProject && !hasMessages;

  useEffect(() => {
    if (!shouldShow) return;

    let cancelled = false;
    fetch('/api/workspace/quick-actions')
      .then(r => r.ok ? r.json() : { actions: [] })
      .then(data => { if (!cancelled) setFetchedActions(data.actions || []); })
      .catch(() => { if (!cancelled) setFetchedActions([]); });
    return () => { cancelled = true; };
  }, [shouldShow]);

  // Derive displayed actions: only show when shouldShow is true
  const actions = useMemo(
    () => shouldShow ? fetchedActions : [],
    [shouldShow, fetchedActions],
  );

  if (actions.length === 0) return null;

  return (
    <div className={cn('flex flex-wrap gap-2 px-1 pb-2', className)}>
      {actions.map((action, i) => {
        // Resolve locale-agnostic action IDs to translated text
        const displayText = action === '__review_week__'
          ? t('assistant.quickActions.reviewWeek' as TranslationKey)
          : action;
        const sendText = action === '__review_week__'
          ? t('assistant.quickActions.reviewWeek' as TranslationKey)
          : action;
        return (
          <Button
            key={i}
            variant="outline"
            size="xs"
            onClick={() => onAction(sendText)}
            className="rounded-full border-border/50 bg-background text-muted-foreground hover:border-primary/30 hover:bg-primary/5 hover:text-foreground"
          >
            <Sparkle size={12} className="text-primary/60" />
            {displayText}
          </Button>
        );
      })}
    </div>
  );
}
