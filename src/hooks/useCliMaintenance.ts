'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from './useTranslation';
import { showLoadingToast, showToast, updateToast, type Toast } from './useToast';
import type { TranslationKey } from '@/i18n';
import {
  initialCliMaintenanceSnapshot,
  type CliMaintenanceSnapshot,
  type CliMaintenanceSnapshots,
  type CliProvider,
} from '@/lib/cli-maintenance-contract';
import { remainingCliUpdateEntries } from '@/lib/cli-maintenance-card';

const DISMISSED_PREFIX = 'codepilot:cli-update-dismissed:';

export interface CliMaintenanceContextValue {
  snapshots: CliMaintenanceSnapshots;
  supported: boolean;
  check: (provider?: CliProvider) => Promise<void>;
  update: (provider: CliProvider) => Promise<CliMaintenanceSnapshot | null>;
  cancel: (provider: CliProvider) => Promise<boolean>;
}

export const CliMaintenanceContext = createContext<CliMaintenanceContextValue | null>(null);

function providerLabel(provider: CliProvider): string {
  return provider === 'claude' ? 'Claude Code' : 'Codex';
}

function dismissalKey(provider: CliProvider, version: string): string {
  return `${DISMISSED_PREFIX}${provider}:${version}`;
}

function rememberDismissed(entries: Array<{ provider: CliProvider; version: string }>): void {
  for (const entry of entries) {
    try { localStorage.setItem(dismissalKey(entry.provider, entry.version), '1'); } catch { /* unavailable */ }
  }
}

export function cliMaintenanceErrorCopy(
  errorCode: CliMaintenanceSnapshot['errorCode'],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const keys: Record<NonNullable<CliMaintenanceSnapshot['errorCode']>, TranslationKey> = {
    active_work: 'cliMaintenance.error.active_work',
    activity_unavailable: 'cliMaintenance.error.activity_unavailable',
    maintenance_in_progress: 'cliMaintenance.error.maintenance_in_progress',
    cli_update_running: 'cliMaintenance.error.cli_update_running',
    app_update_installing: 'cliMaintenance.error.app_update_installing',
    app_quitting: 'cliMaintenance.error.app_quitting',
    install_channel_unknown: 'cliMaintenance.error.install_channel_unknown',
    update_target_mismatch: 'cliMaintenance.error.update_target_mismatch',
    package_manager_missing: 'cliMaintenance.error.package_manager_missing',
    permission_denied: 'cliMaintenance.error.permission_denied',
    executable_locked: 'cliMaintenance.error.executable_locked',
    network_unavailable: 'cliMaintenance.error.network_unavailable',
    timed_out: 'cliMaintenance.error.timed_out',
    cancelled: 'cliMaintenance.error.cancelled',
    cleanup_incomplete: 'cliMaintenance.error.cleanup_incomplete',
    command_failed: 'cliMaintenance.error.command_failed',
    version_unverified: 'cliMaintenance.error.version_unverified',
    version_unchanged: 'cliMaintenance.error.version_unchanged',
    internal: 'cliMaintenance.error.internal',
  };
  if (!errorCode) return '';
  return t(keys[errorCode]);
}

