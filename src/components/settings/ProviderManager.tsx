"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PlusSignIcon,
  Loading02Icon,
  Delete02Icon,
  PencilEdit01Icon,
  Tick01Icon,
  ServerStack01Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { ProviderForm } from "./ProviderForm";
import type { ProviderFormData } from "./ProviderForm";
import type { ApiProvider } from "@/types";
import { useTranslation } from "@/hooks/useTranslation";

const QUICK_PRESETS = [
  { name: "Anthropic", provider_type: "anthropic", base_url: "https://api.anthropic.com" },
  { name: "OpenRouter", provider_type: "openrouter", base_url: "https://openrouter.ai/api" },
  { name: "GLM (CN)", provider_type: "custom", base_url: "https://open.bigmodel.cn/api/anthropic", extra_env: '{"API_TIMEOUT_MS":"3000000","ANTHROPIC_API_KEY":""}' },
  { name: "GLM (Global)", provider_type: "custom", base_url: "https://api.z.ai/api/anthropic", extra_env: '{"API_TIMEOUT_MS":"3000000","ANTHROPIC_API_KEY":""}' },
  { name: "Kimi Coding Plan", provider_type: "custom", base_url: "https://api.kimi.com/coding/", extra_env: '{"ANTHROPIC_AUTH_TOKEN":""}' },
  { name: "Moonshot", provider_type: "custom", base_url: "https://api.moonshot.cn/anthropic", extra_env: '{"ANTHROPIC_API_KEY":""}' },
  { name: "MiniMax (CN)", provider_type: "custom", base_url: "https://api.minimaxi.com/anthropic", extra_env: '{"API_TIMEOUT_MS":"3000000","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1","ANTHROPIC_API_KEY":""}' },
  { name: "MiniMax (Global)", provider_type: "custom", base_url: "https://api.minimax.io/anthropic", extra_env: '{"API_TIMEOUT_MS":"3000000","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1","ANTHROPIC_API_KEY":""}' },
  { name: "AWS Bedrock", provider_type: "bedrock", base_url: "" },
  { name: "Google Vertex", provider_type: "vertex", base_url: "" },
  { name: "LiteLLM", provider_type: "custom", base_url: "http://localhost:4000" },
];

