"use client";

import { computeAgentScore } from "./CliToolCard";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Copy, Play } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import type { CliToolRuntimeInfo, CliToolStructuredDesc } from "@/types";

interface CliToolExtraDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  displayName: string;
  runtimeInfo: CliToolRuntimeInfo;
  autoDescription?: { zh: string; en: string; structured?: unknown };
  locale: string;
  binPath?: string;
}

export function CliToolExtraDetailDialog({
  open,
  onOpenChange,
  displayName,
  runtimeInfo,
  autoDescription,
  locale,
  binPath,
}: CliToolExtraDetailDialogProps) {
  const { t } = useTranslation();
  const isZh = locale === 'zh';

  const structured = autoDescription?.structured as CliToolStructuredDesc | undefined;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const handleTryTool = () => {
    const prefill = isZh
      ? `我想用 ${displayName} 工具完成：`
      : `I want to use ${displayName} to: `;
    window.location.href = `/chat?prefill=${encodeURIComponent(prefill)}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{displayName}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5 overflow-y-auto flex-1 min-h-0">
          {/* Agent compatibility (from AI assessment in structured_json) */}
          {structured?.agentCompat && Object.values(structured.agentCompat).some(Boolean) && (() => {
            const score = computeAgentScore(structured.agentCompat);
            return (
            <section>
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-sm font-medium">{t('cliTools.agentCompat' as TranslationKey)}</h3>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                  score >= 4 ? 'bg-primary/10 text-primary' : score >= 2 ? 'bg-muted text-foreground' : 'bg-muted text-muted-foreground'
                }`}>
                  {score}/5
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {structured.agentCompat.agentFriendly && (
                  <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary font-medium">
                    {t('cliTools.agentNative' as TranslationKey)}
                  </span>
                )}
                {structured.agentCompat.supportsJson && (
                  <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                    JSON {t('cliTools.output' as TranslationKey)}
                  </span>
                )}
                {structured.agentCompat.supportsSchema && (
                  <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                    Schema {t('cliTools.introspection' as TranslationKey)}
                  </span>
                )}
                {structured.agentCompat.supportsDryRun && (
                  <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                    Dry Run
                  </span>
                )}
                {structured.agentCompat.contextFriendly && (
                  <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                    {t('cliTools.contextFriendly' as TranslationKey)}
                  </span>
                )}
              </div>
            </section>
            );
          })()}

          {/* Intro */}
          {structured?.intro ? (
            <section>
              <h3 className="text-sm font-medium mb-2">{t('cliTools.detailIntro')}</h3>
              <p className="text-sm text-muted-foreground">
                {isZh ? structured.intro.zh : structured.intro.en}
              </p>
            </section>
          ) : autoDescription ? (
            <section>
              <h3 className="text-sm font-medium mb-2">{t('cliTools.detailIntro')}</h3>
              <p className="text-sm text-muted-foreground">
                {isZh ? autoDescription.zh : autoDescription.en}
              </p>
            </section>
          ) : null}

          {/* Use cases */}
          {structured?.useCases && (
            <section>
              <h3 className="text-sm font-medium mb-2">{t('cliTools.useCases')}</h3>
              <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
                {(isZh ? structured.useCases.zh : structured.useCases.en).map((uc, i) => (
                  <li key={i}>{uc}</li>
                ))}
              </ul>
            </section>
          )}

          {/* Guide steps */}
          {structured?.guideSteps && (
            <section>
              <h3 className="text-sm font-medium mb-2">{t('cliTools.guideSteps')}</h3>
              <ol className="text-sm text-muted-foreground list-decimal list-inside space-y-1">
                {(isZh ? structured.guideSteps.zh : structured.guideSteps.en).map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </section>
          )}

          {/* Example prompts */}
          {structured?.examplePrompts && structured.examplePrompts.length > 0 && (
            <section>
              <h3 className="text-sm font-medium mb-2">{t('cliTools.examplePrompts')}</h3>
              <div className="space-y-2">
                {structured.examplePrompts.map((ep, i) => (
                  <div key={i} className="rounded-md border bg-muted/30 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium mb-1">{ep.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {isZh ? ep.promptZh : ep.promptEn}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => copyToClipboard(isZh ? ep.promptZh : ep.promptEn)}
                        title={t('cliTools.copy')}
                      >
                        <Copy size={12} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Runtime info */}
          <section>
            <h3 className="text-sm font-medium mb-2">{t('cliTools.toolInfo')}</h3>
            <div className="text-sm text-muted-foreground space-y-1">
              {runtimeInfo.version && (
                <div className="flex gap-2">
                  <span className="text-foreground/70">{t('cliTools.version')}:</span>
                  <span>{runtimeInfo.version}</span>
                </div>
              )}
              {(runtimeInfo.binPath || binPath) && (
                <div className="flex gap-2">
                  <span className="text-foreground/70 shrink-0">{t('cliTools.path')}:</span>
                  <span className="break-all font-mono text-xs">{runtimeInfo.binPath || binPath}</span>
                </div>
              )}
            </div>
          </section>

          {!autoDescription && !structured && (
            <p className="text-sm text-muted-foreground italic">
              {t('cliTools.noDescription')}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button size="sm" className="gap-1.5" onClick={handleTryTool}>
            <Play size={14} />
            {t('cliTools.tryTool' as TranslationKey)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
