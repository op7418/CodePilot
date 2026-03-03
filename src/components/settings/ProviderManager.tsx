"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Loading02Icon,
  PencilEdit01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  ServerStack01Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { ProviderForm } from "./ProviderForm";
import type { ProviderFormData } from "./ProviderForm";
import type { ApiProvider } from "@/types";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import Anthropic from "@lobehub/icons/es/Anthropic";
import OpenRouter from "@lobehub/icons/es/OpenRouter";
import Zhipu from "@lobehub/icons/es/Zhipu";
import Kimi from "@lobehub/icons/es/Kimi";
import Moonshot from "@lobehub/icons/es/Moonshot";
import Minimax from "@lobehub/icons/es/Minimax";
import Aws from "@lobehub/icons/es/Aws";
import Bedrock from "@lobehub/icons/es/Bedrock";
import Google from "@lobehub/icons/es/Google";
import Volcengine from "@lobehub/icons/es/Volcengine";
import Bailian from "@lobehub/icons/es/Bailian";

// ---------------------------------------------------------------------------
// Brand icon resolver
// ---------------------------------------------------------------------------

/** Map a provider name / base_url to a brand icon */
function getProviderIcon(name: string, baseUrl: string): ReactNode {
  const lower = name.toLowerCase();
  const url = baseUrl.toLowerCase();

  if (lower.includes("openrouter")) return <OpenRouter size={18} />;
  if (url.includes("bigmodel.cn") || url.includes("z.ai") || lower.includes("glm") || lower.includes("zhipu") || lower.includes("chatglm"))
    return <Zhipu size={18} />;
  if (url.includes("kimi.com") || lower.includes("kimi")) return <Kimi size={18} />;
  if (url.includes("moonshot") || lower.includes("moonshot")) return <Moonshot size={18} />;
  if (url.includes("minimax") || lower.includes("minimax")) return <Minimax size={18} />;
  if (url.includes("volces.com") || url.includes("volcengine") || lower.includes("volcengine") || lower.includes("火山") || lower.includes("doubao") || lower.includes("豆包"))
    return <Volcengine size={18} />;
  if (url.includes("dashscope") || lower.includes("bailian") || lower.includes("百炼") || lower.includes("aliyun"))
    return <Bailian size={18} />;
  if (lower.includes("bedrock")) return <Bedrock size={18} />;
  if (lower.includes("vertex") || lower.includes("google")) return <Google size={18} />;
  if (lower.includes("aws")) return <Aws size={18} />;
  if (lower.includes("anthropic") || url.includes("anthropic")) return <Anthropic size={18} />;

  return <HugeiconsIcon icon={ServerStack01Icon} className="h-[18px] w-[18px] text-muted-foreground" />;
}

