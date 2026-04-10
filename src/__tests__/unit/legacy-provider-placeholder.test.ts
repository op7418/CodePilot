import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filterVisibleProviders, isLegacyMigratedDefaultPlaceholder } from '@/lib/legacy-provider-placeholder';
import { createProvider, deleteProvider } from '@/lib/db';
import type { ApiProvider } from '@/types';

function buildProvider(overrides: Partial<ApiProvider> = {}): ApiProvider {
  return {
    id: 'provider-id',
    name: 'Default',
    provider_type: 'anthropic',
    protocol: '',
    base_url: '',
    api_key: '',
    is_active: 0,
    sort_order: 0,
    extra_env: '{}',
    headers_json: '{}',
    env_overrides_json: '{}',
    role_models_json: '{}',
    options_json: '{}',
    notes: 'Migrated from settings',
    created_at: '2026-04-05 00:00:00',
    updated_at: '2026-04-05 00:00:00',
    ...overrides,
  };
}

describe('legacy migrated provider placeholder', () => {
  it('detects the empty migrated Default provider', () => {
    assert.equal(isLegacyMigratedDefaultPlaceholder(buildProvider()), true);
  });

  it('keeps user-managed providers visible', () => {
    assert.equal(
      isLegacyMigratedDefaultPlaceholder(buildProvider({ api_key: 'sk-real-key' })),
      false,
    );
    assert.equal(
      isLegacyMigratedDefaultPlaceholder(buildProvider({ notes: 'Custom provider' })),
      false,
    );
  });

  it('filters only the placeholder entry', () => {
    const visibleProvider = buildProvider({
      id: 'real-provider',
      name: 'OpenRouter',
      provider_type: 'openrouter',
      protocol: 'openrouter',
      base_url: 'https://openrouter.ai/api/v1',
      api_key: 'sk-visible',
      notes: '',
    });

    assert.deepEqual(
      filterVisibleProviders([buildProvider(), visibleProvider]).map(provider => provider.id),
      ['real-provider'],
    );
  });

  it('does not expose the placeholder through provider APIs', async () => {
    const placeholder = createProvider({
      name: 'Default',
      provider_type: 'anthropic',
      protocol: '',
      base_url: '',
      api_key: '',
      extra_env: '{}',
      notes: 'Migrated from settings',
    });

    try {
      const providersRoute = await import('@/app/api/providers/route');
      const providersResponse = await providersRoute.GET();
      const providersData = await providersResponse.json() as { providers: ApiProvider[] };
      assert.equal(
        providersData.providers.some(provider => provider.id === placeholder.id),
        false,
      );

      const modelsRoute = await import('@/app/api/providers/models/route');
      const modelsResponse = await modelsRoute.GET();
      const modelsData = await modelsResponse.json() as {
        groups: Array<{ provider_id: string; provider_name: string }>;
      };
      assert.equal(
        modelsData.groups.some(group => group.provider_id === placeholder.id || group.provider_name === 'Default'),
        false,
      );
    } finally {
      deleteProvider(placeholder.id);
    }
  });
});
