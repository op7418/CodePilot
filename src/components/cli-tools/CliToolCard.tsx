"use client";

import { useState } from "react";
import { Plus, CaretDown } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import type { CliToolDefinition, CliToolRuntimeInfo, CliToolPlatform } from "@/types";

interface CliToolCardProps {
  tool: CliToolDefinition;
  runtimeInfo?: CliToolRuntimeInfo;
  variant: 'installed' | 'recommended';
  autoDescription?: { zh: string; en: string };
  onDetail: () => void;
  onInstall?: (tool: CliToolDefinition, method: string) => void;
  locale: string;
  platform: string;
}

export function CliToolCard({
  tool,
  runtimeInfo,
  variant,
  autoDescription,
  onDetail,
  onInstall,
  locale,
  platform,
}: CliToolCardProps) {
  const { t } = useTranslation();
  const [showMethodPicker, setShowMethodPicker] = useState(false);
  const isZh = locale === 'zh';

  const availableMethods = tool.installMethods.filter(
    m => m.platforms.includes(platform as CliToolPlatform)
  );

  const summary = autoDescription
    ? (isZh ? autoDescription.zh : autoDescription.en)
    : (isZh ? tool.summaryZh : tool.summaryEn);

  const handleInstallClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (availableMethods.length === 1) {
      onInstall?.(tool, availableMethods[0].method);
    } else if (availableMethods.length > 1) {
      setShowMethodPicker(!showMethodPicker);
    }
  };

  const handleMethodSelect = (e: React.MouseEvent, method: string) => {
    e.stopPropagation();
    setShowMethodPicker(false);
    onInstall?.(tool, method);
  };

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border/40 px-3 py-2.5 hover:bg-muted/50 cursor-pointer transition-colors"
      onClick={onDetail}
    >
      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm truncate">{tool.name}</h3>
          {/* Category tags inline */}
          {tool.categories.map(cat => (
            <span
              key={cat}
              className="inline-block rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0"
            >
              {t(`cliTools.category.${cat}` as TranslationKey)}
            </span>
          ))}
          {/* Version for installed */}
          {variant === 'installed' && runtimeInfo?.version && (
            <span className="text-xs text-muted-foreground shrink-0">
              v{runtimeInfo.version}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 truncate">
          {summary || t('cliTools.noDescription' as TranslationKey)}
        </p>
      </div>

      {/* Right action */}
      {variant === 'recommended' && onInstall && availableMethods.length > 0 && (
        <div className="shrink-0 relative">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleInstallClick}
            title={t('cliTools.install')}
          >
            {availableMethods.length > 1
              ? <CaretDown size={16} />
              : <Plus size={16} />}
          </Button>
          {showMethodPicker && availableMethods.length > 1 && (
            <div className="absolute right-0 top-8 z-10 rounded-md border bg-popover p-1 shadow-md min-w-[140px]">
              {availableMethods.map(m => (
                <Button
                  key={m.method}
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start px-2 py-1 text-xs h-auto"
                  onClick={(e) => handleMethodSelect(e, m.method)}
                >
                  {m.method}: {m.command}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
