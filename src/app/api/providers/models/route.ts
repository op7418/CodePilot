import { NextResponse } from 'next/server';
import { getAllProviders, getDefaultProviderId } from '@/lib/db';
import type { ErrorResponse, ProviderModelGroup } from '@/types';

interface ModelOption {
  value: string;
  label: string;
  context_window?: number;
}

// Default Claude model options
const DEFAULT_MODELS: ModelOption[] = [
  { value: 'sonnet', label: 'Sonnet 4.6', context_window: 200000 },
  { value: 'opus', label: 'Opus 4.6', context_window: 200000 },
  { value: 'haiku', label: 'Haiku 4.5', context_window: 200000 },
];

// Provider-specific model label mappings (base_url -> alias -> display name)
const PROVIDER_MODEL_LABELS: Record<string, ModelOption[]> = {
  'https://api.z.ai/api/anthropic': [
    { value: 'sonnet', label: 'GLM-4.7' },
    { value: 'opus', label: 'GLM-5' },
    { value: 'haiku', label: 'GLM-4.5-Air' },
  ],
  'https://open.bigmodel.cn/api/anthropic': [
    { value: 'sonnet', label: 'GLM-4.7' },
    { value: 'opus', label: 'GLM-5' },
    { value: 'haiku', label: 'GLM-4.5-Air' },
  ],
  'https://api.kimi.com/coding/': [
    { value: 'sonnet', label: 'Kimi K2.5' },
    { value: 'opus', label: 'Kimi K2.5' },
    { value: 'haiku', label: 'Kimi K2.5' },
  ],
  'https://api.moonshot.ai/anthropic': [
    { value: 'sonnet', label: 'Kimi K2.5' },
    { value: 'opus', label: 'Kimi K2.5' },
    { value: 'haiku', label: 'Kimi K2.5' },
  ],
  'https://api.moonshot.cn/anthropic': [
    { value: 'sonnet', label: 'Kimi K2.5' },
    { value: 'opus', label: 'Kimi K2.5' },
    { value: 'haiku', label: 'Kimi K2.5' },
  ],
  'https://api.minimaxi.com/anthropic': [
    { value: 'sonnet', label: 'MiniMax-M2.5' },
    { value: 'opus', label: 'MiniMax-M2.5' },
    { value: 'haiku', label: 'MiniMax-M2.5' },
  ],
  'https://api.minimax.io/anthropic': [
    { value: 'sonnet', label: 'MiniMax-M2.5' },
    { value: 'opus', label: 'MiniMax-M2.5' },
    { value: 'haiku', label: 'MiniMax-M2.5' },
  ],
  'https://openrouter.ai/api': [
    { value: 'sonnet', label: 'Sonnet 4.6', context_window: 200000 },
    { value: 'opus', label: 'Opus 4.6', context_window: 200000 },
    { value: 'haiku', label: 'Haiku 4.5', context_window: 200000 },
  ],
  'https://coding.dashscope.aliyuncs.com/apps/anthropic': [
    { value: 'qwen3.5-plus', label: 'Qwen 3.5 Plus' },
    { value: 'qwen3-coder-next', label: 'Qwen 3 Coder Next' },
    { value: 'qwen3-coder-plus', label: 'Qwen 3 Coder Plus' },
    { value: 'kimi-k2.5', label: 'Kimi K2.5' },
    { value: 'glm-5', label: 'GLM-5' },
    { value: 'glm-4.7', label: 'GLM-4.7' },
    { value: 'MiniMax-M2.5', label: 'MiniMax-M2.5' },
  ],
};

/**
 * Deduplicate models: if multiple aliases map to the same label, keep only the first one.
 */
function deduplicateModels(models: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  const result: ModelOption[] = [];
  for (const m of models) {
    if (!seen.has(m.label)) {
      seen.add(m.label);
      result.push(m);
    }
  }
  return result;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

export async function GET() {
  try {
    const providers = getAllProviders();
    const groups: ProviderModelGroup[] = [];

    // Always show the built-in Claude Code provider group.
    // Claude Code CLI stores credentials in ~/.claude/ (via `claude login`),
    // which the SDK subprocess can read — even without ANTHROPIC_API_KEY in env.
    groups.push({
      provider_id: 'env',
      provider_name: 'Claude Code',
      provider_type: 'anthropic',
      models: DEFAULT_MODELS,
    });

    // Provider types that are not LLMs (e.g. image generation) — skip in chat model selector
    const MEDIA_PROVIDER_TYPES = new Set(['gemini-image']);

    // Build a group for each configured provider
    for (const provider of providers) {
      if (MEDIA_PROVIDER_TYPES.has(provider.provider_type)) continue;
      const matched = PROVIDER_MODEL_LABELS[provider.base_url];
      let rawModels = matched || DEFAULT_MODELS;
      let providerEnv: Record<string, unknown> = {};

      try {
        providerEnv = JSON.parse(provider.extra_env || '{}') as Record<string, unknown>;
      } catch {
        providerEnv = {};
      }

      const providerContextWindow = parsePositiveInteger(providerEnv.CODEPILOT_CONTEXT_WINDOW);

      // For providers with ANTHROPIC_MODEL in extra_env (e.g. Volcengine Ark),
      // show the configured model name in the selector
      if (!matched) {
        const anthropicModel = providerEnv.ANTHROPIC_MODEL;
        if (typeof anthropicModel === 'string' && anthropicModel.trim()) {
          rawModels = [{ value: anthropicModel, label: anthropicModel }];
        }
      }

      const models = deduplicateModels(
        rawModels.map((model) => ({
          ...model,
          context_window: model.context_window ?? providerContextWindow,
        }))
      );

      groups.push({
        provider_id: provider.id,
        provider_name: provider.name,
        provider_type: provider.provider_type,
        models,
      });
    }

    // Determine default provider
    const defaultProviderId = getDefaultProviderId() || groups[0].provider_id;

    return NextResponse.json({
      groups,
      default_provider_id: defaultProviderId,
    });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to get models' },
      { status: 500 }
    );
  }
}
