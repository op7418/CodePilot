'use client';

import { useState } from 'react';
import { useBatchImageGen } from '@/hooks/useBatchImageGen';
import { usePanel } from '@/hooks/usePanel';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import { Button } from '@/components/ui/button';
import type { PlannerOutput, PlannerItem } from '@/types';
import { BatchPlanRow } from './BatchPlanRow';
import { BatchExecutionDashboard } from './BatchExecutionDashboard';
import { BatchContextSync } from './BatchContextSync';

interface BatchPlanInlinePreviewProps {
  plan: PlannerOutput;
  messageId: string;
}

export function BatchPlanInlinePreview({ plan: initialPlan }: BatchPlanInlinePreviewProps) {
  const batchImageGen = useBatchImageGen();
  const { sessionId } = usePanel();
  const { t } = useTranslation();

  // Local editable state — initialized from the parsed plan
  const [localPlan, setLocalPlan] = useState<PlannerOutput>(initialPlan);
  const [executed, setExecuted] = useState(false);

  // Once execution starts, delegate to the global batch state
  const isExecuting = executed && (
    batchImageGen.state.phase === 'executing' ||
    batchImageGen.state.phase === 'completed' ||
    batchImageGen.state.phase === 'syncing'
  );

  const handleUpdateItem = (index: number, updates: Partial<PlannerItem>) => {
    setLocalPlan(prev => {
      const newItems = [...prev.items];
      newItems[index] = { ...newItems[index], ...updates };
      return { ...prev, items: newItems };
    });
  };

  const handleAddItem = () => {
    setLocalPlan(prev => ({
      ...prev,
      items: [...prev.items, { prompt: '', aspectRatio: '1:1', resolution: '1K', tags: [], sourceRefs: [] }],
    }));
  };

  const handleRemoveItem = (index: number) => {
    setLocalPlan(prev => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index),
    }));
  };

  const handleExecute = async () => {
    if (localPlan.items.length === 0) return;
    setExecuted(true);
    // Inject the (potentially edited) plan into batch state and start execution
    await batchImageGen.injectPlanAndExecute(localPlan, sessionId || undefined);
    // Now actually execute the job
    await batchImageGen.executeJob(sessionId || undefined);
  };

  // Show execution dashboard once execution has started
  if (isExecuting) {
    return (
      <div className="space-y-2">
        <BatchExecutionDashboard />
        <BatchContextSync />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-purple-500/20 bg-card overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/40 bg-purple-500/5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">
            {t('batchImageGen.planPreviewTitle' as TranslationKey)}
          </h3>
          <span className="text-xs text-muted-foreground">
            {localPlan.items.length} {localPlan.items.length === 1 ? 'item' : 'items'}
          </span>
        </div>
        {localPlan.summary && (
          <p className="text-xs text-muted-foreground mt-1">{localPlan.summary}</p>
        )}
      </div>

      {/* Items */}
      <div className="p-3 space-y-2 max-h-[400px] overflow-y-auto">
        {localPlan.items.map((item, i) => (
          <BatchPlanRow
            key={i}
            item={item}
            index={i}
            onUpdate={handleUpdateItem}
            onRemove={handleRemoveItem}
            disabled={false}
          />
        ))}
      </div>

      {/* Footer Actions */}
      <div className="px-4 py-3 border-t border-border/40 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleAddItem}
          className="text-xs text-purple-600 dark:text-purple-400 hover:underline h-auto px-1 py-0.5"
        >
          + {t('batchImageGen.addItem' as TranslationKey)}
        </Button>
        <div className="flex-1" />
        <Button
          size="sm"
          onClick={handleExecute}
          disabled={localPlan.items.length === 0}
          className="bg-purple-600 text-white hover:bg-purple-700"
        >
          {t('batchImageGen.confirmAndExecute' as TranslationKey)}
        </Button>
      </div>
    </div>
  );
}
