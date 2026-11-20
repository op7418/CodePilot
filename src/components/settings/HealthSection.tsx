"use client";

/**
 * Settings → Health — read-only daily health overview.
 *
 * Phase 2C.5. Health is the *日常问题定位* page, not a wizard. It does
 * not run probes on its own and does not write anything; instead it
 * reuses the data the rest of Settings already pulls (`useOverviewData`,
 * `useClaudeStatus`, the runtime resolver) and surfaces five concerns
 * in one place:
 *
 *   1. Provider connectivity
 *   2. 执行引擎 / CLI
 *   3. Default model validity
 *   4. Models exposure
 *   5. Assistant workspace / local environment
 *
 * Each row shows status + 原因 + 影响 + a single primary CTA. Live
 * probes / repair flows stay with Setup Center; Provider Doctor stays
 * with Providers. Health is the index — it points the user at the
 * right specialist surface, it doesn't try to be one.
 */

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "@/hooks/useTranslation";
import { useClaudeStatus } from "@/hooks/useClaudeStatus";
import { Button } from "@/components/ui/button";
import {
  CheckCircle,
  Warning,
  XCircle,
  Plug,
  UserCircle,
  CaretRight,
  Info,
} from "@/components/ui/icon";
import { CodePilotIcon } from "@/components/ui/semantic-icon";
import { cn } from "@/lib/utils";
import { useOverviewData } from "./useOverviewData";
import type { TranslationKey } from "@/i18n";

type Severity = "ok" | "warn" | "error";

interface HealthRow {
  id: string;
  icon: React.ReactNode;
  title: string;
  severity: Severity;
  reason: string;
  impact?: string;
  ctaLabel: string;
  ctaOnClick: () => void;
}

const SEVERITY_DOT: Record<Severity, string> = {
  ok: "bg-status-success-foreground",
  warn: "bg-status-warning-foreground",
  error: "bg-destructive",
};

const SEVERITY_ICON: Record<Severity, React.ReactNode> = {
  ok: <CheckCircle size={14} weight="fill" className="text-status-success-foreground shrink-0" />,
  warn: <Warning size={14} weight="fill" className="text-status-warning-foreground shrink-0" />,
  error: <XCircle size={14} weight="fill" className="text-destructive shrink-0" />,
};

