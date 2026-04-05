export function shouldPersistCcSwitchCompatGlobalDefault(
  enabled: boolean,
  providerId: string | undefined,
  model: string | undefined,
): boolean {
  return enabled && providerId === 'env' && !!model;
}

export function buildCcSwitchCompatGlobalDefaultPayload(providerId: string, model: string) {
  return {
    providerId: '__global__',
    options: {
      default_model: model,
      default_model_provider: providerId,
      legacy_default_provider_id: providerId,
    },
  };
}
