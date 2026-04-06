"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { SpinnerGap, CaretDown, CaretUp } from "@/components/ui/icon";
import type { ProviderFormData } from "./ProviderForm";
import type { QuickPreset } from "./provider-presets";
import { QUICK_PRESETS } from "./provider-presets";
import type { ApiProvider } from "@/types";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";

/** Infer auth style from base URL by fuzzy-matching VENDOR_PRESETS hostnames */
function inferAuthStyleFromUrl(url: string): "api_key" | "auth_token" | null {
  if (!url) return null;
  const urlLower = url.toLowerCase();
  for (const p of QUICK_PRESETS) {
    if (!p.base_url) continue;
    try {
      const presetHost = new URL(p.base_url).hostname;
      if (urlLower.includes(presetHost)) {
        // Map preset's known auth style
        const env = JSON.parse(p.extra_env || '{}');
        if ('ANTHROPIC_AUTH_TOKEN' in env) return 'auth_token';
        return 'api_key';
      }
    } catch { /* skip invalid URLs */ }
  }
  return null;
}

interface PresetConnectDialogProps {
  preset: QuickPreset | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: ProviderFormData) => Promise<void>;
  /** When set, dialog operates in edit mode (pre-fills from existing provider) */
  editProvider?: ApiProvider | null;
}

