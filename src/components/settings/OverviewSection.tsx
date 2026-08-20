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
  const { t } = useTranslation();
  const isZh = t("nav.chats") === "对话";
  const state = useOverviewData();
  const { accountInfo } = useAccountInfo();
  const { updateInfo, checking, checkForUpdates } = useUpdate();
  const { status: claudeStatus } = useClaudeStatus();

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
        <div aria-busy="true" aria-live="polite" className="space-y-8">
          <span className="sr-only">{t("common.loading")}</span>
          <OverviewDashboardSkeleton />
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
          title={isZh ? "运行环境" : "Runtime"}
          tone={runtimeIsFallback ? "warning" : "success"}
          primaryActionLabel={
            runtimeIsFallback
              ? isZh ? "去执行引擎修复" : "Fix in Runtime"
              : isZh ? "管理执行引擎" : "Manage Runtime"
          }
          onPrimaryAction={() => navToSection("runtime")}
        >
          <p>
            <span className="text-muted-foreground">
              {isZh ? "当前默认：" : "Current default: "}
            </span>
            <span className="font-medium">{runtimeLabel}</span>
            {runtimeIsFallback && (
              <span className="ml-1 text-status-warning-foreground">
                {!state.cliEnabled
                  ? (isZh ? "（CLI 已禁用，自动降级）" : "(CLI disabled, fallback)")
                  : (isZh ? "（Claude Code 不可用，自动降级）" : "(Claude Code unavailable, fallback)")}
              </span>
            )}
          </p>
          {claudeWarnings && (
            <p className="text-status-warning-foreground flex items-start gap-1">
              <Warning size={12} weight="fill" className="mt-0.5 shrink-0" />
              <span>{isZh ? "Claude Code 有兼容性提示" : "Claude Code reports compatibility warnings"}</span>
            </p>
          )}
        </OverviewCard>

        {/* Card 2 — Providers (provider count + new-chat default) */}
        <OverviewCard
          icon={<Plug size={16} />}
          title={isZh ? "服务商" : "Providers"}
          tone={state.noCompatibleProvider ? "warning" : "muted"}
          primaryActionLabel={isZh ? "管理服务商" : "Manage providers"}
          onPrimaryAction={() => navToSection("providers")}
        >
          <p>
            <span className="text-muted-foreground">
              {isZh ? "已接入：" : "Configured: "}
            </span>
            <span className="font-medium">{state.providersConfigured}</span>
          </p>
          {state.noCompatibleProvider ? (
            <p className="text-status-warning-foreground">
              {isZh
                ? `当前执行引擎（${runtimeLabel}）下没有可用的 provider/model。`
                : `No provider / model is compatible with the current runtime (${runtimeLabel}).`}
            </p>
          ) : (
            <>
              <p>
                <span className="text-muted-foreground">{isZh ? "默认服务商：" : "Default provider: "}</span>
                <span className="font-medium">
                  {state.defaultProviderName ?? (isZh ? "未配置" : "Not configured")}
                </span>
              </p>
              <p>
                <span className="text-muted-foreground">{isZh ? "默认模型：" : "Default model: "}</span>
                <span className="font-medium">
                  {state.defaultModelLabel ?? (isZh ? "未配置" : "Not configured")}
                </span>
              </p>
            </>
          )}
        </OverviewCard>

        {/* Card 3 — Models exposure */}
        <OverviewCard
          icon={<CodePilotIcon name="model" size="md" />}
          title={isZh ? "模型暴露" : "Models exposure"}
          tone={state.modelsEnabled === 0 && state.providersConfigured > 0 ? "warning" : "muted"}
          primaryActionLabel={isZh ? "管理模型" : "Manage models"}
          onPrimaryAction={() => navToSection("models")}
        >
          <p>
            <span className="text-muted-foreground">
              {isZh ? "可见 / 全部：" : "Visible / total: "}
            </span>
            <span className="font-medium">
              {state.modelsEnabled} / {state.modelsTotal}
            </span>
          </p>
          {state.modelsEnabled === 0 && state.providersConfigured > 0 ? (
            <p className="text-status-warning-foreground">
              {isZh
                ? "你已经接入了服务商，但没有任何模型对 picker 可见。"
                : "You've connected a provider, but no models are visible to the picker."}
            </p>
          ) : (state.modelsManualEnabled > 0 || state.modelsManualHidden > 0) ? (
            <p className="text-muted-foreground">
              {isZh
                ? `手动启用 ${state.modelsManualEnabled} · 手动隐藏 ${state.modelsManualHidden}（刷新不会覆盖）`
                : `${state.modelsManualEnabled} manually enabled · ${state.modelsManualHidden} manually hidden (preserved on refresh)`}
            </p>
          ) : null}
        </OverviewCard>

        {/* Card 4 — Assistant Workspace */}
        <OverviewCard
          icon={<UserCircle size={16} />}
          title={isZh ? "助理工作空间" : "Assistant Workspace"}
          tone={state.workspaceConfigured ? "success" : "warning"}
          primaryActionLabel={
            state.workspaceConfigured
              ? isZh ? "管理助理" : "Manage assistant"
              : isZh ? "去配置" : "Configure"
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
                ? (isZh ? `已配置：${state.workspaceName}` : `Configured: ${state.workspaceName}`)
                : (isZh ? "已配置工作空间" : "Workspace configured")}
            </p>
          ) : (
            <p className="text-muted-foreground">
              {isZh
                ? "尚未配置 — 设定一个本地工作目录开始使用助理"
                : "Not yet configured — pick a local working directory to start"}
            </p>
          )}
        </OverviewCard>

        {/* Card 5 — Update / About */}
        <OverviewCard
          icon={<Info size={16} />}
          title={isZh ? "版本与账户" : "Update & About"}
          tone={updateInfo?.updateAvailable ? "warning" : "success"}
          primaryActionLabel={isZh ? "查看关于" : "View About"}
          onPrimaryAction={() => navToSection("about")}
          footer={
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={checkForUpdates}
              disabled={checking}
            >
              <ArrowsClockwise size={12} className={checking ? "animate-spin" : undefined} />
              {checking ? (isZh ? "检查中…" : "Checking…") : (isZh ? "检查更新" : "Check updates")}
            </Button>
          }
        >
          {updateInfo?.updateAvailable ? (
            <p className="text-status-warning-foreground flex items-start gap-1">
              <Warning size={12} weight="fill" className="mt-0.5 shrink-0" />
              <span>
                {isZh
                  ? `有新版本 v${updateInfo.latestVersion} 可用`
                  : `Update available: v${updateInfo.latestVersion}`}
              </span>
            </p>
          ) : (
            <p className="text-muted-foreground">
              {checking
                ? (isZh ? "正在检查更新…" : "Checking for updates…")
                : (isZh ? "已是最新版本" : "Up to date")}
            </p>
          )}
          {accountInfo?.email && (
            <p className="text-muted-foreground">
              {isZh ? "账户：" : "Account: "}
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
          title={isZh ? "健康检查" : "Health"}
          tone={claudeWarnings ? "warning" : "muted"}
          primaryActionLabel={isZh ? "去健康检查" : "Open Health"}
          onPrimaryAction={() => navToSection("health")}
        >
          {claudeWarnings ? (
            <p className="text-status-warning-foreground flex items-start gap-1">
              <Warning size={12} weight="fill" className="mt-0.5 shrink-0" />
              <span>
                {isZh
                  ? "检测到 Claude Code 兼容性提示，建议在健康检查页查看"
                  : "Claude Code compatibility warnings detected — see Health"}
              </span>
            </p>
          ) : (
            <p className="text-muted-foreground">
              {isZh
                ? "服务商连接、Runtime、默认模型、模型暴露、工作空间状态一站式总览"
                : "One-page overview of provider connectivity, runtime, default model, exposure, and workspace"}
            </p>
          )}
        </OverviewCard>
      </div>

      {/* Bottom — Token usage activity heatmap */}
      <OverviewHeatmap isZh={isZh} onJumpToDetails={() => navToSection("usage")} />
    </div>
  );
}


