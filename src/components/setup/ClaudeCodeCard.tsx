'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Copy, Check } from '@/components/ui/icon';
import { SetupCard } from './SetupCard';
import { useTranslation } from '@/hooks/useTranslation';
import type { SetupCardStatus } from '@/types';

const INSTALL_TYPE_LABELS: Record<string, string> = {
  native: 'Native',
  npm: 'npm',
  bun: 'Bun',
  homebrew: 'Homebrew',
  unknown: 'Unknown',
};

function getUninstallCommand(type: string): string | null {
  switch (type) {
    case 'npm': return 'npm uninstall -g @anthropic-ai/claude-code';
    case 'bun': return 'bun remove -g @anthropic-ai/claude-code';
    case 'homebrew': return 'brew uninstall --cask claude-code';
    default: return null;
  }
}

interface ClaudeStatus {
  connected: boolean;
  version: string | null;
  binaryPath?: string | null;
  installType?: string | null;
  otherInstalls?: Array<{ path: string; version: string | null; type: string }>;
  missingGit?: boolean;
  warnings?: string[];
}

interface ClaudeCodeCardProps {
  status: SetupCardStatus;
  onStatusChange: (status: SetupCardStatus) => void;
}

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1 mt-0.5">
      <code className="block rounded bg-muted px-2 py-1 text-[10px] flex-1 select-all">{command}</code>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 shrink-0"
        onClick={() => {
          navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </Button>
    </div>
  );
}

export function ClaudeCodeCard({ status, onStatusChange }: ClaudeCodeCardProps) {
  const { t } = useTranslation();
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [showCleanup, setShowCleanup] = useState(false);

  const checkStatus = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch('/api/claude-status');
      if (res.ok) {
        const data: ClaudeStatus = await res.json();
        setClaudeStatus(data);
        if (data.connected) {
          onStatusChange('completed');
        }
      }
    } catch {
      // ignore
    } finally {
      setChecking(false);
    }
  }, [onStatusChange]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const handleSkip = useCallback(async () => {
    onStatusChange('skipped');
    try {
      await fetch('/api/setup', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card: 'claude', status: 'skipped' }),
      });
    } catch { /* ignore */ }
  }, [onStatusChange]);

  const description = claudeStatus?.connected
    ? `${t('setup.claude.detected')} — v${claudeStatus.version}`
    : claudeStatus?.missingGit
      ? t('setup.claude.missingGit')
      : t('setup.claude.description');

  return (
    <SetupCard
      title={t('setup.claude.title')}
      description={description}
      status={status}
      onSkip={status === 'not-configured' || status === 'needs-fix' ? handleSkip : undefined}
    >
      {checking ? (
        <p className="text-xs text-muted-foreground">Checking...</p>
      ) : claudeStatus?.connected ? (
        <div className="space-y-1">
          <p className="text-xs">v{claudeStatus.version} ({claudeStatus.installType})</p>
          {claudeStatus.binaryPath && (
            <p className="text-[10px] font-mono text-muted-foreground/60">{claudeStatus.binaryPath}</p>
          )}
          {(claudeStatus.otherInstalls?.length ?? 0) > 0 && (
            <div className="mt-2 rounded bg-status-warning-muted p-2.5 text-xs space-y-2">
              <p className="font-medium text-status-warning-foreground">{t('setup.claude.conflict')}</p>
              <div className="text-muted-foreground">
                <p className="font-medium text-foreground">{t('setup.claude.conflictUsing')}:</p>
                <p className="mt-0.5">
                  <code className="bg-muted px-1 rounded text-[10px]">{claudeStatus.binaryPath}</code>
                  {' '}({INSTALL_TYPE_LABELS[claudeStatus.installType || 'unknown']} v{claudeStatus.version})
                </p>
              </div>
              {!showCleanup ? (
                <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => setShowCleanup(true)}>
                  {t('setup.claude.viewCleanup')}
                </Button>
              ) : (
                <div className="space-y-2 border-t border-border/50 pt-2">
                  {claudeStatus.otherInstalls?.map((inst, i) => {
                    const cmd = getUninstallCommand(inst.type);
                    return (
                      <div key={i} className="space-y-0.5">
                        <p className="text-muted-foreground">
                          <span className="font-medium text-foreground">{t('setup.claude.conflictOther')}:</span>{' '}
                          <code className="bg-muted px-1 rounded text-[10px]">{inst.path}</code>
                          {' '}({INSTALL_TYPE_LABELS[inst.type]} {inst.version && `v${inst.version}`})
                        </p>
                        {cmd && (
                          <div>
                            <p className="text-muted-foreground/80 text-[11px]">{t('setup.claude.conflictRemoveHint')}</p>
                            <CopyableCommand command={cmd} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <p className="text-muted-foreground/80 text-[11px] pt-1">{t('setup.claude.conflictResolved')}</p>
                  <Button size="sm" variant="outline" className="text-xs h-7" onClick={checkStatus}>
                    {t('setup.claude.redetect')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {claudeStatus?.missingGit ? (
            <div className="text-xs text-muted-foreground space-y-1">
              <p>{t('install.gitDescription')}</p>
              <ol className="list-decimal list-inside space-y-0.5 text-[11px]">
                <li>{t('install.gitStep1')}</li>
                <li>{t('install.gitStep2')}</li>
                <li>{t('install.gitStep3')}</li>
              </ol>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              <p>{t('setup.claude.notFound')}</p>
              <code className="block rounded bg-muted px-2 py-1 mt-1 text-[11px]">
                {typeof navigator !== 'undefined' && navigator.platform?.startsWith('Win')
                  ? 'irm https://claude.ai/install.ps1 | iex'
                  : 'curl -fsSL https://claude.ai/install.sh | bash'}
              </code>
            </div>
          )}
          <Button size="sm" variant="outline" className="text-xs" onClick={checkStatus}>
            {t('setup.claude.redetect')}
          </Button>
        </div>
      )}
    </SetupCard>
  );
}
