import type { ApiProvider } from '@/types';

function isBlank(value: string | undefined): boolean {
  return !value || value.trim() === '';
}

function isEmptyJsonObject(value: string | undefined): boolean {
  if (isBlank(value)) return true;
  try {
    const parsed = JSON.parse(value!);
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}

/**
 * Older migrations could create a placeholder provider called "Default"
 * even when the actual runtime path uses the built-in env/Claude Code provider.
 * Hide only the fully empty migrated placeholder, not user-managed providers.
 */
export function isLegacyMigratedDefaultPlaceholder(provider: ApiProvider): boolean {
  return (
    provider.name === 'Default' &&
    provider.notes === 'Migrated from settings' &&
    provider.provider_type === 'anthropic' &&
    isBlank(provider.base_url) &&
    isBlank(provider.api_key) &&
    isEmptyJsonObject(provider.extra_env) &&
    isEmptyJsonObject(provider.headers_json) &&
    isEmptyJsonObject(provider.env_overrides_json) &&
    isEmptyJsonObject(provider.role_models_json) &&
    isEmptyJsonObject(provider.options_json)
  );
}

export function filterVisibleProviders(providers: ApiProvider[]): ApiProvider[] {
  return providers.filter(provider => !isLegacyMigratedDefaultPlaceholder(provider));
}
