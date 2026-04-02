'use client';

import { useState, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { AssistantAvatar } from '@/components/ui/AssistantAvatar';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import { SPECIES_LABEL, SPECIES_IMAGE_URL, RARITY_DISPLAY, RARITY_BG_GRADIENT, STAT_LABEL, rarityColor, type BuddyData, type Species, type Rarity } from '@/lib/buddy';

// ── Types ──

interface OnboardingWizardProps {
  workspacePath: string;
  onComplete: (session: { id: string }, assistantName: string) => void;
}

interface WizardData {
  userName: string;
  userRole: string;
  assistantName: string;
  style: string;
  boundaries: string;
}

const ROLE_IDS = ['developer', 'designer', 'product', 'researcher', 'student', 'general'] as const;

const ROLE_LABEL_KEYS: Record<typeof ROLE_IDS[number], TranslationKey> = {
  developer: 'wizard.roleDeveloper',
  designer: 'wizard.roleDesigner',
  product: 'wizard.roleProduct',
  researcher: 'wizard.roleResearcher',
  student: 'wizard.roleStudent',
  general: 'wizard.roleGeneral',
};

const STYLE_IDS = ['concise', 'detailed', 'casual'] as const;

const STYLE_LABEL_KEYS: Record<typeof STYLE_IDS[number], TranslationKey> = {
  concise: 'wizard.styleConcise',
  detailed: 'wizard.styleDetailed',
  casual: 'wizard.styleCasual',
};

const STYLE_DESC_KEYS: Record<typeof STYLE_IDS[number], TranslationKey> = {
  concise: 'wizard.styleConciseDesc',
  detailed: 'wizard.styleDetailedDesc',
  casual: 'wizard.styleCasualDesc',
};

const TOTAL_STEPS = 3;

// ── Chip Component ──

function Chip({
  selected,
  onClick,
  children,
  className,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}

// ── Step Indicator ──

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            'h-2 rounded-full transition-all duration-300',
            i === current ? 'w-8 bg-primary' : 'w-2 bg-muted-foreground/30',
          )}
        />
      ))}
    </div>
  );
}

// ── Main Component ──

