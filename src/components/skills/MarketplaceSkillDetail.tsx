"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DownloadSimple,
  Trash,
  CheckCircle,
  ArrowSquareOut,
  Lightning,
  SpinnerGap,
} from "@/components/ui/icon";
import { useTranslation } from "@/hooks/useTranslation";
import { InstallProgressDialog } from "./InstallProgressDialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MarketplaceSkill } from "@/types";

interface MarketplaceSkillDetailProps {
  skill: MarketplaceSkill;
  onInstallComplete: () => void;
}

export function MarketplaceSkillDetail({
  skill,
  onInstallComplete,
}: MarketplaceSkillDetailProps) {
  const { t } = useTranslation();
  const [showProgress, setShowProgress] = useState(false);
  const [progressAction, setProgressAction] = useState<"install" | "uninstall">("install");
  const [readme, setReadme] = useState<string | null>(null);
  const [readmeLoading, setReadmeLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setReadme(null);
    setReadmeLoading(true);

    const fetchReadme = async () => {
      try {
        const params = new URLSearchParams({
          source: skill.source,
          skillId: skill.skillId,
        });
        const res = await fetch(`/api/skills/marketplace/readme?${params}`);
        if (!cancelled && res.ok) {
          const data = await res.json();
          setReadme(data.content || null);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setReadmeLoading(false);
      }
    };

    fetchReadme();
    return () => { cancelled = true; };
  }, [skill.source, skill.skillId]);

  const handleInstall = () => {
    setProgressAction("install");
    setShowProgress(true);
  };

  const handleUninstall = () => {
    setProgressAction("uninstall");
    setShowProgress(true);
  };

  const githubUrl = skill.source.includes("/")
    ? `https://github.com/${skill.source}`
    : null;

  // Strip YAML front matter from readme for display
  const displayContent = readme
    ? readme.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim()
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border px-6 py-4 shrink-0">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/50 shrink-0">
            <Lightning size={20} className="text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold truncate">{skill.name}</h3>
              {skill.isInstalled && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 border-status-success-border text-status-success-foreground shrink-0"
                >
                  <CheckCircle size={10} className="mr-0.5" />
                  {t('skills.installed')}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-sm text-muted-foreground truncate">{skill.source}</span>
              {githubUrl && (
                <a
                  href={githubUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                >
                  <ArrowSquareOut size={14} />
                </a>
              )}
              {skill.installs > 0 && (
                <span className="flex items-center gap-0.5 text-xs text-muted-foreground shrink-0">
                  <DownloadSimple size={12} />
                  {skill.installs.toLocaleString()}
                </span>
              )}
            </div>
          </div>
          <div className="shrink-0">
            {skill.isInstalled ? (
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5"
                onClick={handleUninstall}
              >
                <Trash size={14} />
                {t('skills.uninstall')}
              </Button>
            ) : (
              <Button size="sm" className="gap-1.5" onClick={handleInstall}>
                <DownloadSimple size={14} />
                {t('skills.install')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Body — SKILL.md content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {readmeLoading ? (
          <div className="flex items-center justify-center py-12">
            <SpinnerGap size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : displayContent ? (
          <div className="prose prose-sm dark:prose-invert max-w-none px-6 py-4">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {displayContent}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
            <p className="text-sm">{t('skills.noReadme')}</p>
          </div>
        )}
      </div>

      <InstallProgressDialog
        open={showProgress}
        onOpenChange={setShowProgress}
        action={progressAction}
        source={skill.source}
        skillName={skill.name}
        onComplete={onInstallComplete}
      />
    </div>
  );
}
