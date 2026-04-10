"use client";

import type { ReactNode } from "react";
import { HardDrives } from "@/components/ui/icon";
import type { ApiProvider } from "@/types";
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
import XiaomiMiMo from "@lobehub/icons/es/XiaomiMiMo";
import Ollama from "@lobehub/icons/es/Ollama";

// ---------------------------------------------------------------------------
// Brand icon resolver
// ---------------------------------------------------------------------------

/** Map a provider name / base_url to a brand icon */
export function getProviderIcon(name: string, baseUrl: string): ReactNode {
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
  if (url.includes("xiaomimimo") || lower.includes("mimo") || lower.includes("小米"))
    return <XiaomiMiMo size={18} />;
  if (url.includes("11434") || lower.includes("ollama")) return <Ollama size={18} />;
  if (lower.includes("bedrock")) return <Bedrock size={18} />;
  if (lower.includes("vertex") || lower.includes("google")) return <Google size={18} />;
  if (lower.includes("aws")) return <Aws size={18} />;
  if (lower.includes("anthropic") || url.includes("anthropic")) return <Anthropic size={18} />;

  return <HardDrives size={18} className="text-muted-foreground" />;
}

// ---------------------------------------------------------------------------
// Quick-add preset definitions
// ---------------------------------------------------------------------------

export interface QuickPreset {
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

export const QUICK_PRESETS: QuickPreset[] = [
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
    extra_env: '{"ANTHROPIC_API_KEY":""}',
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
    extra_env: '{"API_TIMEOUT_MS":"3000000","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1","ANTHROPIC_AUTH_TOKEN":""}',
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
    extra_env: '{"API_TIMEOUT_MS":"3000000","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1","ANTHROPIC_AUTH_TOKEN":""}',
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
    key: "xiaomi-mimo",
    name: "Xiaomi MiMo",
    description: "Xiaomi MiMo Pay-as-you-go API — MiMo-V2-Pro",
    descriptionZh: "小米 MiMo 按量付费 — MiMo-V2-Pro",
    icon: <XiaomiMiMo size={18} />,
    provider_type: "anthropic",
    protocol: "anthropic",
    base_url: "https://api.xiaomimimo.com/anthropic",
    extra_env: '{"ANTHROPIC_AUTH_TOKEN":""}',
    fields: ["api_key"],
  },
  {
    key: "xiaomi-mimo-token-plan",
    name: "Xiaomi MiMo Token Plan",
    description: "Xiaomi MiMo Token Plan subscription — MiMo-V2-Pro",
    descriptionZh: "小米 MiMo Token Plan 订阅套餐 — MiMo-V2-Pro",
    icon: <XiaomiMiMo size={18} />,
    provider_type: "anthropic",
    protocol: "anthropic",
    base_url: "https://token-plan-cn.xiaomimimo.com/anthropic",
    extra_env: '{"ANTHROPIC_AUTH_TOKEN":""}',
    fields: ["api_key"],
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
  // ── Local / self-hosted ──
  {
    key: "ollama",
    name: "Ollama",
    description: "Ollama — run local models with Anthropic-compatible API",
    descriptionZh: "Ollama — 本地运行模型，Anthropic 兼容 API",
    icon: <Ollama size={18} />,
    provider_type: "anthropic",
    protocol: "anthropic",
    base_url: "http://localhost:11434",
    extra_env: '{"ANTHROPIC_AUTH_TOKEN":"ollama","ANTHROPIC_API_KEY":""}',
    fields: ["base_url", "model_names"],
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

// ---------------------------------------------------------------------------
// Gemini image model definitions
// ---------------------------------------------------------------------------

export const GEMINI_IMAGE_MODELS = [
  { value: 'gemini-3.1-flash-image-preview', label: 'Nano Banana 2' },
  { value: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro' },
  { value: 'gemini-2.5-flash-image', label: 'Nano Banana' },
];

export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

export function getGeminiImageModel(provider: ApiProvider): string {
  try {
    const env = JSON.parse(provider.extra_env || '{}');
    return env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL;
  } catch {
    return DEFAULT_GEMINI_IMAGE_MODEL;
  }
}

// ---------------------------------------------------------------------------
// Preset matcher — find which quick preset a provider was created from
// ---------------------------------------------------------------------------

export function findMatchingPreset(provider: ApiProvider): QuickPreset | undefined {
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
  // Custom providers no longer have a matching preset (OpenAI-compatible removed).
  // They are deleted during DB migration; any survivors use the generic edit form.
  return undefined;
}
