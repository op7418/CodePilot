"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Copy, ArrowSquareOut, Plus, CaretDown } from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import type { CliToolDefinition, CliToolPlatform } from "@/types";

interface CliToolDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tool: CliToolDefinition;
  locale: string;
  /** If provided, shows install button at the bottom (for recommended tools) */
  onInstall?: (tool: CliToolDefinition, method: string) => void;
  platform?: string;
}

export function CliToolDetailDialog({
  open,
  onOpenChange,
  tool,
  locale,
  onInstall,
  platform,
}: CliToolDetailDialogProps) {
  const { t } = useTranslation();
  const isZh = locale === 'zh';
  const [showMethodPicker, setShowMethodPicker] = useState(false);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const availableMethods = platform
    ? tool.installMethods.filter(m => m.platforms.includes(platform as CliToolPlatform))
    : tool.installMethods;

  const handleInstallClick = () => {
    if (availableMethods.length === 1) {
      onInstall?.(tool, availableMethods[0].method);
    } else if (availableMethods.length > 1) {
      setShowMethodPicker(!showMethodPicker);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tool.name}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {/* Intro */}
          <section>
            <h3 className="text-sm font-medium mb-2">{t('cliTools.detailIntro')}</h3>
            <p className="text-sm text-muted-foreground">
              {isZh ? tool.detailIntro.zh : tool.detailIntro.en}
            </p>
          </section>

          {/* Use cases */}
          <section>
            <h3 className="text-sm font-medium mb-2">{t('cliTools.useCases')}</h3>
            <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
              {(isZh ? tool.useCases.zh : tool.useCases.en).map((uc, i) => (
                <li key={i}>{uc}</li>
              ))}
            </ul>
          </section>

          {/* Guide steps */}
          <section>
            <h3 className="text-sm font-medium mb-2">{t('cliTools.guideSteps')}</h3>
            <ol className="text-sm text-muted-foreground list-decimal list-inside space-y-1">
              {(isZh ? tool.guideSteps.zh : tool.guideSteps.en).map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </section>

          {/* Example prompts */}
          <section>
            <h3 className="text-sm font-medium mb-2">{t('cliTools.examplePrompts')}</h3>
            <div className="space-y-2">
              {tool.examplePrompts.map((ep, i) => (
                <div key={i} className="rounded-md border bg-muted/30 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium mb-1">{ep.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {isZh ? ep.promptZh : ep.promptEn}
                      </p>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => copyToClipboard(isZh ? ep.promptZh : ep.promptEn)}
                        title={t('cliTools.copy')}
                      >
                        <Copy size={12} />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Links */}
          {(tool.homepage || tool.repoUrl || tool.officialDocsUrl) && (
            <section className="flex flex-wrap gap-2 pt-2 border-t">
              {tool.homepage && (
                <a
                  href={tool.homepage}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <ArrowSquareOut size={12} />
                  {t('cliTools.homepage')}
                </a>
              )}
              {tool.repoUrl && (
                <a
                  href={tool.repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <ArrowSquareOut size={12} />
                  GitHub
                </a>
              )}
              {tool.officialDocsUrl && (
                <a
                  href={tool.officialDocsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <ArrowSquareOut size={12} />
                  {t('cliTools.docs')}
                </a>
              )}
            </section>
          )}
        </div>

        {/* Install button — only for recommended (not installed) tools */}
        {onInstall && availableMethods.length > 0 && (
          <DialogFooter className="relative">
            <Button
              size="sm"
              className="gap-1.5"
              onClick={handleInstallClick}
            >
              <Plus size={14} />
              {t('cliTools.install')}
              {availableMethods.length > 1 && <CaretDown size={12} />}
            </Button>
            {showMethodPicker && availableMethods.length > 1 && (
              <div className="absolute right-0 bottom-10 z-10 rounded-md border bg-popover p-1 shadow-md min-w-[180px]">
                {availableMethods.map(m => (
                  <Button
                    key={m.method}
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start px-2 py-1.5 text-xs h-auto"
                    onClick={() => {
                      setShowMethodPicker(false);
                      onInstall(tool, m.method);
                    }}
                  >
                    {m.method}: {m.command}
                  </Button>
                ))}
              </div>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
