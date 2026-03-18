"use client";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SpinnerGap } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";

// ── Onboarding Status Card ──

interface OnboardingCardProps {
  onboardingComplete: boolean;
  creatingSession: boolean;
  onStartOnboarding: () => void;
}

export function OnboardingCard({ onboardingComplete, creatingSession, onStartOnboarding }: OnboardingCardProps) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-border/50 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">{t('assistant.onboardingTitle')}</h2>
          <p className="text-xs text-muted-foreground mt-1">{t('assistant.onboardingDesc')}</p>
          <p className="text-xs mt-1">
            {onboardingComplete
              ? <span className="text-status-success-foreground">{t('assistant.onboardingComplete')}</span>
              : <span className="text-status-warning-foreground">{t('assistant.onboardingNotStarted')}</span>
            }
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
          ) : onboardingComplete
            ? t('assistant.redoOnboarding')
            : t('assistant.startOnboarding')
          }
        </Button>
      </div>
    </div>
  );
}

// ── Daily Check-in Card ──

interface CheckInCardProps {
  lastCheckInDate: string | null;
  checkInDoneToday: boolean;
  creatingSession: boolean;
  autoTriggerEnabled: boolean;
  onStartCheckIn: () => void;
  onAutoTriggerChange: (enabled: boolean) => void;
}

export function CheckInCard({ lastCheckInDate, checkInDoneToday, creatingSession, autoTriggerEnabled, onStartCheckIn, onAutoTriggerChange }: CheckInCardProps) {
  const { t } = useTranslation();
  const isZh = t('nav.chats') === '对话';

  return (
    <div className="rounded-lg border border-border/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">{t('assistant.checkInTitle')}</h2>
          <p className="text-xs text-muted-foreground mt-1">{t('assistant.checkInDesc')}</p>
          <p className="text-xs mt-1">
            {lastCheckInDate && (
              <span className="text-muted-foreground">
                {t('assistant.lastCheckIn')}: {lastCheckInDate}
              </span>
            )}
            {" "}
            {checkInDoneToday
              ? <span className="text-status-success-foreground">{t('assistant.checkInToday')}</span>
              : <span className="text-status-warning-foreground">{t('assistant.checkInNeeded')}</span>
            }
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onStartCheckIn}
          disabled={creatingSession}
        >
          {creatingSession ? (
            <SpinnerGap size={14} className="animate-spin" />
          ) : (
            t('assistant.startCheckIn')
          )}
        </Button>
      </div>
      <div className="flex items-center justify-between border-t border-border/30 pt-2">
        <div>
          <p className="text-xs font-medium">{isZh ? '自动每日询问' : 'Auto daily check-in'}</p>
          <p className="text-[11px] text-muted-foreground">
            {isZh ? '打开助理项目对话时自动触发每日询问' : 'Automatically trigger daily check-in when opening assistant project'}
          </p>
        </div>
        <Switch checked={autoTriggerEnabled} onCheckedChange={onAutoTriggerChange} />
      </div>
    </div>
  );
}