export function HealthSection() {
  const { t } = useTranslation();
  const state = useOverviewData();
  const { status: claudeStatus } = useClaudeStatus();
  // Settings is route-level split — cross-section CTAs must router.push
  // a route path; otherwise clicking a Health row only mutates the URL
  // hash without switching pages. See `settings-link-migration.test.ts`.
  const router = useRouter();
  const navToSection = useCallback((section: string) => {
    router.push(`/settings/${section}`);
  }, [router]);

  // While `useOverviewData` is still hydrating its first fetch, every
  // counter sits at the initial-state default (0). Rendering health
  // rows on those zeros would falsely report "no providers / no
  // models" for ~200ms after mount; show a loading shell until the
  // first fetch resolves.
  if (state.loading) {
    return (
      <div className="max-w-4xl mx-auto space-y-8">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            {t("settings.health" as TranslationKey)}
          </h2>
          <p className="text-sm text-muted-foreground mt-1.5">
            {t("settings.healthDesc" as TranslationKey)}
          </p>
        </div>
        <div className="rounded-lg border border-dashed border-border/50 bg-card/50 p-10 text-center">
          <p className="text-xs text-muted-foreground">{t("health.loading")}</p>
        </div>
      </div>
    );
  }

  const rows: HealthRow[] = [];

  // ── 1. Provider connectivity ─────────────────────────────────
  rows.push((() => {
    const count = state.providersConfigured;
    if (count === 0) {
      return {
        id: "providers",
        icon: <Plug size={16} />,
        title: t("health.providers.title"),
        severity: "error",
        reason: t("health.providers.noneReason"),
        impact: t("health.providers.noneImpact"),
        ctaLabel: t("health.providers.noneCta"),
        ctaOnClick: () => navToSection("providers"),
      };
    }
    return {
      id: "providers",
      icon: <Plug size={16} />,
      title: t("health.providers.title"),
      severity: "ok",
      reason: count === 1
        ? t("health.providers.configuredOne", { count })
        : t("health.providers.configuredMany", { count }),
      // Phase 2C.6 follow-up: the CTA was "运行诊断" but it just
      // navigated to #providers (Provider Doctor lives behind a
      // separate button there). Renaming to match the actual destination
      // — the doctor flow is no longer the headline action since
      // health/issue-filing is now log-driven, not auto-diagnose-driven.
      ctaLabel: t("health.providers.okCta"),
      ctaOnClick: () => navToSection("providers"),
    };
  })());

  // ── 2. 执行引擎 / CLI ─────────────────────────────────────────
  rows.push((() => {
    const cliConnected = !!claudeStatus?.connected;
    const cliEnabled = state.cliEnabled;
    const warnCount = claudeStatus?.warnings?.length ?? 0;

    if (state.agentRuntime === "claude-code-sdk" && !cliEnabled) {
      return {
        id: "runtime",
        icon: <CodePilotIcon name="runtime" size="md" />,
        title: t("health.runtime.title"),
        severity: "warn",
        reason: t("health.runtime.cliDisabledReason"),
        impact: t("health.runtime.cliDisabledImpact"),
        ctaLabel: t("health.runtime.cta"),
        ctaOnClick: () => navToSection("runtime"),
      };
    }
    if (state.agentRuntime === "claude-code-sdk" && !cliConnected) {
      return {
        id: "runtime",
        icon: <CodePilotIcon name="runtime" size="md" />,
        title: t("health.runtime.title"),
        severity: "error",
        reason: t("health.runtime.cliMissingReason"),
        impact: t("health.runtime.cliMissingImpact"),
        ctaLabel: t("health.runtime.cta"),
        ctaOnClick: () => navToSection("runtime"),
      };
    }
    if (warnCount > 0) {
      return {
        id: "runtime",
        icon: <CodePilotIcon name="runtime" size="md" />,
        title: t("health.runtime.title"),
        severity: "warn",
        reason: warnCount === 1
          ? t("health.runtime.warningsOne", { count: warnCount })
          : t("health.runtime.warningsMany", { count: warnCount }),
        ctaLabel: t("health.runtime.cta"),
        ctaOnClick: () => navToSection("runtime"),
      };
    }
    return {
      id: "runtime",
      icon: <CodePilotIcon name="runtime" size="md" strokeWidth={2} />,
      title: t("health.runtime.title"),
      severity: "ok",
      reason: state.agentRuntime === "claude-code-sdk"
        ? t("health.runtime.claudeReady")
        : t("health.runtime.codepilotReady"),
      ctaLabel: t("health.runtime.cta"),
      ctaOnClick: () => navToSection("runtime"),
    };
  })());

  // ── 3. Default model validity ────────────────────────────────
  rows.push((() => {
    if (state.noCompatibleProvider) {
      return {
        id: "default-model",
        icon: <CodePilotIcon name="model" size="md" />,
        title: t("health.defaultModel.title"),
        severity: "error",
        reason: t("health.defaultModel.noCompatReason"),
        impact: t("health.defaultModel.noCompatImpact"),
        ctaLabel: t("health.runtime.cta"),
        ctaOnClick: () => navToSection("runtime"),
      };
    }
    if (state.defaultInvalid) {
      const provDisplay = state.defaultProviderName ?? "?";
      const modelDisplay = state.defaultModelLabel ?? "?";
      // #27: pin-incomplete = 固定信息半截（缺 provider 绑定），模型本身可用，
      // 不是 Runtime 兼容问题。其余（provider/model-missing）才是固定目标不在
      // 当前引擎可达范围。两者都是**非阻断**（chat 会自动 fallback），统一降为
      // warning，不再说"阻断"——与 RuntimePanel banner 口径一致。
      if (state.defaultInvalidReason === "pin-incomplete") {
        return {
          id: "default-model",
          icon: <CodePilotIcon name="model" size="md" />,
          title: t("health.defaultModel.title"),
          severity: "warn",
          reason: t("health.defaultModel.pinIncompleteReason"),
          impact: t("health.defaultModel.pinIncompleteImpact"),
          ctaLabel: t("health.defaultModel.cta"),
          ctaOnClick: () => navToSection("models"),
        };
      }
      return {
        id: "default-model",
        icon: <CodePilotIcon name="model" size="md" />,
        title: t("health.defaultModel.title"),
        severity: "warn",
        reason: t("health.defaultModel.incompatibleReason", {
          provider: provDisplay,
          model: modelDisplay,
        }),
        impact: t("health.defaultModel.incompatibleImpact"),
        ctaLabel: t("health.defaultModel.cta"),
        ctaOnClick: () => navToSection("models"),
      };
    }
    if (state.defaultMode === "pinned") {
      return {
        id: "default-model",
        icon: <CodePilotIcon name="model" size="md" />,
        title: t("health.defaultModel.title"),
        severity: "ok",
        reason: t("health.defaultModel.pinnedOk", {
          provider: state.defaultProviderName ?? "?",
          model: state.defaultModelLabel ?? "?",
        }),
        ctaLabel: t("health.defaultModel.cta"),
        ctaOnClick: () => navToSection("models"),
      };
    }
    return {
      id: "default-model",
      icon: <CodePilotIcon name="model" size="md" />,
      title: t("health.defaultModel.title"),
      severity: "ok",
      reason: t("health.defaultModel.autoOk", {
        provider: state.defaultProviderName ?? "?",
        model: state.defaultModelLabel ?? "?",
      }),
      ctaLabel: t("health.defaultModel.cta"),
      ctaOnClick: () => navToSection("models"),
    };
  })());

  // ── 4. Models exposure ───────────────────────────────────────
  rows.push((() => {
    if (state.providersConfigured === 0) {
      return {
        id: "models-exposure",
        icon: <CodePilotIcon name="model" size="md" />,
        title: t("health.modelsExposure.title"),
        severity: "ok",
        reason: t("health.modelsExposure.noProvidersReason"),
        ctaLabel: t("health.defaultModel.cta"),
        ctaOnClick: () => navToSection("models"),
      };
    }
    if (state.modelsEnabled === 0) {
      return {
        id: "models-exposure",
        icon: <CodePilotIcon name="model" size="md" />,
        title: t("health.modelsExposure.title"),
        severity: "error",
        reason: t("health.modelsExposure.noneVisibleReason"),
        impact: t("health.modelsExposure.noneVisibleImpact"),
        ctaLabel: t("health.defaultModel.cta"),
        ctaOnClick: () => navToSection("models"),
      };
    }
    const manualNote = (state.modelsManualEnabled > 0 || state.modelsManualHidden > 0)
      ? t("health.modelsExposure.manualNote", {
          enabled: state.modelsManualEnabled,
          hidden: state.modelsManualHidden,
        })
      : "";
    return {
      id: "models-exposure",
      icon: <CodePilotIcon name="model" size="md" />,
      title: t("health.modelsExposure.title"),
      severity: "ok",
      reason: t("health.modelsExposure.exposedReason", {
        enabled: state.modelsEnabled,
        total: state.modelsTotal,
        manualNote,
      }),
      ctaLabel: t("health.defaultModel.cta"),
      ctaOnClick: () => navToSection("models"),
    };
  })());

  // ── 5. Assistant workspace / local environment ───────────────
  rows.push((() => {
    if (state.workspaceConfigured) {
      return {
        id: "workspace",
        icon: <UserCircle size={16} />,
        title: t("health.workspace.title"),
        severity: "ok",
        reason: state.workspaceName
          ? t("health.workspace.configuredNamed", { name: state.workspaceName })
          : t("health.workspace.configured"),
        ctaLabel: t("health.workspace.cta"),
        ctaOnClick: () => navToSection("assistant"),
      };
    }
    return {
      id: "workspace",
      icon: <UserCircle size={16} />,
      title: t("health.workspace.title"),
      severity: "warn",
      reason: t("health.workspace.notConfiguredReason"),
      impact: t("health.workspace.notConfiguredImpact"),
      ctaLabel: t("health.workspace.cta"),
      ctaOnClick: () => navToSection("assistant"),
    };
  })());

  // Overall severity = max across rows.
  const overallSeverity: Severity = rows.reduce<Severity>((acc, r) => {
    if (r.severity === "error") return "error";
    if (r.severity === "warn" && acc === "ok") return "warn";
    return acc;
  }, "ok");

  const overallTone =
    overallSeverity === "ok"
      ? t("health.overall.ok")
      : overallSeverity === "warn"
        ? t("health.overall.warn")
        : t("health.overall.error");

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight">
            {t("settings.health" as TranslationKey)}
          </h2>
          <p className="text-sm text-muted-foreground mt-1.5">
            {t("settings.healthDesc" as TranslationKey)}
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <span className={cn("size-1.5 rounded-full", SEVERITY_DOT[overallSeverity])} />
          <span className="text-[11px] text-muted-foreground">{overallTone}</span>
        </div>
      </div>

      {/* 5 rows of health checks */}
      <div className="rounded-lg border border-border/50 bg-card divide-y divide-border/50 overflow-hidden">
        {rows.map((row) => (
          <HealthRowItem key={row.id} row={row} />
        ))}
      </div>

      {/* "Need to investigate further?" — Phase 2C.6 reframing. The
          previous wording ("深度诊断与修复") promised auto-detection of
          root causes and an auto-repair path; in practice the doctor
          can't always identify the root cause and "repair" sometimes
          misleads. Honest framing: Health gives status; if status
          doesn't explain it, grab a diagnostic bundle and inspect /
          share. Setup Center stays an entry on the About page (as the
          install / wizard flow), not the headline action here. */}
      <div className="rounded-lg border border-border/50 bg-card p-5 flex flex-col sm:flex-row items-start sm:items-center sm:justify-between gap-3">
        <div className="min-w-0 flex items-start gap-3">
          <Info size={16} className="text-foreground/60 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h3 className="text-sm font-medium">
              {t("health.investigate.title")}
            </h3>
            <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
              {t("health.investigate.desc")}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5"
          onClick={() => navToSection("about")}
        >
          {t("health.investigate.cta")}
          <CaretRight size={12} weight="bold" />
        </Button>
      </div>
    </div>
  );
}

function HealthRowItem({ row }: { row: HealthRow }) {
  return (
    <div className="px-4 py-3.5 flex items-start gap-3">
      <span className="shrink-0 mt-1 text-foreground/60">{row.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {SEVERITY_ICON[row.severity]}
          <h3 className="text-sm font-medium leading-tight">{row.title}</h3>
        </div>
        <p className="text-xs text-foreground/85 mt-1 leading-relaxed">{row.reason}</p>
        {row.impact && (
          <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
            {row.impact}
          </p>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 gap-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={row.ctaOnClick}
      >
        {row.ctaLabel}
        <CaretRight size={12} weight="bold" />
      </Button>
    </div>
  );
}