/**
 * Reserved-geometry loading stand-in for the 6-card grid + heatmap.
 * Matches OverviewCard chrome (`rounded-lg border … p-5`) and Usage's
 * `h-64` reserved chart block so the page does not expand when data lands.
 * Checklist is omitted until loaded (avoids a false "all done" from zeros).
 */
function OverviewDashboardSkeleton() {
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className="rounded-lg border border-border/50 bg-card p-5 flex flex-col gap-3 h-full min-h-[9.5rem] animate-pulse"
          >
            <div className="flex items-center gap-2">
              <div className="size-4 rounded bg-muted" />
              <div className="h-4 w-24 rounded bg-muted" />
            </div>
            <div className="space-y-1.5 flex-1">
              <div className="h-3 w-3/4 rounded bg-muted/70" />
              <div className="h-3 w-1/2 rounded bg-muted/70" />
            </div>
            <div className="h-7 w-28 rounded bg-muted/60" />
          </div>
        ))}
      </div>
      <div
        className="rounded-lg border border-border/50 bg-card p-5 min-h-64 animate-pulse"
        aria-hidden
      >
        <div className="h-4 w-40 rounded bg-muted" />
        <div className="mt-1.5 h-3 w-56 rounded bg-muted/70" />
        <div className="mt-4 h-40 rounded bg-muted/40" />
      </div>
    </>
  );
}
