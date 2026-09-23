import type { ChatRuntime } from './chat-runtime';
import { resolveProviderForSession, type ResolvedProvider, type SessionRuntimeIntent } from './provider-resolver';
import { getModelCompat, getProviderCompat } from './runtime-compat';

/**
 * A message echoes a committed route; it cannot select another provider/model.
 * Old collectors stored the Runtime's upstream ID over the picker model ID.
 * Accept that representation only when ONE live row proves the same identity.
 * Never merge distinct catalog IDs just because they share an upstream.
 * This compatibility read does not mutate the session or its CAS revision.
 */
export function resolveChatMessageRoute(
  intent: SessionRuntimeIntent,
  runtime: ChatRuntime,
): ResolvedProvider | undefined {
  if (intent.requestProviderId && intent.requestProviderId !== intent.provider_id) return undefined;

  // A message may omit the provider echo, but the committed provider remains
  // authoritative. Never resolve legacy identity against a default/env fallback.
  const resolved = resolveProviderForSession({
    ...intent,
    requestProviderId: intent.provider_id,
  }, { runtime, callScene: 'interactive_chat' });
  if (!intent.requestModel || intent.requestModel === intent.model) return resolved;
  if (resolved.invalidReason) return undefined;

  // An exact catalog ID is a committed identity, not a legacy upstream alias.
  if (resolved.availableModels.some(row => row.modelId === intent.model)) return undefined;
  const matches = resolved.availableModels.filter(row => row.upstreamModelId === intent.model);
  if (matches.length !== 1 || matches[0].modelId !== intent.requestModel) return undefined;
  // Legacy repair must not make a row executable in a Runtime which the
  // current provider catalog excludes. Virtual account routes use exact IDs.
  if (!resolved.provider && intent.provider_id !== 'env') return undefined;
  if (intent.provider_id === 'env' && runtime === 'codex_runtime') return undefined;
  const compat = getModelCompat({
    ...matches[0],
    providerBaseUrl: resolved.provider?.base_url,
    providerCompat: resolved.provider ? getProviderCompat(resolved.provider) : 'claude_code_ready',
  });
  if (!compat.supportedRuntimes?.includes(runtime)) return undefined;
  // Require the actual execution resolution to agree with the catalog proof.
  if (resolved.model !== intent.requestModel || resolved.upstreamModel !== intent.model) return undefined;
  return resolved;
}
