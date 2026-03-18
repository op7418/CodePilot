import { NextResponse } from 'next/server';
import { getAllProviders, getDefaultProviderId, setDefaultProviderId, getProvider, getModelsForProvider, getSetting } from '@/lib/db';
import { getContextWindow } from '@/lib/model-context';
import { getDefaultModelsForProvider, inferProtocolFromLegacy, findPresetForLegacy } from '@/lib/provider-catalog';
import type { Protocol } from '@/lib/provider-catalog';
import type { ErrorResponse, ProviderModelGroup } from '@/types';

// Default Claude model options (for the built-in 'env' provider)
const DEFAULT_MODELS = [
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'opus', label: 'Opus 4.6' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

interface ModelEntry {
  value: string;
  label: string;
  upstreamModelId?: string;
  capabilities?: Record<string, unknown>;
  variants?: Record<string, unknown>;
}

/**
 * Deduplicate models: if multiple aliases map to the same label, keep only the first one.
 */
function deduplicateModels(models: ModelEntry[]): ModelEntry[] {
  const seen = new Set<string>();
  const result: ModelEntry[] = [];
  for (const m of models) {
    if (!seen.has(m.label)) {
      seen.add(m.label);
      result.push(m);
    }
  }
  return result;
}

/** Media-only provider protocols — skip in chat model selector */
const MEDIA_PROTOCOLS = new Set<string>(['gemini-image']);
const MEDIA_PROVIDER_TYPES = new Set(['gemini-image']);

export async function GET() {
  try {
    const providers = getAllProviders();
    const groups: ProviderModelGroup[] = [];

    // Always show the built-in Claude Code provider group.
    // Mark it as sdkProxyOnly if no direct API credentials exist — in that case
    // the env provider only works through the Claude Code SDK subprocess, not the
    // Vercel AI SDK text generation path used by features like AI Describe.
    const envHasDirectCredentials = !!(
      process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      getSetting('anthropic_auth_token')
    );
    groups.push({
      provider_id: 'env',
      provider_name: 'Claude Code',
      provider_type: 'anthropic',
      ...(!envHasDirectCredentials ? { sdkProxyOnly: true } : {}),
      models: DEFAULT_MODELS.map(m => {
        const cw = getContextWindow(m.value);
        return cw != null ? { ...m, contextWindow: cw } : m;
      }),
    });

    // If SDK has discovered models, use them for the env group
    try {
      const { getCachedModels } = await import('@/lib/agent-sdk-capabilities');
      const sdkModels = getCachedModels('env');
      if (sdkModels.length > 0) {
        groups[0].models = sdkModels.map(m => {
          const cw = getContextWindow(m.value);
          return {
            value: m.value,
            label: m.displayName,
            description: m.description,
            supportsEffort: m.supportsEffort,
            supportedEffortLevels: m.supportedEffortLevels,
            supportsAdaptiveThinking: m.supportsAdaptiveThinking,
            ...(cw != null ? { contextWindow: cw } : {}),
          };
        });
      }
    } catch {
      // SDK capabilities not available, keep defaults
    }

    // Build a group for each configured provider
    for (const provider of providers) {
      // Determine protocol — use new field if present, otherwise infer from legacy
      const protocol: Protocol = (provider.protocol as Protocol) ||
        inferProtocolFromLegacy(provider.provider_type, provider.base_url);

      // Skip media-only providers in chat model selector
      if (MEDIA_PROTOCOLS.has(protocol) || MEDIA_PROVIDER_TYPES.has(provider.provider_type)) continue;

      // Get models: DB provider_models first, then catalog defaults, then env fallback
      let rawModels: ModelEntry[];

      // 1) Check DB provider_models table
      let dbModels: { value: string; label: string; upstreamModelId?: string; capabilities?: Record<string, unknown> }[] = [];
      try {
        const provModels = getModelsForProvider(provider.id);
        if (provModels.length > 0) {
          dbModels = provModels.map(m => {
            let caps: Record<string, unknown> | undefined;
            let vars: Record<string, unknown> | undefined;
            try { const p = JSON.parse(m.capabilities_json || '{}'); if (Object.keys(p).length > 0) caps = p; } catch { /* ignore */ }
            try { const v = JSON.parse(m.variants_json || '{}'); if (Object.keys(v).length > 0) vars = v; } catch { /* ignore */ }
            return {
              value: m.model_id,
              label: m.display_name || m.model_id,
              upstreamModelId: m.upstream_model_id || undefined,
              capabilities: caps,
              variants: vars,
            };
          });
        }
      } catch { /* table may not exist in old DBs */ }

      // 2) Catalog defaults
      const catalogModels = getDefaultModelsForProvider(protocol, provider.base_url);
      const catalogRaw = catalogModels.map(m => ({
        value: m.modelId,
        label: m.displayName,
        upstreamModelId: m.upstreamModelId,
        capabilities: m.capabilities as Record<string, unknown> | undefined,
      }));

      // Start with DB models + catalog defaults.
      // If both are empty (e.g. Volcengine where user must specify model names),
      // leave rawModels empty — do NOT fall back to DEFAULT_MODELS (Sonnet/Opus/Haiku).
      if (dbModels.length > 0) {
        const dbIds = new Set(dbModels.map(m => m.value));
        rawModels = [...dbModels, ...catalogRaw.filter(m => !dbIds.has(m.value))];
      } else {
        rawModels = [...catalogRaw];
      }

      // Inject models from role_models_json into the list if not already present
      // (e.g. user configured "ark-code-latest" for a Volcengine or anthropic-thirdparty provider)
      try {
        const rm = JSON.parse(provider.role_models_json || '{}');
        // Collect unique model IDs from all role fields (default, reasoning, small, haiku, sonnet, opus)
        const roleEntries: { id: string; role: string }[] = [];
        for (const role of ['default', 'reasoning', 'small', 'haiku', 'sonnet', 'opus'] as const) {
          if (rm[role] && !roleEntries.some(e => e.id === rm[role])) {
            roleEntries.push({ id: rm[role], role });
          }
        }
        // Add each role model to the list (default role first, so it appears at the top)
        for (const entry of roleEntries) {
          if (!rawModels.some(m => m.value === entry.id)) {
            const label = entry.role === 'default' ? entry.id : `${entry.id} (${entry.role})`;
            rawModels.unshift({ value: entry.id, label });
          }
        }
      } catch { /* ignore */ }

      // Legacy: inject ANTHROPIC_MODEL from env overrides if not already present
      try {
        const envOverrides = provider.env_overrides_json || provider.extra_env || '{}';
        const envObj = JSON.parse(envOverrides);
        if (envObj.ANTHROPIC_MODEL && !rawModels.some(m => m.value === envObj.ANTHROPIC_MODEL)) {
          rawModels.unshift({ value: envObj.ANTHROPIC_MODEL, label: envObj.ANTHROPIC_MODEL });
        }
      } catch { /* ignore */ }

      const models = deduplicateModels(rawModels).map(m => {
        const cw = getContextWindow(m.value);
        return {
          ...m,
          ...(cw != null ? { contextWindow: cw } : {}),
        };
      });

      // Detect SDK-proxy-only providers via preset match
      const preset = findPresetForLegacy(provider.base_url, provider.provider_type);
      const sdkProxyOnly = preset?.sdkProxyOnly === true;

      groups.push({
        provider_id: provider.id,
        provider_name: provider.name,
        provider_type: provider.provider_type,
        ...(sdkProxyOnly ? { sdkProxyOnly: true } : {}),
        models,
      });
    }

    // Determine default provider — auto-heal stale references on read
    let defaultProviderId = getDefaultProviderId();
    if (defaultProviderId && !getProvider(defaultProviderId)) {
      // Stale default (provider was deleted). Fix it now.
      const firstValid = groups.find(g => g.provider_id !== 'env');
      defaultProviderId = firstValid?.provider_id || '';
      setDefaultProviderId(defaultProviderId);
    }
    defaultProviderId = defaultProviderId || groups[0]?.provider_id || '';

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
