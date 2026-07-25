"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SpinnerGap, CaretDown, CaretUp } from "@/components/ui/icon";
import type { ApiProvider } from "@/types";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";

const PROVIDER_PRESETS: Record<string, { base_url: string; extra_env: string; protocol: string }> = {
  anthropic: { base_url: "https://api.anthropic.com", extra_env: "{}", protocol: "anthropic" },
  openrouter: { base_url: "https://openrouter.ai/api", extra_env: '{"ANTHROPIC_API_KEY":""}', protocol: "openrouter" },
  bedrock: { base_url: "", extra_env: '{"CLAUDE_CODE_USE_BEDROCK":"1","AWS_REGION":"us-east-1","CLAUDE_CODE_SKIP_BEDROCK_AUTH":"1"}', protocol: "bedrock" },
  vertex: { base_url: "", extra_env: '{"CLAUDE_CODE_USE_VERTEX":"1","CLOUD_ML_REGION":"us-east5","CLAUDE_CODE_SKIP_VERTEX_AUTH":"1"}', protocol: "vertex" },
  "openai-compatible": { base_url: "", extra_env: "{}", protocol: "openai-compatible" },
  xai: { base_url: "https://api.x.ai/v1", extra_env: "{}", protocol: "xai" },
  custom: { base_url: "", extra_env: "{}", protocol: "anthropic" },
};

const PROVIDER_TYPES = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "bedrock", label: "AWS Bedrock" },
  { value: "vertex", label: "Google Vertex" },
  { value: "openai-compatible", label: "OpenAI-Compatible" },
  { value: "xai", label: "xAI" },
  { value: "custom", label: "Custom" },
];

interface ProviderFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  provider?: ApiProvider | null;
  onSave: (data: ProviderFormData) => Promise<void>;
  initialPreset?: { name: string; provider_type: string; base_url: string; extra_env?: string } | null;
}

export interface ProviderFormData {
  name: string;
  /** Stable preset identity. Omitted in generic edit mode to preserve DB value. */
  preset_key?: string;
  provider_type: string;
  protocol?: string;
  base_url: string;
  /**
   * API key.
   *
   * - `string` → new value (including empty string for providers that don't
   *   need a key, e.g. env_only).
   * - `undefined` → "unchanged" signal for edit mode. The backend PUT route
   *   (src/app/api/providers/[id]/route.ts) will omit the field so
   *   updateProvider()'s `data.api_key ?? existing.api_key` preserves the
   *   stored key. This is how the UI represents "user did not touch the
   *   masked-key placeholder" without leaking the mask back to the server.
   *   See docs/exec-plans/active/v0.48-post-release-issues.md §5.5.
   */
  api_key?: string;
  extra_env: string;
  headers_json?: string;
  env_overrides_json?: string;
  role_models_json?: string;
  notes: string;
}

