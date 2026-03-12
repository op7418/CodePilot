"use client";

import { Lightning, DownloadSimple, CheckCircle } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import type { MarketplaceSkill } from "@/types";

interface MarketplaceSkillCardProps {
  skill: MarketplaceSkill;
  selected: boolean;
  onSelect: () => void;
}

export function MarketplaceSkillCard({
  skill,
  selected,
  onSelect,
}: MarketplaceSkillCardProps) {
  const { t } = useTranslation();

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
      <Lightning size={16} className="shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{skill.name}</span>
          {skill.isInstalled ? (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 border-status-success-border text-status-success-foreground"
            >
              <CheckCircle size={10} className="mr-0.5" />
              {t('skills.installed')}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{skill.source}</span>
          {skill.installs > 0 && (
            <span className="flex items-center gap-0.5 shrink-0">
              <DownloadSimple size={12} />
              {skill.installs.toLocaleString()}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
