'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { useTranslation } from '@/hooks/useTranslation';
import { ANNOUNCEMENT_KEY } from './feature-announcement-key';

export function FeatureAnnouncementDialog() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { t } = useTranslation();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Check both localStorage (fast) and DB (persistent across Electron restarts)
    if (localStorage.getItem(ANNOUNCEMENT_KEY)) return;
    // Check DB settings for dismiss state + setup completion in one call
    Promise.all([
      fetch('/api/settings/app').then(r => r.ok ? r.json() : null),
      fetch('/api/setup').then(r => r.ok ? r.json() : null),
    ]).then(([appData, setupData]) => {
      // Already dismissed (persisted in DB)
      if (appData?.settings?.[ANNOUNCEMENT_KEY]) {
        localStorage.setItem(ANNOUNCEMENT_KEY, '1'); // sync to localStorage for fast check
        return;
      }
      // Only show to users who finished setup
      if (setupData?.completed) {
        setTimeout(() => setOpen(true), 800);
      }
    }).catch(() => {});
  }, []);

  const handleDismiss = () => {
    setOpen(false);
    localStorage.setItem(ANNOUNCEMENT_KEY, '1');
    // Persist to DB so it survives Electron restarts / localStorage clearing
    fetch('/api/settings/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { [ANNOUNCEMENT_KEY]: 'true' } }),
    }).catch(() => {});
  };

  const handleGoToSettings = () => {
    handleDismiss();
    router.push('/settings/runtime');
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleDismiss(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('announcement.title')}
          </DialogTitle>
          <DialogDescription>
            {t('announcement.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {t('announcement.issuesBefore')}
            <a href="https://github.com/op7418/CodePilot/issues" target="_blank" rel="noopener noreferrer" className="underline font-medium">GitHub Issues</a>
            {t('announcement.issuesAfter')}
          </div>

          <p>{t('announcement.intro')}</p>
          <div className="space-y-2 text-muted-foreground">
            <p><span className="text-foreground font-medium">{t('announcement.aiSdkEngineTitle')}</span>{t('announcement.aiSdkEngineDesc')}</p>
            <p><span className="text-foreground font-medium">{t('announcement.claudeCodeEngineTitle')}</span>{t('announcement.claudeCodeEngineDesc')}</p>
          </div>
          <p>{t('announcement.oauthBefore')}<span className="font-medium">{t('announcement.oauthHighlight')}</span>{t('announcement.oauthAfter')}</p>
        </div>

        <DialogFooter className="gap-3">
          <Button variant="outline" size="sm" onClick={handleGoToSettings}>
            {t('announcement.goToSettings')}
          </Button>
          <Button size="sm" onClick={handleDismiss}>
            {t('announcement.gotIt')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
