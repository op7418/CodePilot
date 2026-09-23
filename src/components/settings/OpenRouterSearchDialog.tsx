"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SpinnerGap, Check } from "@/components/ui/icon";
import { CodePilotIcon } from "@/components/ui/semantic-icon";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import { showToast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";
import type { CatalogModelPresenceState } from "@/lib/catalog-model-identity";

/**
 * "搜索并添加模型" dialog (originally OpenRouter-only, generalized to any
 * provider whose `/v1/models` returns a usable catalog — see
 * `canSearchUpstreamModels`).
 *
 * Opens, fetches the full candidate list from `POST /search-models`, then
 * filters client-side as the user types — server has no `q` param.
 * Adding a candidate goes through `POST /api/providers/[id]/models`
 * (manual path, source='manual', enable_source='manual_enabled').
 *
 * Closing and re-opening within 5 minutes hits the server cache for
 * OpenRouter; the dialog itself does not cache between opens (so per-row
 * alreadyAdded reflects the current DB state).
 *
 * Failure fallback: if `/search-models` returns an error (key invalid,
 * upstream 5xx, network), the dialog renders a "手动输入模型 ID"
 * button alongside the error message; clicking calls `onManualFallback`,
 * which closes this dialog and opens the manual-entry dialog so the
 * user is never stuck. Per Codex review the contract is "search if
 * possible, fall back to manual otherwise" — and this needs to apply
 * at runtime too, not just at the static gate.
 */

export interface SearchCandidate {
  modelId: string;
  upstreamModelId?: string;
  displayName: string;
  contextWindow?: number;
  pricing?: { promptPerMillion?: number; completionPerMillion?: number };
  alreadyAdded: boolean;
  existingHidden: boolean;
  existingModelId?: string;
  presenceState?: CatalogModelPresenceState;
  conflictModelIds?: string[];
}

interface SearchModelsResponse {
  candidates: SearchCandidate[];
  total: number;
  cachedAt: string;
}

interface ModelIdentityConflictResponse {
  code: "MODEL_IDENTITY_CONFLICT";
  conflictModelIds?: string[];
}

export function isModelIdentityConflictResponse(
  status: number,
  body: unknown,
): body is ModelIdentityConflictResponse {
  if (status !== 409 || !body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  return record.code === "MODEL_IDENTITY_CONFLICT"
    && (record.conflictModelIds === undefined
      || (Array.isArray(record.conflictModelIds)
        && record.conflictModelIds.every(id => typeof id === "string")));
}

interface OpenRouterSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  providerName: string;
  /** Reveal the server-reported conflict rows, including hidden models. */
  onReviewModels: (modelIds: string[]) => void;
  /** Called after a mutation response that may have changed catalog rows
   *  (including a typed conflict after merge), so the parent can refetch. */
  onModelAdded?: () => void;
  /** Called when /search-models fails and the user clicks "type model
   *  ID manually". The parent should close this dialog and open the
   *  manual-entry add dialog. */
  onManualFallback?: () => void;
}

function formatContextWindow(ctx: number | undefined): string | null {
  if (!ctx || ctx <= 0) return null;
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M`;
  if (ctx >= 1_000) return `${Math.round(ctx / 1_000)}K`;
  return String(ctx);
}

function formatPrice(n: number | undefined): string | null {
  if (n === undefined || !Number.isFinite(n)) return null;
  // OpenRouter prices vary 0.01 – 50+ per 1M; 2 decimals gives readability
  // without truncating cheap models to 0.00.
  return n < 0.1 ? n.toFixed(3) : n.toFixed(2);
}

export function filterSearchCandidates(
  candidates: SearchCandidate[],
  query: string,
): SearchCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return candidates;
  return candidates.filter(candidate =>
    candidate.modelId.toLowerCase().includes(q)
    || candidate.upstreamModelId?.toLowerCase().includes(q)
    || candidate.displayName.toLowerCase().includes(q),
  );
}

export function buildSearchCandidateMutation(candidate: SearchCandidate): {
  method: 'POST' | 'PATCH';
  body: Record<string, string | number>;
} {
  if (candidate.existingHidden && candidate.existingModelId) {
    return {
      method: 'PATCH',
      body: { model_id: candidate.existingModelId, enabled: 1 },
    };
  }
  return {
    method: 'POST',
    body: {
      model_id: candidate.modelId,
      upstream_model_id: candidate.upstreamModelId || candidate.modelId,
      display_name: candidate.displayName,
    },
  };
}

export function OpenRouterSearchDialog({
  open,
  onOpenChange,
  providerId,
  providerName,
  onReviewModels,
  onModelAdded,
  onManualFallback,
}: OpenRouterSearchDialogProps) {
  const { t } = useTranslation();
  const [candidates, setCandidates] = useState<SearchCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [addingId, setAddingId] = useState<string | null>(null);
  const reviewingModels = useRef(false);

  // Phase 1 Step 2 收敛 round 3 (2026-05-06): the OpenRouter section in
  // the Models page no longer has its own refresh / validate button.
  // The "fetch / refresh upstream catalog" flow lives entirely inside
  // this dialog now: auto-fetch on open + an in-dialog retry button on
  // failure (or for explicit user reload). `abortRef` lets the retry
  // handler cancel a stale in-flight request without resurrecting an
  // earlier error.
  const abortRef = useRef<{ aborted: boolean } | null>(null);
  const fetchCandidates = useCallback(async () => {
    // Cancel any in-flight request before kicking off a new one.
    // Previous form `abortRef.current?.aborted && (... = true)` was a
    // no-op for in-flight (aborted=false short-circuited the &&), so a
    // fast double-click on Reload could let the older slower response
    // overwrite the newer one. Plain assignment guarantees the old
    // guard flips regardless of state.
    if (abortRef.current) abortRef.current.aborted = true;
    const guard = { aborted: false };
    abortRef.current = guard;
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/providers/${providerId}/search-models`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `${res.status} ${res.statusText}`);
      }
      const data = await res.json() as SearchModelsResponse;
      if (!guard.aborted) setCandidates(data.candidates);
    } catch (err) {
      if (!guard.aborted) setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!guard.aborted) setLoading(false);
    }
  }, [providerId]);

  // Fetch candidates when dialog opens; reset state when it closes so the
  // next open shows current DB state and a fresh search field.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setFetchError(null);
      setAddingId(null);
      if (abortRef.current) abortRef.current.aborted = true;
      return;
    }
    void fetchCandidates();
    return () => {
      if (abortRef.current) abortRef.current.aborted = true;
    };
  }, [open, fetchCandidates]);

  const filtered = useMemo(() => {
    return filterSearchCandidates(candidates, query);
  }, [candidates, query]);

  const handleAdd = async (candidate: SearchCandidate) => {
    if (addingId) return;
    setAddingId(candidate.modelId);
    try {
      const mutation = buildSearchCandidateMutation(candidate);
      const res = await fetch(`/api/providers/${providerId}/models`, {
        method: mutation.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mutation.body),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        if (isModelIdentityConflictResponse(res.status, body)) {
          // The server may have materialized other catalog rows before the
          // target CAS failed. Re-read both dialog and parent model state so a
          // 409 never leaves stale candidates or hides those real writes.
          await fetchCandidates();
          if (typeof window !== "undefined") {
            window.dispatchEvent(new Event("provider-changed"));
          }
          onModelAdded?.();
          throw new Error(t(
            "provider.search.openrouter.mutationIdentityConflict" as TranslationKey,
            {
              ids: body.conflictModelIds?.join(", ") || candidate.modelId,
            },
          ));
        }
        const error = body && typeof body === "object" && "error" in body
          ? String((body as { error?: unknown }).error || "")
          : "";
        throw new Error(error || `${res.status} ${res.statusText}`);
      }
      // Re-read the server-owned five-state classifier. A 2xx mutation alone
      // is not proof that a catalog CAS won, and optimistic local state used
      // to report a false success when another row claimed the identity.
      await fetchCandidates();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("provider-changed"));
      }
      onModelAdded?.();
    } catch (err) {
      showToast({
        type: "error",
        message: t(
          (candidate.existingHidden
            ? "provider.search.openrouter.restoreError"
            : "provider.search.openrouter.addError") as TranslationKey,
          {
            error: err instanceof Error ? err.message : String(err),
          },
        ),
        duration: 5000,
      });
    } finally {
      setAddingId(null);
    }
  };

  const totalLabel = candidates.length > 0
    ? (query.trim()
      ? t("provider.search.openrouter.matchCount" as TranslationKey, {
        count: String(filtered.length),
        total: String(candidates.length),
      })
      : t("provider.search.openrouter.totalCount" as TranslationKey, {
        total: String(candidates.length),
      }))
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl max-h-[85vh] flex flex-col gap-0 overflow-hidden"
        onCloseAutoFocus={(event) => {
          // The parent moves focus to the actual model row. Do not restore
          // focus to the Add button and scroll back away from that row.
          if (reviewingModels.current) event.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4">
          {/* Phase 1 Step 2 收敛 round 6 (2026-05-06): title generalized
              from OpenRouter-specific "从 OpenRouter 搜索模型" to a
              provider-agnostic "为「{name}」添加模型" — same wording as
              the trigger button. The dialog now serves any provider
              whose /v1/models reliably lists models (ollama, litellm,
              anthropic-thirdparty, generic openai-compatible) plus
              OpenRouter. The OpenRouter file name is preserved to keep
              the diff small; component is internally provider-agnostic. */}
          <DialogTitle>
            {t('provider.add.titleManual' as TranslationKey, { name: providerName })}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {t('provider.search.dialogDescription' as TranslationKey)}
          </DialogDescription>
          <div className="relative mt-3">
            <CodePilotIcon
              name="search"
              size="sm"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t("provider.search.openrouter.placeholder" as TranslationKey)}
              className="pl-8 h-9 text-sm"
              autoFocus
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            {totalLabel ? (
              <div className="text-[11px] text-muted-foreground">{totalLabel}</div>
            ) : <span />}
            {/* Lightweight 重新加载 — exists per Codex spec ("弹窗内可以
                有一个轻量「重新加载」按钮，只用于失败或用户主动重试").
                Always rendered (not failure-only) so a user who suspects
                the cached list is stale can re-fetch without closing
                and re-opening the dialog. Cheap server-side cache (5
                min) means quick re-clicks don't hammer upstream. */}
            <button
              type="button"
              onClick={fetchCandidates}
              disabled={loading}
              className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2 disabled:opacity-50 disabled:no-underline"
            >
              {loading
                ? t("provider.search.openrouter.reloading" as TranslationKey)
                : t("provider.search.openrouter.reload" as TranslationKey)}
            </button>
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0 px-6 py-3 flex flex-col">
          {loading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
              <SpinnerGap size={16} className="animate-spin" />
              <span className="text-xs">…</span>
            </div>
          )}
          {fetchError && !loading && (
            <div className="space-y-3">
              <div className="rounded-md border border-status-error-border bg-status-error-muted p-3 text-xs text-status-error-foreground">
                {t("provider.search.openrouter.fetchError" as TranslationKey, { error: fetchError })}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {t("provider.search.openrouter.fetchErrorFallback" as TranslationKey)}
              </div>
              {/* Actionable fallback per Codex review: when the search
                  endpoint fails the user must still have a path to add
                  a model, otherwise the dialog is a dead end. Manual
                  entry is the only path that doesn't depend on
                  upstream /v1/models — same as what canSearchUpstream
                  Models=false providers get. */}
              {onManualFallback && (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={onManualFallback}>
                    {t("provider.search.openrouter.fallbackToManual" as TranslationKey)}
                  </Button>
                  <button
                    type="button"
                    onClick={fetchCandidates}
                    disabled={loading}
                    className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
                  >
                    {t("provider.search.openrouter.reload" as TranslationKey)}
                  </button>
                </div>
              )}
            </div>
          )}
          {!loading && !fetchError && filtered.length === 0 && (
            <div className="py-12 text-center text-xs text-muted-foreground">
              {t("provider.search.openrouter.noResults" as TranslationKey)}
            </div>
          )}
          {!loading && !fetchError && filtered.length > 0 && (
            // Scroll container is the rounded list itself, so the
            // scrollbar sits inside the muted block (right edge of the
            // list) rather than at the dialog's outer edge.
            // `min-h-0` is the standard flex trick — without it, the
            // list refuses to shrink below content height and the outer
            // wrapper has no scroll target. No row dividers per design
            // call: typography + py-3 spacing already give clear
            // visual separation between rows.
            <div className="rounded-md bg-muted/40 overflow-y-auto flex-1 min-h-0">
              <div>
                {filtered.map(candidate => {
                  const isAdded = candidate.alreadyAdded && !candidate.existingHidden;
                  const isAdding = addingId === candidate.modelId;
                  const isLegacyUpgrade = candidate.presenceState === 'legacy_upgrade_available';
                  const isIdentityConflict = candidate.presenceState === 'identity_conflict';
                  const ctx = formatContextWindow(candidate.contextWindow);
                  const promptPrice = formatPrice(candidate.pricing?.promptPerMillion);
                  const completionPrice = formatPrice(candidate.pricing?.completionPerMillion);
                  return (
                    <div
                      key={candidate.modelId}
                      className="px-3.5 py-3 flex items-center gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium truncate">{candidate.displayName}</div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          {candidate.upstreamModelId || candidate.modelId}
                        </div>
                        {isIdentityConflict && (
                          <div className="mt-1 text-[10px] leading-4 text-status-warning-foreground">
                            {t("provider.search.openrouter.identityConflictDetail" as TranslationKey, {
                              ids: candidate.conflictModelIds?.join(", ") || candidate.modelId,
                            })}
                          </div>
                        )}
                        {(ctx || (promptPrice && completionPrice)) && (
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                            {ctx && (
                              <span>
                                {t("provider.search.openrouter.contextWindow" as TranslationKey, { ctx })}
                              </span>
                            )}
                            {promptPrice && completionPrice && (
                              <span>
                                {t("provider.search.openrouter.pricing" as TranslationKey, {
                                  prompt: promptPrice,
                                  completion: completionPrice,
                                })}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      {isIdentityConflict ? (
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="inline-flex items-center rounded-full bg-status-warning-muted px-2 py-0.5 text-[10px] font-medium text-status-warning-foreground">
                            {t("provider.search.openrouter.identityConflict" as TranslationKey)}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2.5 text-xs"
                            onClick={() => {
                              reviewingModels.current = true;
                              onReviewModels(candidate.conflictModelIds ?? []);
                            }}
                          >
                            {t("provider.search.openrouter.reviewModels" as TranslationKey)}
                          </Button>
                        </div>
                      ) : candidate.existingHidden ? (
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {t("provider.search.openrouter.alreadyAddedHidden" as TranslationKey)}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2.5 text-xs gap-1"
                            onClick={() => handleAdd(candidate)}
                            disabled={isAdding || addingId !== null}
                          >
                            {isAdding && <SpinnerGap size={11} className="animate-spin" />}
                            {isAdding
                              ? t("provider.search.openrouter.restoring" as TranslationKey)
                              : t("provider.search.openrouter.restoreButton" as TranslationKey)}
                          </Button>
                        </div>
                      ) : isAdded ? (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0",
                            "bg-status-success-muted text-status-success-foreground",
                          )}
                        >
                          <Check size={10} weight="bold" />
                          {t("provider.search.openrouter.alreadyAdded" as TranslationKey)}
                        </span>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2.5 text-xs gap-1 shrink-0"
                          onClick={() => handleAdd(candidate)}
                          disabled={isAdding || addingId !== null}
                        >
                          {isAdding ? (
                            <SpinnerGap size={11} className="animate-spin" />
                          ) : (
                            <CodePilotIcon name="plus" size={11} strokeWidth={2} aria-hidden />
                          )}
                          {isAdding
                            ? t((isLegacyUpgrade
                                ? "provider.search.openrouter.upgrading"
                                : "provider.search.openrouter.adding") as TranslationKey)
                            : t((isLegacyUpgrade
                                ? "provider.search.openrouter.upgradeButton"
                                : "provider.search.openrouter.addButton") as TranslationKey)}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
