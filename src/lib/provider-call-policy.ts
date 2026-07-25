import type { ApiProvider } from '@/types';
import { getPreset, resolveProviderPresetIdentity } from './provider-catalog';

/**
 * Why a provider/model is being invoked. This is deliberately narrower than
 * route names: every model call must make its user-interaction semantics
 * explicit before credentials can reach the wire.
 */
export type ProviderCallScene =
  | 'interactive_chat'
  | 'active_turn_compact'
  | 'active_turn_memory_rerank'
  | 'user_onboarding'
  | 'user_checkin'
  | 'user_dashboard_refresh'
  | 'user_cli_describe'
  | 'user_skill_search'
  | 'connection_test'
  | 'automatic_title'
  | 'automatic_memory_extract'
  | 'automatic_quick_actions'
  | 'automatic_dashboard_refresh'
  | 'background_cli_describe'
  | 'background_skill_search'
  | 'scheduled_task'
  | 'assistant_heartbeat'
  | 'media_plan'
  | 'structured_generation'
  | 'bridge';

const INTERACTIVE_ALLOWED = new Set<ProviderCallScene>([
  'interactive_chat',
  'active_turn_compact',
  'active_turn_memory_rerank',
  'user_onboarding',
  'user_checkin',
  'user_dashboard_refresh',
  'user_cli_describe',
  'user_skill_search',
  'connection_test',
]);

export class ProviderCallPolicyError extends Error {
  readonly code: 'CALL_SCENE_REQUIRED' | 'INTERACTIVE_ONLY_SCENE_BLOCKED';
  readonly scene?: ProviderCallScene;
  readonly presetKey?: string;

  constructor(input: {
    code: 'CALL_SCENE_REQUIRED' | 'INTERACTIVE_ONLY_SCENE_BLOCKED';
    scene?: ProviderCallScene;
    presetKey?: string;
  }) {
    const message = input.code === 'CALL_SCENE_REQUIRED'
      ? 'Provider call blocked: callScene is required.'
      : `Provider call blocked: ${input.presetKey || 'this subscription'} is limited to interactive coding/agent use and cannot be used for ${input.scene}.`;
    super(message);
    this.name = 'ProviderCallPolicyError';
    this.code = input.code;
    this.scene = input.scene;
    this.presetKey = input.presetKey;
  }
}

export function getProviderUsagePolicy(provider: ApiProvider | undefined): 'general' | 'interactive_only' {
  if (!provider) return 'general';
  const identity = resolveProviderPresetIdentity(provider);
  if (identity.status === 'resolved') return identity.preset.usagePolicy ?? 'general';
  if (
    identity.status === 'ambiguous'
    && identity.candidateKeys.some(key => getPreset(key)?.usagePolicy === 'interactive_only')
  ) return 'interactive_only';
  // A known managed identity whose URL/protocol was later corrupted must not
  // gain broader usage rights merely because identity validation now fails.
  // The UI will ask the user to repair the provider; until then retain the
  // preset's restrictive policy and fail closed for background scenes.
  const explicitPolicy = getPreset(provider.preset_key)?.usagePolicy;
  if (explicitPolicy) return explicitPolicy;
  // Unknown/corrupt keys do not suppress a restrictive identity that can
  // still be inferred conservatively from the legacy URL contract.
  if (provider.preset_key) {
    const legacyIdentity = resolveProviderPresetIdentity({ ...provider, preset_key: '' });
    if (
      legacyIdentity.status === 'ambiguous'
      && legacyIdentity.candidateKeys.some(key => getPreset(key)?.usagePolicy === 'interactive_only')
    ) return 'interactive_only';
    if (legacyIdentity.status === 'resolved') return legacyIdentity.preset.usagePolicy ?? 'general';
  }
  return 'general';
}

export function isInteractiveSceneAllowed(scene: ProviderCallScene): boolean {
  return INTERACTIVE_ALLOWED.has(scene);
}

/** Fail closed before a credential-bearing model request is constructed. */
export function assertProviderCallAllowed(
  provider: ApiProvider | undefined,
  scene: ProviderCallScene | undefined,
): void {
  if (!scene) throw new ProviderCallPolicyError({ code: 'CALL_SCENE_REQUIRED' });
  if (getProviderUsagePolicy(provider) !== 'interactive_only') return;
  if (!isInteractiveSceneAllowed(scene)) {
    throw new ProviderCallPolicyError({
      code: 'INTERACTIVE_ONLY_SCENE_BLOCKED',
      scene,
      presetKey: provider?.preset_key,
    });
  }
}
