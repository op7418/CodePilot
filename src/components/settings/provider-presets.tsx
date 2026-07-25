"use client";

import type { ReactNode } from "react";
import { HardDrives } from "@/components/ui/icon";
import type { ApiProvider } from "@/types";
import { VENDOR_PRESETS, resolveProviderPresetIdentity } from "@/lib/provider-catalog";
import type { VendorPreset } from "@/lib/provider-catalog";
import { getProviderIconKey, type ProviderIconKey } from "@/lib/provider-icon-rule";
import Anthropic from "@lobehub/icons/es/Anthropic";
import OpenRouter from "@lobehub/icons/es/OpenRouter";
import Zhipu from "@lobehub/icons/es/Zhipu";
import Kimi from "@lobehub/icons/es/Kimi";
import Moonshot from "@lobehub/icons/es/Moonshot";
import Minimax from "@lobehub/icons/es/Minimax";
import Cline from "@lobehub/icons/es/Cline";
import OpenCode from "@lobehub/icons/es/OpenCode";
import Aws from "@lobehub/icons/es/Aws";
import Bedrock from "@lobehub/icons/es/Bedrock";
import Google from "@lobehub/icons/es/Google";
import Volcengine from "@lobehub/icons/es/Volcengine";
import DeepSeek from "@lobehub/icons/es/DeepSeek";
import Bailian from "@lobehub/icons/es/Bailian";
import XiaomiMiMo from "@lobehub/icons/es/XiaomiMiMo";
import Ollama from "@lobehub/icons/es/Ollama";
import OpenAI from "@lobehub/icons/es/OpenAI";
import XAI from "@lobehub/icons/es/XAI";

// ---------------------------------------------------------------------------
// Brand icon resolver
// ---------------------------------------------------------------------------

/**
 * React node for a brand icon. Pure rule lives in
 * `src/lib/provider-icon-rule.ts` (unit-testable without React); this
 * thin wrapper just maps the rule's string key to a JSX component.
 */
const ICON_BY_KEY: Record<ProviderIconKey, ReactNode> = {
  openrouter: <OpenRouter size={18} />,
  zhipu: <Zhipu size={18} />,
  kimi: <Kimi size={18} />,
  moonshot: <Moonshot size={18} />,
  minimax: <Minimax size={18} />,
  volcengine: <Volcengine size={18} />,
  bailian: <Bailian size={18} />,
  "xiaomi-mimo": <XiaomiMiMo size={18} />,
  ollama: <Ollama size={18} />,
  openai: <OpenAI size={18} />,
  xai: <XAI size={18} />,
  deepseek: <DeepSeek size={18} />,
  bedrock: <Bedrock size={18} />,
  google: <Google size={18} />,
  aws: <Aws size={18} />,
  anthropic: <Anthropic size={18} />,
  cline: <Cline size={18} />,
  opencode: <OpenCode size={18} />,
  default: <HardDrives size={18} className="text-muted-foreground" />,
};

/** Map a provider name / base_url to a brand icon */
export function getProviderIcon(name: string, baseUrl: string): ReactNode {
  return ICON_BY_KEY[getProviderIconKey(name, baseUrl)];
}

// ---------------------------------------------------------------------------
// Quick-add preset definitions — generated from VENDOR_PRESETS (single source of truth)
// ---------------------------------------------------------------------------

export interface QuickPreset {
  key: string;
  name: string;
  description: string;
  descriptionZh: string;
  icon: ReactNode;
  provider_type: string;
  protocol: string;
  /** Auth style from catalog — frontend should use this instead of inferring from extra_env */
  authStyle: string;
  base_url: string;
  extra_env: string;
  fields: ("name" | "api_key" | "base_url" | "extra_env" | "model_names" | "model_mapping")[];
  category?: "chat" | "media";
  /** Provider meta info from catalog (for user guidance) */
  meta?: VendorPreset['meta'];
  /** Catalog default model id — used to pre-fill the model_names input so a
   *  preset that requires a user-specified model (e.g. MiMo) shows its current
   *  default instead of an empty box with an unrelated placeholder. */
  defaultModelId?: string;
}

