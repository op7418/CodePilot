"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/hooks/useTranslation';
import type { MemoryRecordsSnapshot } from '@/lib/memory-records';
import type { TranslationKey } from '@/i18n';

const REASON_KEYS: Record<string, TranslationKey> = {
  claude_settings_only: 'memoryRecords.reasonCredentials', credentials_missing: 'memoryRecords.reasonCredentials',
  provider_missing: 'memoryRecords.reasonProvider', runtime_unsupported: 'memoryRecords.reasonUnsupported',
  policy_blocked: 'memoryRecords.reasonPolicy', request_failed: 'memoryRecords.reasonRequest',
  empty_response: 'memoryRecords.reasonEmpty', cancelled: 'memoryRecords.reasonCancelled',
  in_flight: 'memoryRecords.reasonInFlight', binding_unavailable: 'memoryRecords.reasonBinding',
  source_unavailable: 'memoryRecords.reasonSource', source_revoked: 'memoryRecords.reasonRevoked',
  configuration_required: 'memoryRecords.reasonConfiguration',
  extraction_or_storage_failed: 'memoryRecords.reasonStorage',
  storage_capacity: 'memoryRecords.storageCapacity', storage_corrupt: 'memoryRecords.corrupt',
  storage_unavailable: 'memoryRecords.storage', storage_busy: 'memoryRecords.busy',
  retry_exhausted: 'memoryRecords.reasonRetryExhausted',
  identity_unavailable: 'memoryRecords.reasonIdentityUnavailable',
  persistence_unavailable: 'memoryRecords.reasonPersistenceUnavailable',
};

interface PanelSnapshot extends MemoryRecordsSnapshot {
  enhancement?: { error?: string; capacityReached?: boolean; pendingTurns?: number; jobs?: Array<{ id: string; status: string; reason?: string; updatedAt: string; retryAt?: number }> };
}

