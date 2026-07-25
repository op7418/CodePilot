"use client";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
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
import { SpinnerGap, ArrowSquareOut, CheckCircle } from "@/components/ui/icon";
import { CodePilotIcon } from "@/components/ui/semantic-icon";
import { ProviderForm } from "./ProviderForm";
import type { ProviderFormData } from "./ProviderForm";
import { PresetConnectDialog } from "./PresetConnectDialog";
import { ProviderCard, type ProviderCardStatus, type ProviderCardInfoRow } from "./ProviderCard";
import { CodexQuotaWidget } from "./CodexQuotaWidget";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  QUICK_PRESETS,
  GEMINI_IMAGE_MODELS,
  getGeminiImageModel,
  OPENAI_IMAGE_MODELS,
  getOpenAIImageModel,
  getProviderIcon,
  findMatchingPreset,
  type QuickPreset,
} from "./provider-presets";
import type { ApiProvider, ProviderModelGroup } from "@/types";
import type { CodexAccountState, CodexRateLimitSnapshot } from "@/lib/codex/types";
import type { CodexLoginStart } from "@/lib/codex/account";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import { runAutoDiscoverForProvider } from "@/lib/auto-discover-models";
import { showToast } from "@/hooks/useToast";
import { isCatalogOnlyPlanProviderRecord, isOpenRouterProviderRecord, getProviderAccessType, resolveProviderPresetIdentity, type AccessType } from "@/lib/provider-catalog";
import { sanitizeEndpointForDisplay, type SanitizeTranslator } from "@/lib/provider-endpoint-sanitize";
import { ProviderOptionsSection } from "./ProviderOptionsSection";
import { cn } from "@/lib/utils";
import { getProviderCompat } from "@/lib/runtime-compat";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// 5-bucket categorization for the user-task-oriented Add Service Modal +
// connected services section. Splits the old "Code Plan" catch-all into
// "official direct API" (Anthropic / Bedrock / Vertex / DeepSeek) vs
// "Claude Code 兼容套餐" (brand-specific anthropic-compat presets). The
// remaining anthropic-thirdparty wildcard + relay/local presets fall to
// "third-party / relay". Image providers stay in their own bucket.
const OFFICIAL_DIRECT_API_KEYS = new Set([
  'anthropic-official', 'deepseek', 'xai', 'bedrock', 'vertex',
]);
const CODING_PLAN_KEYS = new Set([
  'glm-cn', 'glm-global', 'kimi', 'moonshot',
  'minimax-cn', 'minimax-global', 'volcengine',
  'xiaomi-mimo', 'xiaomi-mimo-token-plan',
  'bailian', 'qwen-token-plan-personal-cn', 'bailian-token-plan-cn',
  'cline-pass', 'opencode-go-openai', 'opencode-go-anthropic',
]);

/**
 * Step 4 文案收口: AccessType → i18n key. Kept in this file (not in
 * provider-catalog.ts) because the catalog file is server-safe and must
 * not depend on the i18n bundle.
 */
const ACCESS_TYPE_I18N: Record<AccessType, TranslationKey> = {
  subscription_token: 'provider.accessType.subscriptionToken' as TranslationKey,
  api_key:            'provider.accessType.apiKey' as TranslationKey,
  oauth:              'provider.accessType.oauth' as TranslationKey,
  local:              'provider.accessType.local' as TranslationKey,
  cloud_credentials:  'provider.accessType.cloudCredentials' as TranslationKey,
  gateway:            'provider.accessType.gateway' as TranslationKey,
};

/**
 * Coarse relative-time formatter for the Provider card "Last refresh" row.
 *
 * Buckets: "just now" (<60s) → minutes → hours → days → ISO date.
 * SQLite stores `last_refreshed_at` as `'YYYY-MM-DD HH:MM:SS'` (no timezone)
 * — that's UTC by convention here, so append `Z` before parsing.
 */
