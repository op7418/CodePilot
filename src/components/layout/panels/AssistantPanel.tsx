'use client';

import { useEffect, useState } from 'react';
import { usePanel } from '@/hooks/usePanel';
import { Button } from '@/components/ui/button';
import { AssistantAvatar } from '@/components/ui/AssistantAvatar';
import { X, Gear, Brain, Heart, Clock, File, Check, Warning } from '@/components/ui/icon';
import { useTranslation } from '@/hooks/useTranslation';
import { useRouter } from 'next/navigation';
import type { TranslationKey } from '@/i18n';

interface AssistantSummary {
  configured: boolean;
  name: string;
  styleHint?: string;
  onboardingComplete: boolean;
  lastHeartbeatDate: string | null;
  heartbeatEnabled: boolean;
  memoryCount: number;
  recentDailyDates?: string[];
  fileHealth?: Record<string, boolean>;
}

export function AssistantPanel() {
  const { setAssistantPanelOpen } = usePanel();
  const { t } = useTranslation();
  const router = useRouter();
  const [summary, setSummary] = useState<AssistantSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/workspace/summary')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled) { setSummary(data); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex h-full flex-col border-l border-border bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <AssistantAvatar name={summary?.name || 'assistant'} size={20} />
          <span className="text-sm font-medium">
            {summary?.name || t('assistant.defaultName' as TranslationKey)}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setAssistantPanelOpen(false)}
        >
          <X size={14} />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-5">
        {loading ? (
          <div className="text-sm text-muted-foreground">{t('assistant.panel.loading' as TranslationKey)}</div>
        ) : !summary?.configured ? (
          <div className="text-center py-8 space-y-3">
            <Brain size={32} className="mx-auto text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{t('assistant.panel.notConfigured' as TranslationKey)}</p>
            <Button size="sm" onClick={() => router.push('/settings#assistant')}>
              {t('assistant.panel.setup' as TranslationKey)}
            </Button>
          </div>
        ) : (
          <>
            {/* Personality Hint */}
            {summary.styleHint && (
              <section>
                <p className="text-xs text-muted-foreground italic leading-relaxed">
                  &ldquo;{summary.styleHint}&rdquo;
                </p>
              </section>
            )}

            {/* Status */}
            <section>
              <h3 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                {t('assistant.panel.status' as TranslationKey)}
              </h3>
              <div className="space-y-1.5">
                <StatusRow
                  icon={<Heart size={13} />}
                  label={t('assistant.panel.heartbeat' as TranslationKey)}
                  value={summary.heartbeatEnabled
                    ? summary.lastHeartbeatDate || t('assistant.panel.enabled' as TranslationKey)
                    : t('assistant.panel.disabled' as TranslationKey)}
                  status={summary.heartbeatEnabled ? 'ok' : 'off'}
                />
                <StatusRow
                  icon={<Brain size={13} />}
                  label={t('assistant.panel.memories' as TranslationKey)}
                  value={`${summary.memoryCount}`}
                  status="ok"
                />
              </div>
            </section>

            {/* Recent Memories */}
            {summary.recentDailyDates && summary.recentDailyDates.length > 0 && (
              <section>
                <h3 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                  {t('assistant.panel.recentMemories' as TranslationKey)}
                </h3>
                <div className="space-y-1">
                  {summary.recentDailyDates.map(date => (
                    <div key={date} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Clock size={12} />
                      <span>{date}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Workspace Files */}
            {summary.fileHealth && (
              <section>
                <h3 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                  {t('assistant.panel.files' as TranslationKey)}
                </h3>
                <div className="space-y-1">
                  {Object.entries(summary.fileHealth).map(([key, exists]) => (
                    <div key={key} className="flex items-center gap-2 text-xs">
                      {exists ? (
                        <Check size={12} className="text-status-success" />
                      ) : (
                        <Warning size={12} className="text-status-warning" />
                      )}
                      <span className={exists ? 'text-muted-foreground' : 'text-status-warning'}>
                        {key}.md
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Quick Links */}
            <section>
              <h3 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                {t('assistant.panel.settings' as TranslationKey)}
              </h3>
              <div className="space-y-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2 text-xs h-7"
                  onClick={() => router.push('/settings#assistant')}
                >
                  <Gear size={13} />
                  {t('assistant.panel.assistantSettings' as TranslationKey)}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2 text-xs h-7"
                  onClick={() => router.push('/settings#assistant')}
                >
                  <Clock size={13} />
                  {t('assistant.panel.editHeartbeat' as TranslationKey)}
                </Button>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function StatusRow({ icon, label, value, status }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  status: 'ok' | 'warn' | 'off';
}) {
  const dotColor = status === 'ok' ? 'bg-status-success' : status === 'warn' ? 'bg-status-warning' : 'bg-muted-foreground/30';
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1 text-muted-foreground">{label}</span>
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
      <span className="text-foreground">{value}</span>
    </div>
  );
}
