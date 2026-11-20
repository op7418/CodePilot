"use client";

/**
 * Codex Account models — read-only block for Settings → Models.
 *
 * Phase 5 Phase 6 IA correction (2026-05-14). Codex Account is a
 * virtual provider; its models come from upstream Codex
 * `model/list` (not from CodePilot's DB), so they're NOT toggleable
 * here. The block surfaces them in the same canvas as DB providers so
 * users know which models are available without having to leave
 * Models page — addresses the user's "Codex Account 模型放到 Models 里"
 * spec without rebuilding ModelsSection's section system.
 *
 * Hidden states:
 *   - Codex app-server not ready             → block hidden
 *   - Codex Account not logged in            → block hidden
 *   - /api/codex/models returns empty group  → block hidden
 *
 * No write actions — switching default model, enable/disable, role
 * mapping etc. don't apply to Codex Account models (they're served
 * directly through Codex Runtime). The block carries a clear
 * "仅 Codex" / "Codex only" badge so users understand the constraint.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowSquareOut } from "@/components/ui/icon";
import { CodePilotIcon } from "@/components/ui/semantic-icon";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import type { ProviderModelGroup } from "@/types";

interface CodexAccountModelsBlockProps {
  isZh?: boolean;
}

export function CodexAccountModelsBlock(_props: CodexAccountModelsBlockProps) {
  void _props;
  const { t } = useTranslation();
  const [group, setGroup] = useState<ProviderModelGroup | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchModels = async () => {
      try {
        const res = await fetch("/api/codex/models", { cache: "no-store" });
        const json = await res.json();
        if (!cancelled) {
          setGroup((json?.group ?? null) as ProviderModelGroup | null);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };
    fetchModels();
    const handler = () => fetchModels();
    window.addEventListener("provider-changed", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("provider-changed", handler);
    };
  }, []);

  if (!loaded) return null;
  if (!group || !group.models?.length) return null;

  return (
    <section className="space-y-3" aria-labelledby="codex-account-models-heading">
      <div className="rounded-lg border border-border/50 bg-card p-5 flex flex-col gap-3.5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <CodePilotIcon name="model" size="md" className="text-muted-foreground shrink-0" aria-hidden />
            <h3 id="codex-account-models-heading" className="text-sm font-semibold leading-tight">
              {t("models.codexAccount.title")}
            </h3>
            <span
              className={cn(
                "inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-medium",
                "bg-status-warning-muted text-status-warning-foreground",
              )}
            >
              {t("models.codexAccount.badge")}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {group.models.length === 1
                ? t("models.codexAccount.countOne", { count: group.models.length })
                : t("models.codexAccount.countMany", { count: group.models.length })}
            </span>
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" asChild>
            <a href="/settings/providers">
              <ArrowSquareOut size={12} />
              {t("models.codexAccount.manageAccount")}
            </a>
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {t("models.codexAccount.desc")}
        </p>
        <ul className="flex flex-col divide-y divide-border/40 rounded-md bg-muted/30 px-3.5">
          {group.models.map((m) => (
            <li key={m.value} className="py-2 flex items-center justify-between gap-3 text-xs">
              <span className="font-mono truncate">{m.label}</span>
              <span className="font-mono text-[10px] text-muted-foreground truncate max-w-[40%]">
                {m.value}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