function formatRelativeTime(value: string, isZh: boolean): string {
  const iso = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return value;
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return isZh ? '刚刚' : 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return isZh ? `${diffMin} 分钟前` : `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return isZh ? `${diffHr} 小时前` : `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return isZh ? `${diffDay} 天前` : `${diffDay}d ago`;
  // Older than ~a month — show the date in YYYY-MM-DD; relative numbers
  // start to mislead at this scale ("3 months ago" is unhelpful precision).
  return iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ProviderManager() {
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [envDetected, setEnvDetected] = useState<Record<string, string>>({});
  const { t } = useTranslation();
  const isZh = t('nav.chats') === '对话';

  // Edit dialog state — fallback ProviderForm for providers that don't match any preset
  const [formOpen, setFormOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ApiProvider | null>(null);

  // Preset connect/edit dialog state
  const [connectPreset, setConnectPreset] = useState<QuickPreset | null>(null);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [presetEditProvider, setPresetEditProvider] = useState<ApiProvider | null>(null);
  const [presetChoiceProvider, setPresetChoiceProvider] = useState<ApiProvider | null>(null);
  // Identity adoption and catalog reconciliation are separate intents. A
  // legacy row may acquire its stable preset_key during an ordinary edit,
  // but catalog-managed model rows move only after the user explicitly picks
  // a plan in the ambiguous-identity chooser.
  const [reconcilePresetCatalogOnSave, setReconcilePresetCatalogOnSave] = useState(false);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<ApiProvider | null>(null);
  const [deleting, setDeleting] = useState(false);

  // OpenAI OAuth state
  const [openaiAuth, setOpenaiAuth] = useState<{ authenticated: boolean; email?: string; plan?: string } | null>(null);
  const [openaiLoggingIn, setOpenaiLoggingIn] = useState(false);
  const [openaiError, setOpenaiError] = useState<string | null>(null);

  type XaiOAuthUiStatus = {
    enabled: boolean;
    authenticated: boolean;
    email?: string;
    needsRefresh?: boolean;
    disabledReason?: string;
    error?: string;
    accountUrl: string;
  };
  const [xaiAuth, setXaiAuth] = useState<XaiOAuthUiStatus | null>(null);
  const [xaiLoggingIn, setXaiLoggingIn] = useState(false);
  const [xaiError, setXaiError] = useState<string | null>(null);
  const [xaiLoginDialogOpen, setXaiLoginDialogOpen] = useState(false);
  const [xaiLoginMethod, setXaiLoginMethod] = useState<'browser' | 'device' | null>(null);
  const [xaiDevice, setXaiDevice] = useState<{
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresIn: number;
  } | null>(null);
  const xaiPollTimerRef = useRef<number | null>(null);

  // Codex Account state — Phase 5 Phase 6 IA correction (2026-05-14).
  // Mirrors the openai-oauth pattern: virtual provider surfaces here
  // as a ProviderCard alongside other OAuth-connected sources. The
  // login dialog is rendered inline (no window.open per
  // feedback_no_silent_auto_irreversible).
  const [codexAccount, setCodexAccount] = useState<CodexAccountState | null>(null);
  const [codexRateLimits, setCodexRateLimits] = useState<CodexRateLimitSnapshot | null>(null);
  const [codexLoginStart, setCodexLoginStart] = useState<CodexLoginStart | null>(null);
  const [codexLoggingIn, setCodexLoggingIn] = useState(false);
  const [codexError, setCodexError] = useState<string | null>(null);

  // Doctor dialog state

  // Add Service browse sheet (placeholder for Step 2 — will become 4-category mode)
  const [addServiceOpen, setAddServiceOpen] = useState(false);

  // Model discovery — refresh now returns a *diff* and waits for the user
  // to apply it. The dialog walks through new / will-update / preserved /
  // hidden / orphan buckets so renames and hidden flags survive a refresh.
  type DiffStatus = 'new' | 'will-update' | 'preserve-edited' | 'hidden-but-upstream' | 'unchanged' | 'orphan';
  interface DiffEntry {
    modelId: string;
    upstreamModelId: string;
    status: DiffStatus;
    current?: { display_name: string; enabled: number; user_edited: number; source: string };
  }
  const [discoverState, setDiscoverState] = useState<{
    providerId: string;
    providerName: string;
    loading: boolean;
    applying?: boolean;
    applied?: { inserted: number; refreshedPristine: number; refreshedPreserved: number };
    result?: {
      classification: 'api' | 'experimental' | 'unsupported';
      protocol: string;
      endpoint?: string;
      ok?: boolean;
      modelCount?: number;
      sampleModels?: string[];
      error?: { code: string; message: string };
      notes?: string;
      suggestedFallback?: string;
      durationMs?: number;
      diff?: DiffEntry[];
    };
  } | null>(null);

  const handleDiscoverModels = useCallback(async (provider: ApiProvider) => {
    setDiscoverState({ providerId: provider.id, providerName: provider.name, loading: true });
    try {
      const res = await fetch(`/api/providers/${provider.id}/discover-models`, { method: 'POST' });
      if (!res.ok) {
        setDiscoverState((s) => s && s.providerId === provider.id ? {
          ...s,
          loading: false,
          result: {
            classification: 'unsupported',
            protocol: 'unknown',
            ok: false,
            error: { code: `http-${res.status}`, message: `${res.status} ${res.statusText}` },
          },
        } : s);
        return;
      }
      const data = await res.json();
      setDiscoverState((s) => s && s.providerId === provider.id ? {
        ...s,
        loading: false,
        result: data,
      } : s);
    } catch (err) {
      setDiscoverState((s) => s && s.providerId === provider.id ? {
        ...s,
        loading: false,
        result: {
          classification: 'unsupported',
          protocol: 'unknown',
          ok: false,
          error: { code: 'network', message: err instanceof Error ? err.message : String(err) },
        },
      } : s);
    }
  }, []);

  const handleApplyDiff = useCallback(async () => {
    const s = discoverState;
    if (!s || !s.result?.diff) return;
    // Send only entries that actually result in a write so the route
    // doesn't iterate over no-op statuses (`unchanged` / `orphan`).
    const applicable = s.result.diff.filter((e) =>
      e.status === 'new' || e.status === 'will-update' || e.status === 'preserve-edited' || e.status === 'hidden-but-upstream',
    );
    setDiscoverState((prev) => prev ? { ...prev, applying: true } : prev);
    try {
      const res = await fetch(`/api/providers/${s.providerId}/discover-models/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          upstreamModels: applicable.map((e) => ({ modelId: e.modelId, upstreamModelId: e.upstreamModelId })),
        }),
      });
      if (res.ok) {
        const stats = await res.json();
        setDiscoverState((prev) => prev ? {
          ...prev,
          applying: false,
          applied: {
            inserted: stats.inserted,
            refreshedPristine: stats.refreshedPristine,
            refreshedPreserved: stats.refreshedPreserved,
          },
        } : prev);
        window.dispatchEvent(new Event('provider-changed'));
      } else {
        setDiscoverState((prev) => prev ? { ...prev, applying: false } : prev);
      }
    } catch {
      setDiscoverState((prev) => prev ? { ...prev, applying: false } : prev);
    }
  }, [discoverState]);

  // Global default model state
  const [providerGroups, setProviderGroups] = useState<ProviderModelGroup[]>([]);
  // Phase 2C.4: globalDefault* state + handleGlobalDefaultModelChange
  // removed alongside the inline picker. Models page is now the single
  // write surface for new-chat default.

  // Active media-generation provider id. Persisted server-side in the
  // `active_image_provider_id` setting. Used by the image-generator to break
  // ties when multiple media providers are configured (e.g. both Gemini +
  // OpenAI); without this, the generator would silently prefer Gemini and
  // the "OpenAI Image" setup would appear inert to the user.
  const [activeImageProviderId, setActiveImageProviderId] = useState<string>('');
  // `stale=true` means the stored id no longer resolves to a usable media
  // provider (row deleted, type changed, or api_key cleared). In that case
  // we render the "active" row with a muted/warning badge rather than the
  // normal green one so users notice the mismatch.
  const [activeImageProviderStale, setActiveImageProviderStale] = useState<boolean>(false);

  const fetchProviders = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error("Failed to load providers");
      const data = await res.json();
      setProviders(data.providers || []);
      setEnvDetected(data.env_detected || {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load providers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProviders(); }, [fetchProviders]);

  // Focus signal from ModelsSection's "去刷新" jump. Once providers
  // have loaded, scroll the matching provider card into view and
  // clear the sessionStorage flag so subsequent visits don't re-trigger.
  useEffect(() => {
    if (loading) return;
    if (typeof window === 'undefined') return;
    const focusId = sessionStorage.getItem('codepilot:providers-focus-provider');
    if (!focusId) return;
    sessionStorage.removeItem('codepilot:providers-focus-provider');
    requestAnimationFrame(() => {
      const el = document.getElementById(`provider-card-${focusId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [loading, providers]);

  // Fetch active-image-provider id (which media provider wins when both are configured)
  const fetchActiveImageProvider = useCallback(() => {
    fetch('/api/providers/active-image')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        setActiveImageProviderId(data.providerId || '');
        setActiveImageProviderStale(!!data.stale);
      })
      .catch(() => {});
  }, []);
  useEffect(() => { fetchActiveImageProvider(); }, [fetchActiveImageProvider]);
  // Also refresh when providers change (e.g. user clears the api_key of the
  // active row — the badge must flip to the stale variant without requiring
  // a full page reload).
  useEffect(() => {
    const handler = () => fetchActiveImageProvider();
    window.addEventListener('provider-changed', handler);
    return () => window.removeEventListener('provider-changed', handler);
  }, [fetchActiveImageProvider]);

  // Fetch OpenAI OAuth status
  useEffect(() => {
    fetch('/api/openai-oauth/status')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setOpenaiAuth(data); })
      .catch(() => {});
  }, []);

  const fetchXaiOAuthStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/xai-oauth/status', { cache: 'no-store' });
      if (response.ok) setXaiAuth(await response.json());
    } catch { /* best effort */ }
  }, []);
  useEffect(() => { void fetchXaiOAuthStatus(); }, [fetchXaiOAuthStatus]);

  // Fetch Codex Account state + rate limits. Re-runs on provider-changed
  // events so login / logout updates the card without a page refresh.
  const fetchCodexAccount = useCallback(async () => {
    try {
      const [accRes, rlRes] = await Promise.all([
        fetch('/api/codex/account', { cache: 'no-store' }),
        fetch('/api/codex/rate-limits', { cache: 'no-store' }),
      ]);
      const accJson = accRes.ok ? await accRes.json() : null;
      const rlJson = rlRes.ok ? await rlRes.json() : null;
      if (accJson?.state) setCodexAccount(accJson.state as CodexAccountState);
      if (rlJson?.snapshot) setCodexRateLimits(rlJson.snapshot as CodexRateLimitSnapshot);
      else if (rlJson && rlJson.snapshot === null) setCodexRateLimits(null);
    } catch { /* best effort — keep stale state */ }
  }, []);
  useEffect(() => {
    fetchCodexAccount();
    const handler = () => fetchCodexAccount();
    window.addEventListener('provider-changed', handler);
    return () => window.removeEventListener('provider-changed', handler);
  }, [fetchCodexAccount]);

  // Fetch all provider models for the global default model selector
  const fetchModels = useCallback(() => {
    fetch('/api/providers/models')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.groups) setProviderGroups(data.groups);
      })
      .catch(() => {});
    // Phase 2C.4: removed the global-default fetch — the inline picker
    // it powered is gone. Models page now reads the same `__global__`
    // options endpoint and is the single write surface.
  }, []);

  useEffect(() => {
    fetchModels();
    const handler = () => fetchModels();
    window.addEventListener('provider-changed', handler);
    return () => window.removeEventListener('provider-changed', handler);
  }, [fetchModels]);

  const handleEdit = (provider: ApiProvider) => {
    const identity = resolveProviderPresetIdentity(provider);
    if (identity.status === 'ambiguous') {
      setPresetChoiceProvider(provider);
      return;
    }
    // Try to match provider to a quick preset for a cleaner edit experience
    const matchedPreset = findMatchingPreset(provider);
    if (matchedPreset) {
      // Clear stale generic-form state to prevent handleEditSave picking the wrong target
      setEditingProvider(null);
      setReconcilePresetCatalogOnSave(false);
      setConnectPreset(matchedPreset);
      setPresetEditProvider(provider);
      setConnectDialogOpen(true);
    } else {
      // Clear stale preset-edit state
      setPresetEditProvider(null);
      setEditingProvider(provider);
      setFormOpen(true);
    }
  };

  const handleEditSave = async (data: ProviderFormData) => {
    const target = presetEditProvider || editingProvider;
    if (!target) return;
    const res = await fetch(`/api/providers/${target.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...data,
        ...(reconcilePresetCatalogOnSave ? { reconcile_catalog: true } : {}),
      }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Failed to update provider");
    }
    const result = await res.json();
    setProviders((prev) => prev.map((p) => (p.id === target.id ? result.provider : p)));
    setReconcilePresetCatalogOnSave(false);
    window.dispatchEvent(new Event("provider-changed"));
  };

  const handlePresetAdd = async (data: ProviderFormData) => {
    const res = await fetch("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Failed to create provider");
    }
    const result = await res.json();
    const newProvider: ApiProvider = result.provider;
    setProviders((prev) => [...prev, newProvider]);

    window.dispatchEvent(new Event("provider-changed"));

    // Branch by provider class:
    //   - Plan-based (sdkProxyOnly + coding/token plan): /v1/models 404s or
    //     returns the wider Ark/DashScope catalog that mostly 4xx on use.
    //     Skip auto-discover; show a one-line success toast pointing at
    //     "Add model" for SKU补充.
    //   - OpenRouter: 300+ aggregator catalog — full materialization is the
    //     wrong UX. Eager seed (3-alias) happened on the server; we just
    //     tell the user how to add more (search-and-add path).
    //   - Other: standard auto-discover. The user just typed a Key, the
    //     implicit expectation is "show me what I can use".
    if (isCatalogOnlyPlanProviderRecord(newProvider)) {
      showToast({
        type: 'success',
        message: t('provider.autoDiscover.catalogOnly' as TranslationKey, { name: newProvider.name }),
        duration: 6000,
      });
    } else if (isOpenRouterProviderRecord(newProvider)) {
      showToast({
        type: 'success',
        message: t('provider.autoDiscover.openrouterAddOnly' as TranslationKey, { name: newProvider.name }),
        duration: 6000,
      });
    } else {
      void runAutoDiscoverForProvider({ providerId: newProvider.id, providerName: newProvider.name, t });
    }
  };

  const handleOpenPresetDialog = (preset: QuickPreset) => {
    setReconcilePresetCatalogOnSave(false);
    setConnectPreset(preset);
    setPresetEditProvider(null); // ensure create mode
    setConnectDialogOpen(true);
  };

  const handleDisconnect = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/providers/${deleteTarget.id}`, { method: "DELETE" });
      if (res.ok) {
        setProviders((prev) => prev.filter((p) => p.id !== deleteTarget.id));
        window.dispatchEvent(new Event("provider-changed"));
      }
    } catch { /* ignore */ } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const setActiveImageProvider = useCallback(async (providerId: string) => {
    // Persist the user's pick server-side. On success the server confirms
    // non-stale; on failure (typically: no api_key) we revert the optimistic
    // state and surface the error. Without this revert a row with an empty
    // key would flip green in the UI while /api/media/generate silently
    // picks a different provider.
    const previousId = activeImageProviderId;
    const previousStale = activeImageProviderStale;
    setActiveImageProviderId(providerId);
    setActiveImageProviderStale(false);
    try {
      const res = await fetch('/api/providers/active-image', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId }),
      });
      if (!res.ok) {
        setActiveImageProviderId(previousId);
        setActiveImageProviderStale(previousStale);
        const body = await res.json().catch(() => ({}));
        setError(body?.error || 'Failed to set active image provider');
      } else {
        // Clear any prior error surfaced from this action.
        setError(null);
      }
    } catch {
      setActiveImageProviderId(previousId);
      setActiveImageProviderStale(previousStale);
    }
  }, [activeImageProviderId, activeImageProviderStale]);

  const handleImageModelChange = useCallback(async (provider: ApiProvider, model: string) => {
    try {
      const env = JSON.parse(provider.extra_env || '{}');
      const key = provider.provider_type === 'openai-image' ? 'OPENAI_IMAGE_MODEL' : 'GEMINI_IMAGE_MODEL';
      env[key] = model;
      const newExtraEnv = JSON.stringify(env);
      const res = await fetch(`/api/providers/${provider.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: provider.name,
          provider_type: provider.provider_type,
          base_url: provider.base_url,
          api_key: provider.api_key,
          extra_env: newExtraEnv,
          notes: provider.notes,
        }),
      });
      if (res.ok) {
        const result = await res.json();
        setProviders(prev => prev.map(p => p.id === provider.id ? result.provider : p));
        window.dispatchEvent(new Event('provider-changed'));
      }
    } catch { /* ignore */ }
    // Picking a model on a provider is a strong signal that this is the one
    // the user wants to use; mark it active automatically so /api/media/generate
    // picks the right family without a separate click.
    setActiveImageProvider(provider.id);
  }, [setActiveImageProvider]);

  const handleOpenAILogin = async () => {
    setOpenaiLoggingIn(true);
    setOpenaiError(null);
    try {
      const res = await fetch("/api/openai-oauth/start");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to start OAuth');
      }
      const { authUrl } = await res.json();
      window.open(authUrl, '_blank');

      // Poll for completion with timeout
      let pollCount = 0;
      const maxPolls = 150; // 5 minutes at 2s intervals
      const poll = setInterval(async () => {
        pollCount++;
        if (pollCount >= maxPolls) {
          clearInterval(poll);
          setOpenaiLoggingIn(false);
          setOpenaiError(isZh ? '登录超时，请重试' : 'Login timed out, please try again');
          return;
        }
        try {
          const statusRes = await fetch("/api/openai-oauth/status");
          if (statusRes.ok) {
            const status = await statusRes.json();
            if (status.authenticated) {
              clearInterval(poll);
              setOpenaiAuth(status);
              setOpenaiLoggingIn(false);
              fetchModels(); // refresh model list to include OpenAI models
              // OAuth is a virtual provider source that hasCodePilotProvider()
              // counts; broadcast so listeners (SetupCenter's ProviderCard,
              // anywhere reading provider presence) re-evaluate.
              window.dispatchEvent(new Event('provider-changed'));
            }
          }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (err) {
      setOpenaiLoggingIn(false);
      setOpenaiError(err instanceof Error ? err.message : 'Login failed');
    }
  };

  const handleOpenAILogout = async () => {
    try {
      await fetch("/api/openai-oauth/status", { method: "DELETE" });
      setOpenaiAuth({ authenticated: false });
      fetchModels(); // refresh model list
      // Logout removes the virtual OAuth provider; listeners must re-check
      // so SetupCenter's ProviderCard can downgrade if OAuth was the only source.
      window.dispatchEvent(new Event('provider-changed'));
    } catch { /* ignore */ }
  };

  const cancelXaiOAuthAttempt = useCallback(() => {
    if (xaiPollTimerRef.current !== null) {
      window.clearInterval(xaiPollTimerRef.current);
      xaiPollTimerRef.current = null;
    }
    setXaiLoggingIn(false);
    setXaiLoginMethod(null);
    setXaiDevice(null);
    // Best effort from the UI, fail closed on the server. The manager's abort
    // checks guarantee a late device response cannot persist after this call.
    void fetch('/api/xai-oauth/cancel', { method: 'POST' });
  }, []);

  const pollXaiOAuthCompletion = useCallback((timeoutMs: number) => {
    if (xaiPollTimerRef.current !== null) window.clearInterval(xaiPollTimerRef.current);
    const deadline = Date.now() + timeoutMs;
    const timer = window.setInterval(async () => {
      if (Date.now() >= deadline) {
        cancelXaiOAuthAttempt();
        setXaiError(isZh ? 'xAI 登录超时，请重试' : 'xAI login timed out. Please try again.');
        return;
      }
      try {
        const response = await fetch('/api/xai-oauth/status', { cache: 'no-store' });
        if (!response.ok) return;
        const status = await response.json() as XaiOAuthUiStatus;
        setXaiAuth(status);
        if (status.error) {
          window.clearInterval(timer);
          xaiPollTimerRef.current = null;
          setXaiLoggingIn(false);
          setXaiLoginMethod(null);
          setXaiError(status.error);
          return;
        }
        if (status.authenticated) {
          window.clearInterval(timer);
          xaiPollTimerRef.current = null;
          setXaiLoggingIn(false);
          setXaiLoginMethod(null);
          setXaiLoginDialogOpen(false);
          setXaiDevice(null);
          fetchModels();
          window.dispatchEvent(new Event('provider-changed'));
        }
      } catch { /* keep polling */ }
    }, 2000);
    xaiPollTimerRef.current = timer;
  }, [cancelXaiOAuthAttempt, fetchModels, isZh]);

  useEffect(() => () => {
    if (xaiPollTimerRef.current !== null) window.clearInterval(xaiPollTimerRef.current);
  }, []);

  const handleXaiLogin = useCallback(async (method: 'browser' | 'device') => {
    setXaiLoggingIn(true);
    setXaiLoginMethod(method);
    setXaiError(null);
    setXaiDevice(null);
    try {
      const response = await fetch(`/api/xai-oauth/start?method=${method}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to start xAI login');
      if (method === 'browser') {
        window.open(data.authUrl, '_blank', 'noopener,noreferrer');
      } else {
        setXaiDevice({
          userCode: data.userCode,
          verificationUri: data.verificationUri,
          verificationUriComplete: data.verificationUriComplete,
          expiresIn: data.expiresIn,
        });
      }
      // Match the client deadline to the actual server flow. Browser login has
      // a five-minute manager deadline; device codes normally live for ten
      // minutes and must not be cancelled halfway through their advertised
      // lifetime. The small margin lets the final status poll observe the
      // manager's terminal state before the UI performs its safety cancel.
      const serverLifetimeMs = method === 'device' && typeof data.expiresIn === 'number'
        ? data.expiresIn * 1000
        : 5 * 60 * 1000;
      pollXaiOAuthCompletion(serverLifetimeMs + 5_000);
    } catch (error) {
      setXaiLoggingIn(false);
      setXaiLoginMethod(null);
      setXaiError(error instanceof Error ? error.message : 'xAI login failed');
    }
  }, [pollXaiOAuthCompletion]);

  const handleXaiLogout = useCallback(async () => {
    try {
      await fetch('/api/xai-oauth/status', { method: 'DELETE' });
      setXaiAuth(previous => ({
        enabled: previous?.enabled ?? true,
        authenticated: false,
        accountUrl: previous?.accountUrl || 'https://accounts.x.ai',
      }));
      setXaiLoginMethod(null);
      setXaiDevice(null);
      fetchModels();
      window.dispatchEvent(new Event('provider-changed'));
    } catch { /* best effort */ }
  }, [fetchModels]);

  // ── Codex Account login / logout ──
  // Login is a two-step UX: POST kicks off the flow and returns an
  // authUrl; we show that URL as an explicit click-to-open link (no
  // window.open() per feedback_no_silent_auto_irreversible). After
  // the user completes login in their browser, they click "我已完成
  // 登录" and we refetch account + models.
  const handleCodexLogin = useCallback(async () => {
    setCodexLoggingIn(true);
    setCodexError(null);
    try {
      const res = await fetch('/api/codex/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'chatgpt' }),
      });
      const json = await res.json();
      if (!res.ok || json?.error) {
        setCodexError(typeof json?.error === 'string' ? json.error : `HTTP ${res.status}`);
        return false;
      }
      if (!json?.login) {
        setCodexError(isZh
          ? 'Codex 登录未返回有效会话，请重试。'
          : 'Codex login did not return a login session. Please retry.');
        return false;
      }
      setCodexLoginStart(json.login);
      return true;
    } catch (err) {
      setCodexError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setCodexLoggingIn(false);
    }
  }, [isZh]);

  const handleCodexLoginCancel = useCallback(async () => {
    if (codexLoginStart && codexLoginStart.type !== 'apiKey') {
      try {
        await fetch(
          `/api/codex/login?loginId=${encodeURIComponent(codexLoginStart.loginId)}`,
          { method: 'DELETE' },
        );
      } catch { /* best effort */ }
    }
    setCodexLoginStart(null);
  }, [codexLoginStart]);

  const handleCodexLoginComplete = useCallback(() => {
    setCodexLoginStart(null);
    fetchCodexAccount();
    fetchModels();
    window.dispatchEvent(new Event('provider-changed'));
  }, [fetchCodexAccount, fetchModels]);

  const handleCodexLogout = useCallback(async () => {
    try {
      await fetch('/api/codex/account', { method: 'DELETE' });
      setCodexAccount({ kind: 'logged_out' });
      setCodexRateLimits(null);
      fetchModels();
      window.dispatchEvent(new Event('provider-changed'));
    } catch { /* ignore */ }
  }, [fetchModels]);

  const sorted = [...providers].sort((a, b) => a.sort_order - b.sort_order);

  // Phase 2C.4: handleGlobalDefaultModelChange removed. Default-model
  // writes happen via the Models page status row + per-row pin button.

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Page title — matches other Settings sub-pages. */}
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{t('settings.providers')}</h2>
      </div>
      {/* Error */}
      {error && (
        <div className="rounded-md bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Section 0「服务设置」(连接诊断 + 默认模型) removed 2026-05-06.
          Both options have canonical entries elsewhere now:
            - 连接诊断 → Settings → Health (Phase 2C.5)
            - 默认模型 → Settings → Models (Phase 2C.2 — pin button per row) */}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
          <SpinnerGap size={16} className="animate-spin" />
          <p className="text-sm">{t('common.loading')}</p>
        </div>
      )}

      {/* ─── Section 1: Connected Services — categorized cards ───
           5 user-task buckets (was 4: split "official direct API" out
           of the old "Code Plan" catch-all so Anthropic / Bedrock /
           Vertex / DeepSeek don't sit next to GLM / Kimi / Volcengine
           Code Plans). Add Service Modal mirrors the same 5 buckets. */}
      {!loading && (() => {
        const llmDbProviders = sorted.filter(
          p => p.provider_type !== 'gemini-image' && p.provider_type !== 'openai-image',
        );
        const imageDbProviders = sorted.filter(
          p => p.provider_type === 'gemini-image' || p.provider_type === 'openai-image',
        );
        // Categorize an LLM provider into one of three task buckets by
        // matching its preset key. Unknown / wildcard presets fall to
        // 'thirdparty' (the user-configured custom anthropic-compat
        // gateway case).
        const categorizeProvider = (p: ApiProvider): 'official' | 'codeplan' | 'thirdparty' => {
          const identity = resolveProviderPresetIdentity(p);
          if (
            identity.status === 'ambiguous'
            && identity.candidateKeys.every(key => CODING_PLAN_KEYS.has(key))
          ) return 'codeplan';
          const matched = findMatchingPreset(p);
          if (!matched) return 'thirdparty';
          if (OFFICIAL_DIRECT_API_KEYS.has(matched.key)) return 'official';
          if (CODING_PLAN_KEYS.has(matched.key)) return 'codeplan';
          return 'thirdparty';
        };
        const officialDbProviders = llmDbProviders.filter(p => categorizeProvider(p) === 'official');
        const codePlanDbProviders = llmDbProviders.filter(p => categorizeProvider(p) === 'codeplan');
        const thirdpartyDbProviders = llmDbProviders.filter(p => categorizeProvider(p) === 'thirdparty');
        // Only API_KEY / AUTH_TOKEN count as a credential — ANTHROPIC_BASE_URL
        // alone shouldn't mark Claude Code as Ready (matches SetupCenter's
        // ProviderCard credentialKeys check).
        const hasEnvClaude = !!envDetected && (
          'ANTHROPIC_API_KEY' in envDetected || 'ANTHROPIC_AUTH_TOKEN' in envDetected
        );
        const hasOfficial = hasEnvClaude || officialDbProviders.length > 0;
        const hasCodePlan = codePlanDbProviders.length > 0;
        const hasThirdparty = thirdpartyDbProviders.length > 0;
        const hasImage = imageDbProviders.length > 0;
        const isCompletelyEmpty = sorted.length === 0 && !hasEnvClaude && !openaiAuth?.authenticated && !xaiAuth?.authenticated;

        // Total = enabled + hidden in provider_models (or catalog size when
        // the table is empty). Mirrors the "synced" semantics rather than the
        // picker-visible subset, so the card matches what users see in the
        // Models page.
        const getTotalModelCount = (providerId: string) => {
          const g = providerGroups.find(g => g.provider_id === providerId);
          return typeof g?.total_count === 'number' ? g.total_count : (g?.models.length ?? null);
        };
        const getEnabledModelCount = (providerId: string) =>
          providerGroups.find(g => g.provider_id === providerId)?.models.length ?? null;
        const getLastRefreshedAt = (providerId: string) =>
          providerGroups.find(g => g.provider_id === providerId)?.last_refreshed_at ?? null;

        // LLM 第三方 (DB API key) provider card — keeps Anthropic-official options block beneath
        const renderLlmDbProviderCard = (provider: ApiProvider) => {
          const matched = findMatchingPreset(provider);
          const identity = resolveProviderPresetIdentity(provider);
          const needsPresetChoice = identity.status === 'ambiguous';
          const status: ProviderCardStatus = needsPresetChoice
            ? 'needs-config'
            : provider.api_key ? 'available' : 'needs-config';
          // Step 4 文案收口: 把工程枚举 (Auth Token / API Key) 映射成
          // 用户面接入方式分类（套餐 Token / API Key / 授权登录 / 本地服务
          // / 中转网关 / 云账号凭证），见 `getProviderAccessType` 注释。
          const accessType = getProviderAccessType(provider);
          const authMethod = needsPresetChoice
            ? (isZh ? '套餐类型待确认' : 'Plan type needs confirmation')
            : t(ACCESS_TYPE_I18N[accessType]);
          const totalCount = getTotalModelCount(provider.id);
          const enabledCount = getEnabledModelCount(provider.id);
          const lastRefreshedAt = getLastRefreshedAt(provider.id);
          const info: ProviderCardInfoRow[] = [];
          if (totalCount !== null) {
            // Show "已启用 / 总数" so the card carries both the runtime
            // exposure and the synced inventory at a glance.
            info.push({
              label: isZh ? '可用模型' : 'Models',
              value: isZh
                ? `${enabledCount ?? 0} / ${totalCount} 启用`
                : `${enabledCount ?? 0} / ${totalCount} enabled`,
            });
          }
          if (lastRefreshedAt) {
            // Relative time so the card stays a glance — exact timestamp goes
            // in the title attr for users who need precision.
            info.push({
              label: isZh ? '上次刷新' : 'Last refresh',
              value: formatRelativeTime(lastRefreshedAt, isZh),
              title: lastRefreshedAt + ' UTC',
            });
          }
          info.push({ label: isZh ? '接入方式' : 'Auth', value: authMethod });
          // Surface base_url only when it's not the default vendor URL — it's
          // signal for users routing through a third-party gateway. Render
          // through `sanitizeEndpointForDisplay` so accidental key paste into
          // base_url doesn't leak the secret onto the card / tooltip.
          if (provider.base_url && provider.base_url !== 'https://api.anthropic.com' && provider.base_url !== 'https://api.openai.com/v1') {
            const sanitizeT: SanitizeTranslator = (key, vars) => t(key as TranslationKey, vars);
            const endpoint = sanitizeEndpointForDisplay(provider.base_url, sanitizeT);
            info.push({
              label: isZh ? '接入地址' : 'Endpoint',
              value: endpoint.display,
              // When suspicious: tooltip explains the masking; do NOT echo the
              // raw value (would defeat the masking on hover). Otherwise no
              // tooltip — the host/path string is already readable.
              ...(endpoint.tooltip ? { title: endpoint.tooltip } : {}),
            });
          }
          return (
            <div
              key={provider.id}
              id={`provider-card-${provider.id}`}
              className="flex flex-col gap-3 scroll-mt-4"
            >
              <ProviderCard
                isZh={isZh}
                data={{
                  icon: getProviderIcon(provider.name, provider.base_url),
                  name: provider.name,
                  status,
                  statusLabel: needsPresetChoice
                    ? (isZh ? '请选择套餐类型' : 'Choose plan type')
                    : undefined,
                  compat: getProviderCompat(provider),
                  info,
                }}
                onEdit={() => handleEdit(provider)}
                onDelete={() => setDeleteTarget(provider)}
                /* Phase 1 Step 2 收敛 (2026-05-06): Manage models / Refresh
                   models inline buttons removed. Provider cards are for
                   "connect a service" — model browsing + refresh live on
                   the Models page (and refresh only renders for providers
                   where `canReliablyFetchModels` returns true). */
              />
              {/* Anthropic-official: thinking/1M options */}
              {provider.base_url === 'https://api.anthropic.com' && (
                <div className="rounded-md bg-muted/30 px-5 py-3">
                  <ProviderOptionsSection
                    providerId={provider.id}
                    showThinkingOptions
                  />
                </div>
              )}
            </div>
          );
        };

        // Per-image-provider card — same shape as LLM cards, with model
        // selector chips in the children slot and "set as default" as the
        // primary action when this provider isn't the active image generator.
        const renderImageProviderCard = (provider: ApiProvider) => {
          const isOpenAI = provider.provider_type === 'openai-image';
          const models = isOpenAI ? OPENAI_IMAGE_MODELS : GEMINI_IMAGE_MODELS;
          const current = isOpenAI ? getOpenAIImageModel(provider) : getGeminiImageModel(provider);
          const currentLabel = models.find(m => m.value === current)?.label ?? current;
          const isActive = activeImageProviderId === provider.id;
          const showStale = isActive && activeImageProviderStale;
          const status: ProviderCardStatus = provider.api_key ? 'available' : 'needs-config';
          const statusLabel = showStale
            ? (isZh ? '已失效' : 'Stale')
            : isActive
              ? t('provider.activeForImage')
              : undefined;

          return (
            <ProviderCard
              key={provider.id}
              isZh={isZh}
              data={{
                icon: getProviderIcon(provider.name, provider.base_url),
                name: provider.name,
                status,
                statusLabel,
                compat: 'media_only',
                info: currentLabel
                  ? [{ label: isZh ? '当前模型' : 'Active model', value: currentLabel }]
                  : undefined,
              }}
              primaryAction={
                showStale ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-3 text-xs text-muted-foreground"
                    onClick={() => setActiveImageProvider('')}
                  >
                    {isZh ? '清除' : 'Clear'}
                  </Button>
                ) : !isActive && provider.api_key ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-3 text-xs text-muted-foreground"
                    onClick={() => setActiveImageProvider(provider.id)}
                  >
                    {t('provider.useForImage')}
                  </Button>
                ) : undefined
              }
              onEdit={() => handleEdit(provider)}
              onDelete={() => setDeleteTarget(provider)}
              /* No onRefreshModels for image providers — their /v1/models
                 returns the entire vendor catalogue (text + audio + embedding),
                 not just image models, so discovery is meaningless. The chip
                 selector below uses the curated image-only list directly. */
            >
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px] text-muted-foreground mr-1">{isZh ? '模型' : 'Model'}:</span>
                {models.map((m) => {
                  const active = current === m.value;
                  return (
                    <Button
                      key={m.value}
                      variant="ghost"
                      size="sm"
                      onClick={() => handleImageModelChange(provider, m.value)}
                      className={cn(
                        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium border h-auto',
                        active
                          ? 'bg-primary/10 text-primary border-primary/30'
                          : 'text-muted-foreground border-border/60 hover:text-foreground hover:border-foreground/30 hover:bg-accent/50',
                      )}
                    >
                      {m.label}
                    </Button>
                  );
                })}
              </div>
            </ProviderCard>
          );
        };

        return (
          <div className="space-y-5">
            {/* Header: title + Add Service */}
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium">{t('provider.connectedServices')}</h3>
                <p className="text-sm text-muted-foreground mt-1.5">
                  {t('provider.addServiceDesc')}
                </p>
              </div>
              <Button
                variant="default"
                size="sm"
                className="gap-1.5 shrink-0"
                onClick={() => { setPresetEditProvider(null); setAddServiceOpen(true); }}
              >
                <CodePilotIcon name="plus" size="sm" strokeWidth={2} aria-hidden />
                {t('provider.addService')}
              </Button>
            </div>

            {/* Orphaned-active-image safety net */}
            {activeImageProviderStale && activeImageProviderId && !providers.some(
              p => p.id === activeImageProviderId
                && (p.provider_type === 'gemini-image' || p.provider_type === 'openai-image'),
            ) && (
              <div className="rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {isZh
                      ? '当前“图片生成默认”指向的服务商已不可用（被删除或类型已变更），图片生成会回退到其他服务商'
                      : 'The provider currently marked as the image-generation default is unavailable (deleted or type changed). Image generation will fall back to another provider.'}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 text-[11px] text-amber-700 dark:text-amber-400 shrink-0"
                  onClick={() => setActiveImageProvider('')}
                >
                  {isZh ? '清除' : 'Clear'}
                </Button>
              </div>
            )}

            {isCompletelyEmpty ? (
              /* Empty state — no env, no oauth, no db providers */
              <div className="rounded-lg bg-card border border-border/50 p-10 flex flex-col items-center text-center gap-3">
                <div className="text-sm font-medium">{t('provider.emptyTitle')}</div>
                <div className="text-xs text-muted-foreground max-w-md">
                  {t('provider.emptyDesc')}
                </div>
                <Button
                  variant="default"
                  size="sm"
                  className="gap-1.5 mt-1"
                  onClick={() => { setPresetEditProvider(null); setAddServiceOpen(true); }}
                >
                  <CodePilotIcon name="plus" size="sm" strokeWidth={2} aria-hidden />
                  {t('provider.addService')}
                </Button>
              </div>
            ) : (
              <>
                {/* OAuth section — only rendered when at least one OAuth is
                    actually connected. The unsigned entry lives in the Add
                    Service full-screen flow, so the default page stays
                    "已连接服务" only and the empty-state can still trigger. */}
                {(openaiAuth?.authenticated || xaiAuth?.authenticated || codexAccount?.kind === 'logged_in') && (
                  <section className="space-y-3">
                    <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      {t('provider.categoryOAuth')}
                    </h4>
                    <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
                      {openaiAuth?.authenticated && (
                        <ProviderCard
                          isZh={isZh}
                          data={{
                            icon: getProviderIcon('OpenAI', ''),
                            name: 'OpenAI',
                            status: 'available',
                            statusLabel: openaiAuth.plan || (isZh ? '已登录' : 'Signed in'),
                            compat: 'codepilot_only',
                            info: [
                              ...(openaiAuth.plan ? [{ label: isZh ? '订阅' : 'Plan', value: openaiAuth.plan }] : []),
                              ...(openaiAuth.email ? [{ label: isZh ? '账号' : 'Account', value: openaiAuth.email }] : []),
                            ],
                          }}
                          onDelete={handleOpenAILogout}
                        />
                      )}
                      {xaiAuth?.authenticated && (
                        <ProviderCard
                          isZh={isZh}
                          data={{
                            icon: getProviderIcon('xAI Grok', 'https://api.x.ai/v1'),
                            name: isZh ? 'xAI Grok OAuth' : 'xAI Grok OAuth',
                            status: 'available',
                            statusLabel: isZh ? '已登录' : 'Signed in',
                            compat: 'codepilot_only',
                            info: [
                              { label: isZh ? '额度渠道' : 'Billing source', value: 'SuperGrok-compatible OAuth' },
                              ...(xaiAuth.email ? [{ label: isZh ? '账号' : 'Account', value: xaiAuth.email }] : []),
                            ],
                          }}
                          primaryAction={
                            <Button asChild variant="ghost" size="sm" className="h-8 px-3 text-xs">
                              <a href={xaiAuth.accountUrl} target="_blank" rel="noreferrer">
                                {isZh ? '管理账号' : 'Manage account'}
                              </a>
                            </Button>
                          }
                          onDelete={handleXaiLogout}
                        />
                      )}
                      {codexAccount?.kind === 'logged_in' && (
                        <ProviderCard
                          isZh={isZh}
                          data={{
                            icon: getProviderIcon('OpenAI', ''),
                            name: isZh ? 'Codex 账户' : 'Codex Account',
                            status: 'available',
                            // Phase 6 IA correction (2026-05-14): show
                            // planType-only as the headline. Earlier
                            // builds put `type: chatgpt` here, which
                            // users read as "plan = chatgpt" — confusing
                            // because type is the *login method*, not
                            // the subscription tier.
                            statusLabel: codexAccount.account.planType
                              || (isZh ? '已登录' : 'Signed in'),
                            compat: 'codex_account',
                            info: [
                              ...(codexAccount.account.email
                                ? [{ label: isZh ? '账号' : 'Account', value: codexAccount.account.email }]
                                : []),
                              ...(codexAccount.account.planType
                                ? [{ label: isZh ? '套餐' : 'Plan', value: codexAccount.account.planType }]
                                : []),
                              {
                                // Renamed from "类型" / "Type" — the
                                // chatgpt/apiKey/amazonBedrock value is
                                // how you *signed in*, not your plan.
                                label: isZh ? '登录方式' : 'Login method',
                                value: codexAccount.account.type,
                              },
                            ],
                          }}
                          onDelete={handleCodexLogout}
                        >
                          {codexRateLimits && (
                            <CodexQuotaWidget snapshot={codexRateLimits} isZh={isZh} />
                          )}
                        </ProviderCard>
                      )}
                      {openaiError && (
                        <p className="text-[11px] text-destructive col-span-full">{openaiError}</p>
                      )}
                      {codexError && (
                        <p className="text-[11px] text-destructive col-span-full">{codexError}</p>
                      )}
                    </div>
                  </section>
                )}

                {/* Official direct API — Anthropic / Bedrock / Vertex /
                    DeepSeek + env-detected Claude Code. These are the
                    "fill in your API Key from the vendor's console"
                    bucket; no relay, no Code Plan subscription. */}
                {hasOfficial && (
                  <section className="space-y-3">
                    <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      {isZh ? '官方 API（直连）' : 'Official API (direct)'}
                    </h4>
                    <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
                      {hasEnvClaude && (
                        <ProviderCard
                          isZh={isZh}
                          data={{
                            icon: getProviderIcon('Claude', 'https://api.anthropic.com'),
                            name: 'Claude Code',
                            status: 'available',
                            statusLabel: isZh ? '已就绪' : 'Ready',
                            compat: 'claude_code_ready',
                            info: [
                              { label: isZh ? '来源' : 'Source', value: isZh ? '环境变量' : 'Environment' },
                            ],
                          }}
                          primaryAction={
                            <Button asChild variant="ghost" size="sm" className="h-8 px-3 text-xs">
                              <a href="/settings/runtime">{t('provider.goToClaudeCodeSettings')}</a>
                            </Button>
                          }
                        />
                      )}
                      {officialDbProviders.map(renderLlmDbProviderCard)}
                    </div>
                  </section>
                )}

                {/* Claude Code 兼容套餐 — verified brand presets (GLM /
                    Kimi / Volcengine / MiniMax / Bailian / Xiaomi MiMo /
                    Moonshot). Subscription / coding-plan style billing. */}
                {hasCodePlan && (
                  <section className="space-y-3">
                    <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      {isZh ? 'Claude Code 兼容套餐' : 'Claude Code-compatible plans'}
                    </h4>
                    <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
                      {codePlanDbProviders.map(renderLlmDbProviderCard)}
                    </div>
                  </section>
                )}

                {/* Third-party / relay — generic anthropic-thirdparty
                    template + OpenRouter / Ollama / LiteLLM relays + any
                    custom URL that didn't match a brand preset. */}
                {hasThirdparty && (
                  <section className="space-y-3">
                    <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      {isZh ? '第三方 / 中转兼容' : 'Third-party / relay'}
                    </h4>
                    <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
                      {thirdpartyDbProviders.map(renderLlmDbProviderCard)}
                    </div>
                  </section>
                )}

                {/* Image services — one card per provider (consistent with LLM section) */}
                {hasImage && (
                  <section className="space-y-3">
                    <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                      {t('provider.imageServices')}
                    </h4>
                    <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
                      {imageDbProviders.map(renderImageProviderCard)}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        );
      })()}

      {/* ─── Add Service dialog — modal preset picker.
           Presets are bucketed into 5 user-facing categories (官方直连 API
           / 套餐型 / 第三方中转 / 本地服务 / 图像生成) below — see the
           OFFICIAL_DIRECT_API_KEYS / CODING_PLAN_KEYS sets at the top of
           this file. */}
      <Dialog open={addServiceOpen} onOpenChange={setAddServiceOpen}>
        <DialogContent fullscreen>
          <div className="min-h-full flex items-center justify-center px-6 py-16">
            <div className="w-full max-w-2xl">
            <DialogHeader className="mb-8">
              <DialogTitle className="text-2xl">{t('provider.addService')}</DialogTitle>
              <DialogDescription className="text-sm">{t('provider.addServiceDesc')}</DialogDescription>
            </DialogHeader>
            {(() => {
              // 5-bucket categorization for Add Service Modal — mirrors
              // the connected services section above. Image presets stay
              // image-only; LLM presets split into official direct API /
              // Coding Plan / third-party + relay.
              const officialPresets = QUICK_PRESETS.filter(
                p => p.category !== 'media' && OFFICIAL_DIRECT_API_KEYS.has(p.key),
              );
              const codePlanPresets = QUICK_PRESETS.filter(
                p => p.category !== 'media' && CODING_PLAN_KEYS.has(p.key),
              );
              const thirdpartyPresets = QUICK_PRESETS.filter(
                p => p.category !== 'media'
                  && !OFFICIAL_DIRECT_API_KEYS.has(p.key)
                  && !CODING_PLAN_KEYS.has(p.key),
              );
              const imagePresets = QUICK_PRESETS.filter(p => p.category === 'media');

              // OAuth entries — synthetic (not preset-based). Always shown so the
              // category stays visible; already-connected entries are rendered
              // disabled with a "已登录" tag instead of being hidden.
              type OAuthEntry = { key: string; name: string; description: string; descriptionZh: string; icon: ReactNode; onClick: () => void; connected?: boolean; loading?: boolean; disabled?: boolean };
              const oauthEntries: OAuthEntry[] = [
                {
                  key: 'openai-oauth',
                  name: 'OpenAI',
                  description: 'Sign in with ChatGPT Plus/Pro — no API key required',
                  descriptionZh: '使用 ChatGPT Plus/Pro 订阅登录，无需 API Key',
                  icon: getProviderIcon('OpenAI', ''),
                  onClick: () => { setAddServiceOpen(false); handleOpenAILogin(); },
                  connected: !!openaiAuth?.authenticated,
                },
                {
                  key: 'xai-oauth',
                  name: 'xAI Grok OAuth',
                  description: xaiAuth?.disabledReason
                    || 'SuperGrok-compatible browser or device login; depends on xAI upstream policy. API Key remains available.',
                  descriptionZh: xaiAuth?.disabledReason
                    || '兼容 SuperGrok 的浏览器/设备码登录，依赖 xAI 上游策略；可改用 API Key。',
                  icon: getProviderIcon('xAI Grok', 'https://api.x.ai/v1'),
                  onClick: () => {
                    setAddServiceOpen(false);
                    setXaiLoginMethod(null);
                    setXaiDevice(null);
                    setXaiError(null);
                    setXaiLoginDialogOpen(true);
                  },
                  connected: !!xaiAuth?.authenticated,
                  loading: xaiLoggingIn,
                  disabled: xaiAuth?.enabled === false,
                },
                {
                  // Phase 5 Phase 6 IA correction (2026-05-14) — Codex
                  // Account joins OAuth-style entries. Login flow ≠
                  // OpenAI OAuth's window.open() path; we kick the
                  // /api/codex/login RPC and render the returned
                  // authUrl as an explicit click-to-open link in a
                  // dialog. No silent browser navigation.
                  key: 'codex-account',
                  name: 'Codex Account',
                  description: 'Sign in to Codex with ChatGPT Plus/Pro — gpt-5.5 etc.',
                  descriptionZh: '登录 Codex（ChatGPT Plus/Pro 账户）— 可使用 gpt-5.5 等',
                  icon: getProviderIcon('OpenAI', ''),
                  // Keep the picker open until the app-server accepts the
                  // login request. On failure, the error below remains in the
                  // user's current context instead of disappearing with it.
                  onClick: () => {
                    void handleCodexLogin().then((started) => {
                      if (started) setAddServiceOpen(false);
                    });
                  },
                  connected: codexAccount?.kind === 'logged_in',
                  loading: codexLoggingIn,
                },
              ];

              const renderPresetButton = (preset: QuickPreset) => (
                <button
                  key={preset.key}
                  onClick={() => { setAddServiceOpen(false); handleOpenPresetDialog(preset); }}
                  className="flex items-center gap-3 rounded-md bg-muted/40 px-4 py-3 text-left hover:bg-muted transition-colors"
                >
                  <div className="shrink-0 size-9 rounded-md bg-card flex items-center justify-center">{preset.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{preset.name}</div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {isZh ? preset.descriptionZh : preset.description}
                    </div>
                  </div>
                </button>
              );
              const renderOAuthButton = (entry: OAuthEntry) => (
                <button
                  key={entry.key}
                  onClick={entry.connected || entry.loading || entry.disabled ? undefined : entry.onClick}
                  disabled={entry.connected || entry.loading || entry.disabled}
                  aria-busy={entry.loading || undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-md bg-muted/40 px-4 py-3 text-left transition-colors",
                    entry.connected || entry.loading || entry.disabled ? "opacity-60 cursor-default" : "hover:bg-muted",
                  )}
                >
                  <div className="shrink-0 size-9 rounded-md bg-card flex items-center justify-center">{entry.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate flex items-center gap-2">
                      {entry.name}
                      {entry.connected && (
                        <span className="inline-flex items-center rounded-full bg-status-success-muted px-1.5 py-0.5 text-[10px] font-medium text-status-success-foreground">
                          {isZh ? '已登录' : 'Signed in'}
                        </span>
                      )}
                      {entry.loading && (
                        <span className="text-[10px] font-normal text-muted-foreground">
                          {isZh ? '连接中…' : 'Connecting…'}
                        </span>
                      )}
                      {entry.disabled && (
                        <span className="text-[10px] font-normal text-muted-foreground">
                          {isZh ? '已关闭' : 'Disabled'}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {isZh ? entry.descriptionZh : entry.description}
                    </div>
                  </div>
                </button>
              );
              return (
                <div className="space-y-6">
                  {oauthEntries.length > 0 && (
                    <div>
                      <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
                        {t('provider.categoryOAuth')}
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {oauthEntries.map(renderOAuthButton)}
                      </div>
                      {codexError && (
                        <p className="mt-2 text-[11px] text-destructive" role="alert">
                          {codexError}
                        </p>
                      )}
                      {xaiError && (
                        <p className="mt-2 text-[11px] text-destructive" role="alert">
                          {xaiError}
                        </p>
                      )}
                    </div>
                  )}

                  {officialPresets.length > 0 && (
                    <div>
                      <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
                        {isZh ? '官方 API（直连）' : 'Official API (direct)'}
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {officialPresets.map(renderPresetButton)}
                      </div>
                    </div>
                  )}

                  {codePlanPresets.length > 0 && (
                    <div>
                      <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
                        {isZh ? 'Claude Code 兼容套餐' : 'Claude Code-compatible plans'}
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {codePlanPresets.map(renderPresetButton)}
                      </div>
                    </div>
                  )}

                  {thirdpartyPresets.length > 0 && (
                    <div>
                      <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
                        {isZh ? '第三方 / 中转兼容' : 'Third-party / relay'}
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {thirdpartyPresets.map(renderPresetButton)}
                      </div>
                    </div>
                  )}

                  {imagePresets.length > 0 && (
                    <div>
                      <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
                        {t('provider.imageServices')}
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {imagePresets.map(renderPresetButton)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Codex Account login dialog — Phase 5 Phase 6 IA correction.
          Mirrors what CodexPanel briefly shipped before the IA
          correction: explicit click-to-open authUrl, no window.open. */}
      <Dialog open={!!codexLoginStart} onOpenChange={(open) => { if (!open) void handleCodexLoginCancel(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{isZh ? '登录 Codex' : 'Login to Codex'}</DialogTitle>
            <DialogDescription>
              {isZh
                ? '在浏览器中完成登录后，回到这里点击「我已完成登录」。'
                : 'Complete login in your browser, then click "I’ve completed login" below.'}
            </DialogDescription>
          </DialogHeader>
          {codexLoginStart?.type === 'chatgpt' && (
            <div className="flex flex-col gap-3">
              <a
                href={codexLoginStart.authUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs font-mono break-all text-primary hover:underline inline-flex items-start gap-1.5 rounded-md bg-muted/40 px-3 py-2"
              >
                <ArrowSquareOut size={14} className="mt-0.5 shrink-0" />
                <span>{codexLoginStart.authUrl}</span>
              </a>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => void handleCodexLoginCancel()}>
                  {isZh ? '取消' : 'Cancel'}
                </Button>
                <Button size="sm" onClick={handleCodexLoginComplete}>
                  {isZh ? '我已完成登录' : 'I’ve completed login'}
                </Button>
              </div>
            </div>
          )}
          {codexLoginStart?.type === 'chatgptDeviceCode' && (
            <div className="flex flex-col gap-3">
              <a
                href={codexLoginStart.verificationUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs font-mono break-all text-primary hover:underline inline-flex items-start gap-1.5 rounded-md bg-muted/40 px-3 py-2"
              >
                <ArrowSquareOut size={14} className="mt-0.5 shrink-0" />
                <span>{codexLoginStart.verificationUrl}</span>
              </a>
              <div className="rounded bg-card border border-border/60 px-3 py-2 flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{isZh ? '设备码' : 'Device code'}</span>
                <span className="font-mono text-sm font-semibold tracking-wider">{codexLoginStart.userCode}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { void navigator.clipboard.writeText(codexLoginStart.userCode); }}
                  aria-label={isZh ? '复制' : 'Copy'}
                >
                  <CodePilotIcon name="copy" size={12} aria-hidden />
                </Button>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => void handleCodexLoginCancel()}>
                  {isZh ? '取消' : 'Cancel'}
                </Button>
                <Button size="sm" onClick={handleCodexLoginComplete}>
                  {isZh ? '我已完成登录' : 'I’ve completed login'}
                </Button>
              </div>
            </div>
          )}
          {codexLoginStart?.type === 'apiKey' && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-foreground/85">
                <CheckCircle size={12} weight="fill" className="inline-block mr-1 text-status-success-foreground" />
                {isZh ? 'API key 已保存，可以关闭此对话框。' : 'API key saved. You can close this dialog.'}
              </p>
              <div className="flex justify-end">
                <Button size="sm" onClick={handleCodexLoginComplete}>{isZh ? '完成' : 'Done'}</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit dialog (full form for editing existing providers) */}
      <Dialog
        open={!!presetChoiceProvider}
        onOpenChange={(open) => { if (!open) setPresetChoiceProvider(null); }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isZh ? '请选择套餐类型' : 'Choose the plan type'}</DialogTitle>
            <DialogDescription>
              {isZh
                ? '这个旧配置使用个人版与团队版共用的地址，CodePilot 无法从地址或 Key 判断套餐。选择实际购买的类型后，目录管理的模型会更新为该套餐白名单；手动添加或手动编辑的模型会保留。'
                : 'This legacy configuration uses an endpoint shared by Personal and Team plans. CodePilot cannot infer the product from the endpoint or key. Choosing your plan updates catalog-managed models to its allowlist; manually added or edited models are preserved.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 mt-2">
            {presetChoiceProvider && (() => {
              const resolution = resolveProviderPresetIdentity(presetChoiceProvider);
              if (resolution.status !== 'ambiguous') return null;
              return QUICK_PRESETS
                .filter(preset => resolution.candidateKeys.includes(preset.key))
                .map(preset => (
                  <button
                    key={preset.key}
                    className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-left hover:bg-muted transition-colors"
                    onClick={() => {
                      const provider = presetChoiceProvider;
                      setPresetChoiceProvider(null);
                      setEditingProvider(null);
                      setReconcilePresetCatalogOnSave(true);
                      setConnectPreset(preset);
                      setPresetEditProvider(provider);
                      setConnectDialogOpen(true);
                    }}
                  >
                    <span className="block text-sm font-medium">{preset.name}</span>
                    <span className="block text-xs text-muted-foreground mt-1">
                      {isZh ? preset.descriptionZh : preset.description}
                    </span>
                  </button>
                ));
            })()}
          </div>
        </DialogContent>
      </Dialog>

      <ProviderForm
        open={formOpen}
        onOpenChange={setFormOpen}
        mode="edit"
        provider={editingProvider}
        onSave={handleEditSave}
        initialPreset={null}
      />

      {/* Preset connect/edit dialog */}
      <PresetConnectDialog
        preset={connectPreset}
        open={connectDialogOpen}
        onOpenChange={(open) => {
          setConnectDialogOpen(open);
          if (!open) {
            setPresetEditProvider(null);
            setReconcilePresetCatalogOnSave(false);
          }
        }}
        onSave={presetEditProvider ? handleEditSave : handlePresetAdd}
        editProvider={presetEditProvider}
      />

      {/* Model discovery result — read-only spike. The result is shown so the
          user can decide whether to act on it; nothing is auto-applied. */}
      <Dialog open={!!discoverState} onOpenChange={(open) => { if (!open) setDiscoverState(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {isZh ? '模型同步结果' : 'Model discovery result'} · {discoverState?.providerName}
            </DialogTitle>
            <DialogDescription>
              {isZh
                ? '只读探测，不会自动写入你的配置。失败时可以回退到内置目录。'
                : 'Read-only probe — your configuration is not changed. Falls back to the built-in catalog when the upstream call fails.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            {discoverState?.loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <SpinnerGap size={14} className="animate-spin" />
                {isZh ? '正在探测…' : 'Probing…'}
              </div>
            )}
            {discoverState?.result && (() => {
              const r = discoverState.result;
              const tone =
                r.classification === 'unsupported' ? 'bg-muted text-muted-foreground'
                : r.ok ? 'bg-status-success-muted text-status-success-foreground'
                : 'bg-status-warning-muted text-status-warning-foreground';
              const classLabel =
                r.classification === 'api' ? (isZh ? '可同步' : 'Discoverable')
                : r.classification === 'experimental' ? (isZh ? '实验性同步' : 'Experimental')
                : (isZh ? '使用内置目录' : 'Catalog only');
              return (
                <>
                  <div className="rounded-md bg-card border border-border/50">
                    <div className="px-4 divide-y divide-border/50">
                      <div className="py-2.5 flex items-center justify-between gap-3">
                        <span className="text-[11px] text-muted-foreground">{isZh ? '分类' : 'Category'}</span>
                        <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium', tone)}>
                          {classLabel}
                        </span>
                      </div>
                      <div className="py-2.5 flex items-center justify-between gap-3">
                        <span className="text-[11px] text-muted-foreground">{isZh ? '协议' : 'Protocol'}</span>
                        <span className="text-xs font-mono text-foreground/85">{r.protocol}</span>
                      </div>
                      {r.endpoint && (
                        <div className="py-2.5 flex items-center justify-between gap-3 min-w-0">
                          <span className="text-[11px] text-muted-foreground shrink-0">{isZh ? '端点' : 'Endpoint'}</span>
                          <span className="text-xs font-mono text-foreground/85 truncate text-right">{r.endpoint}</span>
                        </div>
                      )}
                      {typeof r.modelCount === 'number' && (
                        <div className="py-2.5 flex items-center justify-between gap-3">
                          <span className="text-[11px] text-muted-foreground">{isZh ? '模型数' : 'Model count'}</span>
                          <span className="text-xs font-medium text-foreground/85">{r.modelCount}</span>
                        </div>
                      )}
                      {typeof r.durationMs === 'number' && (
                        <div className="py-2.5 flex items-center justify-between gap-3">
                          <span className="text-[11px] text-muted-foreground">{isZh ? '耗时' : 'Duration'}</span>
                          <span className="text-xs font-mono text-foreground/85">{r.durationMs} ms</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {r.notes && (
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{r.notes}</p>
                  )}

                  {r.error && (
                    <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2">
                      <p className="text-xs text-destructive font-mono break-all">
                        [{r.error.code}] {r.error.message}
                      </p>
                      {r.suggestedFallback && (
                        <p className="text-[11px] text-muted-foreground mt-1">{r.suggestedFallback}</p>
                      )}
                    </div>
                  )}

                  {r.sampleModels && r.sampleModels.length > 0 && (
                    <div>
                      <p className="text-[11px] text-muted-foreground mb-2">
                        {isZh ? `模型列表（${r.sampleModels.length} 条）` : `Models (${r.sampleModels.length})`}
                      </p>
                      <div className="rounded-md bg-muted/40 px-3 py-2 max-h-48 overflow-y-auto">
                        <ul className="text-xs font-mono text-foreground/85 space-y-1">
                          {r.sampleModels.map((m) => <li key={m} className="truncate">{m}</li>)}
                        </ul>
                      </div>
                    </div>
                  )}

                  {/* Diff summary — counts per status, shown only when diff exists */}
                  {r.diff && r.diff.length > 0 && !discoverState?.applied && (() => {
                    const counts = r.diff.reduce<Record<DiffStatus, number>>((acc, e) => {
                      acc[e.status] = (acc[e.status] || 0) + 1;
                      return acc;
                    }, { 'new': 0, 'will-update': 0, 'preserve-edited': 0, 'hidden-but-upstream': 0, 'unchanged': 0, 'orphan': 0 });
                    const labelZh: Record<DiffStatus, string> = {
                      'new': '新增',
                      'will-update': '将更新',
                      'preserve-edited': '保留编辑',
                      'hidden-but-upstream': '保持隐藏',
                      'unchanged': '无变化',
                      'orphan': '上游已下线',
                    };
                    const labelEn: Record<DiffStatus, string> = {
                      'new': 'New',
                      'will-update': 'Will update',
                      'preserve-edited': 'Preserve edits',
                      'hidden-but-upstream': 'Keep hidden',
                      'unchanged': 'Unchanged',
                      'orphan': 'No longer upstream',
                    };
                    const order: DiffStatus[] = ['new', 'will-update', 'preserve-edited', 'hidden-but-upstream', 'unchanged', 'orphan'];
                    return (
                      <div className="rounded-md border border-border/50 bg-card">
                        <div className="px-4 divide-y divide-border/50">
                          {order.filter(k => counts[k] > 0).map(k => (
                            <div key={k} className="py-2.5 flex items-center justify-between gap-3">
                              <span className="text-[11px] text-muted-foreground">{isZh ? labelZh[k] : labelEn[k]}</span>
                              <span className="text-xs font-medium text-foreground/85">{counts[k]}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Applied summary — replaces the diff once committed */}
                  {discoverState?.applied && (
                    <div className="rounded-md bg-status-success-muted/40 border border-status-success-border/40 px-3 py-2">
                      <p className="text-xs text-status-success-foreground">
                        {isZh
                          ? `应用完成：新增 ${discoverState.applied.inserted}、刷新 ${discoverState.applied.refreshedPristine}、保留用户编辑 ${discoverState.applied.refreshedPreserved}。`
                          : `Applied: ${discoverState.applied.inserted} new, ${discoverState.applied.refreshedPristine} refreshed, ${discoverState.applied.refreshedPreserved} edits preserved.`}
                      </p>
                    </div>
                  )}

                  {r.ok && r.modelCount === 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      {isZh ? '上游返回空模型列表，没有可应用的变化。' : 'Upstream returned an empty list — nothing to apply.'}
                    </p>
                  )}

                  {/* Apply button — only when there is something actionable and not yet applied */}
                  {!discoverState?.applied && r.diff && r.diff.some(e =>
                    e.status === 'new' || e.status === 'will-update' || e.status === 'preserve-edited' || e.status === 'hidden-but-upstream',
                  ) && (
                    <div className="flex items-center justify-end gap-2 pt-1">
                      <Button
                        variant="default"
                        size="sm"
                        className="gap-1.5"
                        disabled={discoverState?.applying}
                        onClick={handleApplyDiff}
                      >
                        {discoverState?.applying && <SpinnerGap size={12} className="animate-spin" />}
                        {isZh ? '应用更改' : 'Apply changes'}
                      </Button>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={xaiLoginDialogOpen}
        onOpenChange={(open) => {
          setXaiLoginDialogOpen(open);
          if (!open && xaiLoggingIn) {
            cancelXaiOAuthAttempt();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isZh ? '登录 xAI Grok OAuth' : 'Sign in to xAI Grok OAuth'}</DialogTitle>
            <DialogDescription>
              {isZh
                ? '这是兼容接入，复用公开 Grok CLI OAuth client，可能受 xAI 上游策略调整影响。xAI API Key 是独立且更稳定的备用渠道。'
                : 'This compatibility login reuses the public Grok CLI OAuth client and may be affected by xAI policy changes. xAI API Key remains a separate, more stable fallback.'}
            </DialogDescription>
          </DialogHeader>

          {xaiLoginMethod === null ? (
            <div className="grid gap-3 py-3 sm:grid-cols-2">
              <Button
                variant="default"
                disabled={xaiLoggingIn}
                onClick={() => void handleXaiLogin('browser')}
              >
                {isZh ? '浏览器登录' : 'Browser login'}
              </Button>
              <Button
                variant="outline"
                disabled={xaiLoggingIn}
                onClick={() => void handleXaiLogin('device')}
              >
                {isZh ? '设备码登录' : 'Device-code login'}
              </Button>
            </div>
          ) : xaiLoginMethod === 'browser' ? (
            <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
              {isZh
                ? '浏览器授权页面已打开。请在浏览器中完成登录；此流程不需要设备码，完成后窗口会自动收起。'
                : 'The browser authorization page is open. Complete sign-in there; no device code is required, and this dialog will close automatically.'}
            </div>
          ) : xaiDevice ? (
            <div className="space-y-3 py-3">
              <p className="text-sm text-muted-foreground">
                {isZh ? '打开验证页面并输入设备码：' : 'Open the verification page and enter this device code:'}
              </p>
              <div className="rounded-md bg-muted px-4 py-3 text-center font-mono text-xl tracking-widest">
                {xaiDevice.userCode}
              </div>
              <a
                href={xaiDevice.verificationUriComplete || xaiDevice.verificationUri}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                {xaiDevice.verificationUri}
                <ArrowSquareOut size={14} />
              </a>
              <p className="text-xs text-muted-foreground">
                {isZh ? `设备码约 ${Math.ceil(xaiDevice.expiresIn / 60)} 分钟后过期。` : `The code expires in about ${Math.ceil(xaiDevice.expiresIn / 60)} minutes.`}
              </p>
            </div>
          ) : (
            <p className="py-3 text-sm text-muted-foreground">
              {isZh ? '正在获取设备码…' : 'Requesting a device code…'}
            </p>
          )}

          {xaiLoggingIn && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <SpinnerGap size={13} className="animate-spin" />
              {isZh ? '等待 xAI 授权完成…' : 'Waiting for xAI authorization…'}
            </p>
          )}
          {xaiError && <p className="text-xs text-destructive" role="alert">{xaiError}</p>}
        </DialogContent>
      </Dialog>

      {/* Disconnect confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('provider.disconnectProvider')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('provider.disconnectConfirm', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDisconnect}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? t('provider.disconnecting') : t('provider.disconnect')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
