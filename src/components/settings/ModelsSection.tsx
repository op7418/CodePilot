"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  PencilSimple,
  SpinnerGap,
  Check,
  X,
  Warning,
} from "@/components/ui/icon";
import { CodePilotIcon } from "@/components/ui/semantic-icon";
import { useTranslation } from "@/hooks/useTranslation";
import { runAutoDiscoverForProvider, probeAndApplyProvider, type AutoDiscoverResult } from "@/lib/auto-discover-models";
import { canReliablyFetchModels, canSearchUpstreamModels, isCatalogOnlyPlanProviderRecord, isOpenRouterProviderRecord, shouldShowLegacyCatalogBadge } from "@/lib/provider-catalog";
import { OpenRouterSearchDialog } from "./OpenRouterSearchDialog";
import { OpenRouterCleanupDialog } from "./OpenRouterCleanupDialog";
import { showToast, updateToast } from "@/hooks/useToast";
import type { TranslationKey } from "@/i18n";
import { getProviderIcon } from "./provider-presets";
import { CodexAccountModelsBlock } from "./CodexAccountModelsBlock";
import { getProviderCompat, getModelCompat, compatLabel, compatTone, compatDotColor, compatTooltip } from "@/lib/runtime-compat";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { ApiProvider, ProviderModel, ProviderModelSource, ModelEnableSource } from "@/types";

/**
 * Settings > Models
 *
 * Single source of truth for what shows up in chat-side model pickers.
 * Grouped by provider. Surface:
 *   - enable / hide toggle
 *   - search across model_id + display_name (all providers)
 *   - rename display_name
 *   - manually add a model
 *   - delete a manual model
 *
 * Row order is server-driven (`sort_order` from
 * `getAllModelsForProvider`); there is no user-facing reorder UI here.
 * The DB column stays so future admin / drag-drop tooling can ship
 * without a schema change. Capability auto-detection / editing remain
 * out of scope.
 *
 * Upstream pulls are NOT a primary action on this page. They happen
 * exclusively when the user opens (or retries) the "添加模型" dialog
 * — which auto-fetches via `canSearchUpstreamModels` for searchable
 * vendors and falls back to manual SKU entry for non-searchable ones
 * (Bailian / Volcengine / DeepSeek / xiaomi-mimo-token-plan / etc.).
 * Provider-card flows still trigger a one-shot probe after Key /
 * Base URL changes; the Models page just renders the resulting
 * `provider_models` rows.
 */

interface ProviderModelsBundle {
  provider: ApiProvider;
  models: ProviderModel[];
}

const SOURCE_LABEL_ZH: Record<ProviderModelSource, string> = {
  api: 'API 同步',
  catalog: '内置目录',
  manual: '手动添加',
  role_mapping: '角色映射',
  sdk_default: 'SDK 默认',
};
const SOURCE_LABEL_EN: Record<ProviderModelSource, string> = {
  api: 'From API',
  catalog: 'Catalog',
  manual: 'Manual',
  role_mapping: 'Role mapping',
  sdk_default: 'SDK default',
};
const SOURCE_TONE: Record<ProviderModelSource, string> = {
  api: 'bg-status-success-muted text-status-success-foreground',
  catalog: 'bg-muted text-muted-foreground',
  manual: 'bg-primary/10 text-primary',
  role_mapping: 'bg-status-warning-muted text-status-warning-foreground',
  sdk_default: 'bg-muted text-muted-foreground',
};

/**
 * `enable_source` badge — explains *why* a row is in its current
 * enabled/hidden state. Differs from `source` (which says "where the row
 * came from"); together they answer:
 *   "API found this model" + "and we hid it because it isn't recommended".
 *
 * `recommended` and `catalog` map to undefined — they're the boring default
 * and would just add noise to the list. The user-touched and discovered-
 * but-hidden states are the ones worth surfacing.
 */
const ENABLE_SOURCE_LABEL_ZH: Record<ModelEnableSource, string | undefined> = {
  recommended: undefined,
  catalog: undefined,
  manual_enabled: '手动启用',
  manual_hidden: '手动隐藏',
  discovered: '未推荐',
};
const ENABLE_SOURCE_LABEL_EN: Record<ModelEnableSource, string | undefined> = {
  recommended: undefined,
  catalog: undefined,
  manual_enabled: 'Manually enabled',
  manual_hidden: 'Manually hidden',
  discovered: 'Off-catalog',
};
const ENABLE_SOURCE_TONE: Record<ModelEnableSource, string> = {
  recommended: '',
  catalog: '',
  manual_enabled: 'bg-primary/10 text-primary',
  manual_hidden: 'bg-muted text-muted-foreground',
  // Discovered-but-hidden uses the same orange tone as the discover-models
  // dialog's "will-be-hidden" preview so the two surfaces feel coherent.
  discovered: 'bg-status-warning-muted text-status-warning-foreground',
};
const ENABLE_SOURCE_TOOLTIP_ZH: Record<ModelEnableSource, string> = {
  recommended: '系统按推荐目录自动启用',
  catalog: '内置目录默认',
  manual_enabled: '你在 Models 页主动启用，刷新不会覆盖',
  manual_hidden: '你在 Models 页主动隐藏，刷新不会覆盖',
  discovered: '上游有这个模型，但不在推荐目录里 — 默认不在 Picker 中显示',
};
const ENABLE_SOURCE_TOOLTIP_EN: Record<ModelEnableSource, string> = {
  recommended: 'System auto-enabled per the recommended catalog',
  catalog: 'Built-in catalog default',
  manual_enabled: 'You enabled this in Models — refresh will not override',
  manual_hidden: 'You hid this in Models — refresh will not override',
  discovered: 'Upstream offers this but it is not on the recommended list — hidden from the picker by default',
};

/**
 * Whether a provider can be sent through the discover-models probe.
 *
 * Filters cases that are guaranteed to fail or mislead BEFORE any network
 * call:
 *   1. OAuth-only providers (no /v1/models endpoint exists).
 *   2. Coding/Token Plan providers (火山, 百炼, GLM CN/Global, MiniMax CN/Global,
 *      Xiaomi MiMo Token Plan) — these vendors sell a SKU whitelist that's
 *      already shipped in the preset catalog. Their `/v1/models` returns
 *      the much wider Ark / DashScope inference catalogue (text + image +
 *      embedding + deprecated variants) which would 4xx + bill out-of-plan.
 *      The single source of truth is `isCatalogOnlyPlanProvider` in
 *      provider-catalog.ts — same condition that gates the discovery layer
 *      itself; both layers must use it so a probe never slips through.
 *
 * Anything else gets the chance to probe; if upstream rejects (401 / 404
 * / etc.), the resulting toast carries the real reason instead of a
 * misleading pre-emptive "no key, can't try".
 *
 * In particular, missing api_key is NOT a disqualifier: Ollama's
 * `/api/tags` probe doesn't take a key (the `auth_token` in its
 * preset's defaultEnvOverrides is a fixed pseudo-value, not a real
 * credential). Other providers — including LiteLLM, which routes
 * through `probeOpenAICompat` — still need a key today; their probe
 * will return `missing-credentials` and the batch summary will list
 * them as failed. That's accurate behaviour, not a pre-emptive block.
 *
 * Image providers are already filtered out one layer up (`fetchAll`
 * skips gemini-image / openai-image entirely).
 */
function isSyncableProvider(provider: ApiProvider): { ok: boolean; reasonZh?: string; reasonEn?: string } {
  // Phase 1 Step 2 收敛 round 3 (2026-05-06): single source of truth is
  // `canReliablyFetchModels` (in `provider-catalog.ts`). OpenRouter is
  // explicitly NOT special-cased anymore — its per-section "Refresh"
  // (which mapped to /validate-models) is gone too. OpenRouter users'
  // primary task is search-and-add, not maintenance of upstream-state
  // bookkeeping; the search dialog auto-fetches on open and lives
  // entirely inside the Add Model flow now.
  const policy = canReliablyFetchModels(provider);
  if (policy.reliable) return { ok: true };
  return { ok: false, reasonZh: policy.reasonZh, reasonEn: policy.reasonEn };
}

// Role-mapping keys — module-scoped constants so their identity is stable
// across renders (avoids invalidating the role-models useCallback every render).
type RoleKey = 'default' | 'reasoning' | 'small' | 'sonnet' | 'opus' | 'haiku';
const ROLE_KEYS: RoleKey[] = ['default', 'sonnet', 'opus', 'haiku', 'reasoning', 'small'];

