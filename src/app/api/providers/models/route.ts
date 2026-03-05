import { NextResponse } from 'next/server';
import { getAllProviders, getDefaultProviderId } from '@/lib/db';
import { PROVIDER_MODEL_RESOLUTION } from '@/lib/provider-models';
import type { ErrorResponse, ProviderModelGroup } from '@/types';

// Default Claude model options
const DEFAULT_MODELS = [
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'opus', label: 'Opus 4.6' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

// Provider-specific model label mappings (base_url -> actual_api_model_name -> display name).
// IMPORTANT: for non-Anthropic providers that use the direct API path (streamDirectFromProvider),
// the `value` field is sent verbatim to the provider's /v1/messages endpoint as the "model"
// parameter. It must be the actual API model name, NOT a CodePilot internal alias
// (sonnet / opus / haiku). Those aliases only work when the Claude Code CLI resolves them.
//
// Build PROVIDER_MODEL_LABELS from the shared PROVIDER_MODEL_RESOLUTION map.
// This ensures consistency with claude-client.ts model alias resolution.
const PROVIDER_MODEL_LABELS: Record<string, { value: string; label: string }[]> = {
  // ── BigModel / GLM (智谱 AI) ────────────────────────────────────────────────
  'https://api.z.ai/api/anthropic': [
    { value: 'glm-4.7', label: 'GLM-4.7' },
    { value: 'glm-5', label: 'GLM-5' },
    { value: 'glm-4.5-air', label: 'GLM-4.5-Air' },
  ],
  'https://open.bigmodel.cn/api/anthropic': [
    { value: 'glm-4.7', label: 'GLM-4.7' },
    { value: 'glm-5', label: 'GLM-5' },
    { value: 'glm-4.5-air', label: 'GLM-4.5-Air' },
  ],
  // ── Kimi / Moonshot ─────────────────────────────────────────────────────────
  'https://api.kimi.com/coding/': [
    { value: 'kimi-k2.5', label: 'Kimi K2.5' },
  ],
  'https://api.moonshot.ai/anthropic': [
    { value: 'kimi-k2.5', label: 'Kimi K2.5' },
  ],
  'https://api.moonshot.cn/anthropic': [
    { value: 'kimi-k2.5', label: 'Kimi K2.5' },
  ],
  // ── MiniMax ─────────────────────────────────────────────────────────────────
  'https://api.minimaxi.com/anthropic': [
    { value: 'MiniMax-M2.5', label: 'MiniMax-M2.5' },
  ],
  'https://api.minimax.io/anthropic': [
    { value: 'MiniMax-M2.5', label: 'MiniMax-M2.5' },
  ],
  // ── OpenRouter ──────────────────────────────────────────────────────────────
  'https://openrouter.ai/api': [
    { value: 'sonnet', label: 'Sonnet 4.6' },
    { value: 'opus', label: 'Opus 4.6' },
    { value: 'haiku', label: 'Haiku 4.5' },
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

// Note: PROVIDER_MODEL_RESOLUTION is now imported from @/lib/provider-models
// to maintain a single source of truth for model alias resolution.
// If you need to add a new provider, update provider-models.ts.

/**
 * Deduplicate models: if multiple aliases map to the same label, keep only the first one.
 */
function deduplicateModels(models: { value: string; label: string }[]): { value: string; label: string }[] {
  const seen = new Set<string>();
  const result: { value: string; label: string }[] = [];
  for (const m of models) {
    if (!seen.has(m.label)) {
      seen.add(m.label);
      result.push(m);
    }
  }
  return result;
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

      // For providers with ANTHROPIC_MODEL in extra_env (e.g. Volcengine Ark),
      // show the configured model name in the selector
      if (!matched) {
        try {
          const envObj = JSON.parse(provider.extra_env || '{}');
          if (envObj.ANTHROPIC_MODEL) {
            rawModels = [{ value: envObj.ANTHROPIC_MODEL, label: envObj.ANTHROPIC_MODEL }];
          }
        } catch { /* use default */ }
      }

      const models = deduplicateModels(rawModels);

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
