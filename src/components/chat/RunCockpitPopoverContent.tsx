"use client";

/**
 * RunCockpit popover content — the heavy half of the per-chat run-status
 * surface. Lives in its own file specifically so the dev compile graph
 * for /chat does NOT statically reach Settings overview / provider
 * catalog / runtime resolver code.
 *
 * Phase A (2026-05-09 follow-up): Chat first-paint was being inflated by
 * `RunCockpit.tsx` statically importing `useOverviewData` →
 * `runtime/effective` (the same data layer Settings → Overview uses).
 * `provider-catalog.ts` and friends rode in transitively. The fix is
 * structural: the trigger button (RingIcon + percentage) doesn't need
 * any of that, so the heavy data layer moves here, and `RunCockpit`
 * lazy-mounts this component via `next/dynamic({ ssr: false })`.
 *
 * Radix's `<PopoverContent>` only mounts its children when `open=true`.
 * Combined with `dynamic({ ssr: false })`, the chunk for this file (and
 * everything it transitively imports — useOverviewData, runtime/effective,
 * useClaudeStatus, ai-elements/context's ContextContent* family) only
 * resolves the first time the user actually clicks the cockpit trigger.
 *
 * Locked in by `src/__tests__/unit/chat-static-graph.test.ts`.
 */

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import type { SessionPermissionProfile } from "@/lib/permission/profile";
import { useClaudeStatus } from "@/hooks/useClaudeStatus";
import { ContextContentFooter } from "@/components/ai-elements/context";
import { ContextBreakdownList } from "@/components/chat/context-breakdown/ContextBreakdownList";
import { ContextDotMatrix } from "@/components/chat/context-breakdown/ContextDotMatrix";
import { CodePilotIcon } from "@/components/ui/semantic-icon";
import { cn } from "@/lib/utils";
import {
  computeEffectiveRuntime,
  type AgentRuntime,
} from "@/lib/runtime/effective";
import { useOverviewData } from "@/components/settings/useOverviewData";
import { findModelOption } from "@/lib/model-option-match";
import type { ContextUsageData } from "@/hooks/useContextUsage";

interface RunStatusIssue {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

type Severity = "ok" | "warn" | "error";

function formatTokensCompact(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 100 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, "")) + "K";
  }
  return String(n);
}

export interface RunCockpitPopoverContentProps {
  /** Active chat's provider — used here only for resolving the model
   *  label from `useOverviewData().providers`. The trigger / shell pass
   *  it through verbatim. */
  providerId?: string;
  /** Currently selected model name (display + lookup). */
  modelName?: string;
  /** Resolved upstream model ID for context-window lookup display. */
  upstreamModelId?: string;
  /** Active chat's permission profile. */
  permissionProfile: SessionPermissionProfile;
  /** Step 4c round 4 — session-level runtime pin. Same semantics as
   *  before; suppresses global pinned/runtime-fallback signals because
   *  the user has explicitly opted out of the global default. */
  sessionRuntimePin?: string;
  /** Pre-send token estimate suffix (e.g. " +10K") computed by the shell. */
  pendingSuffix: string;
  /** Whether the trigger has full context (usage + contextWindow > 0).
   *  Drives which inner JSX shape this component renders. */
  hasFullCtx: boolean;
  /** ContextUsage hook output, computed by the shell. */
  usage: ContextUsageData;
}