export function ModelsSection() {
  const { t } = useTranslation();
  const isZh = t('nav.chats') === '对话';

  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [bundles, setBundles] = useState<Record<string, ProviderModel[]>>({});
  const [loading, setLoading] = useState(true);
  // Per-provider in-flight refresh — gates the row-section button so a user
  // can't fire two probes against the same upstream while one is in flight.
  const [refreshingProviderId, setRefreshingProviderId] = useState<string | null>(null);
  // OpenRouter validate-models: per-provider Set of model_ids that the
  // last refresh found missing upstream. Component state only — these
  // never enter the DB so the manual_* protection contract isn't muddied.
  // Cleared per-provider on every successful validate.
  const [openRouterMissing, setOpenRouterMissing] = useState<Record<string, Set<string>>>({});
  // OpenRouter search-and-add dialog state: the provider row whose
  // "添加模型" was clicked. Closing resets to null.
  const [openRouterSearchTarget, setOpenRouterSearchTarget] = useState<{ id: string; name: string } | null>(null);
  // OpenRouter "整理早期导入的目录" target — opens the preview dialog for
  // the chosen provider. Closing resets to null.
  const [openRouterCleanupTarget, setOpenRouterCleanupTarget] = useState<string | null>(null);
  // Page-top "刷新全部" in-flight. Disables every per-provider refresh too
  // (no point letting a single refresh race the batch driver).
  const [refreshingAll, setRefreshingAll] = useState(false);
  type ViewFilter = 'enabled' | 'hidden' | 'all';
  const [viewFilter, setViewFilter] = useState<ViewFilter>('enabled');
  type RuntimeFilter = 'all' | 'claude_code_ready' | 'claude_code_verified' | 'claude_code_experimental' | 'openrouter_anthropic_skin' | 'codepilot_only' | 'unknown';
  const [runtimeFilter, setRuntimeFilter] = useState<RuntimeFilter>('all');
  const [search, setSearch] = useState('');

  // Phase 2C: Models page is the canonical entry for "what's the default".
  // We hold:
  //   - `defaultMode` / `pinnedProviderId` / `pinnedModel`: the user's
  //     committed state, read from `/api/providers/options?providerId=__global__`.
  //   - `runtimeCompatModels`: per-provider Set<modelValue> reachable
  //     under the *current* effective Runtime (read from
  //     `/api/providers/models?runtime=auto`). Used to (a) show the
  //     "available in another Runtime" badge on cross-runtime rows and
  //     (b) compute whether the current pin is invalid right now.
  //   - `pinnedIsValid` derives from the above two — null when not in
  //     pinned mode or pin incomplete; boolean otherwise.
  const [defaultMode, setDefaultMode] = useState<'auto' | 'pinned'>('auto');
  const [pinnedProviderId, setPinnedProviderId] = useState('');
  const [pinnedModel, setPinnedModel] = useState('');
  const [runtimeCompatModels, setRuntimeCompatModels] = useState<Map<string, Set<string>>>(new Map());
  const [runtimeApplied, setRuntimeApplied] = useState<string>('');
  const [savingDefault, setSavingDefault] = useState(false);

  // Add-model dialog state
  // Phase 1 Step 2: dialog kind drives the title / description copy.
  // Plan providers describe their Add Model action as "补充 SKU" so the
  // user understands the relationship to the subscription whitelist;
  // generic providers keep the original "manual add" framing.
  const [addDialog, setAddDialog] = useState<{ providerId: string; providerName: string; kind: 'plan' | 'manual' } | null>(null);
  const [newModelId, setNewModelId] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<{ providerId: string; modelId: string; name: string } | null>(null);

  // Bulk toggle confirmation. "全部启用 / 全部关闭" can flip 100+ models
  // in one click on big providers; without confirm the action looks too
  // light for what it does. Show an AlertDialog summarising affected
  // count before executing.
  const [bulkConfirm, setBulkConfirm] = useState<{ providerId: string; providerName: string; target: 0 | 1; affected: number } | null>(null);

  // Inline rename state — keyed by `${providerId}::${modelId}`
  const [editingDisplay, setEditingDisplay] = useState<string | null>(null);
  const [draftDisplay, setDraftDisplay] = useState('');

  // Role-mapping dialog state. role_models_json is parsed lazily per
  // provider; persistance goes through PUT /api/providers/[id].
  // RoleKey / ROLE_KEYS hoisted to module scope (stable identity for the
  // role-models useCallback dep — was recreated every render).
  const ROLE_LABEL_ZH: Record<RoleKey, string> = {
    default: '默认（兜底）',
    sonnet: 'Sonnet 角色',
    opus: 'Opus 角色',
    haiku: 'Haiku 角色',
    reasoning: '推理（reasoning）',
    small: '小模型（small）',
  };
  const ROLE_LABEL_EN: Record<RoleKey, string> = {
    default: 'Default (fallback)',
    sonnet: 'Sonnet role',
    opus: 'Opus role',
    haiku: 'Haiku role',
    reasoning: 'Reasoning',
    small: 'Small',
  };
  const ROLE_HINT_ZH: Record<RoleKey, string> = {
    default: '没有指定模型时用这个；也是 ANTHROPIC_MODEL 的来源',
    sonnet: 'Claude Code 选 Sonnet 时实际跑的模型',
    opus: 'Claude Code 选 Opus 时实际跑的模型',
    haiku: 'Claude Code 选 Haiku 时实际跑的模型',
    reasoning: '复杂推理任务（聊天里专门挑 reasoning 时使用）',
    small: '子代理 / 便宜操作（子任务 / 简单总结时使用）',
  };
  const ROLE_HINT_EN: Record<RoleKey, string> = {
    default: 'Used when no specific model is requested; also feeds ANTHROPIC_MODEL',
    sonnet: 'What Claude Code actually runs when you pick Sonnet',
    opus: 'What Claude Code actually runs when you pick Opus',
    haiku: 'What Claude Code actually runs when you pick Haiku',
    reasoning: 'Complex reasoning tasks (when chat asks for reasoning role)',
    small: 'Sub-agents / cheap ops (sub-tasks / simple summaries)',
  };

  const [roleDialog, setRoleDialog] = useState<{ providerId: string; providerName: string } | null>(null);
  const [roleDraft, setRoleDraft] = useState<Record<RoleKey, string>>({ default: '', sonnet: '', opus: '', haiku: '', reasoning: '', small: '' });
  const [roleSaving, setRoleSaving] = useState(false);

  const parseRoleModels = (provider: ApiProvider): Record<RoleKey, string> => {
    try {
      const parsed = JSON.parse(provider.role_models_json || '{}');
      return {
        default: parsed.default || '',
        sonnet: parsed.sonnet || '',
        opus: parsed.opus || '',
        haiku: parsed.haiku || '',
        reasoning: parsed.reasoning || '',
        small: parsed.small || '',
      };
    } catch {
      return { default: '', sonnet: '', opus: '', haiku: '', reasoning: '', small: '' };
    }
  };

  const openRoleDialog = useCallback((provider: ApiProvider) => {
    setRoleDialog({ providerId: provider.id, providerName: provider.name });
    setRoleDraft(parseRoleModels(provider));
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const provRes = await fetch('/api/providers');
      if (!provRes.ok) throw new Error('Failed to load providers');
      const provData = await provRes.json();
      // Image providers are managed inline on their Provider card (model
      // chips in the children slot, picked from a hardcoded image-only
      // list). Don't surface them here — the picker would be confusing
      // since they don't share the same model_id semantics as chat models.
      const provList: ApiProvider[] = (provData.providers || []).filter(
        (p: ApiProvider) => p.provider_type !== 'gemini-image' && p.provider_type !== 'openai-image',
      );
      setProviders(provList);

      const next: Record<string, ProviderModel[]> = {};
      await Promise.all(provList.map(async (p) => {
        try {
          const r = await fetch(`/api/providers/${p.id}/models?all=1`);
          if (r.ok) {
            const d = await r.json();
            next[p.id] = d.models || [];
          } else {
            next[p.id] = [];
          }
        } catch {
          next[p.id] = [];
        }
      }));
      setBundles(next);
    } finally {
      setLoading(false);
    }
  }, []);

  // Refetch a single provider's bundle without re-fetching the world.
  // Used after the in-place "刷新" so the user's scroll position only
  // shifts because that one section's row count changed, not because
  // every other section also reloaded.
  const refetchProviderBundle = useCallback(async (providerId: string) => {
    try {
      const r = await fetch(`/api/providers/${providerId}/models?all=1`);
      if (r.ok) {
        const d = await r.json();
        setBundles((prev) => ({ ...prev, [providerId]: d.models || [] }));
      }
    } catch { /* ignore — toast already covered failure case */ }
  }, []);

  // In-place "刷新模型" — uses the same probe → conservative apply → toast
  // helper as the Add Service success path, then re-fetches just this
  // provider's bundle so the row list reflects the new state. We don't
  // want to send users to the Providers page for a refresh; they're
  // already looking at the model list, and the diff dialog isn't needed
  // because the conservative apply policy already protects user choices.
  // OpenRouter providers route refresh to /validate-models — read-only
  // diff against upstream, no INSERTs, no enable-state changes, only
  // last_refreshed_at moves. Missing modelIds get stashed in component
  // state so each row can show a "已不在上游" badge until next refresh.
  const handleValidateOpenRouter = useCallback(async (provider: ApiProvider) => {
    setRefreshingProviderId(provider.id);
    try {
      const res = await fetch(`/api/providers/${provider.id}/validate-models`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `${res.status} ${res.statusText}`);
      }
      const data = await res.json() as { verified: number; missing: string[]; cachedAt: string };
      setOpenRouterMissing(prev => ({ ...prev, [provider.id]: new Set(data.missing) }));
      await refetchProviderBundle(provider.id);
      if (data.missing.length === 0) {
        showToast({
          type: 'success',
          message: t('provider.validate.openrouter.allOk' as TranslationKey, {
            verified: String(data.verified),
          }),
          duration: 5000,
        });
      } else {
        showToast({
          type: 'warning',
          message: t('provider.validate.openrouter.someMissing' as TranslationKey, {
            verified: String(data.verified),
            missing: String(data.missing.length),
          }),
          duration: 6000,
        });
      }
    } catch (err) {
      showToast({
        type: 'error',
        message: t('provider.validate.openrouter.error' as TranslationKey, {
          error: err instanceof Error ? err.message : String(err),
        }),
        duration: 5000,
      });
    } finally {
      setRefreshingProviderId(null);
    }
  }, [refetchProviderBundle, t]);

  // Page-top "刷新全部可同步服务商" — sequential probe of every syncable
  // provider with one rolling progress toast. Sequential (not Promise.all)
  // so:
  //   - the rolling toast actually reads as a progression rather than a
  //     blink-and-done
  //   - we don't fan out N parallel probes against shared upstreams
  //     (some Code Plan endpoints rate-limit on bursts)
  //   - if the user navigates away mid-batch, the in-flight one finishes
  //     and the rest is naturally aborted (state guard)
  //
  // Final summary toast lists totals + per-provider failures so the user
  // can tell which one needs attention. We deliberately don't auto-open
  // the Providers page; the user is on Models for a reason.
  const handleRefreshAll = useCallback(async () => {
    if (refreshingAll || refreshingProviderId) return;
    const targets = providers.filter(p => isSyncableProvider(p).ok);
    // Plan-based providers (sdkProxyOnly + coding/token plan) are
    // intentionally not in `targets` — refreshing them would 404 against
    // /v1/models or pollute the user's list with off-plan SKUs. Surface
    // the skip count in the summary so the user can see "we did the
    // right thing on N plan providers" instead of those rows looking
    // mysteriously absent from the toast bookkeeping.
    const skippedPlanCount = providers.filter(p =>
      isCatalogOnlyPlanProviderRecord(p)
    ).length;
    if (targets.length === 0) {
      showToast({
        type: 'info',
        message: isZh ? '没有可同步的服务商' : 'No syncable providers to refresh',
        duration: 4000,
      });
      return;
    }

    setRefreshingAll(true);
    const toastId = showToast({
      type: 'loading',
      message: t('models.refreshAll.progress' as TranslationKey, {
        done: '0',
        total: String(targets.length),
        name: targets[0].name,
      }),
      duration: 0,
    });

    // try/finally guarantees `setRefreshingAll(false)` even if anything
    // in the loop or the post-loop refetch throws — without it, the
    // page-top button would stay "Refreshing..." forever after a single
    // unexpected failure (the original /api/providers throw was the
    // canonical case before we switched away from `fetchAll`).
    try {
      let okCount = 0;
      let noChangeCount = 0;
      let failCount = 0;
      const failures: { name: string; reason: string }[] = [];
      let totalEnabled = 0;
      let totalHidden = 0;
      // OpenRouter validate counts kept separate from the enable/hide
      // bookkeeping above. Validate doesn't enable or hide anything —
      // verified just means "still present upstream", missing means
      // "your local row no longer matches an upstream id". Mixing them
      // into totalEnabled produced a "启用 N" line in the summary that
      // misled users into thinking refresh changed switches.
      let validatedProviders = 0;
      let validatedTotal = 0;
      let validatedMissingTotal = 0;
      const succeededIds: string[] = [];

      for (let i = 0; i < targets.length; i++) {
        const p = targets[i];
        // Update the rolling status to "[i+1]/N · current name"
        updateToast(toastId, {
          type: 'loading',
          message: t('models.refreshAll.progress' as TranslationKey, {
            done: String(i + 1),
            total: String(targets.length),
            name: p.name,
          }),
          duration: 0,
        });

        // OpenRouter providers have their own refresh shape (validate-models
        // — read-only, no INSERT). Without this branch the loop would
        // hand them to `probeAndApplyProvider` → /discover-models → the
        // OpenRouter `unsupported` short-circuit → counted as a failure
        // in the summary. We track validate outcomes in their own
        // counters (validatedProviders / validatedTotal / validatedMissingTotal)
        // and skip the success/up-to-date switch — those map "enabled"
        // and "hidden" into the summary toast, which would lie about
        // what validate actually did (it changes no enable state, only
        // verifies presence upstream).
        if (isOpenRouterProviderRecord(p)) {
          try {
            const res = await fetch(`/api/providers/${p.id}/validate-models`, { method: 'POST' });
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error(body?.error || `${res.status} ${res.statusText}`);
            }
            const data = await res.json() as { verified: number; missing: string[]; cachedAt: string };
            setOpenRouterMissing(prev => ({ ...prev, [p.id]: new Set(data.missing) }));
            okCount += 1;
            validatedProviders += 1;
            validatedTotal += data.verified;
            validatedMissingTotal += data.missing.length;
            succeededIds.push(p.id);
          } catch (err) {
            failCount += 1;
            failures.push({
              name: p.name,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
          continue;
        }

        let result: AutoDiscoverResult;
        try {
          result = await probeAndApplyProvider({ providerId: p.id, providerName: p.name });
        } catch (err) {
          result = { outcome: 'error', errorMessage: err instanceof Error ? err.message : String(err) };
        }

        switch (result.outcome) {
          case 'success':
            okCount++;
            totalEnabled += result.recommendedEnabled ?? 0;
            totalHidden += result.discoveredHidden ?? 0;
            succeededIds.push(p.id);
            break;
          case 'up-to-date':
            // Probe + apply ran; nothing changed substantively but
            // last_refreshed_at advanced. Count as a successful refresh
            // (the user did get a fresh check) and refetch so the row
            // last_refreshed_at column reflects the new timestamp.
            okCount++;
            succeededIds.push(p.id);
            break;
          case 'no-models':
            // Truly empty upstream — apply didn't run, so no bundle
            // refetch needed. Counted in summary so the user knows the
            // probe didn't fail; they may want to investigate why
            // upstream returned 0 models.
            noChangeCount++;
            break;
          case 'unsupported':
            // Should be rare here since isSyncableProvider already
            // filtered; include in failures so the user knows it was
            // skipped silently.
            failCount++;
            failures.push({
              name: p.name,
              reason: isZh ? '不支持自动同步' : 'Discovery not supported',
            });
            break;
          case 'probe-failed':
          case 'apply-failed':
          case 'error':
          default:
            failCount++;
            failures.push({ name: p.name, reason: result.errorMessage ?? 'unknown' });
            break;
        }
      }

      // Soft refetch — only the providers whose bundles actually changed.
      // We deliberately avoid the global `fetchAll` because it flips
      // `loading=true`, which would unmount the entire list and lose the
      // user's scroll position. `refetchProviderBundle` updates one
      // bucket of `bundles` in place, leaving every other section
      // (and the scroll) untouched.
      await Promise.all(succeededIds.map(id => refetchProviderBundle(id)));
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('provider-changed'));
      }

      // Summary toast — surface failures inline so the user can act
      // without expanding anything. Truncate to 3 names; "+N more"
      // suffix for the rest.
      const failNames = failures.slice(0, 3).map(f => f.name).join(', ');
      const failMore = failures.length > 3 ? (isZh ? `等 ${failures.length} 个` : `+${failures.length - 3} more`) : '';
      const summaryParts: string[] = [];
      // Probe-and-apply successes (catalog refreshes that genuinely
      // touched enable/hide state). Skip this line when the only
      // successes were OpenRouter validates — the validated line below
      // already carries the full story, and "0 enabled · 0 hidden" on
      // an OpenRouter-only refresh reads as a bug.
      const probedSuccess = okCount - validatedProviders;
      if (probedSuccess > 0) {
        summaryParts.push(t('models.refreshAll.summaryOk' as TranslationKey, {
          ok: String(probedSuccess),
          enabled: String(totalEnabled),
          hidden: String(totalHidden),
        }));
      }
      if (noChangeCount > 0) {
        summaryParts.push(t('models.refreshAll.summaryNoChange' as TranslationKey, { n: String(noChangeCount) }));
      }
      if (validatedProviders > 0) {
        // Validate summary speaks in "verified / missing" terms — never
        // "enabled / hidden" — because validate changes no enable state.
        // Use a missing-aware variant when there's at least one missing,
        // so the toast directs the user to the per-row badges; otherwise
        // a clean "verified N" reads simpler.
        summaryParts.push(
          validatedMissingTotal > 0
            ? t('models.refreshAll.summaryValidatedSomeMissing' as TranslationKey, {
                providers: String(validatedProviders),
                verified: String(validatedTotal),
                missing: String(validatedMissingTotal),
              })
            : t('models.refreshAll.summaryValidated' as TranslationKey, {
                providers: String(validatedProviders),
                verified: String(validatedTotal),
              }),
        );
      }
      if (failCount > 0) {
        summaryParts.push(t('models.refreshAll.summaryFailed' as TranslationKey, {
          n: String(failCount),
          names: failMore ? `${failNames} ${failMore}` : failNames,
        }));
      }
      // Phase 1 Step 2: surface the plan-provider skip count last so
      // the success/no-change/validate/fail story stays the lead.
      if (skippedPlanCount > 0) {
        summaryParts.push(t('models.refreshAll.summarySkippedPlan' as TranslationKey, {
          n: String(skippedPlanCount),
        }));
      }
      updateToast(toastId, {
        type: failCount > 0 ? 'warning' : 'success',
        message: summaryParts.join(' · '),
        duration: failCount > 0 ? 8000 : 6000,
      });
    } catch (err) {
      // Unexpected exception — turn the rolling toast into an error
      // banner so the user sees something happened, instead of a
      // permanent "loading" spinner.
      updateToast(toastId, {
        type: 'warning',
        message: isZh
          ? `刷新过程异常: ${err instanceof Error ? err.message : String(err)}`
          : `Batch refresh threw: ${err instanceof Error ? err.message : String(err)}`,
        duration: 6000,
      });
    } finally {
      setRefreshingAll(false);
    }
  }, [refreshingAll, refreshingProviderId, providers, isZh, t, refetchProviderBundle]);

  // Persist edited role mappings via PUT /api/providers/[id] (the existing
  // provider PUT route already handles role_models_json). Defined here
  // because it depends on `fetchAll`, which is declared above.
  const handleSaveRoles = useCallback(async () => {
    if (!roleDialog) return;
    const provider = providers.find(p => p.id === roleDialog.providerId);
    if (!provider) return;
    setRoleSaving(true);
    try {
      const next: Record<string, string> = {};
      for (const k of ROLE_KEYS) {
        const v = roleDraft[k]?.trim();
        if (v) next[k] = v;
      }
      const res = await fetch(`/api/providers/${provider.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: provider.name,
          provider_type: provider.provider_type,
          base_url: provider.base_url,
          api_key: provider.api_key,
          extra_env: provider.extra_env,
          role_models_json: JSON.stringify(next),
        }),
      });
      if (res.ok) {
        await fetchAll();
        window.dispatchEvent(new Event('provider-changed'));
      }
    } finally {
      setRoleSaving(false);
      setRoleDialog(null);
    }
  }, [roleDialog, providers, roleDraft, fetchAll]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Phase 2C: read default mode + runtime-compatible groups so the page
  // can render the "new chat default" status row + cross-runtime badges.
  // Refetched on `provider-changed` because flipping mode or pinning a
  // row in another tab shouldn't leave this page stale.
  const fetchDefaultMeta = useCallback(async () => {
    try {
      const [optsRes, modelsRes] = await Promise.all([
        fetch('/api/providers/options?providerId=__global__'),
        fetch('/api/providers/models?runtime=auto'),
      ]);
      if (optsRes.ok) {
        const data = await optsRes.json();
        const opts = data?.options || {};
        setDefaultMode(opts.default_mode === 'pinned' ? 'pinned' : 'auto');
        setPinnedProviderId(opts.default_model_provider || '');
        setPinnedModel(opts.default_model || '');
      }
      if (modelsRes.ok) {
        const data = await modelsRes.json();
        const compatMap = new Map<string, Set<string>>();
        for (const g of data.groups || []) {
          compatMap.set(g.provider_id, new Set(g.models.map((m: { value: string }) => m.value)));
        }
        setRuntimeCompatModels(compatMap);
        setRuntimeApplied(data.runtime_applied || '');
      }
    } catch { /* ignore — best-effort dashboard fetch */ }
  }, []);

  useEffect(() => {
    fetchDefaultMeta();
    const handler = () => { fetchDefaultMeta(); };
    window.addEventListener('provider-changed', handler);
    return () => window.removeEventListener('provider-changed', handler);
  }, [fetchDefaultMeta]);

  // Helpers shared between the top status row and per-row pin button.
  const isRuntimeCompat = useCallback((providerId: string, modelId: string) => {
    return runtimeCompatModels.get(providerId)?.has(modelId) ?? false;
  }, [runtimeCompatModels]);

  const isCurrentDefault = useCallback((providerId: string, modelId: string) => {
    return defaultMode === 'pinned'
      && pinnedProviderId === providerId
      && pinnedModel === modelId;
  }, [defaultMode, pinnedProviderId, pinnedModel]);

  // Pin a specific provider+model as the global default.
  //
  // Two intents converge into this one action:
  //   - "Pin a visible (enabled) model" — straight write.
  //   - "Pin a hidden model" — without enabling the row first, the new
  //     pin would land in 'invalid-default' instantly because the chat
  //     picker filters on `enabled=1`. So when the user clicks pin on a
  //     hidden row we treat it as "enable AND pin" and say so in the
  //     toast. This matches the user's mental model better than
  //     disabling the icon ("why can't I pin this?").
  //
  // Cross-Runtime pins are explicitly *allowed* — the user might be
  // committing for a future Runtime switch — but the resolver will
  // return 'invalid-default' immediately and the chat banner / Runtime
  // banner (2C.3) will surface the broken state until they switch
  // Runtime or re-pin.
  const handleSetAsDefault = useCallback(async (providerId: string, modelId: string) => {
    if (savingDefault) return;
    setSavingDefault(true);
    try {
      const modelRow = (bundles[providerId] || []).find(m => m.model_id === modelId);
      const wasHidden = !!modelRow && modelRow.enabled === 0;
      if (wasHidden) {
        // Inline the enable-row PATCH so this function can stay above
        // `updateModel`'s declaration (closure-time TDZ otherwise). If
        // PATCH fails, abort BEFORE writing the default — pinning a
        // model that's still hidden would land the user back in
        // 'invalid-default' with the same broken pin we tried to fix.
        // Better to surface the enable failure and leave default alone.
        const enableRes = await fetch(`/api/providers/${providerId}/models`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model_id: modelId, enabled: 1 }),
        });
        if (!enableRes.ok) {
          throw new Error('enable-failed');
        }
        const d = await enableRes.json();
        setBundles((prev) => ({ ...prev, [providerId]: d.models || [] }));
      }
      const res = await fetch('/api/providers/options', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: '__global__',
          options: {
            default_mode: 'pinned',
            default_model_provider: providerId,
            default_model: modelId,
            legacy_default_provider_id: providerId,
          },
        }),
      });
      if (!res.ok) throw new Error('save-failed');
      setDefaultMode('pinned');
      setPinnedProviderId(providerId);
      setPinnedModel(modelId);
      window.dispatchEvent(new Event('provider-changed'));
      // Refetch runtime-filtered groups for fresh compat. The
      // `runtimeCompatModels` map we hold in state was built from a
      // pre-enable response (a hidden row is filtered out at the
      // server's `enabled=1` gate), so reading it for the toast would
      // mis-classify a model we *just* enabled as still incompatible.
      // Refetch + decide compat from the fresh response, then update
      // state so the rest of the page sees the same truth.
      let compat = isRuntimeCompat(providerId, modelId);
      try {
        const r = await fetch('/api/providers/models?runtime=auto');
        if (r.ok) {
          const data = await r.json();
          const group = (data.groups || []).find((g: { provider_id: string }) => g.provider_id === providerId);
          compat = !!group?.models?.some((m: { value: string }) => m.value === modelId);
          const compatMap = new Map<string, Set<string>>();
          for (const g of data.groups || []) {
            compatMap.set(g.provider_id, new Set(g.models.map((m: { value: string }) => m.value)));
          }
          setRuntimeCompatModels(compatMap);
        }
      } catch { /* fall back to stale isRuntimeCompat result */ }
      const messageZh = wasHidden
        ? (compat
            ? '已启用并设为默认模型'
            : '已启用并固定，但当前执行引擎 不可执行')
        : (compat
            ? '已设为默认模型'
            : '已固定，但当前执行引擎 不可执行');
      const messageEn = wasHidden
        ? (compat
            ? 'Enabled and set as default'
            : 'Enabled and pinned, but not executable under current Runtime')
        : (compat
            ? 'Set as default model'
            : 'Pinned, but not executable under current Runtime');
      showToast({
        message: isZh ? messageZh : messageEn,
        type: compat ? 'success' : 'warning',
      });
    } catch (err) {
      // Branch the failure copy: an enable-step failure is the more
      // informative case ("we didn't change your default") and avoids
      // implying the pin was actually written.
      const isEnableFailure = err instanceof Error && err.message === 'enable-failed';
      const message = isEnableFailure
        ? (isZh ? '启用模型失败，未修改默认模型' : 'Failed to enable model — default unchanged')
        : (isZh ? '保存默认模型失败' : 'Failed to save default');
      showToast({ message, type: 'error' });
    } finally {
      setSavingDefault(false);
    }
  }, [savingDefault, isZh, isRuntimeCompat, bundles]);

  const handleRevertToAuto = useCallback(async () => {
    if (savingDefault) return;
    setSavingDefault(true);
    try {
      const res = await fetch('/api/providers/options', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: '__global__',
          options: { default_mode: 'auto', legacy_default_provider_id: '' },
        }),
      });
      if (!res.ok) throw new Error('save failed');
      setDefaultMode('auto');
      setPinnedProviderId('');
      setPinnedModel('');
      window.dispatchEvent(new Event('provider-changed'));
      showToast({ message: isZh ? '已切回自动' : 'Reverted to Auto', type: 'success' });
    } catch {
      showToast({ message: isZh ? '切换失败' : 'Failed to switch', type: 'error' });
    } finally {
      setSavingDefault(false);
    }
  }, [savingDefault, isZh]);

  // Resolved display name + label for the current pin. Falls back to the
  // raw ids when the pinned target isn't reachable under the current
  // runtime (so the status row names what's broken instead of showing
  // "未配置"). Same fallback rule as Settings → Runtime explainer
  // (RuntimePanel.tsx) so the two surfaces never drift.
  const pinnedDisplay = useMemo(() => {
    if (defaultMode !== 'pinned' || !pinnedProviderId || !pinnedModel) return null;
    const provider = providers.find(p => p.id === pinnedProviderId);
    const modelRow = provider ? (bundles[provider.id] || []).find(m => m.model_id === pinnedModel) : undefined;
    return {
      providerName: provider?.name ?? pinnedProviderId,
      modelLabel: modelRow?.display_name ?? modelRow?.model_id ?? pinnedModel,
    };
  }, [defaultMode, pinnedProviderId, pinnedModel, providers, bundles]);

  const pinnedIsValid: boolean | null = useMemo(() => {
    if (defaultMode !== 'pinned') return null;
    if (!pinnedProviderId || !pinnedModel) return false; // pin-incomplete
    return isRuntimeCompat(pinnedProviderId, pinnedModel);
  }, [defaultMode, pinnedProviderId, pinnedModel, isRuntimeCompat]);

  // Phase 1 Step 2 收敛 round 2 (2026-05-06): when defaultMode='auto', the
  // status row must show "Auto · 服务商 · 模型" — telling the user *which*
  // provider+model a new chat would actually land on under the current
  // execution engine. Spec point 4 ("Auto 模式必须透明"): an Auto label
  // by itself is a black box.
  //
  // Resolution rule: walk providers in their persisted order; for each,
  // pick the first row that's enabled AND runtime-compatible. If nothing
  // matches, return null and the status row falls back to a "未找到可用
  // 模型" notice (also from the spec — "如果当前自动解析结果不可用，再
  // 显示原因和修复入口").
  //
  // We deliberately don't replicate the full chat-side fallback chain
  // (savedPair from localStorage → apiDefaultProviderId → first) because
  // those concerns belong to chat-init; on Models we just need to
  // explain "what would Auto pick right now under the current engine".
  // The chat-side resolver remains the source of truth at send time.
  const autoResolved = useMemo(() => {
    if (defaultMode !== 'auto') return null;
    for (const p of providers) {
      const rows = bundles[p.id] ?? [];
      const compatSet = runtimeCompatModels.get(p.id);
      if (!compatSet || compatSet.size === 0) continue;
      const first = rows.find(m => m.enabled === 1 && compatSet.has(m.model_id));
      if (first) {
        return {
          providerName: p.name,
          modelLabel: first.display_name || first.model_id,
        };
      }
    }
    return null;
  }, [defaultMode, providers, bundles, runtimeCompatModels]);

  // Don't listen to `provider-changed` — local edits already update bundles
  // from the PATCH response, and a full refetch flips the `loading` flag,
  // unmounts the list, and loses the user's scroll position. The chat-side
  // listeners still pick up the event so the global default-model selector
  // refreshes; this page just stays put.

  // Highlight target row briefly after a deep-link jump. Cleared by the
  // focus effect's setTimeout so the highlight disappears once the user
  // has had time to spot what was scrolled to.
  const [highlightedModelKey, setHighlightedModelKey] = useState<string | null>(null);

  // Focus signal from ProviderCard's "管理模型" jump or RuntimePanel's
  // "去启用此模型" recovery action. Three sessionStorage keys:
  //   codepilot:models-focus-provider  → provider id (required)
  //   codepilot:models-focus-model     → model id (optional, scroll to row)
  //   codepilot:models-focus-filter    → 'all' | 'hidden' (optional, switch filter)
  // ModelsSection consumes all three, then clears them so re-opening the
  // page later doesn't re-trigger.
  useEffect(() => {
    if (loading) return;
    if (typeof window === 'undefined') return;
    const focusProviderId = sessionStorage.getItem('codepilot:models-focus-provider');
    if (!focusProviderId) return;
    const focusModelId = sessionStorage.getItem('codepilot:models-focus-model');
    const focusFilter = sessionStorage.getItem('codepilot:models-focus-filter');
    sessionStorage.removeItem('codepilot:models-focus-provider');
    sessionStorage.removeItem('codepilot:models-focus-model');
    sessionStorage.removeItem('codepilot:models-focus-filter');

    // Filter switch must happen synchronously — the row only renders
    // when the filter exposes it. Without this, scroll-to-row would
    // fail on a hidden-filtered model since the row wouldn't be in the
    // DOM yet.
    if (focusFilter === 'all' || focusFilter === 'hidden') {
      setViewFilter(focusFilter);
    }

    // Defer scroll + highlight to next paint so the DOM has the
    // re-rendered (filter-switched) row in place.
    requestAnimationFrame(() => {
      if (focusModelId) {
        const rowEl = document.querySelector(
          `[data-model-row="${CSS.escape(`${focusProviderId}::${focusModelId}`)}"]`,
        );
        if (rowEl) {
          rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const key = `${focusProviderId}::${focusModelId}`;
          setHighlightedModelKey(key);
          setTimeout(() => {
            setHighlightedModelKey((cur) => (cur === key ? null : cur));
          }, 2400);
          return;
        }
      }
      const sectionEl = document.getElementById(`provider-section-${focusProviderId}`);
      if (sectionEl) sectionEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [loading, providers]);

  const visibleBundles: ProviderModelsBundle[] = useMemo(() => {
    const sorted = [...providers].sort((a, b) => a.sort_order - b.sort_order);
    let bundlesOut = sorted.map((provider) => {
      let models = bundles[provider.id] || [];
      if (viewFilter === 'enabled') models = models.filter(m => m.enabled === 1);
      else if (viewFilter === 'hidden') models = models.filter(m => m.enabled === 0);
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        models = models.filter(m =>
          m.model_id.toLowerCase().includes(q) ||
          m.display_name.toLowerCase().includes(q),
        );
      }
      return { provider, models };
    });
    // Runtime filter — applied per row via getModelCompat. Provider compat
    // and model compat are not the same thing: a `codepilot_only` provider
    // could in principle hold a row whose catalog capability flags shift
    // its model-layer compat (most don't today, but the data model allows
    // it), and per-row evaluation keeps the filter honest as catalog
    // capabilities get filled in. Empty bundles are dropped from the
    // result so the page doesn't render a section header for a provider
    // with zero matching rows.
    if (runtimeFilter !== 'all') {
      bundlesOut = bundlesOut
        .map(b => {
          const providerCompat = getProviderCompat(b.provider);
          // Filter rows by checking each model's compat against the
          // selected provider tier. The `runtimeFilter` value is a
          // provider-tier label (e.g. `claude_code_verified`); a row
          // belongs to the visible set when its provider lives in that
          // tier AND `getModelCompat` doesn't strip it for being media.
          const filteredModels = b.models.filter(m => {
            if (providerCompat !== runtimeFilter) return false;
            const cap = getModelCompat({
              modelId: m.model_id,
              upstreamModelId: m.upstream_model_id || undefined,
              providerCompat,
            });
            // Drop media-only rows and rows that have no chat-side flag
            // (a defensive zero-flag check; today this matches if a
            // future capability ever marks a row entirely non-chat).
            if (cap.media) return false;
            return !!cap.claude_code_compatible || !!cap.codepilot_runtime_compatible;
          });
          return { provider: b.provider, models: filteredModels };
        })
        .filter(b => b.models.length > 0);
    }
    return bundlesOut;
  }, [providers, bundles, search, viewFilter, runtimeFilter]);

  // Aggregate counts for the filter tabs.
  const filterCounts = useMemo(() => {
    let enabled = 0, hidden = 0;
    for (const provider of providers) {
      const list = bundles[provider.id] || [];
      for (const m of list) {
        if (m.enabled === 1) enabled++; else hidden++;
      }
    }
    return { enabled, hidden, all: enabled + hidden };
  }, [providers, bundles]);

  const updateModel = useCallback(async (
    providerId: string,
    modelId: string,
    fields: { display_name?: string; enabled?: number; sort_order?: number },
  ) => {
    const res = await fetch(`/api/providers/${providerId}/models`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId, ...fields }),
    });
    if (res.ok) {
      const d = await res.json();
      setBundles((prev) => ({ ...prev, [providerId]: d.models || [] }));
      window.dispatchEvent(new Event('provider-changed'));
    }
  }, []);

  const handleToggleEnabled = useCallback((providerId: string, model: ProviderModel) => {
    updateModel(providerId, model.model_id, { enabled: model.enabled === 1 ? 0 : 1 });
  }, [updateModel]);

  // Global align dialog state — fetches a dry-run preview first, lets the
  // user see the per-provider impact (insert/enable/hide/prune counts), and
  // only writes when they confirm.
  type AlignPreviewRow = {
    providerId: string;
    providerName: string;
    catalogSize: number;
    enabled: number;
    disabled: number;
    unchanged: number;
    inserted: number;
    pruned: number;
    skipped?: boolean;
  };
  const [alignAllOpen, setAlignAllOpen] = useState(false);
  const [alignAllPhase, setAlignAllPhase] = useState<'idle' | 'previewing' | 'preview-ready' | 'applying'>('idle');
  const [alignPreview, setAlignPreview] = useState<AlignPreviewRow[]>([]);

  const openAlignDialog = useCallback(async () => {
    setAlignAllOpen(true);
    setAlignAllPhase('previewing');
    setAlignPreview([]);
    try {
      const res = await fetch('/api/models/align-all-with-catalog?dryRun=1', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setAlignPreview(data.results || []);
      }
    } finally {
      setAlignAllPhase('preview-ready');
    }
  }, []);

  const handleAlignAll = useCallback(async () => {
    setAlignAllPhase('applying');
    try {
      const res = await fetch('/api/models/align-all-with-catalog', { method: 'POST' });
      if (res.ok) {
        await fetchAll();
        window.dispatchEvent(new Event('provider-changed'));
      }
    } finally {
      setAlignAllOpen(false);
      setAlignAllPhase('idle');
      setAlignPreview([]);
    }
  }, [fetchAll]);

  /** Bulk toggle all models for one provider — used by the "全部关闭/启用"
   *  header button. Skips rows that already have the target state to avoid
   *  needless PATCHes (and unnecessary user_edited flips). */
  const handleBulkToggle = useCallback(async (providerId: string, target: 0 | 1) => {
    const list = bundles[providerId] || [];
    const todo = list.filter(m => m.enabled !== target);
    if (todo.length === 0) return;
    await Promise.all(todo.map(m =>
      fetch(`/api/providers/${providerId}/models`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: m.model_id, enabled: target }),
      }).catch(() => {}),
    ));
    // Single refetch after the batch to avoid N renders.
    try {
      const r = await fetch(`/api/providers/${providerId}/models?all=1`);
      if (r.ok) {
        const d = await r.json();
        setBundles((prev) => ({ ...prev, [providerId]: d.models || [] }));
      }
    } catch { /* ignore */ }
    window.dispatchEvent(new Event('provider-changed'));
  }, [bundles]);

  const beginRename = (providerId: string, model: ProviderModel) => {
    setEditingDisplay(`${providerId}::${model.model_id}`);
    setDraftDisplay(model.display_name || model.model_id);
  };
  const commitRename = async (providerId: string, modelId: string) => {
    if (!editingDisplay) return;
    const trimmed = draftDisplay.trim();
    if (trimmed) {
      await updateModel(providerId, modelId, { display_name: trimmed });
    }
    setEditingDisplay(null);
  };

  const handleAddModel = useCallback(async () => {
    if (!addDialog || !newModelId.trim()) return;
    const res = await fetch(`/api/providers/${addDialog.providerId}/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: newModelId.trim(),
        display_name: newDisplayName.trim() || newModelId.trim(),
      }),
    });
    if (res.ok) {
      const d = await res.json();
      setBundles((prev) => ({ ...prev, [addDialog.providerId]: d.models || [] }));
      window.dispatchEvent(new Event('provider-changed'));
      setAddDialog(null);
      setNewModelId('');
      setNewDisplayName('');
    }
  }, [addDialog, newModelId, newDisplayName]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const res = await fetch(`/api/providers/${deleteTarget.providerId}/models`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: deleteTarget.modelId }),
    });
    if (res.ok) {
      const d = await res.json();
      setBundles((prev) => ({ ...prev, [deleteTarget.providerId]: d.models || [] }));
      window.dispatchEvent(new Event('provider-changed'));
    }
    setDeleteTarget(null);
  }, [deleteTarget]);

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="flex flex-col sm:flex-row items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight">{isZh ? '模型管理' : 'Model management'}</h2>
          <p className="text-sm text-muted-foreground mt-1.5">
            {isZh
              ? '选择每个服务商要在聊天里出现的模型，并补充自定义显示名。'
              : 'Choose which models each provider exposes in chat, with optional display-name overrides.'}
          </p>
        </div>
      </div>

      {/* Phase 1 Step 2 收敛 round 2 (2026-05-06): 「刷新全部」+「按推荐整理」
          完全从主路径移除。理由（来自 insights/models-provider-experience.md）：
          - "刷新全部" 把套餐型 / OpenRouter / 本地 / API 全混在一起，summary
            必须解释跳过/校验/失败/启用，不是用户主路径动作。检测应只在新增
            服务商 / 改 Key / 改 Base URL / 用户在 Add Model 里主动检测时触发。
          - "按推荐整理" 是迁移期维护工具，针对旧版本污染数据；普通用户日常
            不需要。OpenRouter 旧版本 300+ 模型污染走单独的「整理旧版本模型
            目录」入口（仅在检测到污染时显示，见 OpenRouter section header）。
          handleRefreshAll / openAlignDialog 这两个回调函数仍保留供测试 + 隐藏
          维护用，但 UI 不再有触发入口。 */}

      {/* Phase 2C: "New chat default" status row. The Models page is now
          the canonical entry for setting / clearing the default. This row
          shows the current commitment (Auto vs Pinned) and surfaces the
          broken-pin state inline when the pinned target isn't reachable
          under the current Runtime — same wording rule as the chat
          banner + Settings → Runtime explainer (resolver name fallback
          to provider id / model value when friendly labels are absent). */}
      <div
        className={cn(
          'rounded-lg border p-4 flex items-start justify-between gap-3',
          pinnedIsValid === false
            ? 'border-status-warning-border bg-status-warning-muted/30'
            : 'border-border/50 bg-card',
        )}
      >
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium flex items-center gap-2">
            {isZh ? '新会话默认' : 'New chat default'}
            <span
              className={cn(
                'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                defaultMode === 'pinned'
                  ? 'bg-foreground text-background'
                  : 'bg-muted text-muted-foreground',
              )}
              title={defaultMode === 'pinned'
                ? (isZh ? '已固定到具体的 provider + model；不会被自动 fallback。' : 'Pinned to a specific provider + model; never silently fallback.')
                : (isZh ? '系统按当前执行引擎自动选择第一个合适模型。' : 'System auto-picks the first suitable model under the current Runtime.')}
            >
              {defaultMode === 'pinned' ? (isZh ? '已固定' : 'Pinned') : (isZh ? '自动' : 'Auto')}
            </span>
          </h3>
          <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
            {defaultMode === 'auto' ? (
              autoResolved ? (
                isZh
                  ? `当前会用：${autoResolved.providerName} · ${autoResolved.modelLabel}。点击下方任何模型行右侧的图钉可固定为默认。`
                  : `Currently resolves to: ${autoResolved.providerName} · ${autoResolved.modelLabel}. Pin any model row below to commit.`
              ) : (
                <>
                  <Warning size={12} weight="fill" className="inline-block text-status-warning-foreground mr-1 -mt-0.5" />
                  {isZh
                    ? '当前执行引擎下没有可用模型 — 请到「服务商」连接一个，或在下方添加 / 启用模型。'
                    : 'No usable model under the current execution engine — connect one in Providers, or enable / add a model below.'}
                </>
              )
            ) : pinnedIsValid === true ? (
              isZh
                ? `已固定：${pinnedDisplay?.providerName} / ${pinnedDisplay?.modelLabel}`
                : `Pinned: ${pinnedDisplay?.providerName} / ${pinnedDisplay?.modelLabel}`
            ) : pinnedIsValid === false ? (
              <>
                <Warning size={12} weight="fill" className="inline-block text-status-warning-foreground mr-1 -mt-0.5" />
                {isZh
                  ? `已固定：${pinnedDisplay?.providerName ?? pinnedProviderId} / ${pinnedDisplay?.modelLabel ?? pinnedModel} — 当前执行引擎 下无法执行。`
                  : `Pinned: ${pinnedDisplay?.providerName ?? pinnedProviderId} / ${pinnedDisplay?.modelLabel ?? pinnedModel} — not executable under current Runtime.`}
              </>
            ) : (
              isZh
                ? '尚未选择默认模型 — 点击下方任意模型行的图钉。'
                : 'No default selected — pin any model row below.'
            )}
          </p>
        </div>
        {defaultMode === 'pinned' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRevertToAuto}
            disabled={savingDefault}
            className="shrink-0 gap-1.5 text-xs"
          >
            {savingDefault ? (
              <SpinnerGap size={12} className="animate-spin" />
            ) : null}
            {isZh ? '改回自动' : 'Revert to Auto'}
          </Button>
        )}
      </div>

      <div className="flex items-center gap-3">
        {/* Filter tabs — uses the shared Tabs component so the rounded-full
            pill geometry + h-9 height match the Luma-style Input/SelectTrigger
            sitting next to it. The Tabs Root is just used as a styled
            container; we don't render TabsContent (the page itself is the
            content), so gap-0 collapses the otherwise-empty vertical gap. */}
        <Tabs
          value={viewFilter}
          onValueChange={(v) => setViewFilter(v as ViewFilter)}
          className="shrink-0 gap-0"
        >
          <TabsList>
            {([
              { key: 'enabled' as const, labelZh: '已启用', labelEn: 'Enabled', count: filterCounts.enabled },
              { key: 'hidden' as const, labelZh: '已隐藏', labelEn: 'Hidden', count: filterCounts.hidden },
              { key: 'all' as const, labelZh: '全部', labelEn: 'All', count: filterCounts.all },
            ]).map((opt) => (
              <TabsTrigger key={opt.key} value={opt.key} className="gap-1.5 text-xs">
                {isZh ? opt.labelZh : opt.labelEn}
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {opt.count}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* Channel filter — uses the same compat tags as the cards. Wording
            mirrors `compatLabel` / `compatTooltip` to avoid drift. */}
        <Select value={runtimeFilter} onValueChange={(v) => setRuntimeFilter(v as RuntimeFilter)}>
          <SelectTrigger
            className="w-[180px] shrink-0"
            title={isZh ? '按接入渠道筛选服务商' : 'Filter providers by access channel'}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{isZh ? '全部渠道' : 'All channels'}</SelectItem>
            <SelectItem value="claude_code_ready">{compatLabel('claude_code_ready', isZh)}</SelectItem>
            <SelectItem value="claude_code_verified">{compatLabel('claude_code_verified', isZh)}</SelectItem>
            <SelectItem value="claude_code_experimental">{compatLabel('claude_code_experimental', isZh)}</SelectItem>
            <SelectItem value="openrouter_anthropic_skin">{compatLabel('openrouter_anthropic_skin', isZh)}</SelectItem>
            <SelectItem value="codepilot_only">{compatLabel('codepilot_only', isZh)}</SelectItem>
            <SelectItem value="unknown">{compatLabel('unknown', isZh)}</SelectItem>
          </SelectContent>
        </Select>

        <div className="relative flex-1">
          <CodePilotIcon name="search" size="sm" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" aria-hidden />
          <Input
            id="models-search"
            name="models-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isZh ? '搜索模型 id 或显示名…' : 'Search model id or display name…'}
            className="pl-9"
          />
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
          <SpinnerGap size={16} className="animate-spin" />
          <p className="text-sm">{t('common.loading')}</p>
        </div>
      )}

      {!loading && visibleBundles.length === 0 && (
        <div className="rounded-lg border border-border/50 bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {isZh ? '尚未配置任何服务商。先到「服务商」页连接服务。' : 'No providers configured yet — connect one from the Providers page first.'}
          </p>
        </div>
      )}

      {/* Phase 5 Phase 6 IA correction (2026-05-14) — Codex Account is a
          virtual provider whose models come from upstream Codex, not
          from CodePilot's DB. The block surfaces them in Models so users
          don't need to leave the page to discover what's available; it
          self-hides when the user isn't logged in or models haven't been
          fetched yet (no empty-state noise). */}
      {!loading && <CodexAccountModelsBlock isZh={isZh} />}

      {!loading && visibleBundles.map(({ provider, models }) => {
        // Counts/availability are computed on the FULL provider model list,
        // not the search-filtered slice. Bulk-toggle operates on the full
        // list too — see the disabled flag tied to `isSearching` below,
        // which prevents accidental mass actions on filtered views.
        const fullModels = bundles[provider.id] || [];
        const enabledCount = fullModels.filter(m => m.enabled === 1).length;
        const allEnabled = fullModels.length > 0 && enabledCount === fullModels.length;
        const allDisabled = fullModels.length > 0 && enabledCount === 0;
        const isSearching = search.trim().length > 0;
        const providerRoles = parseRoleModels(provider);
        const defaultRoleId = providerRoles.default;
        const defaultRoleHidden = !!defaultRoleId
          && fullModels.some(m => m.model_id === defaultRoleId && m.enabled === 0);
        const defaultRoleModel = defaultRoleId
          ? fullModels.find(m => m.model_id === defaultRoleId)
          : undefined;
        const providerCompat = getProviderCompat(provider);
        return (
        <section
          key={provider.id}
          id={`provider-section-${provider.id}`}
          className="space-y-3 scroll-mt-4"
        >
          {/* Section header — split across two rows so the actions stay
              aligned with the title regardless of how many secondary
              chips ride along.

              Row 1: icon + name + 启用计数 (+ OpenRouter cleanup link
                     when applicable)  ← actions
              Row 2: Compat pill + 默认模型 chip (only when present)

              The split keeps the "角色映射 / 添加模型" cluster pinned to
              the right of the same baseline as the provider name;
              without it those buttons drift down
              when row 1 wraps. */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="shrink-0 size-7 rounded-md bg-muted/60 flex items-center justify-center">
                  {getProviderIcon(provider.name, provider.base_url)}
                </div>
                <h3 className="text-sm font-medium truncate">{provider.name}</h3>
                <span className="text-[11px] text-muted-foreground shrink-0">
                  {isSearching
                    ? (isZh
                        ? `${models.length} / ${fullModels.length} 匹配`
                        : `${models.length} / ${fullModels.length} match`)
                    : (isZh
                        ? `${enabledCount} / ${fullModels.length} 启用`
                        : `${enabledCount} / ${fullModels.length} enabled`)}
                </span>
                {/* Phase 1 Step 2 收敛 round 4 + 5 (2026-05-06): compat
                    tag moved onto the same line as the count, kept as
                    a pill shape (rounded-full + padding + small font)
                    but with a neutral muted background instead of the
                    full colored fill. The compat tier is conveyed by a
                    small colored dot inside the pill — same idea as
                    the status pill on ProviderCard, just neutral bg. */}
                {providerCompat && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground cursor-help shrink-0">
                        <span className={cn('size-1.5 rounded-full', compatDotColor(providerCompat))} aria-hidden />
                        {compatLabel(providerCompat, isZh)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{compatTooltip(providerCompat, isZh)}</TooltipContent>
                  </Tooltip>
                )}
                {/* "默认" role indicator — also lifted up from Row 2.
                    Stays as a muted-bg chip (not a dot) because it's
                    an actionable warning when the default is hidden:
                    the ⚠ flips on real misconfiguration, and a plain
                    text label wouldn't carry the warning tone strong
                    enough for "your default model is hidden". */}
                {defaultRoleId && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium cursor-help shrink-0",
                          defaultRoleHidden ? "bg-status-warning-muted text-status-warning-foreground" : "bg-muted text-muted-foreground",
                        )}
                      >
                        {isZh ? '默认' : 'Default'}: {defaultRoleModel?.display_name || defaultRoleId}
                        {defaultRoleHidden && ' ⚠'}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {defaultRoleHidden
                        ? (isZh
                            ? `默认模型「${defaultRoleId}」已隐藏，运行时会回退到第一个启用的模型`
                            : `Default "${defaultRoleId}" is hidden — runtime falls back to the first enabled model`)
                        : (isZh
                            ? `没有指定模型时使用：${defaultRoleModel?.display_name || defaultRoleId}`
                            : `Used when no model is specified: ${defaultRoleModel?.display_name || defaultRoleId}`)}
                    </TooltipContent>
                  </Tooltip>
                )}
                {/* Phase 1 Step 2 收敛 round 8 (2026-05-06): the section-
                    level "上次同步" timestamp was paired with the per-
                    section Refresh button. With Refresh gone (search/Add
                    Model is the only upstream-pull entry now), the
                    timestamp had no actionable meaning and its tooltip
                    still pointed at a button that no longer exists, so
                    it's removed entirely. */}
                {/* Phase 1 Step 2 收敛 round 2 (2026-05-06): only show the
                    "整理旧版本模型目录" entry when there's actually legacy
                    pollution to clean. The cleanup heuristic
                    (`enable_source='recommended' AND user_edited=0`) is
                    cheap to compute client-side from the already-loaded
                    `bundles` — no extra fetch. When the count is 0 the
                    link disappears entirely; the dialog's "nothing to
                    tidy" empty state never shows for normal users. The
                    server-side WHERE clause still guarantees `manual_*`
                    / `user_edited` rows are never touched. */}
                {isOpenRouterProviderRecord(provider)
                  && (bundles[provider.id] ?? []).some(m => m.enable_source === 'recommended' && m.user_edited === 0) && (
                    <button
                      type="button"
                      onClick={() => setOpenRouterCleanupTarget(provider.id)}
                      className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2 shrink-0"
                      title={t('provider.cleanup.openrouter.entryLinkTooltip' as TranslationKey)}
                    >
                      {t('provider.cleanup.openrouter.entryLink' as TranslationKey)}
                    </button>
                  )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
              {/* Phase 1 Step 2 收敛 round 8 (2026-05-06): per-section
                  "Refresh" button removed entirely. Earlier rounds hid
                  it for plan/OpenRouter/image/SDK-only providers; this
                  round drops it for the remaining set (ollama / litellm
                  / anthropic-thirdparty / kimi / moonshot / xiaomi-mimo
                  PAYG) too. Reasoning (review feedback): every provider
                  in that set ALSO has a working `canSearchUpstreamModels`
                  path, so there are now two near-duplicate ways to pull
                  upstream — Refresh and Add Model — and the latter is
                  the one the page is built around. Upstream pulls now
                  happen exclusively when the Add Model dialog opens or
                  is retried (or invisibly after Key/Base URL change in
                  the provider's own card flow). */}
              {/* Phase 1 Step 2 收敛 round 3 (2026-05-06): "全部启用" /
                  "全部关闭" 批量操作从 section header 移除。理由：这两条
                  来自旧的全量同步时代（一次拉 100+ 模型，需要批量裁剪到
                  日常用得上的几个）。当前方向是 catalog 默认启用 + 用户
                  按需手动添加 / 隐藏，单条操作即可，不再需要批量治理。
                  历史污染由「整理旧版本模型目录」迁移工具按条件出现处理。
                  bulkConfirm state + AlertDialog 实现保留供测试和编程
                  调用，但 UI 不再有触发入口。 */}
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => openRoleDialog(provider)}
                title={isZh
                  ? '设置 Claude Code 引擎的别名映射（Sonnet / Opus / Haiku 等）实际跑哪个模型；只对 Claude Code 引擎生效，其它执行引擎按你直接选择的模型运行'
                  : "Set the Claude Code engine alias mapping (Sonnet / Opus / Haiku) — only Claude Code uses these aliases, other engines run whichever model you pick directly"}
              >
                {isZh ? '角色映射' : 'Roles'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  // Phase 1 Step 2 收敛 round 6 (2026-05-06): search-add
                  // path extended beyond OpenRouter. Any provider where
                  // /v1/models reliably returns a real catalog
                  // (`canReliablyFetchModels`) gets the search dialog —
                  // ollama, litellm, anthropic-thirdparty, generic
                  // openai-compatible. Plan providers (Volcengine
                  // included), image providers, Bedrock/Vertex, PAYG
                  // anthropic-compat brands and Anthropic official all
                  // fall to the manual dialog where users type
                  // modelId + displayName by hand.
                  if (canSearchUpstreamModels(provider).reliable) {
                    setOpenRouterSearchTarget({ id: provider.id, name: provider.name });
                  } else {
                    const isPlan = isCatalogOnlyPlanProviderRecord(provider);
                    setAddDialog({ providerId: provider.id, providerName: provider.name, kind: isPlan ? 'plan' : 'manual' });
                    setNewModelId('');
                    setNewDisplayName('');
                  }
                }}
              >
                <CodePilotIcon name="plus" size={12} strokeWidth={2} aria-hidden />
                {isZh ? '添加模型' : 'Add model'}
              </Button>
              </div>
            </div>
            {/* Row 2 removed — compat + default role chips moved up onto
                Row 1 (next to the count) per Codex round-4 review. */}
          </div>

          {models.length === 0 ? (
            <div className="rounded-lg border border-border/50 bg-card px-4 py-6 text-center">
              <p className="text-xs text-muted-foreground">
                {search.trim()
                  ? (isZh ? '无匹配结果' : 'No matches')
                  : (isZh ? '该服务商暂无模型 — 点右上方「添加模型」补充' : 'No models yet — use "Add model" above to add one')}
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-border/50 bg-card divide-y divide-border/50">
              {models.map((model, idx) => {
                const editing = editingDisplay === `${provider.id}::${model.model_id}`;
                const sourceTone = SOURCE_TONE[model.source as ProviderModelSource] || SOURCE_TONE.manual;
                const sourceLabel = (isZh ? SOURCE_LABEL_ZH : SOURCE_LABEL_EN)[model.source as ProviderModelSource] || model.source;
                const enableSourceLabel = (isZh ? ENABLE_SOURCE_LABEL_ZH : ENABLE_SOURCE_LABEL_EN)[model.enable_source];
                const enableSourceTone = ENABLE_SOURCE_TONE[model.enable_source];
                const enableSourceTooltip = (isZh ? ENABLE_SOURCE_TOOLTIP_ZH : ENABLE_SOURCE_TOOLTIP_EN)[model.enable_source];
                return (
                  <div
                    key={model.id}
                    data-model-row={`${provider.id}::${model.model_id}`}
                    className={cn(
                      'px-4 py-3 flex items-center gap-3 transition-colors duration-700',
                      highlightedModelKey === `${provider.id}::${model.model_id}`
                        && 'bg-status-warning-muted/40',
                    )}
                  >
                    {/* Identity column */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {editing ? (
                          <div className="flex items-center gap-1 flex-1 min-w-0">
                            <Input
                              value={draftDisplay}
                              onChange={(e) => setDraftDisplay(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitRename(provider.id, model.model_id);
                                if (e.key === 'Escape') setEditingDisplay(null);
                              }}
                              autoFocus
                              className="h-7 text-sm"
                            />
                            <Button variant="ghost" size="icon-xs" className="h-6 w-6 shrink-0" onClick={() => commitRename(provider.id, model.model_id)}>
                              <Check size={12} />
                            </Button>
                            <Button variant="ghost" size="icon-xs" className="h-6 w-6 shrink-0" onClick={() => setEditingDisplay(null)}>
                              <X size={12} />
                            </Button>
                          </div>
                        ) : (
                          <>
                            <span className={cn("text-sm font-medium truncate", model.enabled === 0 && "text-muted-foreground line-through")}>
                              {model.display_name || model.model_id}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
                              onClick={() => beginRename(provider.id, model)}
                              title={isZh ? '编辑显示名' : 'Rename'}
                            >
                              <PencilSimple size={11} />
                            </Button>
                          </>
                        )}
                        {/* Phase 1 Step 2 收敛 round 2 (2026-05-06): 主路径
                            上不再展示工程感的 source / enable_source pill。
                            这两个 pill 在迁移期是调试 catalog vs manual vs
                            recommended 来源用的；普通用户看到的是噪音 ——
                            "API 同步" / "手动启用" / "已不再推荐" 这套词
                            对他们没有可执行含义。`sourceLabel`、
                            `enableSourceLabel`、`enableSourceTooltip` 等
                            计算逻辑保留供未来"详情"展开使用，但默认行 UI
                            不渲染。actionable 的 pill 只剩三类：默认标记、
                            OpenRouter validate「已不在上游」（用户能行动 —
                            隐藏这一行）、当前执行引擎不可用。 */}
                        {/* Phase 1 Step 2 收敛 round 3 (2026-05-06):
                            OpenRouter "Not on upstream" badge removed
                            from primary path. Reason: validate-models
                            UI trigger is gone; "已添加模型不常驻显示
                            still upstream / missing upstream 这类上游
                            校验状态" per Codex's spec — that bookkeeping
                            is not the user's primary concern after they
                            search-and-add a model. `openRouterMissing`
                            state remains in the component tree but
                            never gets populated from main UI now;
                            keeping the state for tests / future
                            "details" view doesn't surface a badge. */}
                        {/* Phase 2C: "Default" pill on the currently-pinned row.
                            Helps the user spot their commitment without
                            scanning all the pin icons. Persistent visual
                            independent of hover state. */}
                        {isCurrentDefault(provider.id, model.model_id) && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-foreground text-background px-2 py-0.5 text-[10px] font-medium"
                            title={isZh
                              ? '当前固定的默认模型 — 新会话将使用这个'
                              : 'Currently pinned default — used by new chats'}
                          >
                            <CodePilotIcon name="pin" size={9} strokeWidth={2} aria-hidden />
                            {isZh ? '默认' : 'Default'}
                          </span>
                        )}
                        {/* Phase 2C: cross-Runtime tag — this model isn't
                            in the runtime-filtered list, so a chat under
                            the *current* Runtime can't reach it. Pinning
                            it is still allowed (user may be committing
                            for a future Runtime switch); the resolver
                            will return 'invalid-default' and the chat
                            banner / Runtime banner will surface that. */}
                        {model.enabled === 1 && !isRuntimeCompat(provider.id, model.model_id) && (
                          <span
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-status-warning-muted text-status-warning-foreground cursor-help"
                            title={isZh
                              ? `当前执行引擎（${runtimeApplied || '未知'}）不支持这个模型。聊天发送时会被跳过；切换到另一个执行引擎，或在下方选其他模型。这与「角色映射」无关 — 角色映射只对 Claude Code 引擎生效。`
                              : `The current execution engine (${runtimeApplied || 'unknown'}) does not run this model. Chat will skip it; switch engine, or pick a different model below. This is unrelated to role mapping — those aliases only apply to the Claude Code engine.`}
                          >
                            {isZh ? '当前执行引擎不可用' : 'Other engine only'}
                          </span>
                        )}
                        {/* Phase 1 Step 2 收敛 round 2 (2026-05-06):
                            "已不在当前推荐目录" badge moved off the
                            primary path. Reason: even when narrowed to
                            authoritative-catalog providers it's catalog-
                            history information, not an actionable user
                            state — users can't fix "this SKU isn't in
                            the recommended list anymore" except by
                            hiding the row, which they can already do
                            without the badge. `shouldShowLegacyCatalogBadge`
                            stays in `provider-catalog.ts` for tests and
                            future "details / 更多" use, but no row UI
                            renders it. */}
                      </div>
                      {/* Three-concept identity rows. Without explicit
                          labels the bare strings (e.g. plain `sonnet`)
                          look like a model name; users couldn't tell
                          short aliases apart from real model IDs. Row
                          structure now distinguishes:
                            - upstream model ID  → what's actually sent
                              to the API
                            - Claude Code alias  → labelled when the
                              model_id is `sonnet` / `opus` / `haiku`
                            - last refresh       → when this row was
                              last synced from upstream */}
                      {(() => {
                        const isAlias = model.model_id === 'sonnet' || model.model_id === 'opus' || model.model_id === 'haiku';
                        const upstreamDiffers = !!model.upstream_model_id && model.upstream_model_id !== model.model_id;
                        // Phase 1 Step 2 收敛 round 4 (2026-05-06): when a
                        // provider has a custom role mapping set (via the
                        // role-mapping dialog → role_models_json) for this
                        // alias, surface the target inline so users can
                        // tell at a glance what "Sonnet" resolves to under
                        // the Claude Code engine. Shown only on alias
                        // rows; a non-alias row's `role_models_json` entry
                        // doesn't apply to its own row identity.
                        const roleMappingTarget = isAlias
                          ? (providerRoles[model.model_id as keyof typeof providerRoles] || '')
                          : '';
                        const showRoleMapping = !!roleMappingTarget && roleMappingTarget !== model.model_id;
                        return (
                          <div className="mt-0.5 flex items-center gap-3 text-[11px] text-muted-foreground truncate">
                            {isAlias ? (
                              <span className="truncate">
                                <span>{isZh ? 'Claude Code 别名: ' : 'Claude Code alias: '}</span>
                                <span className="font-mono">{model.model_id}</span>
                              </span>
                            ) : (
                              <span className="truncate">
                                <span>{isZh ? '上游模型 ID: ' : 'Upstream ID: '}</span>
                                <span className="font-mono">{model.model_id}</span>
                              </span>
                            )}
                            {showRoleMapping && (
                              <span
                                className="truncate"
                                title={isZh
                                  ? `Claude Code 引擎下，「${model.model_id}」会调用 ${roleMappingTarget}（在「角色映射」里设置）`
                                  : `Under the Claude Code engine, "${model.model_id}" routes to ${roleMappingTarget} (set in Role mapping)`}
                              >
                                <span>{isZh ? '映射到: ' : 'Maps to: '}</span>
                                <span className="font-mono">{roleMappingTarget}</span>
                              </span>
                            )}
                            {upstreamDiffers && (
                              <span className="truncate">
                                <span>{isZh ? '实际请求: ' : 'Actual: '}</span>
                                <span className="font-mono">{model.upstream_model_id}</span>
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    {/* Phase 2C: pin-as-default. Filled icon when this row
                        is the current pin, ghost otherwise. Click commits
                        provider+model as the global default (writes
                        default_mode='pinned' alongside the pair). To clear,
                        use the "Revert to Auto" button on the top status
                        row — clearing via row-toggle would make every pin
                        click feel two-stage. Cross-Runtime models can be
                        pinned (allowed but immediately invalid; warned in
                        the top status row). */}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleSetAsDefault(provider.id, model.model_id)}
                      disabled={savingDefault || isCurrentDefault(provider.id, model.model_id)}
                      className={cn(
                        'shrink-0 h-7 w-7',
                        isCurrentDefault(provider.id, model.model_id)
                          ? 'text-status-warning-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                      title={isCurrentDefault(provider.id, model.model_id)
                        ? (isZh ? '当前默认模型' : 'Current default model')
                        : model.enabled === 0
                          ? (isZh ? '启用并设为默认模型' : 'Enable and set as default')
                          : (isZh ? '设为默认模型' : 'Set as default')}
                    >
                      <CodePilotIcon
                        name="pin"
                        size="sm"
                        strokeWidth={isCurrentDefault(provider.id, model.model_id) ? 2 : undefined}
                        aria-hidden
                      />
                    </Button>

                    {/* Delete (manual only) — sits LEFT of the Switch so
                        the toggle stays anchored to the right edge whether
                        or not this row is deletable. No placeholder
                        reservation: rows without delete should close the
                        gap, not leave a ghost slot. */}
                    {model.source === 'manual' && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive shrink-0"
                        onClick={() => setDeleteTarget({ providerId: provider.id, modelId: model.model_id, name: model.display_name || model.model_id })}
                        title={isZh ? '删除此条' : 'Delete'}
                      >
                        <CodePilotIcon name="delete" size="sm" aria-hidden />
                      </Button>
                    )}

                    {/* Enabled toggle — always rightmost */}
                    <div className="flex items-center gap-2 shrink-0">
                      <Switch
                        checked={model.enabled === 1}
                        onCheckedChange={() => handleToggleEnabled(provider.id, model)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        );
      })}

      {/* Role mapping editor — one provider at a time. Each role is a Select
          over enabled models for that provider, plus a "清除" option. We
          show hidden models in the dropdown too (greyed out) so the user
          can see what they previously picked even if it's now hidden. */}
      <Dialog open={!!roleDialog} onOpenChange={(open) => { if (!open) setRoleDialog(null); }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col gap-0 overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {isZh ? `${roleDialog?.providerName} · 角色映射（Claude Code 引擎）` : `${roleDialog?.providerName} · Role mapping (Claude Code engine)`}
            </DialogTitle>
            <DialogDescription>
              {isZh
                ? '这是 Claude Code 引擎使用的别名映射 —— 聊天里选「Sonnet / Opus / Haiku」时实际跑这里指定的模型。其它执行引擎不使用这套别名，按你直接选择的模型运行。留空表示这个角色没有专属映射。'
                : 'This alias mapping is used by the Claude Code engine — when chat picks "Sonnet / Opus / Haiku", it runs whatever you map here. Other execution engines ignore these aliases and run whichever model you pick directly. Leave blank to skip a role.'}
            </DialogDescription>
          </DialogHeader>
          {(() => {
            if (!roleDialog) return null;
            const provider = providers.find(p => p.id === roleDialog.providerId);
            if (!provider) return null;
            const allModels = bundles[provider.id] || [];
            return (
              <div className="flex-1 min-h-0 overflow-y-auto mt-4 space-y-3">
                {ROLE_KEYS.map((role) => {
                  const value = roleDraft[role] || '';
                  const valueIsHidden = !!value && allModels.some(m => m.model_id === value && m.enabled === 0);
                  return (
                    <div key={role} className="rounded-md bg-muted/40 px-3.5 py-2.5 space-y-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-xs font-medium">
                            {isZh ? ROLE_LABEL_ZH[role] : ROLE_LABEL_EN[role]}
                            {valueIsHidden && (
                              <span className="ml-2 inline-flex items-center rounded-full bg-status-warning-muted px-2 py-0.5 text-[10px] font-medium text-status-warning-foreground">
                                {isZh ? '已隐藏' : 'Hidden'}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {isZh ? ROLE_HINT_ZH[role] : ROLE_HINT_EN[role]}
                          </div>
                        </div>
                        <Select
                          value={value || '__unset__'}
                          onValueChange={(v) => setRoleDraft(prev => ({ ...prev, [role]: v === '__unset__' ? '' : v }))}
                        >
                          <SelectTrigger className="w-[200px] shrink-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__unset__">{isZh ? '未设置' : 'Not set'}</SelectItem>
                            {/* Enabled rows first, hidden rows after — order
                                within each bucket follows the DB sort_order
                                already returned by getAllModelsForProvider.
                                The Models page no longer exposes a manual
                                reorder UI; this stable sort just preserves
                                whatever ordering the catalog / discovery
                                produced. */}
                            {[...allModels]
                              .sort((a, b) => (b.enabled ?? 0) - (a.enabled ?? 0))
                              .map(m => (
                                <SelectItem key={m.id} value={m.model_id}>
                                  {m.display_name || m.model_id}
                                  {m.enabled === 0 && (isZh ? ' (已隐藏)' : ' (hidden)')}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleDialog(null)} disabled={roleSaving}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSaveRoles} disabled={roleSaving}>
              {roleSaving ? (isZh ? '保存中…' : 'Saving…') : (isZh ? '保存' : 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* OpenRouter search-and-add dialog. Mounted as a sibling to the
          generic "manual add" dialog below; the "添加模型" button opens
          one or the other based on whether the provider is OpenRouter. */}
      {openRouterSearchTarget && (
        <OpenRouterSearchDialog
          open={!!openRouterSearchTarget}
          onOpenChange={(open) => { if (!open) setOpenRouterSearchTarget(null); }}
          providerId={openRouterSearchTarget.id}
          providerName={openRouterSearchTarget.name}
          onModelAdded={() => refetchProviderBundle(openRouterSearchTarget.id)}
          onManualFallback={() => {
            // Search hit a runtime error (key invalid, upstream 5xx,
            // network); the contract is "search if possible, fall back
            // to manual otherwise". Hand the user the same manual-add
            // dialog the deny-listed providers get. Plan vs generic
            // copy is decided here just like in the per-section "添加
            // 模型" button click handler.
            const target = openRouterSearchTarget;
            const provider = providers.find(p => p.id === target.id);
            const isPlan = provider
              ? isCatalogOnlyPlanProviderRecord(provider)
              : false;
            setOpenRouterSearchTarget(null);
            setAddDialog({ providerId: target.id, providerName: target.name, kind: isPlan ? 'plan' : 'manual' });
            setNewModelId('');
            setNewDisplayName('');
          }}
        />
      )}

      {/* OpenRouter "整理早期导入的目录" preview/confirm dialog. */}
      {openRouterCleanupTarget && (
        <OpenRouterCleanupDialog
          open={!!openRouterCleanupTarget}
          onOpenChange={(open) => { if (!open) setOpenRouterCleanupTarget(null); }}
          providerId={openRouterCleanupTarget}
          onCleaned={() => refetchProviderBundle(openRouterCleanupTarget)}
        />
      )}

      {/* Add manual model — title / description branch on dialog kind so
          plan-provider users see "补充 SKU / Add SKU" framing while
          generic providers keep the original "manual add" copy. Both
          flows write the same row shape (manual_enabled + source=manual).

          Phase 1 Step 2 收敛 round 2 (2026-05-06): for providers that can
          reliably fetch upstream models (`canReliablyFetchModels`), the
          dialog also offers an inline "重新检测模型" link that triggers
          the same single-provider discovery used by Add Service success
          and the per-section refresh button. Users who picked Add Model
          but actually wanted "show me what upstream offers" don't have
          to back out and find another button. */}
      <Dialog open={!!addDialog} onOpenChange={(open) => { if (!open) setAddDialog(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {addDialog?.kind === 'plan'
                ? t('provider.add.titlePlan' as TranslationKey, { name: addDialog?.providerName ?? '' })
                : t('provider.add.titleManual' as TranslationKey, { name: addDialog?.providerName ?? '' })}
            </DialogTitle>
            <DialogDescription>
              {addDialog?.kind === 'plan'
                ? t('provider.add.descriptionPlan' as TranslationKey)
                : t('provider.add.descriptionManual' as TranslationKey)}
            </DialogDescription>
          </DialogHeader>
          {(() => {
            if (!addDialog || addDialog.kind !== 'manual') return null;
            const provider = providers.find(p => p.id === addDialog.providerId);
            if (!provider) return null;
            const policy = canReliablyFetchModels(provider);
            if (!policy.reliable) return null;
            return (
              <div className="mt-2 -mb-1 text-[11px] text-muted-foreground">
                {isZh ? '不知道要填什么 ID？' : 'Not sure what ID to type?'}
                {' '}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={async () => {
                    const target = { id: provider.id, name: provider.name };
                    setAddDialog(null);
                    await runAutoDiscoverForProvider({ providerId: target.id, providerName: target.name, t });
                    refetchProviderBundle(target.id);
                  }}
                >
                  {isZh ? '让 CodePilot 重新检测一次该服务商的模型列表' : 'Re-detect this provider\'s upstream models'}
                </button>
              </div>
            );
          })()}
          <div className="space-y-3 mt-2">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">{isZh ? '模型 ID' : 'Model ID'}</label>
              <Input
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
                placeholder="claude-sonnet-4-6"
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">{isZh ? '显示名（可选）' : 'Display name (optional)'}</label>
              <Input
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                placeholder={isZh ? '留空则与模型 ID 相同' : 'Defaults to model ID'}
                className="text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialog(null)}>{t('common.cancel')}</Button>
            <Button onClick={handleAddModel} disabled={!newModelId.trim()}>
              <CodePilotIcon name="plus" size="sm" aria-hidden />
              {isZh ? '添加' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isZh ? '删除手动添加的模型' : 'Delete manual model'}</AlertDialogTitle>
            <AlertDialogDescription>
              {isZh
                ? `确定要删除「${deleteTarget?.name}」吗？此操作不可撤销。`
                : `Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {isZh ? '删除' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk toggle confirmation — large providers can have 100+ models;
          a single click to flip them all needs an explicit confirm so the
          action's weight matches its visual prominence. */}
      <AlertDialog open={!!bulkConfirm} onOpenChange={(open) => { if (!open) setBulkConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {bulkConfirm?.target === 1
                ? (isZh ? '启用全部模型' : 'Enable all models')
                : (isZh ? '关闭全部模型' : 'Disable all models')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isZh
                ? `这会${bulkConfirm?.target === 1 ? '启用' : '关闭'}「${bulkConfirm?.providerName}」下的 ${bulkConfirm?.affected ?? 0} 个模型，操作可在每行单独还原。`
                : `This will ${bulkConfirm?.target === 1 ? 'enable' : 'disable'} ${bulkConfirm?.affected ?? 0} models under "${bulkConfirm?.providerName}". You can revert per row afterwards.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (bulkConfirm) {
                  handleBulkToggle(bulkConfirm.providerId, bulkConfirm.target);
                  setBulkConfirm(null);
                }
              }}
            >
              {bulkConfirm?.target === 1
                ? (isZh ? '全部启用' : 'Enable all')
                : (isZh ? '全部关闭' : 'Disable all')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Global align — confirm dialog */}
      <AlertDialog open={alignAllOpen} onOpenChange={(open) => {
        if (!open) {
          setAlignAllOpen(false);
          setAlignAllPhase('idle');
          setAlignPreview([]);
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isZh ? '整理模型列表' : 'Tidy model list'}</AlertDialogTitle>
            <AlertDialogDescription>
              {isZh
                ? '只保留每个服务商的推荐模型为启用，其余隐藏。下面是即将发生的变化预览，确认后再写入。'
                : 'Keep each provider\'s recommended models enabled and hide the rest. Preview below — nothing is written until you confirm.'}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="mt-2">
            {alignAllPhase === 'previewing' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
                <SpinnerGap size={14} className="animate-spin" />
                {isZh ? '计算中…' : 'Computing…'}
              </div>
            )}
            {alignAllPhase !== 'previewing' && alignPreview.length === 0 && (
              <p className="text-xs text-muted-foreground py-2">
                {isZh ? '没有可处理的服务商。' : 'No providers to align.'}
              </p>
            )}
            {alignAllPhase !== 'previewing' && alignPreview.length > 0 && (() => {
              const changed = alignPreview.filter(r => !r.skipped && (r.enabled + r.disabled + r.inserted + r.pruned) > 0);
              const unchanged = alignPreview.filter(r => !r.skipped && (r.enabled + r.disabled + r.inserted + r.pruned) === 0);
              const skipped = alignPreview.filter(r => r.skipped);
              const totals = changed.reduce((acc, r) => ({
                inserted: acc.inserted + r.inserted,
                enabled: acc.enabled + r.enabled,
                disabled: acc.disabled + r.disabled,
                pruned: acc.pruned + r.pruned,
              }), { inserted: 0, enabled: 0, disabled: 0, pruned: 0 });
              return (
                <div className="space-y-3">
                  <div className="rounded-md border border-border/50 bg-card">
                    <div className="px-4 divide-y divide-border/50">
                      {([
                        { label: isZh ? '插入' : 'Insert', value: totals.inserted },
                        { label: isZh ? '启用' : 'Enable', value: totals.enabled },
                        { label: isZh ? '隐藏' : 'Hide', value: totals.disabled },
                        { label: isZh ? '删除目录种子' : 'Prune catalog seeds', value: totals.pruned },
                      ]).map((item) => (
                        <div key={item.label} className="py-2.5 flex items-center justify-between gap-3">
                          <span className="text-[11px] text-muted-foreground">{item.label}</span>
                          <span className="text-xs font-medium text-foreground/85 tabular-nums">{item.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {changed.length > 0 && (
                    <div className="max-h-48 overflow-y-auto rounded-md bg-muted/40 px-3 py-2 text-[11px] space-y-1">
                      {changed.map(r => (
                        <div key={r.providerId} className="flex items-center justify-between gap-2">
                          <span className="truncate">{r.providerName}</span>
                          <span className="text-muted-foreground font-mono text-[10px] shrink-0">
                            {r.inserted ? `+${r.inserted} ` : ''}
                            {r.enabled ? `↑${r.enabled} ` : ''}
                            {r.disabled ? `↓${r.disabled} ` : ''}
                            {r.pruned ? `−${r.pruned}` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {(unchanged.length > 0 || skipped.length > 0) && (
                    <p className="text-[11px] text-muted-foreground">
                      {isZh
                        ? `${unchanged.length} 个服务商无变化${skipped.length ? `，${skipped.length} 个无目录已跳过` : ''}`
                        : `${unchanged.length} unchanged${skipped.length ? `, ${skipped.length} skipped (no catalog)` : ''}`}
                    </p>
                  )}
                </div>
              );
            })()}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={alignAllPhase === 'applying'}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleAlignAll}
              disabled={alignAllPhase !== 'preview-ready'}
            >
              {alignAllPhase === 'applying'
                ? (isZh ? '应用中…' : 'Applying…')
                : alignAllPhase === 'previewing'
                  ? (isZh ? '加载中…' : 'Loading…')
                  : (isZh ? '应用' : 'Apply')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