export function OnboardingWizard({ workspacePath, onComplete }: OnboardingWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [buddy, setBuddy] = useState<BuddyData | null>(null);
  const [buddyName, setBuddyName] = useState('');
  const [completionResult, setCompletionResult] = useState<{ session: { id: string }; assistantName: string } | null>(null);
  const [data, setData] = useState<WizardData>({
    userName: '',
    userRole: '',
    assistantName: '',
    style: 'concise',
    boundaries: '',
  });

  const update = useCallback(<K extends keyof WizardData>(key: K, value: WizardData[K]) => {
    setData(prev => ({ ...prev, [key]: value }));
  }, []);

  const canNext = step === 0
    ? data.userName.trim().length > 0
    : step === 1
      ? data.style.length > 0
      : true;

  const resolvedRoleLabel = useMemo(() => {
    const roleId = data.userRole as typeof ROLE_IDS[number];
    const key = ROLE_LABEL_KEYS[roleId];
    return key ? t(key) : t('wizard.roleGeneral' as TranslationKey);
  }, [data.userRole, t]);

  const resolvedStyleLabel = useMemo(() => {
    const styleId = data.style as typeof STYLE_IDS[number];
    const key = STYLE_LABEL_KEYS[styleId];
    return key ? t(key) : t('wizard.styleConcise' as TranslationKey);
  }, [data.style, t]);

  const handleComplete = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/workspace/wizard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        // Log server error for debugging, show i18n message to user
        const errData = await res.json().catch(() => ({}));
        console.error('[OnboardingWizard] API error:', errData.error);
        throw new Error('api_error');
      }
      const result = await res.json();
      setCompletionResult({ session: result.session, assistantName: result.assistantName });
      if (result.buddy) {
        setBuddy(result.buddy);
      } else {
        onComplete(result.session, result.assistantName);
      }
    } catch (e) {
      console.error('[OnboardingWizard] Failed:', e);
      setError(t('wizard.error' as TranslationKey));
    } finally {
      setSubmitting(false);
    }
  }, [data, workspacePath, onComplete, t]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <Card className="w-full max-w-lg mx-4 shadow-lg">
        <CardHeader>
          <div className="mb-2">
            <StepIndicator current={step} total={TOTAL_STEPS} />
          </div>
          <CardTitle className="text-center text-lg">
            {step === 0 && t('wizard.step1Title' as TranslationKey)}
            {step === 1 && t('wizard.step2Title' as TranslationKey)}
            {step === 2 && t('wizard.step3Title' as TranslationKey)}
          </CardTitle>
          <CardDescription className="text-center">
            {step === 0 && t('wizard.step1Subtitle' as TranslationKey)}
            {step === 1 && t('wizard.step2Subtitle' as TranslationKey)}
            {step === 2 && t('wizard.step3Subtitle' as TranslationKey)}
          </CardDescription>
        </CardHeader>

        <CardContent>
          {/* ── Step 1: User Info ── */}
          {step === 0 && (
            <div className="space-y-5">
              <div className="space-y-2">
                <label htmlFor="wizard-name" className="text-sm font-medium">
                  {t('wizard.nameLabel' as TranslationKey)}
                </label>
                <Input
                  id="wizard-name"
                  placeholder={t('wizard.namePlaceholder' as TranslationKey)}
                  value={data.userName}
                  onChange={e => update('userName', e.target.value)}
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">{t('wizard.roleLabel' as TranslationKey)}</label>
                <div className="flex flex-wrap gap-2">
                  {ROLE_IDS.map(roleId => (
                    <Chip
                      key={roleId}
                      selected={data.userRole === roleId}
                      onClick={() => update('userRole', roleId)}
                    >
                      {t(ROLE_LABEL_KEYS[roleId])}
                    </Chip>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Step 2: Assistant Config ── */}
          {step === 1 && (
            <div className="space-y-5">
              <div className="space-y-2">
                <label htmlFor="wizard-assistant-name" className="text-sm font-medium">
                  {t('wizard.assistantNameLabel' as TranslationKey)}{' '}
                  <span className="text-muted-foreground">{t('wizard.assistantNameOptional' as TranslationKey)}</span>
                </label>
                <Input
                  id="wizard-assistant-name"
                  placeholder={t('wizard.assistantNamePlaceholder' as TranslationKey)}
                  value={data.assistantName}
                  onChange={e => update('assistantName', e.target.value)}
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">{t('wizard.styleLabel' as TranslationKey)}</label>
                <div className="flex flex-wrap gap-2">
                  {STYLE_IDS.map(styleId => (
                    <Chip
                      key={styleId}
                      selected={data.style === styleId}
                      onClick={() => update('style', styleId)}
                    >
                      <span className="flex flex-col items-start">
                        <span>{t(STYLE_LABEL_KEYS[styleId])}</span>
                        <span className={cn(
                          'text-xs font-normal',
                          data.style === styleId ? 'text-primary-foreground/70' : 'text-muted-foreground',
                        )}>
                          {t(STYLE_DESC_KEYS[styleId])}
                        </span>
                      </span>
                    </Chip>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="wizard-boundaries" className="text-sm font-medium">
                  {t('wizard.boundariesLabel' as TranslationKey)}{' '}
                  <span className="text-muted-foreground">{t('wizard.assistantNameOptional' as TranslationKey)}</span>
                </label>
                <textarea
                  id="wizard-boundaries"
                  className={cn(
                    'placeholder:text-muted-foreground dark:bg-input/30 border-input min-h-[80px] w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none',
                    'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                  )}
                  placeholder={t('wizard.boundariesPlaceholder' as TranslationKey)}
                  value={data.boundaries}
                  onChange={e => update('boundaries', e.target.value)}
                />
              </div>
            </div>
          )}

          {/* ── Step 3: Completion / Buddy Reveal ── */}
          {step === 2 && buddy && (
            <div className="text-center space-y-4 py-6">
              {/* 3D Species Image with rarity gradient background */}
              <div className="flex justify-center">
                <div
                  className="w-20 h-20 rounded-2xl flex items-center justify-center"
                  style={{ background: RARITY_BG_GRADIENT[buddy.rarity as Rarity] || '' }}
                >
                  <img
                    src={SPECIES_IMAGE_URL[buddy.species as Species] || ''}
                    alt={buddy.species}
                    width={64} height={64}
                    className="drop-shadow-md"
                  />
                </div>
              </div>
              <div>
                <h3 className="text-lg font-semibold">{t('buddy.reveal' as TranslationKey)}</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  {SPECIES_LABEL[buddy.species]?.zh || buddy.species}
                </p>
                {/* Pill-style rarity badge */}
                <span
                  className={cn('inline-flex items-center gap-1 text-xs font-medium mt-2 px-2.5 py-0.5 rounded-full', rarityColor(buddy.rarity))}
                  style={{ background: RARITY_BG_GRADIENT[buddy.rarity as Rarity] || '' }}
                >
                  {RARITY_DISPLAY[buddy.rarity]?.stars} {RARITY_DISPLAY[buddy.rarity]?.label.zh}
                </span>
              </div>
              {/* Stats with gradient bars */}
              <div className="space-y-1.5 max-w-xs mx-auto text-left">
                {Object.entries(buddy.stats).map(([stat, value]) => (
                  <div key={stat} className="flex items-center gap-2 text-xs">
                    <span className="w-10 text-muted-foreground">{STAT_LABEL[stat]?.zh || stat}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn('h-full rounded-full transition-all', stat === buddy.peakStat ? 'bg-primary' : 'bg-muted-foreground/40')}
                        style={{ width: `${value}%` }}
                      />
                    </div>
                    <span className={cn('w-5 text-right text-[10px]', stat === buddy.peakStat ? 'text-primary font-semibold' : 'text-muted-foreground')}>{value}</span>
                  </div>
                ))}
              </div>
              {/* Buddy name input */}
              <div className="max-w-xs mx-auto mt-4">
                <Input
                  placeholder={t('buddy.namePlaceholder' as TranslationKey)}
                  value={buddyName}
                  onChange={e => setBuddyName(e.target.value)}
                  className="text-center"
                />
                <p className="text-[10px] text-muted-foreground mt-1 text-center">
                  {t('buddy.nameHint' as TranslationKey)}
                </p>
              </div>
            </div>
          )}
          {step === 2 && !buddy && (
            <div className="flex flex-col items-center gap-5 py-2">
              <AssistantAvatar
                name={data.assistantName || t('wizard.defaultFallbackName' as TranslationKey)}
                size={80}
                className="ring-2 ring-primary/20"
              />
              <div className="text-center space-y-1">
                <p className="font-semibold text-base">
                  {data.assistantName || t('wizard.defaultAssistantName' as TranslationKey)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('wizard.readyToHelp' as TranslationKey).replace('{name}', data.userName || 'you')}
                </p>
              </div>
              <div className="w-full rounded-md bg-muted/50 p-4 text-sm space-y-1">
                <p><span className="text-muted-foreground">{t('wizard.summaryRole' as TranslationKey)}</span> {resolvedRoleLabel}</p>
                <p><span className="text-muted-foreground">{t('wizard.summaryStyle' as TranslationKey)}</span> {resolvedStyleLabel}</p>
                {data.boundaries && (
                  <p><span className="text-muted-foreground">{t('wizard.summaryBoundaries' as TranslationKey)}</span> {data.boundaries}</p>
                )}
              </div>
              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}
            </div>
          )}
        </CardContent>

        {/* ── Footer Buttons ── */}
        <div className="flex items-center justify-between px-6 pb-6">
          {step > 0 ? (
            <Button
              variant="ghost"
              onClick={() => setStep(s => s - 1)}
              disabled={submitting}
            >
              {t('wizard.back' as TranslationKey)}
            </Button>
          ) : (
            <div />
          )}

          {step < TOTAL_STEPS - 1 ? (
            <Button onClick={() => setStep(s => s + 1)} disabled={!canNext}>
              {t('wizard.next' as TranslationKey)}
            </Button>
          ) : buddy && completionResult ? (
            <Button onClick={async () => {
              // Save buddy name if provided
              if (buddyName.trim()) {
                try {
                  await fetch('/api/workspace/hatch-buddy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ buddyName: buddyName.trim() }),
                  });
                } catch { /* best effort */ }
              }
              onComplete(completionResult.session, completionResult.assistantName);
            }}>
              {t('wizard.startChatting' as TranslationKey)}
            </Button>
          ) : (
            <Button onClick={handleComplete} disabled={submitting}>
              {submitting ? t('wizard.completing' as TranslationKey) : t('wizard.complete' as TranslationKey)}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
