'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { CodePilotIcon } from '@/components/ui/semantic-icon';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import type { AuxiliaryExecutionStatus } from '@/lib/auxiliary-provider';

export type QuickActionEnhancement = AuxiliaryExecutionStatus
  | { status: 'unavailable'; reason: 'workspace_unavailable' | 'configuration_changed' };

export function quickActionsEnhancementHint(status: QuickActionEnhancement | undefined): TranslationKey | null {
  if (!status || status.status === 'completed') return null;
  if (status.reason === 'in_flight') return 'assistant.quickActions.generating';
  if (status.status === 'cooldown') return 'assistant.quickActions.cooldown';
  if (status.reason === 'claude_settings_only' || status.reason === 'credentials_missing') return 'assistant.quickActions.credentials';
  if (status.reason === 'configuration_required' || status.reason === 'configuration_changed') return 'assistant.quickActions.configuration';
  if (status.reason === 'identity_unavailable') return 'assistant.quickActions.identityUnavailable';
  if (status.reason === 'persistence_unavailable') return 'assistant.quickActions.persistenceUnavailable';
  if (status.reason === 'workspace_unavailable') return 'assistant.quickActions.workspaceUnavailable';
  if (status.reason === 'policy_blocked') return 'assistant.quickActions.policy';
  return 'assistant.quickActions.unavailable';
}

/** Present status independently of the suggestion list, including an empty list. */
export function QuickActionsStatus({ status, loading, retried, now, onRetry }: {
  status?: QuickActionEnhancement; loading: boolean; retried: boolean; now: number; onRetry: () => void;
}) {
  const { locale, t } = useTranslation();
  const hint = quickActionsEnhancementHint(status);
  const retryAt = status && status.status !== 'completed' && 'retryAt' in status ? status.retryAt : undefined;
  const coolingDown = typeof retryAt === 'number' && retryAt > now;
  if (!loading && !hint && !retried) return null;
  return <div className="flex w-full flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
    <p role="status">{loading ? t('assistant.quickActions.generating')
      : hint ? (retried ? t('assistant.quickActions.retryResult', { status: t(hint) }) : t(hint)) : t('assistant.quickActions.updated')}</p>
    {coolingDown && <p className="w-full">{t('assistant.quickActions.retryAfter', { time: new Date(retryAt).toLocaleTimeString(locale) })}</p>}
    {!loading && hint && <Button variant="outline" size="xs" disabled={coolingDown} onClick={onRetry}>{t('assistant.quickActions.retry')}</Button>}
    {!loading && hint && <p className="w-full">{t('assistant.quickActions.retryCost')}</p>}
  </div>;
}

interface QuickActionsProps {
  isAssistantProject: boolean;
  hasMessages: boolean;
  onAction: (text: string) => void;
  className?: string;
}

export function QuickActions({ isAssistantProject, hasMessages, onAction, className }: QuickActionsProps) {
  const { t } = useTranslation();
  const [actions, setActions] = useState<string[]>([]);
  const [enhancement, setEnhancement] = useState<QuickActionEnhancement>();
  const [completedRequest, setCompletedRequest] = useState(-1);
  const [request, setRequest] = useState({ version: 0, retry: false });
  const [now, setNow] = useState(() => Date.now());
  const loading = completedRequest !== request.version;
  const shouldShow = isAssistantProject && !hasMessages;

  useEffect(() => {
    if (!shouldShow) return;
    const refresh = () => setRequest(previous => ({ version: previous.version + 1, retry: false }));
    window.addEventListener('provider-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('provider-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [shouldShow]);

  useEffect(() => {
    if (!shouldShow) return;
    let cancelled = false;
    const abort = new AbortController();
    fetch('/api/workspace/quick-actions', {
      cache: 'no-store', signal: abort.signal,
      ...(request.retry ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'retry' }) } : {}),
    }).then(async response => {
      const data = await response.json();
      if (!data.enhancement && !response.ok) throw new Error('Request failed');
      if (!cancelled) {
        setActions(Array.isArray(data.actions) ? data.actions.filter((item: unknown) => typeof item === 'string') : []);
        setEnhancement(data.enhancement);
      }
    }).catch(() => {
      if (!cancelled) { setActions([]); setEnhancement({ status: 'failed', reason: 'request_failed' }); }
    }).finally(() => { if (!cancelled) setCompletedRequest(request.version); });
    return () => { cancelled = true; abort.abort(); };
  }, [shouldShow, request]);

  const retryAt = enhancement && enhancement.status !== 'completed' && 'retryAt' in enhancement ? enhancement.retryAt : undefined;
  const coolingDown = typeof retryAt === 'number' && retryAt > now;
  useEffect(() => {
    if (!shouldShow || !coolingDown) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [shouldShow, coolingDown]);

  if (!shouldShow) return null;
  return <div className={cn('flex flex-wrap gap-2 px-1 pb-2', className)}>
    {actions.map((action, i) => {
      const text = action === '__review_week__' ? t('assistant.quickActions.reviewWeek') : action;
      return <Button key={i} variant="outline" size="xs" onClick={() => onAction(text)}
        className="rounded-full border-border/50 bg-background text-muted-foreground hover:border-primary/30 hover:bg-primary/5 hover:text-foreground">
        <CodePilotIcon name="skill" size={12} className="text-primary/60" aria-hidden />{text}
      </Button>;
    })}
    <QuickActionsStatus status={enhancement} loading={loading} retried={request.retry} now={now}
      onRetry={() => setRequest(previous => ({ version: previous.version + 1, retry: true }))} />
  </div>;
}