export function RunCockpitPopoverContent({
  providerId,
  modelName = "",
  upstreamModelId,
  permissionProfile,
  sessionRuntimePin,
  pendingSuffix,
  hasFullCtx,
  usage,
}: RunCockpitPopoverContentProps) {
  void upstreamModelId;
  const { t } = useTranslation();
  const isZh = t("nav.chats") === "对话";
  const state = useOverviewData();
  const { status: claudeStatus } = useClaudeStatus();
  // Settings is route-level split — cross-section CTAs router.push the
  // route path so the navigation actually switches pages.
  const router = useRouter();
  const navToSection = useCallback(
    (section: string) => {
      router.push(`/settings/${section}`);
    },
    [router],
  );

  const cliConnected = !!claudeStatus?.connected;
  const settingRuntime: AgentRuntime = computeEffectiveRuntime(
    state.agentRuntime,
    state.cliEnabled,
    cliConnected,
  );
  const isNonAnthropicProvider = providerId === "openai-oauth" || providerId === "xai-oauth";
  // Round 4 — session-level runtime override. When the user has
  // explicitly pinned a runtime via the composer's RuntimeSelector,
  // this surface must reflect THAT runtime, not the global setting.
  const sessionRuntimeOverride = !!sessionRuntimePin;
  const sessionPinnedAgentRuntime: AgentRuntime | null =
    sessionRuntimePin === "claude_code"
      ? "claude-code-sdk"
      : sessionRuntimePin === "codepilot_runtime"
        ? "native"
        : null;
  const effectiveRuntime: AgentRuntime = isNonAnthropicProvider
    ? "native"
    : sessionPinnedAgentRuntime ?? settingRuntime;
  void effectiveRuntime;
  // Global SDK→native fallback notice: only meaningful when this session
  // follows the global runtime. Suppressed under explicit pin.
  const runtimeFallback =
    !sessionRuntimeOverride &&
    state.agentRuntime === "claude-code-sdk" &&
    effectiveRuntime !== "claude-code-sdk";
  const showGlobalDefaultInvalid =
    !sessionRuntimeOverride && state.defaultInvalid;

  const severity: Severity = useMemo(() => {
    if (state.loading) return "ok";
    if (state.providersConfigured === 0) return "error";
    if (state.modelsEnabled === 0) return "error";
    if (state.noCompatibleProvider) return "error";
    if (showGlobalDefaultInvalid) return "error";
    if (runtimeFallback) return "error";
    const claudeWarn = !!(claudeStatus?.warnings && claudeStatus.warnings.length > 0);
    if (claudeWarn) return "warn";
    if (state.agentRuntime === "claude-code-sdk" && !state.cliEnabled) return "warn";
    if (!state.workspaceConfigured) return "warn";
    return "ok";
  }, [state, claudeStatus, runtimeFallback, showGlobalDefaultInvalid]);
  void severity;

  // Loading shell while overview data is in flight. The trigger keeps
  // showing its context ring (no overview dependency); only the popover
  // body waits for fetch to settle.
  if (state.loading) {
    return (
      <div className="flex min-h-[120px] items-center justify-center p-3 text-xs text-muted-foreground">
        {t("runStatus.loading" as TranslationKey)}
      </div>
    );
  }

  // Issues — providers / models / Claude CLI warnings that don't reach
  // the upper RunCheckpoint. Surface them here (in the popover) so the
  // user can still get to a fix without leaving the chat.
  const issues: RunStatusIssue[] = [];
  if (state.providersConfigured === 0) {
    issues.push({
      message: isZh ? "尚未配置任何服务商" : "No providers configured",
      actionLabel: t("runStatus.fixIssue" as TranslationKey),
      onAction: () => navToSection("providers"),
    });
  }
  if (state.modelsEnabled === 0 && state.providersConfigured > 0) {
    issues.push({
      message: isZh ? "未启用任何模型" : "No models enabled",
      actionLabel: t("runStatus.fixIssue" as TranslationKey),
      onAction: () => navToSection("models"),
    });
  }
  if (state.noCompatibleProvider) {
    issues.push({
      message: isZh
        ? "当前执行引擎下没有可用的服务商"
        : "No compatible provider under the current Runtime",
      actionLabel: t("runStatus.fixIssue" as TranslationKey),
      onAction: () => navToSection("runtime"),
    });
  }
  if (claudeStatus?.warnings && claudeStatus.warnings.length > 0) {
    for (const w of claudeStatus.warnings) {
      issues.push({ message: w });
    }
  }

  const modeIsPinned = state.defaultMode === "pinned";

  // 2026-05-08 — model row reflects THIS session's selection (providerId
  // + modelName props), not the global default; resolve via the cached
  // groups in `useOverviewData`. Fall back to the raw id/value when the
  // lookup misses (mid-fetch, or a deleted provider). Empty fields →
  // "未配置" so an unfilled session reads coherently.
  const sessionProviderGroup = providerId
    ? state.providers.find((g) => g.provider_id === providerId)
    : undefined;
  const sessionModelEntry =
    sessionProviderGroup && modelName
      // Canonical-aware (tech-debt #37): resolve a saved canonical id
      // (`claude-opus-4-7`) to its alias row so the run-status model label
      // reads "Opus 4.7", not the raw upstream slug.
      ? findModelOption(sessionProviderGroup.models, modelName)
      : undefined;
  const providerLabel =
    sessionProviderGroup?.provider_name
    ?? (providerId || t("runStatus.notConfigured" as TranslationKey));
  const modelLabel =
    sessionModelEntry?.label
    ?? (modelName || t("runStatus.notConfigured" as TranslationKey));
  const defaultModeValue = sessionRuntimeOverride
    ? t("runStatus.modeAuto" as TranslationKey)
    : modeIsPinned
      ? showGlobalDefaultInvalid
        ? t("runStatus.modePinnedInvalid" as TranslationKey)
        : t("runStatus.modePinned" as TranslationKey)
      : t("runStatus.modeAuto" as TranslationKey);

  const auxRows = (
    <div className="flex flex-col gap-2 text-xs">
      <div className="text-sm font-medium text-foreground">
        {t("runStatus.title" as TranslationKey)}
      </div>
      <div className="group/row flex items-baseline gap-3">
        <span className="shrink-0 text-muted-foreground">
          {t("runStatus.model" as TranslationKey)}
        </span>
        <span className="min-w-0 flex-1 truncate text-right text-foreground">
          {`${providerLabel} · ${modelLabel}`}
        </span>
        <button
          type="button"
          onClick={() => navToSection("models")}
          className="shrink-0 inline-flex items-center gap-0.5 text-[11px] text-muted-foreground/40 transition-colors group-hover/row:text-muted-foreground hover:!text-foreground"
        >
          {t("runStatus.switch" as TranslationKey)}
          <CodePilotIcon name="external" size={10} aria-hidden />
        </button>
      </div>
      <div className="group/row flex items-baseline gap-3">
        <span className="shrink-0 text-muted-foreground">
          {t("runStatus.defaultMode" as TranslationKey)}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-right",
            !sessionRuntimeOverride && showGlobalDefaultInvalid
              ? "text-status-warning-foreground"
              : "text-foreground",
          )}
        >
          {defaultModeValue}
        </span>
        <button
          type="button"
          onClick={() => navToSection("models")}
          className="shrink-0 inline-flex items-center gap-0.5 text-[11px] text-muted-foreground/40 transition-colors group-hover/row:text-muted-foreground hover:!text-foreground"
        >
          {t("runStatus.modify" as TranslationKey)}
          <CodePilotIcon name="external" size={10} aria-hidden />
        </button>
      </div>
      <div className="flex items-baseline gap-3">
        <span className="shrink-0 text-muted-foreground">
          {t("runStatus.permission" as TranslationKey)}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-right",
            // Only the bypass reads as an alarm. auto_review is elevated but
            // reviewed — colouring it red would tell the user it's the same
            // risk as full access.
            permissionProfile === "full_access"
              ? "text-status-error-foreground"
              : "text-foreground",
          )}
        >
          {permissionProfile === "full_access"
            ? t("runStatus.permissionFullAccess" as TranslationKey)
            : permissionProfile === "auto_review"
              ? t("runStatus.permissionAutoReview" as TranslationKey)
              : t("runStatus.permissionDefault" as TranslationKey)}
        </span>
      </div>
    </div>
  );

  const issuesBlock =
    issues.length > 0 ? (
      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium text-status-warning-foreground">
          {t("runStatus.issuesHeader" as TranslationKey)}
        </div>
        <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          {issues.map((issue, idx) => (
            <li key={idx} className="flex items-start gap-2">
              <span className="mt-1 size-1 shrink-0 rounded-full bg-status-warning-foreground" />
              <div className="flex-1 leading-snug">
                <span>{issue.message}</span>
                {issue.actionLabel && issue.onAction && (
                  <button
                    type="button"
                    onClick={issue.onAction}
                    className="ml-2 inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    {issue.actionLabel}
                    <CodePilotIcon name="external" size={10} aria-hidden />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  // Full-context branch: render the Context.* breakdown the shell's
  // `<Context>` provider already wired with usedTokens / maxTokens / usage
  // / modelId. Same shape as the original popover body, just hosted in
  // the lazy chunk.
  if (hasFullCtx) {
    // Phase 6 Phase 2b follow-up (2026-05-19): the previous
    // `<ContextContentHeader />` from ai-elements rendered a Progress bar
    // PLUS the percentage/tokens text. With the new dot-matrix main bar
    // below, the Progress bar duplicated the same information visually.
    // Inline the header text (no Progress bar) so Context section shows
    // exactly one bar — the dot-matrix.
    // hasFullCtx (the prop) already requires a trusted window; clamp ≤100%
    // so a trusted-but-momentarily-exceeded window (post-compaction) never
    // renders ">100%" (#632).
    const clampedRatio = Math.min(1, Math.max(0, usage.ratio));
    const headerPercentText =
      usage.contextWindow && usage.contextWindow > 0
        ? `${(clampedRatio * 100).toFixed(clampedRatio < 0.1 ? 1 : 0)}%`
        : "";
    const headerTokensText = `${formatTokensCompact(usage.used)} / ${formatTokensCompact(usage.contextWindow ?? 0)}`;
    // UI review 2026-05-19: previously the popover divided children with
    // `divide-y` AND each child carried its own p-3 — that produced 3
    // dividers + uneven outer/inner spacing. Now PopoverContent owns the
    // outer p-3 + space-y-3, each child is padding-free, and there is
    // exactly one divider — a 1px border-top line between the context-
    // usage half (header + breakdown) and the per-session-state half
    // (model / mode / permission + issues + cost). The -mx-3 lets the
    // line stretch across the popover width despite the parent p-3.
    return (
      <>
        {/* UI review round 3 (2026-05-19): PopoverContent dropped its
            outer `space-y-3` because that uniformly gave every child a
            12px margin-top — including the divider, making the line
            feel marooned 24px from both neighbours. Now the popover
            splits into two groups (context-usage half + session-state
            half), each keeping internal `space-y-3`, with the divider
            owning a smaller `my-2` (8px) between them. */}
        <div className="space-y-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <p>{headerPercentText}</p>
              <p className="font-mono text-muted-foreground">{headerTokensText}</p>
            </div>
          </div>
          <div className="space-y-3">
            <ContextDotMatrix breakdown={usage.breakdown} />
            <ContextBreakdownList breakdown={usage.breakdown} />
          </div>
        </div>
        <div className="-mx-3 my-2 border-t border-border" />
        <div className="space-y-3">
          {auxRows}
          {issuesBlock}
          <ContextContentFooter className="!p-0 bg-transparent" />
        </div>
      </>
    );
  }

  // Fallback / unknown-capacity branch — usage exists but the context
  // window couldn't be resolved (e.g. glm-5-turbo). Phase 2a (2026-05-19):
  // the legacy Input/Output/Cache three-row block is replaced by the
  // 10-row ContextBreakdownList (same component as the hasFullCtx branch).
  // Header stays as the bespoke "capacity unknown · used N + pending"
  // line because ContextContentHeader requires a known maxTokens.
  const showUnknownCapacityBlock = usage.hasData && !hasFullCtx;
  const usedDisplay = formatTokensCompact(usage.used);

  return (
    <>
      {showUnknownCapacityBlock && (
        <>
          {/* Mirror of hasFullCtx group structure (see hasFullCtx branch
              note): two groups + my-2 divider, replacing the previous
              uniform space-y-3 that left the divider feeling marooned. */}
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3 text-xs">
                <p className="text-muted-foreground">
                  {t("runStatus.contextCapacityUnknown" as TranslationKey)}
                </p>
                <p className="font-mono text-foreground">
                  {`${usedDisplay}${pendingSuffix}`}
                </p>
              </div>
            </div>
            <div className="space-y-3">
              <ContextDotMatrix breakdown={usage.breakdown} />
              <ContextBreakdownList breakdown={usage.breakdown} />
            </div>
          </div>
          <div className="-mx-3 my-2 border-t border-border" />
        </>
      )}
      <div className="space-y-3">
        {auxRows}
        {issuesBlock}
      </div>
    </>
  );
}
