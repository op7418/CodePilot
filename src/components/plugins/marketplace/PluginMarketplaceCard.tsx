"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Plug01Icon,
  CheckmarkCircle02Icon,
  ZapIcon,
  UserIcon,
  CodeIcon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import type { MarketplacePlugin } from "@/types";

interface PluginMarketplaceCardProps {
  plugin: MarketplacePlugin;
  selected: boolean;
  onSelect: () => void;
}

export function PluginMarketplaceCard({
  plugin,
  selected,
  onSelect,
}: PluginMarketplaceCardProps) {
  const { t } = useTranslation();

  const componentCount = [
    plugin.components.hasSkills,
    plugin.components.hasAgents,
    plugin.components.hasHooks,
    plugin.components.hasMcp,
    plugin.components.hasLsp,
    plugin.components.hasCommands,
  ].filter(Boolean).length;

  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-md px-3 py-2 cursor-pointer transition-colors",
        selected
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/50"
      )}
      onClick={onSelect}
    >
      <HugeiconsIcon
        icon={Plug01Icon}
        className="h-4 w-4 shrink-0 text-muted-foreground"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{plugin.name}</span>
          {plugin.isInstalled && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 border-green-500/40 text-green-600 dark:text-green-400"
            >
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                className="h-2.5 w-2.5 mr-0.5"
              />
              {t("pluginMarket.installed")}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
          {plugin.description && (
            <span className="truncate">{plugin.description}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          {plugin.version && (
            <span className="text-[10px] text-muted-foreground">
              {t("pluginMarket.version", { version: plugin.version })}
            </span>
          )}
          {plugin.author?.name && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
              <HugeiconsIcon icon={UserIcon} className="h-2.5 w-2.5" />
              {plugin.author.name}
            </span>
          )}
          {componentCount > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
              <HugeiconsIcon icon={CodeIcon} className="h-2.5 w-2.5" />
              {componentCount}
            </span>
          )}
          {plugin.components.hasSkills && (
            <span title={t("pluginMarket.skills")}>
              <HugeiconsIcon
                icon={ZapIcon}
                className="h-2.5 w-2.5 text-muted-foreground/60"
              />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