export function MemoryRecordsPanel() {
  const { locale, t } = useTranslation();
  const [snapshot, setSnapshot] = useState<PanelSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [retryPolls, setRetryPolls] = useState(0);
  const [retryRequested, setRetryRequested] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const operation = useRef<string | null>(null);
  const mounted = useRef(true);
  const mutating = useRef(false);
  const readVersion = useRef(0);
  const refresh = useCallback(async () => {
    if (mutating.current) return;
    const version = ++readVersion.current;
    try {
      const response = await fetch('/api/workspace/memory', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'unavailable');
      if (mounted.current && version === readVersion.current) { setSnapshot(data); setError(null); }
    } catch (error) { if (mounted.current && version === readVersion.current) { setSnapshot(null); setError(error instanceof Error ? error.message : 'unavailable'); } }
  }, []);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, [refresh]);
  const pending = snapshot?.enhancement?.jobs?.some(job => job.status === 'running' || job.status === 'pending');
  const retryPolling = retryPolls > 0;
  const coolingDown = snapshot?.enhancement?.jobs?.some(job => (job.retryAt ?? 0) > now);
  const retryEligible = snapshot?.enhancement?.jobs?.some(job => job.reason !== 'retry_exhausted' && ['failed', 'unavailable', 'cooldown', 'pending'].includes(job.status) && (job.retryAt ?? 0) <= now);
  useEffect(() => {
    if (!coolingDown) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [coolingDown]);
  useEffect(() => {
    if (!pending && !retryPolling) return;
    const timer = setInterval(() => { void refresh(); setRetryPolls(count => Math.max(0, count - 1)); }, 2000);
    return () => clearInterval(timer);
  }, [pending, retryPolling, refresh]);

  async function mutate(action: 'remember' | 'correct' | 'forget' | 'retry', id?: string) {
    if (!snapshot || busy) return;
    mutating.current = true;
    readVersion.current += 1;
    setBusy(true);
    setError(null);
    operation.current ??= crypto.randomUUID();
    try {
      const response = await fetch('/api/workspace/memory', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id, content: action === 'forget' || action === 'retry' ? undefined : content,
          expectedRevision: snapshot.revision, idempotencyKey: operation.current }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'unavailable');
      if (!mounted.current) return;
      setSnapshot({ ...data, enhancement: data.enhancement || snapshot.enhancement });
      if (action === 'retry') { setRetryPolls(5); setRetryRequested(data.retryRequested === true); }
      if (action === 'remember' || action === 'correct' || (action === 'forget' && editing === id)) { setContent(''); setEditing(null); }
      if (action !== 'retry') { setForgetting(null); operation.current = null; }
    } catch (error) { if (mounted.current) {
      const code = error instanceof Error ? error.message : 'unavailable';
      setError(code);
      if (code === 'corrupt' || code === 'unsafe_path') setSnapshot(null);
    } }
    finally {
      mutating.current = false;
      if (mounted.current) { setBusy(false); if (action === 'retry') void refresh(); }
    }
  }

  const errorKeys: Record<string, TranslationKey> = {
    conflict: 'memoryRecords.conflict', busy: 'memoryRecords.busy', secret: 'memoryRecords.secret',
    invalid: 'memoryRecords.invalid', capacity: 'memoryRecords.storageCapacity', corrupt: 'memoryRecords.corrupt',
    storage: 'memoryRecords.storage', unsafe_path: 'memoryRecords.unsafePath',
  };
  const errorText = t(errorKeys[error || ''] || 'memoryRecords.unavailable');

  return <section className="space-y-4" aria-label={t('memoryRecords.ariaLabel')}>
    <div className="flex items-start justify-between gap-4">
      <div><h3 className="text-sm font-medium">{t('memoryRecords.title')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('memoryRecords.storageHint')}</p></div>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>{t('memoryRecords.refresh')}</Button>
    </div>
    {snapshot?.enhancement && <div className="space-y-2 rounded-md bg-muted/40 p-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{t('memoryRecords.extractionTitle')}</span>
        {!!snapshot.enhancement.jobs?.some(job => job.reason !== 'retry_exhausted' && ['failed', 'unavailable', 'cooldown', 'pending'].includes(job.status)) &&
          <Button variant="outline" size="sm" disabled={busy || !retryEligible || snapshot.enhancement.jobs?.some(job => job.status === 'running')} onClick={() => void mutate('retry')}>{t('memoryRecords.retry')}</Button>}
      </div>
      <p className="text-muted-foreground">{t('memoryRecords.extractionCost')}</p>
      {retryRequested && <p role="status">{t('memoryRecords.retryRequested')}</p>}
      {snapshot.enhancement.error && <p role="status">{t('memoryRecords.statusUnavailable')}</p>}
      {snapshot.enhancement.capacityReached && <p>{t('memoryRecords.capacity')}</p>}
      {typeof snapshot.enhancement.pendingTurns === 'number' && snapshot.enhancement.pendingTurns > 0 && <p>{t('memoryRecords.pendingTurns').replace('{count}', String(snapshot.enhancement.pendingTurns))}</p>}
      {snapshot.enhancement.jobs?.length === 0 && !snapshot.enhancement.pendingTurns && <p>{t('memoryRecords.noJobs')}</p>}
      {snapshot.enhancement.jobs?.slice(-5).reverse().map(job => <div key={job.id} className="flex flex-wrap justify-between gap-2">
        <span>{({ pending: t('memoryRecords.pending'), running: t('memoryRecords.running'), completed: t('memoryRecords.saved'),
          nothing: t('memoryRecords.nothing'), unavailable: t('memoryRecords.modelUnavailable'),
          failed: t('memoryRecords.failed'), cooldown: t('memoryRecords.cooldown'),
          skipped: job.reason === 'source_revoked' ? (t('memoryRecords.sourceRevoked')) : (t('memoryRecords.skipped')),
        } as Record<string, string>)[job.status] || (t('memoryRecords.unknownStatus'))}</span>
        <time dateTime={job.updatedAt} className="text-muted-foreground">{new Date(job.updatedAt).toLocaleString(locale)}</time>
        {typeof job.retryAt === 'number' && job.retryAt > now && <p className="w-full text-muted-foreground">{t('memoryRecords.retryAfter').replace('{time}', new Date(job.retryAt).toLocaleTimeString(locale))}</p>}
        {job.reason && <p className="w-full text-muted-foreground">{t(REASON_KEYS[job.reason] || 'memoryRecords.reasonRequest')}</p>}
      </div>)}
    </div>}
    {error && <p role="alert" className="text-xs text-destructive">{errorText}</p>}
    {!snapshot && !error && <p className="text-xs text-muted-foreground">{t('memoryRecords.loading')}</p>}
    <div className="space-y-2">
      <label htmlFor="memory-record-content" className="text-xs font-medium">{editing ? (t('memoryRecords.correctTitle')) : (t('memoryRecords.rememberTitle'))}</label>
      <Textarea id="memory-record-content" value={content} maxLength={16000} disabled={busy}
        onChange={event => { setContent(event.target.value); operation.current = null; }} />
      <div className="flex justify-end gap-2">
        {editing && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setEditing(null); setContent(''); operation.current = null; }}>{t('memoryRecords.cancelCorrection')}</Button>}
        <Button size="sm" disabled={busy || !snapshot || !content.trim()} onClick={() => void mutate(editing ? 'correct' : 'remember', editing || undefined)}>
          {busy ? (t('memoryRecords.saving')) : (t('common.save'))}
        </Button>
      </div>
    </div>
    {snapshot && snapshot.records.length === 0 && <p className="text-xs text-muted-foreground">{t('memoryRecords.empty')}</p>}
    <div className="divide-y divide-border/50">
      {snapshot?.records.slice().reverse().map(record => <div key={record.id} className="space-y-2 py-3">
        <div className="flex flex-wrap justify-between gap-2 text-xs">
          <span className="text-muted-foreground">{record.status === 'active' ? (t('memoryRecords.active')) : record.status === 'superseded' ? (t('memoryRecords.superseded')) : (t('memoryRecords.revoked'))}</span>
          <time dateTime={record.updatedAt} className="text-muted-foreground">{new Date(record.updatedAt).toLocaleString(locale)}</time>
        </div>
        {record.content && <p className="whitespace-pre-wrap break-words text-sm">{record.content}</p>}
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t('memoryRecords.sourceTitle')}</summary>
          <div className="mt-2 space-y-1 break-all">
            <p>{record.source.kind === 'manual' ? (t('memoryRecords.manualSource')) : record.source.kind === 'tool' ? (t('memoryRecords.toolSource')) : (t('memoryRecords.extractedSource'))}</p>
            {record.source.sessionId && <Link className="underline" href={`/chat/${encodeURIComponent(record.source.sessionId)}`}>{t('memoryRecords.openConversation')}</Link>}
            {record.source.messageId && <p>{t('memoryRecords.messageId')}{record.source.messageId}</p>}
            <p>{t('memoryRecords.recordId')}{record.id}</p>
          </div>
        </details>
        {record.status === 'active' && <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setEditing(record.id); setContent(record.content); operation.current = null; }}>{t('memoryRecords.correct')}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setForgetting(record.id)}>{t('memoryRecords.forget')}</Button>
        </div>}
        {forgetting === record.id && <div className="rounded-md bg-muted/40 p-3 text-xs">
          <p>{t('memoryRecords.forgetDescription')}</p>
          <div className="mt-2 flex justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={() => setForgetting(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void mutate('forget', record.id)}>{t('memoryRecords.confirmForget')}</Button></div>
        </div>}
      </div>)}
    </div>
  </section>;
}
