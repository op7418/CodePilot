/**
 * Settings effective provider resolver — Phase 5e Phase 3 review
 * round 4 fix P2 #2 (2026-05-18).
 *
 * Scope (narrowed 2026-05-18 review round 5 P2 — match implementation):
 *
 *   **Provider-level fallback only.** This helper resolves the
 *   effective PROVIDER id when the user's pinned provider id is
 *   missing / inactive — same chain `resolveProvider()` walks at
 *   chat send time (pinned → default_provider_id setting → active
 *   provider). It does NOT walk model-level fallback (model not in
 *   the catalog under the active Runtime, role-model overrides,
 *   etc.) — that lives in `resolveNewChatDefault()` on the client
 *   side and would require feeding full ProviderGroup data here.
 *
 *   Today the only downstream consumer is the **codex_runtime
 *   capability matrix downgrade**: when the resolved provider id is
 *   `codex_account`, bridge-only capabilities demote to
 *   perception_only. That decision is provider-level — `codex_account`
 *   is a virtual provider id, not a model id — so provider-level
 *   resolution is sufficient for the current Settings clipboard.
 *
 *   If a future feature needs "Settings capability matrix matches
 *   exact model the next chat will use", extend with model-level
 *   resolution by feeding ProviderGroup data + calling
 *   `resolveNewChatDefault()` from server-side. Until then the
 *   intentional scope is provider-level only.
 *
 * Tests live in `settings-effective-provider.test.ts` under the
 * "provider-level" describe blocks; model-level fallback is
 * explicitly out of scope there.
 */

import { getSetting } from '@/lib/db';
import { resolveProvider } from '@/lib/provider-resolver';

/**
 * Returns the effective provider id chat send path would use, with
 * `undefined` when no provider is reachable at all (Settings matrix
 * then degrades gracefully — no provider-specific demotion fires).
 */
export function resolveEffectiveProviderId(): string | undefined {
  try {
    const pinned = getSetting('global_default_model_provider');

    // Virtual providers are NOT stored in `api_providers`. The chat
    // send path (`provider-resolver.ts:143-156`) treats them as the
    // effective id directly — short-circuit here so we don't accidentally
    // try to look them up as DB rows.
    if (
      pinned === 'codex_account' ||
      pinned === 'openai-oauth' ||
      pinned === 'xai-oauth' ||
      pinned === 'env'
    ) {
      return pinned;
    }

    // Real DB provider id, undefined (auto mode), or empty string —
    // defer to the canonical resolver. Same helper claude-client.ts +
    // codex/proxy/adapter.ts use at send time.
    const resolved = resolveProvider({
      ...(pinned ? { providerId: pinned } : {}),
    });

    // Virtual provider flags surface via _* booleans when the resolver
    // intercepts an id pattern. Preserve the id for downstream use.
    if (resolved._codexAccount) return 'codex_account';
    if (resolved._openaiOAuth) return 'openai-oauth';
    if (resolved._xaiOAuth) return 'xai-oauth';

    return resolved.provider?.id;
  } catch {
    return undefined;
  }
}
