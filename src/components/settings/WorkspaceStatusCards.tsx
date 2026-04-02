"use client";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SpinnerGap, CheckCircle } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";

// ── Onboarding Status Card ──

interface OnboardingCardProps {
  onboardingComplete: boolean;
  creatingSession: boolean;
  onStartOnboarding: () => void;
}

export function OnboardingCard({ onboardingComplete, creatingSession, onStartOnboarding }: OnboardingCardProps) {
  const { t } = useTranslation();

  // When complete: compact one-line status
  if (onboardingComplete) {
    return (
      <div className="rounded-lg border border-border/50 px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CheckCircle size={14} className="text-status-success-foreground" />
          <span className="text-xs text-status-success-foreground">{t('assistant.configured')}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 h-auto p-0"
          onClick={onStartOnboarding}
          disabled={creatingSession}
        >
          {creatingSession ? (
            <SpinnerGap size={12} className="animate-spin" />
          ) : (
            t('assistant.reconfigure')
          )}
        </Button>
      </div>
    );
  }

  // When not complete: full card with Wizard button
  return (
    <div className="rounded-lg border border-border/50 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">{t('assistant.onboardingTitle')}</h2>
          <p className="text-xs text-muted-foreground mt-1">{t('assistant.onboardingDesc')}</p>
          <p className="text-xs mt-1">
            <span className="text-status-warning-foreground">{t('assistant.onboardingNotStarted')}</span>
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onStartOnboarding}
          disabled={creatingSession}
        >
          {creatingSession ? (
            <SpinnerGap size={14} className="animate-spin" />
          ) : (
            t('assistant.startOnboarding')
          )}
        </Button>
      </div>
    </div>
  );
}

// ── Heartbeat Card ──

interface CheckInCardProps {
  lastCheckInDate: string | null;
  checkInDoneToday: boolean;
  autoTriggerEnabled: boolean;
  onAutoTriggerChange: (enabled: boolean) => void;
}

export function CheckInCard({ lastCheckInDate, checkInDoneToday, autoTriggerEnabled, onAutoTriggerChange }: CheckInCardProps) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-border/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">{t('assistant.heartbeatTitle')}</h2>
          <p className="text-xs text-muted-foreground mt-1">{t('assistant.heartbeatDesc')}</p>
          <p className="text-xs mt-1">
            {lastCheckInDate && (
              <span className="text-muted-foreground">
                {t('assistant.lastHeartbeatLabel')}: {lastCheckInDate}
              </span>
            )}
            {" "}
            {checkInDoneToday
              ? <span className="text-status-success-foreground">{t('assistant.heartbeatOk')}</span>
              : <span className="text-status-warning-foreground">{t('assistant.heartbeatNeeded')}</span>
            }
          </p>
        </div>
        <Switch checked={autoTriggerEnabled} onCheckedChange={onAutoTriggerChange} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t('assistant.editHeartbeatHint')}
      </p>
    </div>
  );
}