export function ProviderForm({
  open,
  onOpenChange,
  mode,
  provider,
  onSave,
  initialPreset,
}: ProviderFormProps) {
  const [name, setName] = useState("");
  const [providerType, setProviderType] = useState("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  // #449 fix: edit-mode flag indicating DB has a stored key. We never put the
  // (masked) stored key string into apiKey state; instead the input shows a
  // "keep existing" placeholder and the save request omits api_key so the
  // backend preserves the DB value. Same pattern as PresetConnectDialog.
  // See docs/exec-plans/active/v0.48-post-release-issues.md §5.5.
  const [hasStoredKey, setHasStoredKey] = useState(false);
  // Companion flag for explicit "clear the stored key" intent. Without it,
  // hasStoredKey + empty input is unconditionally interpreted as "keep
  // existing", leaving users with no way to actually delete a stored key.
  const [clearStoredKey, setClearStoredKey] = useState(false);
  const [extraEnv, setExtraEnv] = useState("{}");
  const [notes, setNotes] = useState("");
  const [headersJson, setHeadersJson] = useState("{}");
  const [envOverridesJson, setEnvOverridesJson] = useState("");
  const [roleModelsJson, setRoleModelsJson] = useState("{}");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { t } = useTranslation();

  // Reset form when dialog opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    setClearStoredKey(false);

    if (mode === "edit" && provider) {
      setName(provider.name);
      setProviderType(provider.provider_type);
      setBaseUrl(provider.base_url);
      // #449 fix: do NOT put (masked) stored key into state. Flag it instead
      // so the input shows a "keep existing" placeholder and save omits the
      // field when the user leaves it blank.
      setApiKey("");
      setHasStoredKey(!!provider.api_key);
      setExtraEnv(provider.extra_env || "{}");
      setHeadersJson(provider.headers_json || "{}");
      setEnvOverridesJson(provider.env_overrides_json || "");
      setRoleModelsJson(provider.role_models_json || "{}");
      setNotes(provider.notes || "");
      // Show advanced if extra_env or new fields have content
      try {
        const parsed = JSON.parse(provider.extra_env || "{}");
        const hasHeaders = provider.headers_json && provider.headers_json !== "{}";
        const hasEnvOverrides = provider.env_overrides_json && provider.env_overrides_json !== "";
        const hasRoleModels = provider.role_models_json && provider.role_models_json !== "{}";
        setShowAdvanced(Object.keys(parsed).length > 0 || !!hasHeaders || !!hasEnvOverrides || !!hasRoleModels);
      } catch {
        setShowAdvanced(true);
      }
    } else if (initialPreset) {
      setName(initialPreset.name);
      setProviderType(initialPreset.provider_type);
      setBaseUrl(initialPreset.base_url);
      setApiKey("");
      setHasStoredKey(false);
      // Use extra_env from preset if provided, otherwise look up by type
      const envStr = initialPreset.extra_env || PROVIDER_PRESETS[initialPreset.provider_type]?.extra_env || "{}";
      setExtraEnv(envStr);
      setNotes("");
      try {
        const parsed = JSON.parse(envStr);
        setShowAdvanced(Object.keys(parsed).length > 0);
      } catch {
        setShowAdvanced(false);
      }
    } else {
      setName("");
      setProviderType("anthropic");
      setBaseUrl(PROVIDER_PRESETS.anthropic.base_url);
      setApiKey("");
      setHasStoredKey(false);
      setExtraEnv("{}");
      setHeadersJson("{}");
      setEnvOverridesJson("");
      setRoleModelsJson("{}");
      setNotes("");
      setShowAdvanced(false);
    }
  }, [open, mode, provider, initialPreset]);

  const handleTypeChange = (type: string) => {
    setProviderType(type);
    const preset = PROVIDER_PRESETS[type];
    if (preset) {
      setBaseUrl(preset.base_url);
      setExtraEnv(preset.extra_env);
      try {
        const parsed = JSON.parse(preset.extra_env);
        setShowAdvanced(Object.keys(parsed).length > 0);
      } catch {
        setShowAdvanced(false);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t('provider.form.errorNameRequired' as TranslationKey));
      return;
    }

    // Validate JSON fields. Field labels reuse the same i18n keys as the
    // labels rendered in the form so the error message reads as "<the
    // field you just looked at> must be valid JSON".
    // `envOverridesJson` is also a JSON textarea but was missing from the
    // original validation list — invalid input would silently fail at the
    // backend instead of being caught here.
    for (const [labelKey, val] of [
      ['provider.extraEnvVars', extraEnv],
      ['provider.form.headersJson', headersJson],
      ['provider.form.envOverridesJson', envOverridesJson],
      ['provider.form.roleModelsJson', roleModelsJson],
    ] as const) {
      if (val && val.trim()) {
        try { JSON.parse(val); } catch {
          setError(t('provider.form.errorJsonInvalid' as TranslationKey, { field: t(labelKey as TranslationKey) }));
          return;
        }
      }
    }

    setSaving(true);
    setError(null);
    try {
      // Always sync protocol with provider_type to prevent stale protocol after edits
      const derivedProtocol = PROVIDER_PRESETS[providerType]?.protocol || providerType;

      // #449 fix: three distinct save intents for api_key in edit mode.
      // See PresetConnectDialog handleSubmit for the full rationale.
      //   new value   → apiKey as-is
      //   clear       → "" (overwrites DB since `?? existing` only falls
      //                 back on nullish)
      //   keep        → undefined (PUT body omits field → DB preserved)
      //   create/no stored → apiKey as-is
      const apiKeyForSave: string | undefined = (() => {
        if (apiKey) return apiKey;
        if (mode === "edit" && hasStoredKey && clearStoredKey) return "";
        if (mode === "edit" && hasStoredKey) return undefined;
        return apiKey;
      })();
      await onSave({
        name: name.trim(),
        provider_type: providerType,
        protocol: derivedProtocol,
        base_url: baseUrl.trim(),
        api_key: apiKeyForSave,
        extra_env: extraEnv,
        headers_json: headersJson.trim() || "{}",
        env_overrides_json: envOverridesJson.trim() || "",
        role_models_json: roleModelsJson.trim() || "{}",
        notes: notes.trim(),
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('provider.form.errorSaveFailed' as TranslationKey));
    } finally {
      setSaving(false);
    }
  };

  // Show "keep existing" placeholder when the DB has a stored key and the
  // user hasn't typed anything yet. Replaces the old isMaskedKey derivation
  // which was based on detecting "***" in apiKey state — we no longer load
  // masked values into state at all.
  const showStoredKeyPlaceholder = mode === "edit" && hasStoredKey && !apiKey;
  // Show the explicit "clear stored key" affordance under the same
  // conditions.
  const showClearStoredKeyAction = showStoredKeyPlaceholder;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent fullscreen>
        <div className="min-h-full flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-md">
        <DialogHeader className="mb-6">
          <DialogTitle className="text-xl">
            {mode === "edit" ? t('provider.editProvider') : t('provider.addProvider')}
          </DialogTitle>
          <DialogDescription>
            {mode === "edit"
              ? t('provider.form.editDesc' as TranslationKey)
              : t('provider.form.addDesc' as TranslationKey)}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 min-w-0">
          <div className="space-y-2">
            <Label htmlFor="provider-name" className="text-xs text-muted-foreground">
              {t('provider.name')}
            </Label>
            <Input
              id="provider-name"
              placeholder="My API Provider"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="provider-type" className="text-xs text-muted-foreground">
              {t('provider.providerType')}
            </Label>
            <Select value={providerType} onValueChange={handleTypeChange}>
              <SelectTrigger className="w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="provider-base-url" className="text-xs text-muted-foreground">
              {t('provider.baseUrl')}
            </Label>
            <Input
              id="provider-base-url"
              placeholder="https://api.anthropic.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="font-mono text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="provider-api-key" className="text-xs text-muted-foreground">
              {t('provider.apiKey')}
            </Label>
            <Input
              id="provider-api-key"
              type="password"
              placeholder={
                clearStoredKey
                  ? t('provider.form.clearKeyPlaceholder' as TranslationKey)
                  : showStoredKeyPlaceholder
                  ? t('provider.form.keepKeyPlaceholder' as TranslationKey)
                  : "sk-ant-..."
              }
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                // Typing a new key overrides any pending "clear" intent
                if (clearStoredKey) setClearStoredKey(false);
              }}
              className="font-mono text-sm"
            />
            {/* Explicit "clear stored key" action — see PresetConnectDialog
                for the rationale. Without this users cannot actually
                delete a stored key. */}
            {showClearStoredKeyAction && (
              <p className="text-[11px]">
                {clearStoredKey ? (
                  <>
                    <span className="text-amber-500">
                      {t('provider.form.clearKeyPending' as TranslationKey)}{" "}
                    </span>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-[11px] text-amber-500 underline hover:no-underline"
                      onClick={() => setClearStoredKey(false)}
                    >
                      {t('provider.form.undo' as TranslationKey)}
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-[11px] text-muted-foreground underline hover:no-underline"
                    onClick={() => setClearStoredKey(true)}
                  >
                    {t('provider.form.clearKeyAction' as TranslationKey)}
                  </Button>
                )}
              </p>
            )}
          </div>

          {/* Advanced options toggle */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs text-muted-foreground hover:text-foreground px-0 h-auto"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? <CaretUp size={12} /> : <CaretDown size={12} />}
            {t('provider.advancedOptions')}
          </Button>

          {showAdvanced && (
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label htmlFor="provider-extra-env" className="text-xs text-muted-foreground">
                  {t('provider.extraEnvVars')} (JSON)
                </Label>
                <Textarea
                  id="provider-extra-env"
                  placeholder='{"KEY": "value"}'
                  value={extraEnv}
                  onChange={(e) => setExtraEnv(e.target.value)}
                  className="font-mono text-sm min-h-[80px]"
                  rows={3}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="provider-headers-json" className="text-xs text-muted-foreground">
                  {t('provider.form.headersJson' as TranslationKey)}
                </Label>
                <Textarea
                  id="provider-headers-json"
                  placeholder='{"X-Custom-Header": "value"}'
                  value={headersJson}
                  onChange={(e) => setHeadersJson(e.target.value)}
                  className="font-mono text-sm min-h-[60px]"
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="provider-env-overrides" className="text-xs text-muted-foreground">
                  {t('provider.form.envOverridesJson' as TranslationKey)}
                </Label>
                <Textarea
                  id="provider-env-overrides"
                  placeholder='{"CLAUDE_CODE_USE_BEDROCK": "1"}'
                  value={envOverridesJson}
                  onChange={(e) => setEnvOverridesJson(e.target.value)}
                  className="font-mono text-sm min-h-[60px]"
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="provider-role-models" className="text-xs text-muted-foreground">
                  {t('provider.form.roleModelsJson' as TranslationKey)}
                </Label>
                <Textarea
                  id="provider-role-models"
                  placeholder='{"default": "sonnet", "reasoning": "opus", "small": "haiku"}'
                  value={roleModelsJson}
                  onChange={(e) => setRoleModelsJson(e.target.value)}
                  className="font-mono text-sm min-h-[60px]"
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="provider-notes" className="text-xs text-muted-foreground">
                  {t('provider.notes')}
                </Label>
                <Textarea
                  id="provider-notes"
                  placeholder={t('provider.notesPlaceholder')}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="text-sm"
                  rows={2}
                />
              </div>
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saving} className="gap-2">
              {saving && (
                <SpinnerGap size={16} className="animate-spin" />
              )}
              {saving ? t('provider.saving') : mode === "edit" ? t('provider.update') : t('provider.addProvider')}
            </Button>
          </DialogFooter>
        </form>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