export function PresetConnectDialog({
  preset,
  open,
  onOpenChange,
  onSave,
  editProvider,
}: PresetConnectDialogProps) {
  const isEdit = !!editProvider;
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [name, setName] = useState("");
  const [extraEnv, setExtraEnv] = useState("{}");
  const [modelName, setModelName] = useState("");
  // Auth style for anthropic-thirdparty: 'api_key' or 'auth_token'
  const [authStyle, setAuthStyle] = useState<"api_key" | "auth_token">("api_key");
  // Track the initial auth style to detect changes
  const [initialAuthStyle, setInitialAuthStyle] = useState<"api_key" | "auth_token">("api_key");
  // Edit-mode advanced fields
  const [headersJson, setHeadersJson] = useState("{}");
  const [envOverridesJson, setEnvOverridesJson] = useState("");
  const [notes, setNotes] = useState("");
  // Model mapping fields (sonnet/opus/haiku → actual API model IDs)
  const [mapSonnet, setMapSonnet] = useState("");
  const [mapOpus, setMapOpus] = useState("");
  const [mapHaiku, setMapHaiku] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { t } = useTranslation();
  const isZh = t('nav.chats') === '对话';

  // Reset form when dialog opens
  useEffect(() => {
    if (!open || !preset) return;
    setError(null);
    setSaving(false);

    if (isEdit && editProvider) {
      // Edit mode — pre-fill from existing provider
      setName(editProvider.name);
      setBaseUrl(editProvider.base_url);
      setExtraEnv(editProvider.extra_env || preset.extra_env);
      // Detect auth style from existing extra_env
      let detected: 'auth_token' | 'api_key' = 'api_key';
      try {
        const env = JSON.parse(editProvider.extra_env || "{}");
        detected = "ANTHROPIC_AUTH_TOKEN" in env ? "auth_token" : "api_key";
      } catch { /* keep default */ }
      setAuthStyle(detected);
      setInitialAuthStyle(detected);
      // If api_key field isn't shown and stored key is empty, use preset default
      // (e.g. Ollama needs ANTHROPIC_AUTH_TOKEN='ollama' without user input)
      if (!preset.fields.includes("api_key") && !editProvider.api_key) {
        const presetEnv = (() => { try { return JSON.parse(preset.extra_env || '{}'); } catch { return {}; } })();
        const defaultToken = detected === 'auth_token'
          ? (presetEnv['ANTHROPIC_AUTH_TOKEN'] || '')
          : (presetEnv['ANTHROPIC_API_KEY'] || '');
        setApiKey(defaultToken);
      } else {
        setApiKey(editProvider.api_key || "");
      }
      // Pre-fill advanced fields
      setHeadersJson(editProvider.headers_json || "{}");
      setEnvOverridesJson(editProvider.env_overrides_json || "");
      setNotes(editProvider.notes || "");
      // Pre-fill model name from role_models_json
      try {
        const rm = JSON.parse(editProvider.role_models_json || "{}");
        setModelName(rm.default || "");
        setMapSonnet(rm.sonnet || "");
        setMapOpus(rm.opus || "");
        setMapHaiku(rm.haiku || "");
      } catch {
        setModelName("");
        setMapSonnet("");
        setMapOpus("");
        setMapHaiku("");
      }
      // Auto-expand advanced if there's meaningful data beyond preset defaults
      const hasModelMapping = (() => {
        try {
          const rm = JSON.parse(editProvider.role_models_json || "{}");
          return !!(rm.sonnet || rm.opus || rm.haiku);
        } catch { return false; }
      })();
      const hasExtraEnvBeyondAuth = (() => {
        try {
          const env = JSON.parse(editProvider.extra_env || "{}");
          const meaningful = Object.keys(env).filter(k =>
            k !== "ANTHROPIC_API_KEY" && k !== "ANTHROPIC_AUTH_TOKEN"
          );
          return meaningful.length > 0;
        } catch { return false; }
      })();
      const hasHeaders = editProvider.headers_json && editProvider.headers_json !== "{}";
      const hasEnvOverrides = !!editProvider.env_overrides_json;
      const hasNotes = !!editProvider.notes;
      setShowAdvanced(hasModelMapping || hasExtraEnvBeyondAuth || !!hasHeaders || hasEnvOverrides || hasNotes);
    } else {
      // Create mode — reset to preset defaults
      setBaseUrl(preset.base_url);
      setName(preset.name);
      setExtraEnv(preset.extra_env);
      setModelName("");
      // Auto-detect auth style from preset's extra_env
      const presetEnv = (() => { try { return JSON.parse(preset.extra_env || '{}'); } catch { return {}; } })();
      const detectedStyle = 'ANTHROPIC_AUTH_TOKEN' in presetEnv ? 'auth_token' as const : 'api_key' as const;
      // If preset doesn't expose api_key field, pre-fill from extra_env default
      // (e.g. Ollama needs ANTHROPIC_AUTH_TOKEN='ollama' without user input)
      if (!preset.fields.includes("api_key")) {
        const defaultToken = detectedStyle === 'auth_token'
          ? (presetEnv['ANTHROPIC_AUTH_TOKEN'] || '')
          : (presetEnv['ANTHROPIC_API_KEY'] || '');
        setApiKey(defaultToken);
      } else {
        setApiKey("");
      }
      setAuthStyle(detectedStyle);
      setInitialAuthStyle(detectedStyle);
      setMapSonnet("");
      setMapOpus("");
      setMapHaiku("");
      setHeadersJson("{}");
      setEnvOverridesJson("");
      setNotes("");
      setShowAdvanced(false);
    }
  }, [open, preset, isEdit, editProvider]);

  if (!preset) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // If auth style changed in edit mode, require a new key
    if (isEdit && authStyle !== initialAuthStyle && (!apiKey || apiKey.startsWith("***"))) {
      setError(isZh
        ? '切换认证方式后需要重新输入密钥'
        : 'Please re-enter the key after changing auth style');
      return;
    }

    // For anthropic-thirdparty, inject the correct auth key into extra_env
    // while preserving any other user-specified env vars (e.g. API_TIMEOUT_MS)
    let finalExtraEnv = extraEnv;
    if (preset.key === "anthropic-thirdparty") {
      try {
        const parsed = JSON.parse(extraEnv || "{}");
        // Remove both auth keys, then set the correct one
        delete parsed["ANTHROPIC_API_KEY"];
        delete parsed["ANTHROPIC_AUTH_TOKEN"];
        if (authStyle === "auth_token") {
          parsed["ANTHROPIC_AUTH_TOKEN"] = "";
        } else {
          parsed["ANTHROPIC_API_KEY"] = "";
        }
        finalExtraEnv = JSON.stringify(parsed);
      } catch {
        // If parse fails, fall back to simple replacement
        finalExtraEnv = authStyle === "auth_token"
          ? '{"ANTHROPIC_AUTH_TOKEN":""}'
          : '{"ANTHROPIC_API_KEY":""}';
      }
    }
    // In edit mode, preserve existing role_models_json unless the user modifies mapping fields
    let roleModelsJson = (isEdit && editProvider?.role_models_json) ? editProvider.role_models_json : "{}";

    // Model mapping (sonnet/opus/haiku → actual API model IDs)
    // Merge into existing roleModels to preserve roles not shown in this preset.
    // If the preset exposes these fields and user cleared them all, remove those keys.
    if (preset.fields.includes("model_mapping")) {
      const hasAny = mapSonnet.trim() || mapOpus.trim() || mapHaiku.trim();
      if (hasAny) {
        // If user fills any, all 3 are required
        if (!mapSonnet.trim() || !mapOpus.trim() || !mapHaiku.trim()) {
          setError(isZh
            ? '模型映射需要同时填写 Sonnet、Opus、Haiku 三个模型名称'
            : 'Model mapping requires all 3 model names (Sonnet, Opus, Haiku)');
          return;
        }
        const existing = (() => { try { return JSON.parse(roleModelsJson); } catch { return {}; } })();
        roleModelsJson = JSON.stringify({
          ...existing,
          sonnet: mapSonnet.trim(),
          opus: mapOpus.trim(),
          haiku: mapHaiku.trim(),
        });
      } else {
        // All cleared — remove these keys from existing
        const existing = (() => { try { return JSON.parse(roleModelsJson); } catch { return {}; } })();
        delete existing.sonnet;
        delete existing.opus;
        delete existing.haiku;
        roleModelsJson = JSON.stringify(existing);
      }
    }

    // Inject model name into role_models_json — merge, don't replace.
    // If the preset exposes model_names and user cleared it, remove the default key.
    if (preset.fields.includes("model_names")) {
      const existing = (() => { try { return JSON.parse(roleModelsJson); } catch { return {}; } })();
      if (modelName.trim()) {
        roleModelsJson = JSON.stringify({ ...existing, default: modelName.trim() });
      } else {
        delete existing.default;
        roleModelsJson = JSON.stringify(existing);
      }
    }

    // Validate JSON fields
    for (const [label, val] of [
      ["Extra environment variables", finalExtraEnv],
      ...(isEdit ? [["Headers", headersJson]] : []),
    ] as const) {
      if (val && val.trim()) {
        try { JSON.parse(val); } catch {
          setError(`${label} must be valid JSON`);
          return;
        }
      }
    }

    setSaving(true);
    try {
      await onSave({
        name: name.trim() || preset.name,
        provider_type: preset.provider_type,
        protocol: preset.protocol,
        base_url: baseUrl.trim(),
        api_key: apiKey,
        extra_env: finalExtraEnv,
        role_models_json: roleModelsJson,
        headers_json: isEdit ? headersJson.trim() || "{}" : undefined,
        env_overrides_json: isEdit ? envOverridesJson.trim() || "" : undefined,
        notes: isEdit ? notes.trim() : "",
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : (isEdit ? "Failed to update provider" : "Failed to add provider"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[28rem]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            {preset.icon}
            {isEdit ? t('provider.editProvider') : t('provider.connect')} {preset.name}
          </DialogTitle>
          <DialogDescription>
            {isZh ? preset.descriptionZh : preset.description}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 min-w-0">
          {/* Name field — custom/thirdparty */}
          {preset.fields.includes("name") && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t('provider.name')}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={preset.name}
                className="text-sm"
              />
            </div>
          )}

          {/* Base URL */}
          {preset.fields.includes("base_url") && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t('provider.baseUrl')}</Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com"
                className="text-sm font-mono"
              />
            </div>
          )}

          {/* API Key with optional auth style select */}
          {preset.fields.includes("api_key") && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">
                {preset.key === "anthropic-thirdparty"
                  ? (authStyle === "auth_token" ? "Auth Token" : "API Key")
                  : "API Key"}
              </Label>
              <div className="flex gap-2">
                {preset.key === "anthropic-thirdparty" && (
                  <Select
                    value={authStyle}
                    onValueChange={(v) => {
                      const newStyle = v as "api_key" | "auth_token";
                      setAuthStyle(newStyle);
                      if (isEdit && editProvider?.api_key) {
                        if (newStyle !== initialAuthStyle) {
                          setApiKey("");
                        } else {
                          setApiKey(editProvider.api_key);
                        }
                      }
                    }}
                  >
                    <SelectTrigger className="w-[130px] shrink-0 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="api_key">API Key</SelectItem>
                      <SelectItem value="auth_token">Auth Token</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={authStyle === "auth_token" ? "token-..." : "sk-..."}
                  className="text-sm font-mono flex-1"
                  autoFocus
                />
              </div>
              {/* Show auth style badge for non-thirdparty presets (auto-determined) */}
              {preset.key !== "anthropic-thirdparty" && (
                <p className="text-[11px] text-muted-foreground">
                  Auth: <span className="font-mono">{authStyle === "auth_token" ? "Authorization: Bearer ..." : "X-Api-Key: ..."}</span>
                </p>
              )}
              {/* Smart recommend for thirdparty based on URL */}
              {preset.key === "anthropic-thirdparty" && baseUrl && (() => {
                const inferred = inferAuthStyleFromUrl(baseUrl);
                return inferred && inferred !== authStyle ? (
                  <p className="text-[11px] text-amber-500">
                    {isZh
                      ? `检测到此 URL 通常使用 ${inferred === 'auth_token' ? 'Auth Token' : 'API Key'} 认证方式`
                      : `This URL typically uses ${inferred === 'auth_token' ? 'Auth Token' : 'API Key'} authentication`}
                    {' '}
                    <Button
                      variant="link"
                      className="h-auto p-0 text-[11px] text-amber-500 underline hover:no-underline"
                      onClick={() => setAuthStyle(inferred)}
                    >
                      {isZh ? '切换' : 'Switch'}
                    </Button>
                  </p>
                ) : null;
              })()}
            </div>
          )}

          {/* Model name — for providers that need user-specified model */}
          {preset.fields.includes("model_names") && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t('provider.modelName' as TranslationKey)}</Label>
              <Input
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="ark-code-latest"
                className="text-sm font-mono"
              />
              <p className="text-[11px] text-muted-foreground">
                {isZh
                  ? '在服务商控制台配置的模型名称，如 ark-code-latest、doubao-seed-2.0-code'
                  : 'Model name configured in provider console, e.g. ark-code-latest'}
              </p>
            </div>
          )}

          {/* Extra env — bedrock/vertex/custom always shown */}
          {preset.fields.includes("extra_env") && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t('provider.extraEnvVars')} (JSON)</Label>
              <Textarea
                value={extraEnv}
                onChange={(e) => setExtraEnv(e.target.value)}
                className="text-sm font-mono min-h-[80px]"
                rows={3}
              />
            </div>
          )}

          {/* Advanced options — for presets that don't normally show extra_env */}
          {!preset.fields.includes("extra_env") && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground h-auto px-0 py-0"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                {showAdvanced ? <CaretUp size={12} /> : <CaretDown size={12} />}
                {t('provider.advancedOptions')}
              </Button>
              {showAdvanced && (
                <div className="space-y-4 border-t border-border/50 pt-3">
                  {/* Model mapping (sonnet/opus/haiku → API model IDs) */}
                  {preset.fields.includes("model_mapping") && (
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">
                        {isZh ? '模型名称映射' : 'Model Name Mapping'}
                      </Label>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        {isZh
                          ? '如果服务商使用不同的模型名称（如 claude-sonnet-4-6），在此映射。留空则使用默认名称（sonnet / opus / haiku）。'
                          : 'Map model names if the provider uses different IDs (e.g. claude-sonnet-4-6). Leave empty to use defaults (sonnet / opus / haiku).'}
                      </p>
                      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center">
                        <span className="text-xs text-muted-foreground text-right">Sonnet</span>
                        <Input
                          value={mapSonnet}
                          onChange={(e) => setMapSonnet(e.target.value)}
                          placeholder="claude-sonnet-4-6"
                          className="text-sm font-mono h-8"
                        />
                        <span className="text-xs text-muted-foreground text-right">Opus</span>
                        <Input
                          value={mapOpus}
                          onChange={(e) => setMapOpus(e.target.value)}
                          placeholder="claude-opus-4-6"
                          className="text-sm font-mono h-8"
                        />
                        <span className="text-xs text-muted-foreground text-right">Haiku</span>
                        <Input
                          value={mapHaiku}
                          onChange={(e) => setMapHaiku(e.target.value)}
                          placeholder="claude-haiku-4-5-20251001"
                          className="text-sm font-mono h-8"
                        />
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">{t('provider.extraEnvVars')} (JSON)</Label>
                    <Textarea
                      value={extraEnv}
                      onChange={(e) => setExtraEnv(e.target.value)}
                      className="text-sm font-mono min-h-[60px]"
                      rows={3}
                    />
                  </div>

                  {/* Edit-mode only: headers, env overrides, notes */}
                  {isEdit && (
                    <>
                      <div className="space-y-2">
                        <Label className="text-xs text-muted-foreground">Headers (JSON)</Label>
                        <Textarea
                          value={headersJson}
                          onChange={(e) => setHeadersJson(e.target.value)}
                          placeholder='{"X-Custom-Header": "value"}'
                          className="text-sm font-mono min-h-[60px]"
                          rows={2}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs text-muted-foreground">Env Overrides (JSON)</Label>
                        <Textarea
                          value={envOverridesJson}
                          onChange={(e) => setEnvOverridesJson(e.target.value)}
                          placeholder='{"CLAUDE_CODE_USE_BEDROCK": "1"}'
                          className="text-sm font-mono min-h-[60px]"
                          rows={2}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs text-muted-foreground">{t('provider.notes')}</Label>
                        <Textarea
                          value={notes}
                          onChange={(e) => setNotes(e.target.value)}
                          placeholder={t('provider.notesPlaceholder')}
                          className="text-sm"
                          rows={2}
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

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
              {saving && <SpinnerGap size={16} className="animate-spin" />}
              {saving ? t('provider.saving') : isEdit ? t('provider.update') : t('provider.connect')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
