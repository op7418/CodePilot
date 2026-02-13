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
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon, ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import type { ApiProvider } from "@/types";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";

const PROVIDER_PRESETS: Record<string, { base_url: string; extra_env: string }> = {
  anthropic: { base_url: "https://api.anthropic.com", extra_env: "{}" },
  openrouter: { base_url: "https://openrouter.ai/api", extra_env: '{"ANTHROPIC_API_KEY":""}' },
  bedrock: { base_url: "", extra_env: '{"CLAUDE_CODE_USE_BEDROCK":"1","AWS_REGION":"us-east-1","CLAUDE_CODE_SKIP_BEDROCK_AUTH":"1"}' },
  vertex: { base_url: "", extra_env: '{"CLAUDE_CODE_USE_VERTEX":"1","CLOUD_ML_REGION":"us-east5","CLAUDE_CODE_SKIP_VERTEX_AUTH":"1"}' },
  custom: { base_url: "", extra_env: "{}" },
};

const PROVIDER_TYPES: { value: string; labelKey: TranslationKey }[] = [
  { value: "anthropic", labelKey: "providerForm.typeAnthropic" },
  { value: "openrouter", labelKey: "providerForm.typeOpenRouter" },
  { value: "bedrock", labelKey: "providerForm.typeBedrock" },
  { value: "vertex", labelKey: "providerForm.typeVertex" },
  { value: "custom", labelKey: "providerForm.typeCustom" },
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
  base_url: string;
  api_key: string;
  extra_env: string;
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
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [providerType, setProviderType] = useState("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [extraEnv, setExtraEnv] = useState("{}");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Reset form when dialog opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);

    if (mode === "edit" && provider) {
      setName(provider.name);
      setProviderType(provider.provider_type);
      setBaseUrl(provider.base_url);
      setApiKey("");
      setExtraEnv(provider.extra_env || "{}");
      setNotes(provider.notes || "");
      // Show advanced if extra_env has content
      try {
        const parsed = JSON.parse(provider.extra_env || "{}");
        setShowAdvanced(Object.keys(parsed).length > 0);
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
      setError(t("providerForm.nameRequired"));
      return;
    }

    // Validate extra_env JSON
    try {
      JSON.parse(extraEnv);
    } catch {
      setError(t("providerForm.invalidEnvJson"));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        provider_type: providerType,
        base_url: baseUrl.trim(),
        api_key: apiKey,
        extra_env: extraEnv,
        notes: notes.trim(),
      });
      onOpenChange(false);
    } catch (err) {
      setError(t("providerForm.failedToSave"));
    } finally {
      setSaving(false);
    }
  };

  const isMaskedKey = mode === "edit" && provider?.api_key?.startsWith("***");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[28rem] overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {mode === "edit" ? t("providerForm.editTitle") : t("providerForm.addTitle")}
          </DialogTitle>
          <DialogDescription>
            {mode === "edit"
              ? t("providerForm.editDesc")
              : t("providerForm.addDesc")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 min-w-0">
          <div className="space-y-2">
            <Label htmlFor="provider-name" className="text-xs text-muted-foreground">
              {t("providerForm.name")}
            </Label>
            <Input
              id="provider-name"
              placeholder={t("providerForm.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="provider-type" className="text-xs text-muted-foreground">
              {t("providerForm.providerType")}
            </Label>
            <Select value={providerType} onValueChange={handleTypeChange}>
              <SelectTrigger className="w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_TYPES.map((pt) => (
                  <SelectItem key={pt.value} value={pt.value}>
                    {t(pt.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="provider-base-url" className="text-xs text-muted-foreground">
              {t("providerForm.baseUrl")}
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
              {t("providerForm.apiKey")}
            </Label>
            <Input
              id="provider-api-key"
              type="password"
              placeholder={isMaskedKey ? t("providerForm.apiKeyEditPlaceholder") : t("providerForm.apiKeyPlaceholder")}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-mono text-sm"
            />
          </div>

          {/* Advanced options toggle */}
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            <HugeiconsIcon
              icon={showAdvanced ? ArrowUp01Icon : ArrowDown01Icon}
              className="h-3 w-3"
            />
            {t("providerForm.advancedOptions")}
          </button>

          {showAdvanced && (
            <div className="space-y-4 border-t border-border/50 pt-4">
              <div className="space-y-2">
                <Label htmlFor="provider-extra-env" className="text-xs text-muted-foreground">
                  {t("providerForm.extraEnv")}
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
                <Label htmlFor="provider-notes" className="text-xs text-muted-foreground">
                  {t("providerForm.notes")}
                </Label>
                <Textarea
                  id="provider-notes"
                  placeholder={t("providerForm.notesPlaceholder")}
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
              {t("providerForm.cancel")}
            </Button>
            <Button type="submit" disabled={saving} className="gap-2">
              {saving && (
                <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
              )}
              {saving ? t("providerForm.saving") : mode === "edit" ? t("providerForm.update") : t("providerForm.add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
