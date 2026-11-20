"use client";

/**
 * Settings → Overview — the dashboard of the Settings shell.
 *
 * Three layers, top to bottom:
 *
 *   1. Getting Started checklist — 4 items (provider / models / runtime
 *      / workspace). Hidden once 4/4 done. Each pending item carries its
 *      own jump button so the user can pick whichever step they want.
 *   2. 6 status cards in a 2-col grid: Runtime, Providers, Models,
 *      Assistant Workspace, Update / About, Setup / Diagnostics. Cards
 *      that need attention pick up an accent (`status-warning-muted`),
 *      already-configured cards stay flat — so the page no longer reads
 *      as "all uniform black tiles".
 *   3. Token usage heatmap — GitHub-style 7×N grid + summary stats over
 *      the chosen 30 / 90 / 365 day window. Reuses `/api/usage/stats`.
 *
 * Resolution helpers (`computeEffectiveRuntime`, `resolveNewChatDefault`)
 * are reused from `src/lib/runtime/effective.ts` so this surface and
 * Settings → Runtime always agree on which runtime is currently in
 * effect and what the next chat would resolve to.
 */

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "@/hooks/useTranslation";
import { useAccountInfo } from "@/hooks/useAccountInfo";
import { useUpdate } from "@/hooks/useUpdate";
import { useClaudeStatus } from "@/hooks/useClaudeStatus";
import { Button } from "@/components/ui/button";
import { CodePilotIcon } from "@/components/ui/semantic-icon";
import {
  Plug,
  UserCircle,
  CheckCircle,
  Warning,
  ArrowsClockwise,
  Info,
} from "@/components/ui/icon";
import {
  computeEffectiveRuntime,
  runtimeDisplayLabel,
  type AgentRuntime,
} from "@/lib/runtime/effective";
import type { TranslationKey } from "@/i18n";
import { releasePlatformLabel } from "@/lib/update-release";
import { OverviewHeatmap } from "./OverviewHeatmap";
import { OverviewCard } from "./OverviewCard";
import {
  OverviewGettingStartedBar,
  type ChecklistItem,
} from "./OverviewGettingStartedBar";
import { useOverviewData } from "./useOverviewData";

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OverviewSection() {
  const { t, locale } = useTranslation();
  const isZh = locale === "zh";
  const state = useOverviewData();
  const { accountInfo } = useAccountInfo();
  const { updateInfo, checking, checkForUpdates } = useUpdate();
  const { status: claudeStatus } = useClaudeStatus();
  const nativeUpdateBusy = updateInfo?.nativePhase === "downloading"
    || updateInfo?.nativePhase === "downloaded"
    || updateInfo?.nativePhase === "installing";

  // Settings is a route-level split now (one page per /settings/<section>),
  // so cross-section jumps must go through the router or they only mutate
  // the URL hash without switching pages. Section IDs match the folder
  // names under src/app/settings/.
  const router = useRouter();
  const navToSection = useCallback((section: string) => {
    router.push(`/settings/${section}`);
  }, [router]);

  const cliConnected = !!claudeStatus?.connected;
  const effectiveRuntime: AgentRuntime = computeEffectiveRuntime(
    state.agentRuntime,
    state.cliEnabled,
    cliConnected,
  );
  const runtimeIsFallback =
    state.agentRuntime === "claude-code-sdk" && effectiveRuntime !== "claude-code-sdk";
  const runtimeLabel = runtimeDisplayLabel(effectiveRuntime);
  const claudeWarnings = !!(claudeStatus?.warnings && claudeStatus.warnings.length > 0);

  // Build the checklist. Tasks resolve once per render; once a task is
  // done it stays "done" until the underlying state changes — no stuck-
  // checked rows.
  const checklist: ChecklistItem[] = useMemo(() => [
    {
      id: "connect-provider",
      label: t("overview.checklistConnectProvider" as TranslationKey),
      desc: t("overview.checklistConnectProviderDesc" as TranslationKey),
      done: state.providersConfigured > 0,
      actionLabel: t("overview.actionGoConfigure" as TranslationKey),
      onAction: () => navToSection("providers"),
    },
    {
      id: "enable-models",
      label: t("overview.checklistEnableModels" as TranslationKey),
      desc: t("overview.checklistEnableModelsDesc" as TranslationKey),
      // Only ask once a provider exists; "no provider" is covered above.
      done: state.providersConfigured === 0 || state.modelsEnabled > 0,
      actionLabel: t("overview.actionGoConfigure" as TranslationKey),
      onAction: () => navToSection("models"),
    },
    {
      id: "verify-runtime",
      label: t("overview.checklistVerifyRuntime" as TranslationKey),
      desc: t("overview.checklistVerifyRuntimeDesc" as TranslationKey),
      done: !runtimeIsFallback && !claudeWarnings,
      actionLabel: t("overview.actionGoConfigure" as TranslationKey),
      onAction: () => navToSection("runtime"),
    },
    {
      id: "configure-workspace",
      label: t("overview.checklistConfigureWorkspace" as TranslationKey),
      desc: t("overview.checklistConfigureWorkspaceDesc" as TranslationKey),
      done: state.workspaceConfigured,
      actionLabel: t("overview.actionGoConfigure" as TranslationKey),
      onAction: () => navToSection("assistant"),
    },
  ], [
    t, navToSection,
    state.providersConfigured,
    state.modelsEnabled,
    runtimeIsFallback,
    claudeWarnings,
    state.workspaceConfigured,
  ]);

  const allDone = checklist.every((c) => c.done);

  if (state.loading) {
    return (
      <div className="max-w-4xl mx-auto space-y-8">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{t("settings.overview" as TranslationKey)}</h2>
          <p className="text-sm text-muted-foreground mt-1.5">
            {t("settings.overviewDesc" as TranslationKey)}
          </p>
        </div>
        <div className="rounded-lg border border-dashed border-border/50 bg-card/50 p-10 text-center">
          <p className="text-xs text-muted-foreground">{t("overview.loading")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{t("settings.overview" as TranslationKey)}</h2>
        <p className="text-sm text-muted-foreground mt-1.5">
          {t("settings.overviewDesc" as TranslationKey)}
        </p>
      </div>

      {/* Top — Getting Started checklist (hidden once everything done) */}
      {!allDone && (
        <OverviewGettingStartedBar items={checklist} isZh={isZh} t={t} />
      )}

      {/* Middle — 6 status cards in a 2-col grid.
          `md:` breakpoint kicks in at 768px so the dashboard shape lands at
          typical settings widths (in-app browser sidebar already eats ~240px,
          so the lg breakpoint was too late — content area never got there). */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Card 1 — Runtime status */}
        <OverviewCard
          icon={<CodePilotIcon name="runtime" size="md" strokeWidth={runtimeIsFallback ? undefined : 2} />}
          title={t("overview.runtime.title")}
          tone={runtimeIsFallback ? "warning" : "success"}
          primaryActionLabel={
            runtimeIsFallback
              ? t("overview.runtime.ctaFix")
              : t("overview.runtime.ctaManage")
          }
          onPrimaryAction={() => navToSection("runtime")}
        >
          <p>
            <span className="text-muted-foreground">
              {t("overview.runtime.currentDefault")}
            </span>
            <span className="font-medium">{runtimeLabel}</span>
            {runtimeIsFallback && (
              <span className="ml-1 text-status-warning-foreground">
                {!state.cliEnabled
                  ? t("overview.runtime.fallbackCliDisabled")
                  : t("overview.runtime.fallbackCliUnavailable")}
              </span>
            )}
          </p>
          {claudeWarnings && (
            <p className="text-status-warning-foreground flex items-start gap-1">
              <Warning size={12} weight="fill" className="mt-0.5 shrink-0" />
              <span>{t("overview.runtime.claudeWarnings")}</span>
            </p>
          )}
        </OverviewCard>

        {/* Card 2 — Providers (provider count + new-chat default) */}
        <OverviewCard
          icon={<Plug size={16} />}
          title={t("overview.providers.title")}
          tone={state.noCompatibleProvider ? "warning" : "muted"}
          primaryActionLabel={t("overview.providers.ctaManage")}
          onPrimaryAction={() => navToSection("providers")}
        >
          <p>
            <span className="text-muted-foreground">
              {t("overview.providers.configuredLabel")}
            </span>
            <span className="font-medium">{state.providersConfigured}</span>
          </p>
          {state.noCompatibleProvider ? (
            <p className="text-status-warning-foreground">
              {t("overview.providers.noCompatible", { runtime: runtimeLabel })}
            </p>
          ) : (
            <>
              <p>
                <span className="text-muted-foreground">{t("overview.providers.defaultProviderLabel")}</span>
                <span className="font-medium">
                  {state.defaultProviderName ?? t("overview.providers.notConfigured")}
                </span>
              </p>
              <p>
                <span className="text-muted-foreground">{t("overview.providers.defaultModelLabel")}</span>
                <span className="font-medium">
                  {state.defaultModelLabel ?? t("overview.providers.notConfigured")}
                </span>
              </p>
            </>
          )}
        </OverviewCard>

        {/* Card 3 — Models exposure */}
        <OverviewCard
          icon={<CodePilotIcon name="model" size="md" />}
          title={t("overview.models.title")}
          tone={state.modelsEnabled === 0 && state.providersConfigured > 0 ? "warning" : "muted"}
          primaryActionLabel={t("overview.models.ctaManage")}
          onPrimaryAction={() => navToSection("models")}
        >
          <p>
            <span className="text-muted-foreground">
              {t("overview.models.visibleTotalLabel")}
            </span>
            <span className="font-medium">
              {state.modelsEnabled} / {state.modelsTotal}
            </span>
          </p>
          {state.modelsEnabled === 0 && state.providersConfigured > 0 ? (
            <p className="text-status-warning-foreground">
              {t("overview.models.noneVisible")}
            </p>
          ) : (state.modelsManualEnabled > 0 || state.modelsManualHidden > 0) ? (
            <p className="text-muted-foreground">
              {t("overview.models.manualNote", {
                enabled: state.modelsManualEnabled,
                hidden: state.modelsManualHidden,
              })}
            </p>
          ) : null}
        </OverviewCard>

        {/* Card 4 — Assistant Workspace */}
        <OverviewCard
          icon={<UserCircle size={16} />}
          title={t("overview.workspace.title")}
          tone={state.workspaceConfigured ? "success" : "warning"}
          primaryActionLabel={
            state.workspaceConfigured
              ? t("overview.workspace.ctaManage")
              : t("overview.workspace.ctaConfigure")
          }
          onPrimaryAction={() => navToSection("assistant")}
        >
          {state.workspaceConfigured ? (
            <p>
              <CheckCircle
                size={12}
                weight="fill"
                className="inline-block text-status-success-foreground mr-1 -mt-0.5"
              />
              {state.workspaceName
                ? t("overview.workspace.configuredNamed", { name: state.workspaceName })
                : t("overview.workspace.configured")}
            </p>
          ) : (
            <p className="text-muted-foreground">
              {t("overview.workspace.notConfigured")}
            </p>
          )}
        </OverviewCard>

        {/* Card 5 — Update / About */}
        <OverviewCard
          icon={<Info size={16} />}
          title={t("overview.update.title")}
          tone={updateInfo?.updateAvailable ? "warning" : "success"}
          primaryActionLabel={t("overview.update.ctaView")}
          onPrimaryAction={() => navToSection("about")}
          footer={
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={checkForUpdates}
              disabled={checking || nativeUpdateBusy}
            >
              <ArrowsClockwise size={12} className={checking ? "animate-spin" : undefined} />
              {checking
                ? t("settings.checking")
                : nativeUpdateBusy
                  ? t("update.checkUnavailableDuringUpdate")
                  : t("settings.checkForUpdates")}
            </Button>
          }
        >
          {updateInfo?.updateAvailable ? (
            <p className="text-status-warning-foreground flex items-start gap-1">
              <Warning size={12} weight="fill" className="mt-0.5 shrink-0" />
              <span>
                {updateInfo.platformAssetMissing
                  ? t("update.platformAssetMissing", {
                      version: updateInfo.latestVersion,
                      platform: releasePlatformLabel(updateInfo.detectedPlatform),
                    })
                  : t("overview.update.available", { version: updateInfo.latestVersion })}
              </span>
            </p>
          ) : (
            <p className="text-muted-foreground">
              {checking
                ? t("overview.update.checking")
                : t("overview.update.upToDate")}
            </p>
          )}
          {accountInfo?.email && (
            <p className="text-muted-foreground">
              {t("overview.update.accountLabel")}
              <span className="text-foreground/85">{accountInfo.email}</span>
            </p>
          )}
        </OverviewCard>

        {/* Card 6 — Health entry. Phase 2C.5 redirects this card from
            Setup Center to the new Health page, which is now the single
            "is anything wrong?" surface. Setup Center is still the
            wizard / repair flow but reaches it via Health, not directly
            from Overview, so the Overview index has one consistent
            answer for "where do I check status?". */}
        <OverviewCard
          // Swapped from Phosphor `<Heart weight="fill">` to the
          // CodePilotIcon `health` glyph (HugeIcons HeartCheck —
          // stroked). The other Overview cards already use stroked
          // CodePilotIcon glyphs (runtime / model / provider); the
          // filled Phosphor heart visually broke the row. The
          // health-vs-warning state is already conveyed by `tone` +
          // the warning copy below the card, so we don't need the
          // icon weight to carry that signal too.
          icon={<CodePilotIcon name="health" size="md" />}
          title={t("overview.health.title")}
          tone={claudeWarnings ? "warning" : "muted"}
          primaryActionLabel={t("overview.health.ctaOpen")}
          onPrimaryAction={() => navToSection("health")}
        >
          {claudeWarnings ? (
            <p className="text-status-warning-foreground flex items-start gap-1">
              <Warning size={12} weight="fill" className="mt-0.5 shrink-0" />
              <span>
                {t("overview.health.claudeWarnings")}
              </span>
            </p>
          ) : (
            <p className="text-muted-foreground">
              {t("overview.health.summary")}
            </p>
          )}
        </OverviewCard>
      </div>

      {/* Bottom — Token usage activity heatmap */}
      <OverviewHeatmap isZh={isZh} onJumpToDetails={() => navToSection("usage")} />
    </div>
  );
}
