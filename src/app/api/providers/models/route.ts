import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getAllProviders, getDefaultProviderId } from '@/lib/db';
import type { ErrorResponse, ProviderModelGroup } from '@/types';

// Default Claude model options
const DEFAULT_MODELS = [
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'opus', label: 'Opus 4.6' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

// Provider-specific model label mappings (base_url -> alias -> display name)
const PROVIDER_MODEL_LABELS: Record<string, { value: string; label: string }[]> = {
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

/**
 * Read ANTHROPIC_MODEL from ~/.claude/settings.json (top-level or under "env" key).
 * Returns null if not configured.
 */
function getClaudeSettingsModel(): string | null {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return null;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    const model =
      (settings.ANTHROPIC_MODEL as string | undefined) ||
      ((settings.env as Record<string, unknown> | undefined)?.ANTHROPIC_MODEL as string | undefined);
    return model || null;
  } catch {
    return null;
  }
}

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
    // If the user has configured ANTHROPIC_MODEL in ~/.claude/settings.json,
    // surface that model instead of the default Claude aliases.
    const claudeSettingsModel = getClaudeSettingsModel();
    const envModels = claudeSettingsModel
      ? [{ value: claudeSettingsModel, label: claudeSettingsModel }]
      : DEFAULT_MODELS;
    groups.push({
      provider_id: 'env',
      provider_name: 'Claude Code',
      provider_type: 'anthropic',
      models: envModels,
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