/** Resolve the key field name from extra_env JSON (e.g. ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN) */
function getKeyFieldFromExtraEnv(extraEnv: string): string | null {
  try {
    const parsed = JSON.parse(extraEnv);
    if ("ANTHROPIC_AUTH_TOKEN" in parsed) return "ANTHROPIC_AUTH_TOKEN";
    if ("ANTHROPIC_API_KEY" in parsed) return "ANTHROPIC_API_KEY";
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// Quick-add preset definitions
// ---------------------------------------------------------------------------

interface QuickPreset {
  key: string;           // unique key
  name: string;
  description: string;
  descriptionZh: string;
  icon: ReactNode;
  // Pre-filled provider data
  provider_type: string;
  base_url: string;
  extra_env: string;
  // Which fields user must fill
  fields: ("name" | "api_key" | "base_url" | "extra_env" | "model_names")[];
  // Category: 'chat' (default) or 'media'
  category?: "chat" | "media";
}

const QUICK_PRESETS: QuickPreset[] = [
  {
    key: "custom-api",
    name: "Custom API",
    description: "Custom API endpoint — fill in all fields",
    descriptionZh: "自定义 API 端点 — 填写所有信息",
    icon: <HugeiconsIcon icon={Settings02Icon} className="h-[18px] w-[18px] text-muted-foreground" />,
    provider_type: "custom",
    base_url: "",
    extra_env: "{}",
    fields: ["name", "api_key", "base_url", "extra_env"],
  },
  {
    key: "anthropic-thirdparty",
    name: "Anthropic Third-party API",
    description: "Anthropic-compatible API — provide URL and Key",
    descriptionZh: "Anthropic 兼容第三方 API — 填写地址和密钥",
    icon: <Anthropic size={18} />,
    provider_type: "anthropic",
    base_url: "",
    extra_env: '{"ANTHROPIC_API_KEY":""}',
    fields: ["name", "api_key", "base_url", "model_names"],
  },
  {
    key: "anthropic-official",
    name: "Anthropic",
    description: "Official Anthropic API",
    descriptionZh: "Anthropic 官方 API",
    icon: <Anthropic size={18} />,
    provider_type: "anthropic",
    base_url: "https://api.anthropic.com",
    extra_env: "{}",
    fields: ["api_key"],
  },
  {
    key: "openrouter",
    name: "OpenRouter",
    description: "Use OpenRouter to access multiple models",
    descriptionZh: "通过 OpenRouter 访问多种模型",
    icon: <OpenRouter size={18} />,
    provider_type: "openrouter",
    base_url: "https://openrouter.ai/api",
    extra_env: '{"ANTHROPIC_API_KEY":""}',
    fields: ["api_key"],
  },
  {
    key: "glm-cn",
    name: "GLM (CN)",
    description: "Zhipu GLM Code Plan — China region",
    descriptionZh: "智谱 GLM 编程套餐 — 中国区",
    icon: <Zhipu size={18} />,
    provider_type: "custom",
    base_url: "https://open.bigmodel.cn/api/anthropic",
    extra_env: '{"API_TIMEOUT_MS":"3000000","ANTHROPIC_API_KEY":""}',
    fields: ["api_key"],
  },
  {
    key: "glm-global",
    name: "GLM (Global)",
    description: "Zhipu GLM Code Plan — Global region",
    descriptionZh: "智谱 GLM 编程套餐 — 国际区",
    icon: <Zhipu size={18} />,
    provider_type: "custom",
    base_url: "https://api.z.ai/api/anthropic",
    extra_env: '{"API_TIMEOUT_MS":"3000000","ANTHROPIC_API_KEY":""}',
    fields: ["api_key"],
  },
  {
    key: "kimi",
    name: "Kimi Coding Plan",
    description: "Kimi Coding Plan API",
    descriptionZh: "Kimi 编程计划 API",
    icon: <Kimi size={18} />,
    provider_type: "custom",
    base_url: "https://api.kimi.com/coding/",
    extra_env: '{"ANTHROPIC_AUTH_TOKEN":""}',
    fields: ["api_key"],
  },
  {
    key: "moonshot",
    name: "Moonshot",
    description: "Moonshot AI API",
    descriptionZh: "月之暗面 API",
    icon: <Moonshot size={18} />,
    provider_type: "custom",
    base_url: "https://api.moonshot.cn/anthropic",
    extra_env: '{"ANTHROPIC_API_KEY":""}',
    fields: ["api_key"],
  },
  {
    key: "minimax-cn",
    name: "MiniMax (CN)",
    description: "MiniMax Code Plan — China region",
    descriptionZh: "MiniMax 编程套餐 — 中国区",
    icon: <Minimax size={18} />,
    provider_type: "custom",
    base_url: "https://api.minimaxi.com/anthropic",
    extra_env: '{"API_TIMEOUT_MS":"3000000","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1","ANTHROPIC_API_KEY":""}',
    fields: ["api_key"],
  },
  {
    key: "minimax-global",
    name: "MiniMax (Global)",
    description: "MiniMax Code Plan — Global region",
    descriptionZh: "MiniMax 编程套餐 — 国际区",
    icon: <Minimax size={18} />,
    provider_type: "custom",
    base_url: "https://api.minimax.io/anthropic",
    extra_env: '{"API_TIMEOUT_MS":"3000000","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1","ANTHROPIC_API_KEY":""}',
    fields: ["api_key"],
  },
  {
    key: "volcengine",
    name: "Volcengine Ark",
    description: "Volcengine Ark Coding Plan — Doubao, GLM, DeepSeek, Kimi",
    descriptionZh: "字节火山方舟 Coding Plan — 豆包、GLM、DeepSeek、Kimi",
    icon: <Volcengine size={18} />,
    provider_type: "custom",
    base_url: "https://ark.cn-beijing.volces.com/api/coding",
    extra_env: '{"ANTHROPIC_AUTH_TOKEN":""}',
    fields: ["api_key", "model_names"],
  },
  {
    key: "bailian",
    name: "Aliyun Bailian",
    description: "Aliyun Bailian Coding Plan — Qwen, GLM, Kimi, MiniMax",
    descriptionZh: "阿里云百炼 Coding Plan — 通义千问、GLM、Kimi、MiniMax",
    icon: <Bailian size={18} />,
    provider_type: "custom",
    base_url: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    extra_env: '{"ANTHROPIC_AUTH_TOKEN":""}',
    fields: ["api_key"],
  },
  {
    key: "bedrock",
    name: "AWS Bedrock",
    description: "Amazon Bedrock — requires AWS credentials",
    descriptionZh: "Amazon Bedrock — 需要 AWS 凭证",
    icon: <Bedrock size={18} />,
    provider_type: "bedrock",
    base_url: "",
    extra_env: '{"CLAUDE_CODE_USE_BEDROCK":"1","AWS_REGION":"us-east-1","CLAUDE_CODE_SKIP_BEDROCK_AUTH":"1"}',
    fields: ["extra_env"],
  },
  {
    key: "vertex",
    name: "Google Vertex",
    description: "Google Vertex AI — requires GCP credentials",
    descriptionZh: "Google Vertex AI — 需要 GCP 凭证",
    icon: <Google size={18} />,
    provider_type: "vertex",
    base_url: "",
    extra_env: '{"CLAUDE_CODE_USE_VERTEX":"1","CLOUD_ML_REGION":"us-east5","CLAUDE_CODE_SKIP_VERTEX_AUTH":"1"}',
    fields: ["extra_env"],
  },
  {
    key: "litellm",
    name: "LiteLLM",
    description: "LiteLLM proxy — local or remote",
    descriptionZh: "LiteLLM 代理 — 本地或远程",
    icon: <HugeiconsIcon icon={ServerStack01Icon} className="h-[18px] w-[18px] text-muted-foreground" />,
    provider_type: "custom",
    base_url: "http://localhost:4000",
    extra_env: "{}",
    fields: ["api_key", "base_url"],
  },
  {
    key: "gemini-image-thirdparty",
    name: "Gemini Image Third-party API",
    description: "Gemini-compatible image API — provide URL and Key",
    descriptionZh: "Gemini 兼容第三方图片 API — 填写地址和密钥",
    icon: <Google size={18} />,
    provider_type: "gemini-image",
    base_url: "",
    extra_env: '{"GEMINI_API_KEY":""}',
    fields: ["api_key", "base_url", "model_names"],
    category: "media",
  },
  {
    key: "gemini-image",
    name: "Google Gemini (Image)",
    description: "Nano Banana Pro — AI image generation by Google Gemini",
    descriptionZh: "Nano Banana Pro — Google Gemini AI 图片生成",
    icon: <Google size={18} />,
    provider_type: "gemini-image",
    base_url: "https://generativelanguage.googleapis.com/v1beta",
    extra_env: '{"GEMINI_API_KEY":""}',
    fields: ["api_key"],
    category: "media",
  },
];

const GEMINI_IMAGE_MODELS = [
  { value: 'gemini-3.1-flash-image-preview', label: 'Nano Banana 2' },
  { value: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro' },
  { value: 'gemini-2.5-flash-image', label: 'Nano Banana' },
];

const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

function getGeminiImageModel(provider: ApiProvider): string {
  try {
    const env = JSON.parse(provider.extra_env || '{}');
    return env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL;
  } catch {
    return DEFAULT_GEMINI_IMAGE_MODEL;
  }
}

// ---------------------------------------------------------------------------
// Preset connect dialog
// ---------------------------------------------------------------------------

function PresetConnectDialog({
  preset,
  open,
  onOpenChange,
  onAdd,
}: {
  preset: QuickPreset | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (data: ProviderFormData) => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [name, setName] = useState("");
  const [extraEnv, setExtraEnv] = useState("{}");
  const [modelName, setModelName] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { t } = useTranslation();
  const isZh = t('nav.chats') === '对话';

  // Reset form when dialog opens with a new preset
  useEffect(() => {
    if (!open || !preset) return;
    setApiKey("");
    setBaseUrl(preset.base_url);
    setName(preset.name);
    setExtraEnv(preset.extra_env);
    setModelName("");
    setError(null);
    setSaving(false);
    setShowAdvanced(false);
  }, [open, preset]);

  if (!preset) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Inject key into extra_env if needed
    let finalExtraEnv = extraEnv;
    const keyField = getKeyFieldFromExtraEnv(preset.extra_env);
    if (keyField && apiKey) {
      try {
        const envObj = JSON.parse(finalExtraEnv);
        envObj[keyField] = apiKey;
        finalExtraEnv = JSON.stringify(envObj);
      } catch { /* use as-is */ }
    }

    // Inject model name into extra_env if model_names field is used
    if (preset.fields.includes("model_names") && modelName.trim()) {
      try {
        const envObj = JSON.parse(finalExtraEnv);
        const modelKey = preset.provider_type === "gemini-image" ? "GEMINI_IMAGE_MODEL" : "ANTHROPIC_MODEL";
        envObj[modelKey] = modelName.trim();
        finalExtraEnv = JSON.stringify(envObj);
      } catch { /* use as-is */ }
    }

    // Validate extra_env JSON
    try {
      JSON.parse(finalExtraEnv);
    } catch {
      setError("Extra environment variables must be valid JSON");
      return;
    }

    setSaving(true);
    try {
      await onAdd({
        name: name.trim() || preset.name,
        provider_type: preset.provider_type,
        base_url: baseUrl.trim(),
        api_key: keyField ? "" : apiKey,
        extra_env: finalExtraEnv,
        notes: "",
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add provider");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[28rem] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            {preset.icon}
            {t('provider.connect')} {preset.name}
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

          {/* API Key */}
          {preset.fields.includes("api_key") && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">API Key</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="text-sm font-mono"
                autoFocus
              />
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
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                <HugeiconsIcon
                  icon={showAdvanced ? ArrowUp01Icon : ArrowDown01Icon}
                  className="h-3 w-3"
                />
                {t('provider.advancedOptions')}
              </button>
              {showAdvanced && (
                <div className="space-y-2 border-t border-border/50 pt-3">
                  <Label className="text-xs text-muted-foreground">{t('provider.extraEnvVars')} (JSON)</Label>
                  <Textarea
                    value={extraEnv}
                    onChange={(e) => setExtraEnv(e.target.value)}
                    className="text-sm font-mono min-h-[60px]"
                    rows={3}
                  />
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
              {saving && <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />}
              {saving ? t('provider.saving') : t('provider.connect')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
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

  // Edit dialog state (reuse existing ProviderForm for full editing)
  const [formOpen, setFormOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ApiProvider | null>(null);

  // Preset connect dialog state
  const [connectPreset, setConnectPreset] = useState<QuickPreset | null>(null);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<ApiProvider | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  const handleEdit = (provider: ApiProvider) => {
    setEditingProvider(provider);
    setFormOpen(true);
  };

  const handleEditSave = async (data: ProviderFormData) => {
    if (!editingProvider) return;
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
    setProviders((prev) => prev.map((p) => (p.id === editingProvider.id ? result.provider : p)));
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
    setProviders((prev) => [...prev, result.provider]);
    window.dispatchEvent(new Event("provider-changed"));
  };

  const handleOpenPresetDialog = (preset: QuickPreset) => {
    setConnectPreset(preset);
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

  const handleImageModelChange = useCallback(async (provider: ApiProvider, model: string) => {
    try {
      const env = JSON.parse(provider.extra_env || '{}');
      env.GEMINI_IMAGE_MODEL = model;
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
  }, []);

  const sorted = [...providers].sort((a, b) => a.sort_order - b.sort_order);

  return (
    <div className="space-y-6">
      {/* Error */}
      {error && (
        <div className="rounded-md bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
          <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
          <p className="text-sm">{t('common.loading')}</p>
        </div>
      )}

      {/* ─── Section 1: Connected Providers ─── */}
      {!loading && (
        <div className="rounded-lg border border-border/50 p-4 space-y-2">
          <h3 className="text-sm font-medium mb-1">{t('provider.connectedProviders')}</h3>

          {/* Claude Code default config */}
          <div className="border-b border-border/30 pb-2">
            <div className="flex items-center gap-3 py-2.5 px-1">
              <div className="shrink-0 w-[22px] flex justify-center">
                <Anthropic size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Claude Code</span>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    {t('provider.default')}
                  </Badge>
                  {Object.keys(envDetected).length > 0 && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-green-600 dark:text-green-400 border-green-500/30">
                      ENV
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground ml-[34px] leading-relaxed">
              {t('provider.ccSwitchHint')}
            </p>
          </div>

          {/* Connected provider list */}
          {sorted.length > 0 ? (
            sorted.map((provider) => (
              <div
                key={provider.id}
                className="py-2.5 px-1 border-b border-border/30 last:border-b-0"
              >
                <div className="flex items-center gap-3">
                  <div className="shrink-0 w-[22px] flex justify-center">
                    {getProviderIcon(provider.name, provider.base_url)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{provider.name}</span>
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        {provider.api_key ? "API Key" : t('provider.configured')}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Edit"
                      onClick={() => handleEdit(provider)}
                    >
                      <HugeiconsIcon icon={PencilEdit01Icon} className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleteTarget(provider)}
                    >
                      {t('provider.disconnect')}
                    </Button>
                  </div>
                </div>
                {/* Gemini Image model selector — capsule buttons */}
                {provider.provider_type === 'gemini-image' && (
                  <div className="ml-[34px] mt-2 flex items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground mr-1">{isZh ? '模型' : 'Model'}:</span>
                    {GEMINI_IMAGE_MODELS.map((m) => {
                      const isActive = getGeminiImageModel(provider) === m.value;
                      return (
                        <button
                          key={m.value}
                          type="button"
                          onClick={() => handleImageModelChange(provider, m.value)}
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium border transition-all ${
                            isActive
                              ? 'bg-primary/10 text-primary border-primary/30'
                              : 'text-muted-foreground border-border/60 hover:text-foreground hover:border-foreground/30 hover:bg-accent/50'
                          }`}
                        >
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))
          ) : (
            Object.keys(envDetected).length === 0 && (
              <p className="text-xs text-muted-foreground py-4 text-center">
                {t('provider.noConnected')}
              </p>
            )
          )}
        </div>
      )}

      {/* ─── Section 2: Add Provider (Quick Presets) ─── */}
      {!loading && (
        <div className="rounded-lg border border-border/50 p-4">
          <h3 className="text-sm font-medium mb-1">{t('provider.addProviderSection')}</h3>
          <p className="text-xs text-muted-foreground mb-3">
            {t('provider.addProviderDesc')}
          </p>

          {/* Chat Providers */}
          <div className="mb-1">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              {t('provider.chatProviders')}
            </h4>
            {QUICK_PRESETS.filter((p) => p.category !== "media").map((preset) => (
              <div
                key={preset.key}
                className="flex items-center gap-3 py-2.5 px-1 border-b border-border/30 last:border-b-0"
              >
                <div className="shrink-0 w-[22px] flex justify-center">{preset.icon}</div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{preset.name}</span>
                  <p className="text-xs text-muted-foreground truncate">
                    {isZh ? preset.descriptionZh : preset.description}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="xs"
                  className="shrink-0 gap-1"
                  onClick={() => handleOpenPresetDialog(preset)}
                >
                  + {t('provider.connect')}
                </Button>
              </div>
            ))}
          </div>

          {/* Media Providers */}
          <div className="mt-4 pt-3 border-t border-border/30">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              {t('provider.mediaProviders')}
            </h4>
            {QUICK_PRESETS.filter((p) => p.category === "media").map((preset) => (
              <div
                key={preset.key}
                className="flex items-center gap-3 py-2.5 px-1 border-b border-border/30 last:border-b-0"
              >
                <div className="shrink-0 w-[22px] flex justify-center">{preset.icon}</div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{preset.name}</span>
                  <p className="text-xs text-muted-foreground truncate">
                    {isZh ? preset.descriptionZh : preset.description}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="xs"
                  className="shrink-0 gap-1"
                  onClick={() => handleOpenPresetDialog(preset)}
                >
                  + {t('provider.connect')}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Edit dialog (full form for editing existing providers) */}
      <ProviderForm
        open={formOpen}
        onOpenChange={setFormOpen}
        mode="edit"
        provider={editingProvider}
        onSave={handleEditSave}
        initialPreset={null}
      />

      {/* Preset connect dialog */}
      <PresetConnectDialog
        preset={connectPreset}
        open={connectDialogOpen}
        onOpenChange={setConnectDialogOpen}
        onAdd={handlePresetAdd}
      />

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
