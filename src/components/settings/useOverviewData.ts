"use client";

/**
 * Aggregate the data needed by Settings → Overview into one hook.
 *
 * Three sources, fanned out in parallel on mount:
 *   - `/api/settings/app`              → agent_runtime + cli_enabled
 *   - `/api/providers/models?runtime=auto` → runtime-filtered groups
 *     (used to resolve "what does a new chat actually run?" via the
 *     same `resolveNewChatDefault` chain Settings → Runtime + chat init
 *     also use, so the three surfaces never disagree)
 *   - `/api/providers/models`          → unfiltered group totals
 *     (so the Models card's enabled / total + manual_* counts reflect
 *     the *whole* inventory, not just the runtime-compatible slice)
 *
 * Plus per-provider `?all=1` fetches to pull `enable_source` rows and
 * count manual decisions — picker-feed groups don't carry that field.
 *
 * Refetches when another section dispatches `provider-changed`, so the
 * dashboard reflects the user's edits when they bounce back here.
 */

import { useState, useEffect, useCallback } from "react";
import {
  resolveNewChatDefault,
} from "@/lib/runtime/effective";

/**
 * Virtual / non-DB providers: no `api_providers` row and no `provider_models`
 * to count — their models come from the runtime, not the DB.
 *   - `env`           — environment-variable default
 *   - `openai-oauth`  — OpenAI subscription login
 *   - `codex_account` — Codex (ChatGPT) subscription login; routes through
 *                       Codex's app-server, has no DB provider record
 * Fetching `/api/providers/{id}/models?all=1` for these returns 404
 * ("Provider not found") and reddens the Settings smoke. Add any future
 * virtual provider id here so the overview count loop keeps skipping them.
 */
export const NON_DB_PROVIDER_IDS = new Set<string>(["env", "openai-oauth", "xai-oauth", "codex_account"]);

/** Whether a provider group is backed by a real api_providers DB row, so its
 *  provider_models can be counted via /api/providers/{id}/models?all=1. */
export function isCountableDbProvider(providerId: string): boolean {
  return !NON_DB_PROVIDER_IDS.has(providerId);
}

interface ProviderModelGroup {
  provider_id: string;
  provider_name: string;
  models: Array<{ value: string; label: string }>;
  total_count?: number;
}

interface ModelRow {
  model_id: string;
  enabled: number;
  enable_source: string;
}

export interface OverviewState {
  loading: boolean;
  agentRuntime: string;
  cliEnabled: boolean;
  resolvedRuntimeFromApi: string | null;
  defaultMode: "auto" | "pinned";
  defaultProviderName: string | null;
  defaultModelLabel: string | null;
  /** Phase 2C: pinned default not reachable under effective Runtime.
   *  Surfaced on the Overview Runtime card so the dashboard names the
   *  problem the same way Settings → Runtime does. */
  defaultInvalid: boolean;
  /** When defaultInvalid, which kind — so the UI can distinguish a
   *  half-pinned config (`pin-incomplete`, model is fine, just missing the
   *  provider binding) from a genuinely unreachable pin (provider/model
   *  not in the runtime-filtered groups). #27. */
  defaultInvalidReason: "provider-missing" | "model-missing" | "pin-incomplete" | null;
  noCompatibleProvider: boolean;
  providersConfigured: number;
  modelsTotal: number;
  modelsEnabled: number;
  modelsManualEnabled: number;
  modelsManualHidden: number;
  workspaceConfigured: boolean;
  workspaceName: string | null;
  /**
   * Unfiltered provider groups — kept around so per-session surfaces
   * (RunCockpit's "本次运行" model row) can resolve `providerId` →
   * `provider_name` and `modelValue` → friendly label without a second
   * fetch. We already pull `/api/providers/models` for the inventory
   * counts; persisting the raw groups costs nothing extra.
   */
  providers: ProviderModelGroup[];
}

const initialState: OverviewState = {
  loading: true,
  agentRuntime: "claude-code-sdk",
  cliEnabled: true,
  resolvedRuntimeFromApi: null,
  defaultMode: "auto",
  defaultProviderName: null,
  defaultModelLabel: null,
  defaultInvalid: false,
  defaultInvalidReason: null,
  noCompatibleProvider: false,
  providersConfigured: 0,
  modelsTotal: 0,
  modelsEnabled: 0,
  modelsManualEnabled: 0,
  modelsManualHidden: 0,
  workspaceConfigured: false,
  workspaceName: null,
  providers: [],
};