export function ProviderManager() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [envDetected, setEnvDetected] = useState<Record<string, string>>({});

  // Form dialog state
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [editingProvider, setEditingProvider] = useState<ApiProvider | null>(null);
  const [initialPreset, setInitialPreset] = useState<{ name: string; provider_type: string; base_url: string } | null>(null);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<ApiProvider | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Activating state
  const [activatingId, setActivatingId] = useState<string | null>(null);

  const fetchProviders = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/providers");
      if (!res.ok) {
        throw new Error("Failed to load providers");
      }
      const data = await res.json();
      setProviders(data.providers || []);
      setEnvDetected(data.env_detected || {});
    } catch (err) {
      setError(t("provider.failedToLoad"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const handleAdd = () => {
    setFormMode("create");
    setEditingProvider(null);
    setInitialPreset(null);
    setFormOpen(true);
  };

  const handlePresetAdd = (preset: typeof QUICK_PRESETS[number]) => {
    setFormMode("create");
    setEditingProvider(null);
    setInitialPreset(preset);
    setFormOpen(true);
  };

  const handleEdit = (provider: ApiProvider) => {
    setFormMode("edit");
    setEditingProvider(provider);
    setInitialPreset(null);
    setFormOpen(true);
  };

  const handleSave = async (data: ProviderFormData) => {
    if (formMode === "edit" && editingProvider) {
      const res = await fetch(`/api/providers/${editingProvider.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to update provider");
      }
      const result = await res.json();
      setProviders((prev) =>
        prev.map((p) => (p.id === editingProvider.id ? result.provider : p))
      );
    } else {
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
      setProviders((prev) => [...prev, result.provider]);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/providers/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setProviders((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      }
    } catch {
      // ignore
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const handleActivate = async (provider: ApiProvider) => {
    setActivatingId(provider.id);
    try {
      const res = await fetch(`/api/providers/${provider.id}/activate`, {
        method: "POST",
      });
      if (res.ok) {
        // Mark the activated provider as active, deactivate others
        setProviders((prev) =>
          prev.map((p) => ({
            ...p,
            is_active: p.id === provider.id ? 1 : 0,
          }))
        );
      }
    } catch {
      // ignore
    } finally {
      setActivatingId(null);
    }
  };

  const handleDeactivate = async (provider: ApiProvider) => {
    setActivatingId(provider.id);
    try {
      const res = await fetch(`/api/providers/${provider.id}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      if (res.ok) {
        setProviders((prev) =>
          prev.map((p) => ({ ...p, is_active: 0 }))
        );
      }
    } catch {
      // ignore
    } finally {
      setActivatingId(null);
    }
  };

  const sorted = [...providers].sort((a, b) => a.sort_order - b.sort_order);

  return (
    <div className="rounded-lg border border-border/50 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">{t("provider.title")}</h3>
            {providers.length > 0 && (
              <span className="text-xs text-muted-foreground">
                ({providers.length})
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("provider.desc")}
          </p>
        </div>
        <Button size="sm" className="gap-1" onClick={handleAdd}>
          <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
          {t("provider.addProvider")}
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Environment variable detection banner */}
      {!loading && Object.keys(envDetected).length > 0 && (() => {
        const hasActiveProvider = providers.some(p => p.is_active === 1);
        return (
          <div className={`rounded-md border p-3 ${
            hasActiveProvider
              ? "border-border/50 bg-muted/30"
              : "border-green-500/30 bg-green-500/5"
          }`}>
            <div className="flex items-center gap-2 mb-1">
              <p className={`text-xs font-medium ${
                hasActiveProvider
                  ? "text-muted-foreground"
                  : "text-green-700 dark:text-green-400"
              }`}>
                {t("provider.envDetected")}
              </p>
              {hasActiveProvider ? (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                  {t("provider.envOverridden")}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-green-600 dark:text-green-400 border-green-500/30">
                  {t("provider.envInUse")}
                </Badge>
              )}
            </div>
            <div className="space-y-0.5">
              {Object.entries(envDetected).map(([key, value]) => (
                <p key={key} className={`text-xs font-mono ${
                  hasActiveProvider ? "text-muted-foreground/60 line-through" : "text-muted-foreground"
                }`}>
                  {key}={value}
                </p>
              ))}
            </div>
            {hasActiveProvider && (
              <p className="text-xs text-muted-foreground mt-1.5">
                {t("provider.envOverriddenHint")}
              </p>
            )}
          </div>
        );
      })()}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
          <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
          <p className="text-sm">{t("provider.loadingProviders")}</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && providers.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground">
          <HugeiconsIcon icon={ServerStack01Icon} className="h-10 w-10 opacity-30" />
          <div className="text-center">
            <p className="text-sm font-medium">{t("provider.noProviders")}</p>
            <p className="text-xs mt-0.5">
              {Object.keys(envDetected).length > 0
                ? t("provider.emptyWithEnv")
                : t("provider.emptyNoEnv")}
            </p>
          </div>
          {/* Quick preset buttons */}
          <div className="flex flex-wrap items-center justify-center gap-1.5 mt-2 max-w-md">
            {QUICK_PRESETS.map((preset) => (
              <Button
                key={preset.name}
                variant="outline"
                size="xs"
                className="gap-1"
                onClick={() => handlePresetAdd(preset)}
              >
                <HugeiconsIcon icon={PlusSignIcon} className="h-3 w-3" />
                {preset.name}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Provider list */}
      {!loading && sorted.length > 0 && (
        <div className="space-y-2 max-h-[400px] overflow-y-auto min-h-0">
          {sorted.map((provider) => {
            const isActive = provider.is_active === 1;
            const isActivating = activatingId === provider.id;

            return (
              <div
                key={provider.id}
                className={`rounded-lg border p-3 transition-colors ${
                  isActive
                    ? "border-border bg-green-500/5"
                    : "border-border/50 hover:border-border"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {provider.name}
                      </span>
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        {provider.provider_type}
                      </Badge>
                      {isActive && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-green-600 dark:text-green-400 border-green-500/30">
                          {t("provider.active")}
                        </Badge>
                      )}
                    </div>
                    {provider.base_url && (
                      <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                        {provider.base_url}
                      </p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {isActive ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={isActivating}
                        onClick={() => handleDeactivate(provider)}
                        className="gap-1 text-muted-foreground"
                      >
                        {isActivating ? (
                          <HugeiconsIcon icon={Loading02Icon} className="h-3 w-3 animate-spin" />
                        ) : (
                          <HugeiconsIcon icon={Cancel01Icon} className="h-3 w-3" />
                        )}
                        {t("provider.disable")}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={isActivating}
                        onClick={() => handleActivate(provider)}
                        className="gap-1"
                      >
                        {isActivating ? (
                          <HugeiconsIcon icon={Loading02Icon} className="h-3 w-3 animate-spin" />
                        ) : (
                          <HugeiconsIcon icon={Tick01Icon} className="h-3 w-3" />
                        )}
                        {t("provider.apply")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title={t("provider.edit")}
                      onClick={() => handleEdit(provider)}
                    >
                      <HugeiconsIcon icon={PencilEdit01Icon} className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title={t("provider.delete")}
                      onClick={() => setDeleteTarget(provider)}
                    >
                      <HugeiconsIcon icon={Delete02Icon} className="h-3 w-3 text-destructive" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Quick presets row (when providers exist) */}
      {!loading && providers.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground mr-1">{t("provider.quickAdd")}</span>
          {QUICK_PRESETS.map((preset) => (
            <Button
              key={preset.name}
              variant="outline"
              size="xs"
              className="gap-1 text-[11px]"
              onClick={() => handlePresetAdd(preset)}
            >
              <HugeiconsIcon icon={PlusSignIcon} className="h-2.5 w-2.5" />
              {preset.name}
            </Button>
          ))}
        </div>
      )}

      {/* Form dialog */}
      <ProviderForm
        open={formOpen}
        onOpenChange={setFormOpen}
        mode={formMode}
        provider={editingProvider}
        onSave={handleSave}
        initialPreset={initialPreset}
      />

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("provider.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("provider.deleteDesc", { name: deleteTarget?.name || "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("provider.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? t("provider.deleting") : t("provider.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
