"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  SpinnerGap,
  PencilSimple,
  CaretDown,
  CaretUp,
  HardDrives,
  Gear,
} from "@phosphor-icons/react";
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

  return <HardDrives size={18} className="text-muted-foreground" />;
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
  /** Wire protocol — determines how the provider is dispatched at runtime */
  protocol: string;
  base_url: string;
  extra_env: string;
  // Which fields user must fill
  fields: ("name" | "api_key" | "base_url" | "extra_env" | "model_names" | "model_mapping")[];
  // Category: 'chat' (default) or 'media'
  category?: "chat" | "media";
}

const QUICK_PRESETS: QuickPreset[] = [
  // ── Custom endpoints ──
  {
    key: "custom-openai",
    name: "Custom API (OpenAI-compatible)",
    description: "OpenAI-compatible custom endpoint",
    descriptionZh: "自定义 OpenAI 兼容 API 端点",
    icon: <Gear size={18} className="text-muted-foreground" />,
    provider_type: "custom",
    protocol: "openai-compatible",
    base_url: "",
    extra_env: "{}",
    fields: ["name", "api_key", "base_url", "extra_env"],
  },
  // ── Anthropic-compatible services ──
  {
    key: "anthropic-thirdparty",
    name: "Anthropic Third-party API",
    description: "Anthropic-compatible API — provide URL and Key",
    descriptionZh: "Anthropic 兼容第三方 API — 填写地址和密钥",
    icon: <Anthropic size={18} />,
    provider_type: "anthropic",
    protocol: "anthropic",
    base_url: "",
    extra_env: "{}",
    fields: ["name", "api_key", "base_url", "model_mapping"],
  },
  {
    key: "anthropic-official",
    name: "Anthropic",
    description: "Official Anthropic API",
    descriptionZh: "Anthropic 官方 API",
    icon: <Anthropic size={18} />,
    provider_type: "anthropic",
    protocol: "anthropic",
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
    protocol: "openrouter",
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
    provider_type: "anthropic",
    protocol: "anthropic",
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
    provider_type: "anthropic",
    protocol: "anthropic",
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
    provider_type: "anthropic",
    protocol: "anthropic",
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
    provider_type: "anthropic",
    protocol: "anthropic",
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
    provider_type: "anthropic",
    protocol: "anthropic",
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
    provider_type: "anthropic",
    protocol: "anthropic",
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
    provider_type: "anthropic",
    protocol: "anthropic",
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
    provider_type: "anthropic",
    protocol: "anthropic",
    base_url: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    extra_env: '{"ANTHROPIC_API_KEY":""}',
    fields: ["api_key"],
  },
  // ── Cloud platform providers ──
  {
    key: "bedrock",
    name: "AWS Bedrock",
    description: "Amazon Bedrock — requires AWS credentials",
    descriptionZh: "Amazon Bedrock — 需要 AWS 凭证",
    icon: <Bedrock size={18} />,
    provider_type: "bedrock",
    protocol: "bedrock",
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
    protocol: "vertex",
    base_url: "",
    extra_env: '{"CLAUDE_CODE_USE_VERTEX":"1","CLOUD_ML_REGION":"us-east5","CLAUDE_CODE_SKIP_VERTEX_AUTH":"1"}',
    fields: ["extra_env"],
  },
  // ── Proxy / gateway ──
  {
    key: "litellm",
    name: "LiteLLM",
    description: "LiteLLM proxy — local or remote",
    descriptionZh: "LiteLLM 代理 — 本地或远程",
    icon: <HardDrives size={18} className="text-muted-foreground" />,
    provider_type: "anthropic",
    protocol: "anthropic",
    base_url: "http://localhost:4000",
    extra_env: "{}",
    fields: ["api_key", "base_url"],
  },
  // ── Media providers ──
  {
    key: "gemini-image",
    name: "Google Gemini (Image)",
    description: "Nano Banana Pro — AI image generation by Google Gemini",
    descriptionZh: "Nano Banana Pro — Google Gemini AI 图片生成",
    icon: <Google size={18} />,
    provider_type: "gemini-image",
    protocol: "gemini-image",
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
  onSave,
  editProvider,
}: {
  preset: QuickPreset | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: ProviderFormData) => Promise<void>;
  /** When set, dialog operates in edit mode (pre-fills from existing provider) */
  editProvider?: ApiProvider | null;
}) {
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
      setApiKey(editProvider.api_key || "");
      setExtraEnv(editProvider.extra_env || preset.extra_env);
      // Detect auth style from existing extra_env
      try {
        const env = JSON.parse(editProvider.extra_env || "{}");
        const detected = "ANTHROPIC_AUTH_TOKEN" in env ? "auth_token" as const : "api_key" as const;
        setAuthStyle(detected);
        setInitialAuthStyle(detected);
      } catch {
        setAuthStyle("api_key");
        setInitialAuthStyle("api_key");
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
      setApiKey("");
      setBaseUrl(preset.base_url);
      setName(preset.name);
      setExtraEnv(preset.extra_env);
      setModelName("");
      setAuthStyle("api_key");
      setInitialAuthStyle("api_key");
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

    // For anthropic-thirdparty, strip auth key placeholders from extra_env.
    // Auth is handled via the api_key field — storing empty ANTHROPIC_API_KEY /
    // ANTHROPIC_AUTH_TOKEN placeholders in extra_env causes toClaudeCodeEnv()
    // to infer the wrong authStyle and can override freshly-injected credentials.
    let finalExtraEnv = extraEnv;
    if (preset.key === "anthropic-thirdparty") {
      try {
        const parsed = JSON.parse(extraEnv || "{}");
        delete parsed["ANTHROPIC_API_KEY"];
        delete parsed["ANTHROPIC_AUTH_TOKEN"];
        finalExtraEnv = JSON.stringify(parsed);
      } catch {
        finalExtraEnv = "{}";
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
                          // Switching away — clear masked key to force re-entry
                          setApiKey("");
                        } else {
                          // Switching back to original — restore masked key
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
                {showAdvanced ? <CaretUp size={12} /> : <CaretDown size={12} />}
                {t('provider.advancedOptions')}
              </button>
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

// ---------------------------------------------------------------------------
// Preset matcher — find which quick preset a provider was created from
// ---------------------------------------------------------------------------

function findMatchingPreset(provider: ApiProvider): QuickPreset | undefined {
  // Exact base_url match (most specific)
  if (provider.base_url) {
    const match = QUICK_PRESETS.find(p => p.base_url && p.base_url === provider.base_url);
    if (match) return match;
  }
  // Type-based fallback for known types
  if (provider.provider_type === "bedrock") return QUICK_PRESETS.find(p => p.key === "bedrock");
  if (provider.provider_type === "vertex") return QUICK_PRESETS.find(p => p.key === "vertex");
  if (provider.provider_type === "openrouter") return QUICK_PRESETS.find(p => p.key === "openrouter");
  if (provider.provider_type === "gemini-image") return QUICK_PRESETS.find(p => p.key === "gemini-image");
  if (provider.provider_type === "anthropic" && provider.base_url === "https://api.anthropic.com") {
    return QUICK_PRESETS.find(p => p.key === "anthropic-official");
  }
  // Anthropic-type with custom base_url → anthropic-thirdparty
  if (provider.provider_type === "anthropic" && provider.base_url) {
    return QUICK_PRESETS.find(p => p.key === "anthropic-thirdparty");
  }
  // Custom/OpenAI-compatible
  if (provider.provider_type === "custom" || provider.protocol === "openai-compatible") {
    return QUICK_PRESETS.find(p => p.key === "custom-openai");
  }
  return undefined;
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
    // Try to match provider to a quick preset for a cleaner edit experience
    const matchedPreset = findMatchingPreset(provider);
    if (matchedPreset) {
      // Clear stale generic-form state to prevent handleEditSave picking the wrong target
      setEditingProvider(null);
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
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Failed to update provider");
    }
    const result = await res.json();
    setProviders((prev) => prev.map((p) => (p.id === target.id ? result.provider : p)));
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
          <SpinnerGap size={16} className="animate-spin" />
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
                        {provider.api_key
                          ? (provider.extra_env?.includes("ANTHROPIC_AUTH_TOKEN") ? "Auth Token" : "API Key")
                          : t('provider.configured')}
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
                      <PencilSimple size={12} />
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

      {/* Preset connect/edit dialog */}
      <PresetConnectDialog
        preset={connectPreset}
        open={connectDialogOpen}
        onOpenChange={(open) => {
          setConnectDialogOpen(open);
          if (!open) setPresetEditProvider(null);
        }}
        onSave={presetEditProvider ? handleEditSave : handlePresetAdd}
        editProvider={presetEditProvider}
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
