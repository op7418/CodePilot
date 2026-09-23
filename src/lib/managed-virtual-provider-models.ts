import type { ProviderRuntimeCompat } from '@/types';
import type { CatalogModel, Protocol } from './provider-catalog';
import { getOAuthStatus } from './openai-oauth-manager';
import { getXaiOAuthStatus } from './xai-oauth-manager';

import { OPENAI_OAUTH_CATALOG_MODELS, getOpenAIOAuthModels } from './openai-oauth-models';
export { OPENAI_OAUTH_CATALOG_MODELS } from './openai-oauth-models';

export const XAI_OAUTH_CATALOG_MODELS: CatalogModel[] = [
  {
    modelId: 'grok-4.6',
    displayName: 'Grok 4.6',
    capabilities: {
      reasoning: true,
      toolUse: true,
      vision: true,
      contextWindow: 500_000,
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
      thinkingMode: 'always',
      defaultEffortLevel: 'high',
    },
  },
  { modelId: 'grok-4.5', displayName: 'Grok 4.5 (Legacy)' },
];

export interface ManagedVirtualProviderModelGroup {
  providerId: 'openai-oauth' | 'xai-oauth';
  providerName: string;
  providerType: 'openai-oauth' | 'xai-oauth';
  presetKey: 'openai-oauth' | 'xai-oauth';
  protocol: Protocol;
  compat: ProviderRuntimeCompat;
  models: CatalogModel[];
}

export type ManagedVirtualProviderDefinition = ManagedVirtualProviderModelGroup;

const MANAGED_VIRTUAL_PROVIDER_DEFINITIONS: Record<
  ManagedVirtualProviderDefinition['providerId'],
  ManagedVirtualProviderDefinition
> = {
  'openai-oauth': {
    providerId: 'openai-oauth',
    providerName: 'OpenAI OAuth (Codex API)',
    providerType: 'openai-oauth',
    presetKey: 'openai-oauth',
    protocol: 'openai-compatible',
    compat: 'codepilot_only',
    models: OPENAI_OAUTH_CATALOG_MODELS,
  },
  'xai-oauth': {
    providerId: 'xai-oauth',
    providerName: 'Grok Build OAuth',
    providerType: 'xai-oauth',
    presetKey: 'xai-oauth',
    protocol: 'xai',
    compat: 'codepilot_only',
    models: XAI_OAUTH_CATALOG_MODELS,
  },
};

/**
 * Authentication-independent metadata used by Runtime compatibility and the
 * Codex proxy. Availability still comes exclusively from
 * `listManagedVirtualProviderModelGroups()`.
 */
export function listManagedVirtualProviderDefinitions(): ManagedVirtualProviderDefinition[] {
  return Object.values(MANAGED_VIRTUAL_PROVIDER_DEFINITIONS).map(d => getManagedVirtualProviderDefinition(d.providerId));
}

export function getManagedVirtualProviderDefinition(
  providerId: ManagedVirtualProviderDefinition['providerId'],
): ManagedVirtualProviderDefinition {
  const definition = MANAGED_VIRTUAL_PROVIDER_DEFINITIONS[providerId];
  return providerId === 'openai-oauth' ? { ...definition, models: getOpenAIOAuthModels() } : definition;
}

/**
 * Authenticated, non-DB providers that are executable through CodePilot's
 * managed Native/Codex provider paths.
 *
 * Keep this as the shared source for both `/api/providers/models` and managed
 * Sub-agent route discovery. The v0.60.0 regression came from the picker
 * hand-adding xAI OAuth while `listSubagentRoutes()` enumerated DB rows only.
 *
 * `codex_account` is intentionally not here: its models are discovered
 * asynchronously from Codex app-server and its native-worker path does not use
 * the managed CodePilot provider proxy represented by this catalog.
 */
export function listManagedVirtualProviderModelGroups(): ManagedVirtualProviderModelGroup[] {
  const groups: ManagedVirtualProviderModelGroup[] = [];

  try {
    const status = getOAuthStatus();
    if (status.authenticated) {
      const definition = getManagedVirtualProviderDefinition('openai-oauth');
      groups.push({
        ...definition,
        providerName: `OpenAI${status.plan ? ` (${status.plan})` : ''}`,
      });
    }
  } catch {
    // OAuth module/storage unavailable: omit the route rather than advertise
    // a child whose credentials cannot be proven at this boundary.
  }

  try {
    const status = getXaiOAuthStatus();
    if (status.enabled && status.authenticated) {
      groups.push(MANAGED_VIRTUAL_PROVIDER_DEFINITIONS['xai-oauth']);
    }
  } catch {
    // Same fail-closed rule as OpenAI OAuth above.
  }

  return groups;
}