export function useCliMaintenanceChecker(): CliMaintenanceContextValue {
  const router = useRouter();
  const { locale, t } = useTranslation();
  const [snapshots, setSnapshots] = useState<CliMaintenanceSnapshots>({
    claude: initialCliMaintenanceSnapshot('claude'),
    codex: initialCliMaintenanceSnapshot('codex'),
  });
  const supported = typeof window !== 'undefined' && !!window.electronAPI?.cliMaintenance;
  const notificationKeyRef = useRef('');
  const notificationToastIdRef = useRef('');

  useEffect(() => {
    if (!supported) return;
    const api = window.electronAPI!.cliMaintenance!;
    const cleanup = api.onStatus(setSnapshots);
    void api.getStatus().then((current) => {
      if (current) setSnapshots(current);
    }).catch(() => undefined);
    const timer = setTimeout(() => {
      void api.check().then(setSnapshots).catch(() => undefined);
    }, 3_000);
    return () => {
      clearTimeout(timer);
      cleanup();
    };
  }, [supported]);

  const check = useCallback(async (provider?: CliProvider) => {
    if (!window.electronAPI?.cliMaintenance) return;
    const next = await window.electronAPI.cliMaintenance.check(provider);
    setSnapshots(next);
  }, []);

  const runUpdate = useCallback(async (
    provider: CliProvider,
    options: { silent?: boolean } = {},
  ): Promise<CliMaintenanceSnapshot | null> => {
    const api = window.electronAPI?.cliMaintenance;
    if (!api) return null;
    const loadingId = options.silent ? '' : showLoadingToast(t('cliMaintenance.updatingProvider', {
      provider: providerLabel(provider),
    }));
    try {
      const result = await api.update(provider);
      if (!result) {
        if (loadingId) updateToast(loadingId, { type: 'error', message: t('cliMaintenance.requestRejected') });
        return null;
      }
      setSnapshots((current) => ({ ...current, [provider]: result }));
      if (loadingId && result.phase === 'succeeded') {
        updateToast(loadingId, {
          type: 'success',
          message: t('cliMaintenance.updatedProviderVersion', {
            provider: providerLabel(provider),
            version: result.currentVersion ?? '',
          }),
        });
      } else if (loadingId && result.phase === 'unchanged') {
        updateToast(loadingId, {
          type: 'warning',
          message: cliMaintenanceErrorCopy(result.errorCode, t),
        });
      } else if (loadingId) {
        updateToast(loadingId, {
          type: 'error',
          message: cliMaintenanceErrorCopy(result.errorCode, t),
        });
      }
      return result;
    } catch {
      if (loadingId) updateToast(loadingId, { type: 'error', message: t('cliMaintenance.updateCouldNotStart') });
      return null;
    }
  }, [t]);

  const update = useCallback((provider: CliProvider) => runUpdate(provider), [runUpdate]);

  const cancel = useCallback(async (provider: CliProvider) => (
    window.electronAPI?.cliMaintenance?.cancel(provider) ?? Promise.resolve(false)
  ), []);

  useEffect(() => {
    if (!supported) return;
    const entries = (['claude', 'codex'] as const).flatMap((provider) => {
      const snapshot = snapshots[provider];
      if (snapshot.updateAvailability !== 'update_available' || !snapshot.latestVersion) return [];
      try {
        if (localStorage.getItem(dismissalKey(provider, snapshot.latestVersion)) === '1') return [];
      } catch { /* unavailable */ }
      return [{ provider, version: snapshot.latestVersion, canUpdate: snapshot.canOneClickUpdate }];
    });
    if (entries.length === 0) return;
    const key = `${locale}|${entries.map((entry) => `${entry.provider}:${entry.version}`).join('|')}`;
    if (notificationKeyRef.current === key) return;
    notificationKeyRef.current = key;
    const updatable = entries.filter((entry) => entry.canUpdate);
    const singleProvider = entries.length === 1 ? entries[0].provider : null;
    const cardBrand = singleProvider ?? 'multi';
    const cardTitle = singleProvider
      ? t('cliMaintenance.card.singleTitle', {
          provider: singleProvider === 'codex' ? 'Codex CLI' : providerLabel(singleProvider),
        })
      : t('cliMaintenance.card.multiTitle');
    const versionLines = entries.map((entry) => {
      const current = snapshots[entry.provider].currentVersion;
      const versions = current ? `v${current} → v${entry.version}` : `v${entry.version}`;
      return entries.length === 1 ? versions : `${providerLabel(entry.provider)}  ${versions}`;
    });
    const cardMessage = [
      ...versionLines,
      t('cliMaintenance.card.stayCurrent'),
    ].join('\n');
    let cardId = notificationToastIdRef.current;
    const completedProviders = new Set<CliProvider>();
    const runCardUpdates = async (): Promise<void> => {
      const pendingUpdates = remainingCliUpdateEntries(updatable, completedProviders);
      for (let index = 0; index < pendingUpdates.length; index += 1) {
        const entry = pendingUpdates[index];
        updateToast(cardId, {
          type: 'loading',
          title: t('cliMaintenance.updatingProvider', { provider: providerLabel(entry.provider) }),
          message: pendingUpdates.length > 1
            ? t('cliMaintenance.card.installingProgress', {
                current: index + 1,
                total: pendingUpdates.length,
              })
            : t('cliMaintenance.card.installing'),
          action: undefined,
          duration: 0,
          persistent: true,
          dismissible: false,
          onDismiss: undefined,
        });
        const result = await runUpdate(entry.provider, { silent: true });
        if (!result || result.phase !== 'succeeded') {
          const unchanged = result?.phase === 'unchanged';
          updateToast(cardId, {
            type: unchanged ? 'warning' : 'error',
            title: t('cliMaintenance.card.notCompleted'),
            message: result
              ? cliMaintenanceErrorCopy(result.errorCode, t)
              : t('cliMaintenance.updateCouldNotStart'),
            action: {
              label: t('cliMaintenance.card.retry'),
              onClick: () => { void runCardUpdates(); },
            },
            duration: 0,
            persistent: true,
            dismissible: true,
            onDismiss: () => {
              notificationToastIdRef.current = '';
              notificationKeyRef.current = '';
            },
          });
          return;
        }
        completedProviders.add(entry.provider);
      }
      updateToast(cardId, {
        type: 'success',
        title: t('cliMaintenance.card.complete'),
        message: updatable.length > 1
          ? t('cliMaintenance.card.multiSuccess', { count: updatable.length })
          : t('cliMaintenance.card.singleSuccess', {
              provider: providerLabel(updatable[0]?.provider ?? 'claude'),
            }),
        action: undefined,
        duration: 2_500,
        persistent: false,
        dismissible: false,
        onDismiss: undefined,
      });
      notificationToastIdRef.current = '';
      notificationKeyRef.current = '';
    };
    const card: Omit<Toast, 'id'> = {
      type: 'info',
      title: cardTitle,
      message: cardMessage,
      duration: 0,
      placement: 'bottom-left',
      variant: 'card',
      brand: cardBrand,
      persistent: true,
      action: updatable.length > 0
        ? {
            label: t('cliMaintenance.card.update'),
            onClick: () => { void runCardUpdates(); },
          }
        : {
            label: t('cliMaintenance.card.settings'),
            onClick: () => {
              router.push('/settings/runtime');
            },
          },
      onDismiss: () => {
        rememberDismissed(entries);
        notificationToastIdRef.current = '';
      },
    };
    if (cardId) {
      updateToast(cardId, card);
    } else {
      cardId = showToast(card);
      notificationToastIdRef.current = cardId;
    }
  }, [locale, router, runUpdate, snapshots, supported, t]);

  return useMemo(() => ({ snapshots, supported, check, update, cancel }), [snapshots, supported, check, update, cancel]);
}

export function useCliMaintenance(): CliMaintenanceContextValue {
  const value = useContext(CliMaintenanceContext);
  if (!value) throw new Error('useCliMaintenance must be used within CliMaintenanceContext.Provider');
  return value;
}
