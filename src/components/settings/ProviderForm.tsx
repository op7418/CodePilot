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

const PROVIDER_PRESETS: Record<string, { base_url: string; extra_env: string; protocol: string }> = {
  anthropic: { base_url: "https://api.anthropic.com", extra_env: "{}", protocol: "anthropic" },
  openrouter: { base_url: "https://openrouter.ai/api", extra_env: '{"ANTHROPIC_API_KEY":""}', protocol: "openrouter" },
  bedrock: { base_url: "", extra_env: '{"CLAUDE_CODE_USE_BEDROCK":"1","AWS_REGION":"us-east-1","CLAUDE_CODE_SKIP_BEDROCK_AUTH":"1"}', protocol: "bedrock" },
  vertex: { base_url: "", extra_env: '{"CLAUDE_CODE_USE_VERTEX":"1","CLOUD_ML_REGION":"us-east5","CLAUDE_CODE_SKIP_VERTEX_AUTH":"1"}', protocol: "vertex" },
  custom: { base_url: "", extra_env: "{}", protocol: "openai-compatible" },
};

const PROVIDER_TYPES = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "bedrock", label: "AWS Bedrock" },
  { value: "vertex", label: "Google Vertex" },
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
  provider_type: string;
  protocol?: string;
  base_url: string;
  api_key: string;
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

    if (mode === "edit" && provider) {
      setName(provider.name);
      setProviderType(provider.provider_type);
      setBaseUrl(provider.base_url);
      // Show masked key so user sees dots indicating a key exists
      setApiKey(provider.api_key || "");
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
      setError("Name is required");
      return;
    }

    // Validate JSON fields
    for (const [label, val] of [
      ["Extra environment variables", extraEnv],
      ["Headers", headersJson],
      ["Role models", roleModelsJson],
    ] as const) {
      if (val && val.trim()) {
        try { JSON.parse(val); } catch {
          setError(`${label} must be valid JSON`);
          return;
        }
      }
    }

    setSaving(true);
    setError(null);
    try {
      // Always sync protocol with provider_type to prevent stale protocol after edits
      const derivedProtocol = PROVIDER_PRESETS[providerType]?.protocol || providerType;

      await onSave({
        name: name.trim(),
        provider_type: providerType,
        protocol: derivedProtocol,
        base_url: baseUrl.trim(),
        api_key: apiKey,
        extra_env: extraEnv,
        headers_json: headersJson.trim() || "{}",
        env_overrides_json: envOverridesJson.trim() || "",
        role_models_json: roleModelsJson.trim() || "{}",
        notes: notes.trim(),
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save provider");
    } finally {
      setSaving(false);
    }
  };

  const isMaskedKey = mode === "edit" && apiKey?.startsWith("***");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[28rem] overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {mode === "edit" ? t('provider.editProvider') : t('provider.addProvider')}
          </DialogTitle>
          <DialogDescription>
            {mode === "edit"
              ? "Update the API provider configuration."
              : "Configure a new API provider for Claude Code."}
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
              placeholder={isMaskedKey ? "Leave empty to keep current key" : "sk-ant-..."}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-mono text-sm"
            />
          </div>

          {/* Advanced options toggle */}
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs text-muted-foreground hover:text-foreground px-0 h-auto"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? <CaretUp size={12} /> : <CaretDown size={12} />}
            {t('provider.advancedOptions')}
          </Button>

          {showAdvanced && (
            <div className="space-y-4 border-t border-border/50 pt-4">
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
                  Headers (JSON)
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
                  Env Overrides (JSON)
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
                  Role Models (JSON)
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
      </DialogContent>
    </Dialog>
  );
}
