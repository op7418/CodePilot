"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Download04Icon,
  Delete02Icon,
  CheckmarkCircle02Icon,
  LinkSquare01Icon,
  Plug01Icon,
  Loading02Icon,
  ZapIcon,
  UserIcon,
  CodeIcon,
  Wifi01Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";
import { PluginInstallDialog } from "./PluginInstallDialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MarketplacePlugin } from "@/types";

interface PluginMarketplaceDetailProps {
  plugin: MarketplacePlugin;
  onInstallComplete: () => void;
}

interface DetailData {
  manifest: Record<string, unknown>;
  readme: string | null;
  components: Record<string, string[]>;
}

export function PluginMarketplaceDetail({
  plugin,
  onInstallComplete,
}: PluginMarketplaceDetailProps) {
  const { t } = useTranslation();
  const [showProgress, setShowProgress] = useState(false);
  const [progressAction, setProgressAction] = useState<"install" | "uninstall">(
    "install"
  );
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoading(true);

    const fetchDetail = async () => {
      try {
        const params = new URLSearchParams({
          marketplace: plugin.marketplace,
          name: plugin.name,
        });
        const res = await fetch(`/api/plugins/marketplace/detail?${params}`);
        if (!cancelled && res.ok) {
          const data = await res.json();
          setDetail(data);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchDetail();
    return () => {
      cancelled = true;
    };
  }, [plugin.marketplace, plugin.name]);

  const handleInstall = () => {
    setProgressAction("install");
    setShowProgress(true);
  };

  const handleUninstall = () => {
    setProgressAction("uninstall");
    setShowProgress(true);
  };

  const repoUrl =
    (detail?.manifest?.repository as string) ||
    (detail?.manifest?.homepage as string) ||
    null;

  const displayContent = detail?.readme
    ? detail.readme.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim()
    : null;

  const componentIcons: Record<
    string,
    { icon: typeof ZapIcon; label: string }
  > = {
    skills: { icon: ZapIcon, label: t("pluginMarket.skills") },
    agents: { icon: UserIcon, label: t("pluginMarket.agents") },
    hooks: { icon: Settings02Icon, label: t("pluginMarket.hooks") },
    mcp: { icon: Wifi01Icon, label: t("pluginMarket.mcpServers") },
    lsp: { icon: CodeIcon, label: t("pluginMarket.lspServers") },
    commands: { icon: CodeIcon, label: t("pluginMarket.commands") },
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border px-6 py-4 shrink-0">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/50 shrink-0">
            <HugeiconsIcon
              icon={Plug01Icon}
              className="h-5 w-5 text-muted-foreground"
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold truncate">
                {plugin.name}
              </h3>
              {plugin.version && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  {t("pluginMarket.version", { version: plugin.version })}
                </Badge>
              )}
              {plugin.isInstalled && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 border-green-500/40 text-green-600 dark:text-green-400 shrink-0"
                >
                  <HugeiconsIcon
                    icon={CheckmarkCircle02Icon}
                    className="h-2.5 w-2.5 mr-0.5"
                  />
                  {t("pluginMarket.installed")}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              {plugin.description && (
                <span className="text-sm text-muted-foreground truncate">
                  {plugin.description}
                </span>
              )}
              {repoUrl && (
                <a
                  href={repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                >
                  <HugeiconsIcon
                    icon={LinkSquare01Icon}
                    className="h-3.5 w-3.5"
                  />
                </a>
              )}
            </div>
            {plugin.author?.name && (
              <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
                <HugeiconsIcon icon={UserIcon} className="h-3 w-3" />
                {plugin.author.name}
              </div>
            )}
          </div>
          <div className="shrink-0">
            {plugin.isInstalled ? (
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5"
                onClick={handleUninstall}
              >
                <HugeiconsIcon icon={Delete02Icon} className="h-3.5 w-3.5" />
                {t("pluginMarket.uninstall")}
              </Button>
            ) : (
              <Button size="sm" className="gap-1.5" onClick={handleInstall}>
                <HugeiconsIcon
                  icon={Download04Icon}
                  className="h-3.5 w-3.5"
                />
                {t("pluginMarket.install")}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Components badges */}
      {detail?.components && Object.keys(detail.components).length > 0 && (
        <div className="border-b border-border px-6 py-3 shrink-0">
          <p className="text-xs font-medium text-muted-foreground mb-2">
            {t("pluginMarket.components")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(detail.components).map(([key, items]) => {
              const info = componentIcons[key];
              if (!info) return null;
              return (
                <Badge
                  key={key}
                  variant="secondary"
                  className="text-xs gap-1"
                >
                  <HugeiconsIcon icon={info.icon} className="h-3 w-3" />
                  {info.label}
                  {Array.isArray(items) && items.length > 0 && (
                    <span className="text-muted-foreground">
                      ({items.length})
                    </span>
                  )}
                </Badge>
              );
            })}
          </div>
        </div>
      )}

      {/* Body — README content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <HugeiconsIcon
              icon={Loading02Icon}
              className="h-5 w-5 animate-spin text-muted-foreground"
            />
          </div>
        ) : displayContent ? (
          <div className="prose prose-sm dark:prose-invert max-w-none px-6 py-4">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {displayContent}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
            <p className="text-sm">{t("pluginMarket.noReadme")}</p>
          </div>
        )}
      </div>

      <PluginInstallDialog
        open={showProgress}
        onOpenChange={setShowProgress}
        action={progressAction}
        pluginName={plugin.name}
        marketplace={plugin.marketplace}
        onComplete={onInstallComplete}
      />
    </div>
  );
}