/** Map iconKey from VENDOR_PRESETS to React icon component */
function resolveIcon(iconKey: string): ReactNode {
  const ICON_MAP: Record<string, ReactNode> = {
    anthropic: <Anthropic size={18} />,
    openrouter: <OpenRouter size={18} />,
    zhipu: <Zhipu size={18} />,
    kimi: <Kimi size={18} />,
    moonshot: <Moonshot size={18} />,
    minimax: <Minimax size={18} />,
    bedrock: <Bedrock size={18} />,
    google: <Google size={18} />,
    volcengine: <Volcengine size={18} />,
    bailian: <Bailian size={18} />,
    'xiaomi-mimo': <XiaomiMiMo size={18} />,
    ollama: <Ollama size={18} />,
    openai: <OpenAI size={18} />,
    xai: <XAI size={18} />,
    deepseek: <DeepSeek size={18} />,
    cline: <Cline size={18} />,
    opencode: <OpenCode size={18} />,
    server: <HardDrives size={18} className="text-muted-foreground" />,
  };
  return ICON_MAP[iconKey] || <HardDrives size={18} className="text-muted-foreground" />;
}

/** Convert a VendorPreset to the frontend QuickPreset format */
function toQuickPreset(vp: VendorPreset): QuickPreset {
  return {
    key: vp.key,
    name: vp.name,
    description: vp.description,
    descriptionZh: vp.descriptionZh,
    icon: resolveIcon(vp.iconKey),
    provider_type: vp.protocol === 'openrouter' ? 'openrouter'
      : vp.protocol === 'bedrock' ? 'bedrock'
      : vp.protocol === 'vertex' ? 'vertex'
      : vp.protocol === 'gemini-image' ? 'gemini-image'
      : vp.protocol === 'openai-image' ? 'openai-image'
      : vp.protocol === 'openai-compatible' ? 'openai-compatible'
      : vp.protocol === 'xai' ? 'xai'
      : 'anthropic',
    protocol: vp.protocol,
    authStyle: vp.authStyle,
    base_url: vp.baseUrl,
    extra_env: JSON.stringify(vp.defaultEnvOverrides),
    fields: vp.fields as QuickPreset['fields'],
    category: vp.category,
    meta: vp.meta,
    defaultModelId: vp.defaultRoleModels?.default
      ?? vp.defaultModels?.[0]?.upstreamModelId
      ?? vp.defaultModels?.[0]?.modelId,
  };
}

export const QUICK_PRESETS: QuickPreset[] = VENDOR_PRESETS.map(toQuickPreset);

// ---------------------------------------------------------------------------
// Gemini image model definitions
// ---------------------------------------------------------------------------

export const GEMINI_IMAGE_MODELS = [
  { value: 'gemini-3.1-flash-image-preview', label: 'Nano Banana 2' },
  { value: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro' },
  { value: 'gemini-2.5-flash-image', label: 'Nano Banana' },
];

export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

export const OPENAI_IMAGE_MODELS = [
  { value: 'gpt-image-2', label: 'GPT Image 2' },
  { value: 'gpt-image-1.5', label: 'GPT Image 1.5' },
  { value: 'gpt-image-1', label: 'GPT Image 1' },
  { value: 'gpt-image-1-mini', label: 'GPT Image 1 Mini' },
];

export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-2';

export function getGeminiImageModel(provider: ApiProvider): string {
  try {
    const env = JSON.parse(provider.extra_env || '{}');
    return env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL;
  } catch {
    return DEFAULT_GEMINI_IMAGE_MODEL;
  }
}

export function getOpenAIImageModel(provider: ApiProvider): string {
  try {
    const env = JSON.parse(provider.extra_env || '{}');
    return env.OPENAI_IMAGE_MODEL || DEFAULT_OPENAI_IMAGE_MODEL;
  } catch {
    return DEFAULT_OPENAI_IMAGE_MODEL;
  }
}

// ---------------------------------------------------------------------------
// Preset matcher — find which quick preset a provider was created from
// ---------------------------------------------------------------------------

export function findMatchingPreset(provider: ApiProvider): QuickPreset | undefined {
  const resolution = resolveProviderPresetIdentity(provider);
  if (resolution.status !== 'resolved') return undefined;
  return QUICK_PRESETS.find(p => p.key === resolution.preset.key);
}