export function useOverviewData(): OverviewState {
  const [state, setState] = useState<OverviewState>(initialState);

  const fetchAll = useCallback(async () => {
    try {
      const [appRes, modelsAutoRes, modelsAllRes, globalOptRes, workspaceRes, workspaceSummaryRes] =
        await Promise.all([
          fetch("/api/settings/app"),
          fetch("/api/providers/models?runtime=auto"),
          fetch("/api/providers/models"),
          fetch("/api/providers/options?providerId=__global__"),
          fetch("/api/settings/workspace"),
          fetch("/api/workspace/summary"),
        ]);

      const next = { ...initialState, loading: false };

      if (appRes.ok) {
        const appData = await appRes.json();
        const appSettings = appData.settings || {};
        next.agentRuntime = appSettings.agent_runtime || "claude-code-sdk";
        next.cliEnabled = appSettings.cli_enabled !== "false";
      }

      // Runtime-filtered groups → resolve new-chat default via the same
      // chain Settings → Runtime + chat init both use.
      if (modelsAutoRes.ok) {
        const data = (await modelsAutoRes.json()) as {
          groups?: ProviderModelGroup[];
          default_provider_id?: string;
          runtime_applied?: string;
        };
        next.resolvedRuntimeFromApi = data.runtime_applied ?? null;
        const groups = data.groups ?? [];

        let defaultMode: "auto" | "pinned" = "auto";
        let pinnedProviderId = "";
        let pinnedModel = "";
        if (globalOptRes.ok) {
          const globalData = await globalOptRes.json();
          defaultMode = globalData?.options?.default_mode === "pinned" ? "pinned" : "auto";
          pinnedProviderId = globalData?.options?.default_model_provider ?? "";
          pinnedModel = globalData?.options?.default_model ?? "";
        }
        next.defaultMode = defaultMode;

        let savedProviderId = "";
        let savedModel = "";
        if (typeof window !== "undefined") {
          savedProviderId = localStorage.getItem("codepilot:last-provider-id") ?? "";
          savedModel = localStorage.getItem("codepilot:last-model") ?? "";
        }

        const resolved = resolveNewChatDefault({
          groups,
          apiDefaultProviderId: data.default_provider_id,
          mode: defaultMode,
          pinnedProviderId,
          pinnedModel,
          savedProviderId,
          savedModel,
        });

        if (resolved.status === "no-compatible") {
          next.noCompatibleProvider = true;
        } else if (resolved.status === "invalid-default") {
          // Pinned + unreachable. Don't fill in a fallback — that's the
          // contract. Surface what *was* pinned so downstream surfaces
          // (Overview Runtime card, Health page) can name the broken
          // pin instead of showing "未配置". For 'provider-missing' /
          // 'pin-incomplete' the resolver only fills providerId /
          // modelValue (the friendly fields aren't populated when the
          // target isn't in the runtime-filtered group list). Mirror
          // RuntimePanel's fallback rule: providerName ?? providerId,
          // modelLabel ?? modelValue.
          next.defaultInvalid = true;
          next.defaultInvalidReason = resolved.reason ?? null;
          next.defaultProviderName =
            resolved.providerName ?? resolved.providerId ?? null;
          next.defaultModelLabel =
            resolved.modelLabel ?? resolved.modelValue ?? null;
        } else {
          next.defaultProviderName = resolved.providerName ?? null;
          next.defaultModelLabel = resolved.modelLabel ?? null;
        }
      }

      // Unfiltered group list — for the Models aggregate + provider count.
      // P0.4 (2026-06-01): the per-provider `?all=1` deep fetch below is the
      // only UNBOUNDED-N part of this hook (one request per configured
      // provider). Keep the aggregate totals (provider count, enabled/total)
      // in this first paint — they come from the single modelsAll response —
      // but DEFER the manual-count deep fetches to a follow-up patch so the
      // dashboard's core + inventory cards render without waiting on a long
      // provider list. modelsManual* stay 0 until the patch lands.
      let dbGroupsToCount: ProviderModelGroup[] = [];
      if (modelsAllRes.ok) {
        const data = (await modelsAllRes.json()) as { groups?: ProviderModelGroup[] };
        const groups = data.groups ?? [];
        next.providers = groups;
        next.providersConfigured = groups.length;
        let total = 0;
        let enabled = 0;
        for (const g of groups) {
          total += g.total_count ?? g.models.length;
          enabled += g.models.length;
        }
        next.modelsTotal = total;
        next.modelsEnabled = enabled;
        // Skip virtual / non-DB providers (env / OAuth logins / codex_account):
        // they have no provider_models to count and 404 the per-provider fetch.
        dbGroupsToCount = groups.filter((g) => isCountableDbProvider(g.provider_id));
      }

      // Assistant Workspace status — boolean configured + optional name.
      if (workspaceRes.ok) {
        const wsData = await workspaceRes.json();
        if (wsData?.path) next.workspaceConfigured = true;
      }
      if (workspaceSummaryRes.ok) {
        const summary = await workspaceSummaryRes.json();
        if (summary?.name) next.workspaceName = summary.name;
        if (summary?.configured) next.workspaceConfigured = true;
      }

      // First paint: everything except the per-provider manual counts.
      setState(next);

      // Phase 2 (non-blocking): per-provider deep fetch for manual_enabled /
      // manual_hidden counts. A slow / large provider list can't hold up the
      // dashboard's core + inventory cards anymore — they're already painted.
      if (dbGroupsToCount.length > 0) {
        let manualEnabled = 0;
        let manualHidden = 0;
        await Promise.all(
          dbGroupsToCount.map(async (g) => {
            try {
              const r = await fetch(`/api/providers/${g.provider_id}/models?all=1`);
              if (!r.ok) return;
              const j = (await r.json()) as { models?: ModelRow[] };
              for (const m of j.models ?? []) {
                if (m.enable_source === "manual_enabled") manualEnabled += 1;
                else if (m.enable_source === "manual_hidden") manualHidden += 1;
              }
            } catch {
              /* ignore */
            }
          }),
        );
        setState((prev) => ({ ...prev, modelsManualEnabled: manualEnabled, modelsManualHidden: manualHidden }));
      }
    } catch {
      setState((prev) => ({ ...prev, loading: false }));
    }
  }, []);

  useEffect(() => {
    // setState lands on a microtask after `await fetch(...)`, not
    // synchronously — but the `react-hooks/set-state-in-effect` rule
    // can't see through async closures and false-flags this fetch-on-
    // mount pattern. Disabling here is intentional; the canonical
    // alternatives (TanStack Query / React.use(Promise)) are too heavy
    // for a Settings dashboard.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    const handler = () => { fetchAll(); };
    window.addEventListener("provider-changed", handler);
    return () => window.removeEventListener("provider-changed", handler);
  }, [fetchAll]);

  return state;
}
