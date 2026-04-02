/**
 * Resolve the effective model and provider for a session.
 *
 * Priority:
 * 1. Session's stored model (if non-empty)
 * 2. Global default model — only if it belongs to the session's provider (or session has no provider)
 * 3. First available model within the session's provider
 * 4. Global default model + provider (when session has neither)
 * 5. localStorage last-used model (cross-session fallback)
 * 6. 'sonnet' hardcoded fallback
 *
 * The session's provider_id is never overwritten by a different provider's global default.
 */

type ModelGroup = { provider_id: string; models: Array<{ value: string }> };

interface ResolveContext {
  globalModel: string;
  globalProvider: string;
  groups: ModelGroup[];
  lsModel: string;
  lsProvider: string;
}

/**
 * Pure resolution logic — no I/O, fully testable.
 */
export function resolveSessionModelPure(
  sessionModel: string,
  sessionProviderId: string,
  ctx: ResolveContext,
): { model: string; providerId: string } {
  // Session already has a model — use it as-is
  if (sessionModel) {
    return { model: sessionModel, providerId: sessionProviderId };
  }

  const { globalModel, globalProvider, groups, lsModel, lsProvider } = ctx;

  // Case 1: Session has a provider — resolve model within that provider
  if (sessionProviderId) {
    const sessionGroup = groups.find(g => g.provider_id === sessionProviderId);

    // Use global default only if it belongs to this session's provider
    if (globalModel && globalProvider === sessionProviderId) {
      const valid = sessionGroup?.models.some(m => m.value === globalModel);
      if (valid) {
        return { model: globalModel, providerId: sessionProviderId };
      }
    }

    // Fall back to first available model in this provider
    if (sessionGroup?.models?.length) {
      return { model: sessionGroup.models[0].value, providerId: sessionProviderId };
    }
  }

  // Case 2: Session has no provider — use global default as-is
  if (globalModel) {
    return { model: globalModel, providerId: globalProvider || '' };
  }

  // Case 3: No global default either — localStorage last-used
  return {
    model: lsModel || 'sonnet',
    providerId: lsProvider || '',
  };
}

/**
 * Fetch-based wrapper for use in components. Gathers context then delegates to pure function.
 */
export async function resolveSessionModel(
  sessionModel: string,
  sessionProviderId: string,
): Promise<{ model: string; providerId: string }> {
  // Session already has a model — skip fetches
  if (sessionModel) {
    return { model: sessionModel, providerId: sessionProviderId };
  }

  let globalModel = '';
  let globalProvider = '';
  let groups: ModelGroup[] = [];

  try {
    const [globalRes, modelsRes] = await Promise.all([
      fetch('/api/providers/options?providerId=__global__').catch(() => null),
      fetch('/api/providers/models').catch(() => null),
    ]);

    if (globalRes && 'ok' in globalRes && globalRes.ok) {
      const globalData = await globalRes.json().catch(() => null);
      globalModel = globalData?.options?.default_model || '';
      globalProvider = globalData?.options?.default_model_provider || '';
    }
    if (modelsRes && 'ok' in modelsRes && modelsRes.ok) {
      const data = await modelsRes.json().catch(() => null);
      groups = (data?.groups as ModelGroup[]) || [];
    }
  } catch { /* best effort */ }

  const lsModel = typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-model') : null;
  const lsProvider = typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-provider-id') : null;

  return resolveSessionModelPure(sessionModel, sessionProviderId, {
    globalModel,
    globalProvider,
    groups,
    lsModel: lsModel || '',
    lsProvider: lsProvider || '',
  });
}
