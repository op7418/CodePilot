import { getDefaultProviderId, getSetting } from '@/lib/db';
import { getActiveChatRuntime } from '@/lib/chat-runtime';
import { resolveProviderForSession } from '@/lib/provider-resolver';
import type { ProviderCallScene } from '@/lib/provider-call-policy';
import type { SessionRouteIdentity } from '@/lib/db';
import type { RuntimeId } from './runtime-id';

/**
 * Freeze the current global defaults at automatic-session creation time.
 * Background execution consumes this stored identity later; it never resolves
 * a fresh global default at tick time.
 */
export function resolveAutomaticSessionRoute(
  callScene: ProviderCallScene,
  overrides: { runtimeId?: RuntimeId; providerId?: string; modelId?: string } = {},
): SessionRouteIdentity {
  const runtimeId = overrides.runtimeId || getActiveChatRuntime();
  const configuredProviderId = overrides.providerId
    || (runtimeId === 'codex_runtime' ? 'codex_account' : getDefaultProviderId())
    || (runtimeId === 'claude_code' ? 'env' : '');
  const configuredModelId = overrides.modelId
    || getSetting('global_default_model')
    || getSetting('default_model')
    || '';
  const resolved = resolveProviderForSession({
    provider_id: configuredProviderId,
    model: configuredModelId,
  }, { runtime: runtimeId, callScene });
  const providerId = configuredProviderId || resolved.provider?.id || '';
  const modelId = configuredModelId || resolved.model || '';
  if (resolved.invalidReason || !providerId || !modelId || !resolved.hasCredentials) {
    throw new Error(`Automatic session route is unavailable${resolved.invalidReason ? `: ${resolved.invalidReason}` : ''}`);
  }
  return { runtimeId, providerId, modelId };
}
