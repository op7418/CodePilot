/**
 * Phase 5b — Provider parity inventory for the Codex proxy.
 *
 * Answers "which CodePilot providers / models can route through
 * Codex's `codepilot_proxy`?" so the picker UI can render disabled
 * rows with a *specific* reason instead of "Codex doesn't support
 * this model" (the wording Codex CLI smoke users push back on
 * because it implies permanence).
 *
 * Inventory dimensions:
 *
 *   provider_id       DB row id or 'env'.
 *   provider_name     User-visible.
 *   compat            ProviderRuntimeCompat tier.
 *   adapter_status    Per Phase 5b adapter readiness for that compat
 *                     tier — 'ready' / 'pending' / 'not_applicable'.
 *   excluded_reason   Populated when adapter_status !== 'ready'.
 *
 * The contract: for every NON-excluded codepilot_runtime-reachable
 * provider in the DB, the inventory must include an entry. A future
 * provider added to the DB or a future compat tier must trip the
 * `phase-5b-parity-contract` test until the adapter status is set
 * explicitly here.
 */

import type { ApiProvider, ProviderRuntimeCompat } from '@/types';
import { getProviderCompat } from '@/lib/runtime-compat';

/**
 * Per-tier adapter readiness for Phase 5b. Single source of truth.
 * Flip a value to 'ready' as each adapter ships; the picker reads
 * this and stops disabling rows for that tier.
 */
export const ADAPTER_STATUS_BY_COMPAT: Record<ProviderRuntimeCompat, ProxyAdapterStatus> = {
  // Native runtime never goes through the proxy — Codex Account
  // routes through Codex's own app-server, not via codepilot_proxy.
  codex_account: 'not_applicable',
  // Image / video / embedding don't surface in chat picker.
  media_only: 'not_applicable',
  // The three real adapter targets are now wired via the unified
  // translator (Phase 5b). Provider differences are absorbed by
  // ai-sdk's per-tier SDK selection inside `createModel()`, so the
  // same translation layer serves all three families.
  claude_code_ready: 'ready',
  claude_code_verified: 'ready',
  claude_code_experimental: 'ready',
  openrouter_anthropic_skin: 'ready',
  codepilot_only: 'ready',
  // Unknown stays pending — we don't know which wire format an
  // unrecognised provider speaks, so the safe default is to surface
  // a clear error instead of guessing.
  unknown: 'pending',
};

export type ProxyAdapterStatus = 'ready' | 'pending' | 'not_applicable';

export type AdapterFamily = 'openai_compatible' | 'anthropic_compatible' | 'codeplan' | 'native';

/** Which adapter family a compat tier maps to. */
export const ADAPTER_FAMILY_BY_COMPAT: Record<ProviderRuntimeCompat, AdapterFamily> = {
  // Codex Account routes through Codex natively, never via the proxy.
  codex_account: 'native',
  media_only: 'native',
  // Anthropic-shape wire (proper Messages-API). Phase 5b's
  // Anthropic-compat adapter handles these.
  claude_code_ready: 'anthropic_compatible',
  openrouter_anthropic_skin: 'anthropic_compatible',
  // Verified + experimental are CodePlan / 套餐型 brands speaking
  // Anthropic wire format. Same adapter family as claude_code_ready
  // mechanically but classified separately because they carry
  // brand-specific alias mapping (GLM / Kimi / 百炼 / MiniMax /
  // DeepSeek) that the CodePlan adapter is responsible for honoring.
  claude_code_verified: 'codeplan',
  claude_code_experimental: 'codeplan',
  // OpenAI chat-completions wire.
  codepilot_only: 'openai_compatible',
  // Unknown — best-guess to OpenAI-compatible since chat/completions
  // is the more common third-party shape; adapter surfaces the
  // failure cleanly if it doesn't fit.
  unknown: 'openai_compatible',
};

export interface ProviderParityEntry {
  provider_id: string;
  provider_name: string;
  compat: ProviderRuntimeCompat;
  adapter_family: AdapterFamily;
  adapter_status: ProxyAdapterStatus;
  /** Populated when status !== 'ready'. UI tooltip uses this. */
  excluded_reason?: string;
}

/**
 * Snapshot of the proxy's parity surface for one provider. Pure
 * function — doesn't read the DB; caller passes ApiProvider records
 * in. Picker tooltip + Settings inventory both call this.
 */
export function getProxyParityEntry(provider: ApiProvider): ProviderParityEntry {
  const compat = getProviderCompat(provider);
  const family = ADAPTER_FAMILY_BY_COMPAT[compat];
  const status = ADAPTER_STATUS_BY_COMPAT[compat];
  return {
    provider_id: provider.id,
    provider_name: provider.name,
    compat,
    adapter_family: family,
    adapter_status: status,
    ...(status === 'ready' || status === 'not_applicable'
      ? {}
      : { excluded_reason: pendingReason(family) }),
  };
}

function pendingReason(family: AdapterFamily): string {
  // Phase 5b shipped the unified translator for every known family,
  // so the only path that hits this is the `unknown` provider tier
  // (which the parity registry routes to `openai_compatible` as a
  // best guess). The copy explains that the proxy refuses to guess
  // the wire format rather than silently picking the wrong one.
  switch (family) {
    case 'openai_compatible':
      return 'Codex provider proxy: provider wire format not recognised. Set the provider protocol explicitly so the proxy can pick the right translator.';
    case 'anthropic_compatible':
      return 'Codex provider proxy: Anthropic-compatible adapter currently disabled.';
    case 'codeplan':
      return 'Codex provider proxy: CodePlan / brand-shaped adapter currently disabled.';
    case 'native':
      // Should never be returned — native maps to not_applicable.
      // Defensive fallback.
      return 'Provider does not route through the Codex proxy.';
  }
}

/**
 * Build the bilingual disabled-state copy the chat picker shows on
 * a CodePilot provider model row under Codex Runtime. Phase 5b
 * shipped the translator for every known family, so this only fires
 * for the `unknown` provider tier today; the wording reflects "wire
 * format unidentified" rather than "adapter in progress".
 */
export function pickerDisabledReason(family: AdapterFamily, isZh: boolean): string {
  if (isZh) {
    switch (family) {
      case 'openai_compatible':
        return 'Codex provider proxy 暂未识别该 provider 的 wire format；请在 provider 设置里显式选 OpenAI 兼容 / Anthropic 兼容';
      case 'anthropic_compatible':
        return 'Codex provider proxy 的 Anthropic / ClaudeCode 兼容 adapter 当前已停用';
      case 'codeplan':
        return 'Codex provider proxy 的 CodePlan / 套餐型 adapter 当前已停用';
      case 'native':
        return '该服务商不通过 Codex provider proxy';
    }
  }
  switch (family) {
    case 'openai_compatible':
      return 'Codex provider proxy: provider wire format unidentified — set the provider protocol explicitly';
    case 'anthropic_compatible':
      return 'Codex provider proxy: Anthropic / ClaudeCode-compatible adapter currently disabled';
    case 'codeplan':
      return 'Codex provider proxy: CodePlan / brand-shaped adapter currently disabled';
    case 'native':
      return 'This provider does not route through the Codex proxy';
  }
}
