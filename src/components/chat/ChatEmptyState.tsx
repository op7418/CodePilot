'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { FolderOpen, Brain, X } from '@/components/ui/icon';
import { useTranslation } from '@/hooks/useTranslation';
import { EGG_IMAGE_URL } from '@/lib/buddy';

interface ChatEmptyStateProps {
  hasDirectory: boolean;
  hasProvider: boolean;
  onSelectFolder: () => void;
  recentProjects?: string[];
  onSelectProject?: (path: string) => void;
  assistantConfigured?: boolean;
  onOpenAssistant?: () => void;
}

export function ChatEmptyState({
  hasDirectory,
  hasProvider,
  onSelectFolder,
  recentProjects,
  onSelectProject,
  assistantConfigured,
  onOpenAssistant,
}: ChatEmptyStateProps) {
  const { t } = useTranslation();

  if (hasDirectory && hasProvider) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">{t('chat.empty.ready')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-2xl w-full space-y-6">
        {/* Dual entry point cards */}
        <div className="flex flex-col sm:flex-row gap-4">
          {/* Project Chat card */}
          <Card className="flex-1 cursor-pointer transition-colors hover:border-primary/40">
            <CardHeader>
              <div className="flex items-center gap-2">
                <FolderOpen size={20} className="text-primary" />
                <CardTitle className="text-base">{t('chat.empty.projectChat.title')}</CardTitle>
              </div>
              <CardDescription>{t('chat.empty.projectChat.description')}</CardDescription>
            </CardHeader>
            <CardFooter>
              <Button size="sm" className="gap-1.5" onClick={onSelectFolder}>
                <FolderOpen size={14} />
                {t('chat.empty.selectFolder')}
              </Button>
            </CardFooter>
          </Card>

          {/* Personal Assistant card */}
          <Card className="flex-1 cursor-pointer transition-colors hover:border-primary/40">
            <CardHeader>
              <div className="flex items-center gap-2">
                <img src={EGG_IMAGE_URL} alt="" width={24} height={24} className="shrink-0" />
                <CardTitle className="text-base">{t('chat.empty.assistant.title')}</CardTitle>
              </div>
              <CardDescription>{t('chat.empty.assistant.description')}</CardDescription>
            </CardHeader>
            <CardFooter>
              {assistantConfigured ? (
                <Button size="sm" className="gap-1.5" onClick={onOpenAssistant}>
                  <img src={EGG_IMAGE_URL} alt="" width={14} height={14} />
                  {t('chat.empty.assistant.open')}
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="gap-1.5" onClick={onOpenAssistant}>
                  <img src={EGG_IMAGE_URL} alt="" width={14} height={14} />
                  {t('chat.empty.assistant.setup')}
                </Button>
              )}
            </CardFooter>
          </Card>
        </div>

        {/* Explanation text */}
        <p className="text-xs text-center text-muted-foreground px-4">
          {t('chat.empty.explanation')}
        </p>

        {/* Provider setup prompt */}
        {!hasProvider && (
          <div className="space-y-2 text-center">
            <p className="text-sm font-medium">{t('chat.empty.noProvider')}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.dispatchEvent(new CustomEvent('open-setup-center', { detail: { initialCard: 'provider' } }))}
            >
              {t('chat.empty.openSetup')}
            </Button>
          </div>
        )}

        {/* Recent projects */}
        {recentProjects && recentProjects.length > 0 && onSelectProject && (
          <div className="space-y-1.5 text-center">
            <p className="text-xs text-muted-foreground">{t('chat.empty.recentProjects')}</p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {recentProjects.slice(0, 5).map(p => {
                const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
                return (
                  <Button
                    key={p}
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px] font-mono"
                    onClick={() => onSelectProject(p)}
                    title={p}
                  >
                    {name}
                  </Button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Sidebar promo card ─────────────────────────────────────────── */

interface AssistantPromoCardProps {
  onSetup: () => void;
  onDismiss: () => void;
}

export function AssistantPromoCard({ onSetup, onDismiss }: AssistantPromoCardProps) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('codepilot:assistant-promo-dismissed') === '1';
  });

  if (dismissed) return null;

  const handleDismiss = () => {
    localStorage.setItem('codepilot:assistant-promo-dismissed', '1');
    setDismissed(true);
    onDismiss();
  };

  return (
    <Card className="mx-2 mb-2">
      <CardContent className="relative py-3 px-3">
        <button
          onClick={handleDismiss}
          className="absolute top-1.5 right-1.5 p-0.5 rounded-sm text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
        <div className="flex items-start gap-2 pr-4">
          <img src={EGG_IMAGE_URL} alt="" width={20} height={20} className="shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <p className="text-xs font-medium leading-snug">
              {t('chat.empty.assistant.promo')}
            </p>
            <Button size="xs" variant="outline" onClick={onSetup}>
              {t('chat.empty.assistant.setup')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
