import { useState, useCallback, useEffect, useMemo } from 'react';
import type { ProviderModelGroup } from '@/types';

// Default Claude model options — used as fallback when API is unavailable
export const DEFAULT_MODEL_OPTIONS = [
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'opus', label: 'Opus 4.6' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

export interface UseProviderModelsReturn {
  providerGroups: ProviderModelGroup[];
  currentProviderIdValue: string;
  modelOptions: typeof DEFAULT_MODEL_OPTIONS;
  currentModelOption: (typeof DEFAULT_MODEL_OPTIONS)[number];
}

export function useProviderModels(
  providerId?: string,
  modelName?: string,
): UseProviderModelsReturn {
  const [providerGroups, setProviderGroups] = useState<ProviderModelGroup[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState<string>('');

  const fetchProviderModels = useCallback(() => {
    fetch('/api/providers/models')
      .then((r) => r.json())
      .then((data) => {
        if (data.groups && data.groups.length > 0) {
          setProviderGroups(data.groups);
        } else {
          setProviderGroups([{
            provider_id: 'env',
            provider_name: 'Anthropic',
            provider_type: 'anthropic',
            models: DEFAULT_MODEL_OPTIONS,
          }]);
        }
        setDefaultProviderId(data.default_provider_id || '');
      })
      .catch(() => {
        setProviderGroups([{
          provider_id: 'env',
          provider_name: 'Anthropic',
          provider_type: 'anthropic',
          models: DEFAULT_MODEL_OPTIONS,
        }]);
        setDefaultProviderId('');
      });
  }, []);

  // Load models on mount and listen for provider changes
  useEffect(() => {
    fetchProviderModels();
    const handler = () => fetchProviderModels();
    window.addEventListener('provider-changed', handler);
    return () => window.removeEventListener('provider-changed', handler);
  }, [fetchProviderModels]);

  // Derive flat model list for current provider
  const currentProviderIdValue = providerId || defaultProviderId || (providerGroups[0]?.provider_id ?? '');
  const currentGroup = providerGroups.find(g => g.provider_id === currentProviderIdValue) || providerGroups[0];
  const modelOptions = currentGroup?.models || DEFAULT_MODEL_OPTIONS;

  const currentModelValue = modelName || 'sonnet';
  const currentModelOption = useMemo(
    () => modelOptions.find((m) => m.value === currentModelValue) || modelOptions[0],
    [modelOptions, currentModelValue],
  );

  return {
    providerGroups,
    currentProviderIdValue,
    modelOptions,
    currentModelOption,
  };
}
