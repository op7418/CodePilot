/**
 * provider-presence.ts — Single-source-of-truth: "does CodePilot itself have
 * a usable provider to talk to a model with?"
 *
 * Scope (intentionally narrow, by user requirement 2026-04-15):
 *   - DB provider records with usable auth (api_key, Bedrock/Vertex flag)
 *   - process.env.ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
 *   - Legacy DB setting `anthropic_auth_token`
 *   - OpenAI OAuth session (virtual provider, no DB record required)
 *
 * Out of scope (intentionally NOT checked):
 *   - ~/.claude/settings.json env block (cc-switch, hand-edit) — that file
 *     lives under the Claude Code CLI's ownership; CodePilot treats CLI login
 *     state as "not our business". A user with only settings.json and no
 *     CodePilot-level provider will be intercepted and asked to add one.
 *
 * Used by:
 *   - `/api/chat` entry precheck (412 + NEEDS_PROVIDER_SETUP when false)
 *   - `/api/setup` Provider card status (kept in lockstep to avoid the
 *     "intercepted at chat but setup shows green" skew)
 *   - ProviderCard consumes `/api/setup` output, so it inherits the same
 *     judgement transitively.
 */

import type { ApiProvider } from '@/types';
import { getSetting, getAllProviders } from '@/lib/db';
import { isOAuthUsable } from '@/lib/openai-oauth-manager';
import { isXaiOAuthUsable } from '@/lib/xai-oauth-manager';

/**
 * True when a single DB provider has credentials CodePilot can dispatch on.
 *
 * Checks (in order):
 *   1. api_key non-empty
 *   2. Bedrock / Vertex routing flag in env_overrides_json OR legacy extra_env
 *
 * Mirrors the resolver's `env_overrides_json || extra_env` precedence
 * (see `provider-resolver.ts:703`) so we never say "no provider configured"
 * while the resolver would actually accept the same record.
 */
export function providerHasUsableCodePilotAuth(p: ApiProvider): boolean {
  if (p.api_key) return true;

  const raw = p.env_overrides_json || p.extra_env || '';
  if (!raw) return false;

  // Legacy `extra_env` was historically a raw JSON blob as well, so the same
  // parse handles both columns. Fall back to substring match only when JSON
  // parsing fails, preserving backwards compat with any malformed records.
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      const bedrock = parsed.CLAUDE_CODE_USE_BEDROCK;
      const vertex = parsed.CLAUDE_CODE_USE_VERTEX;
      if (bedrock != null && bedrock !== '' && bedrock !== '0' && bedrock !== false) return true;
      if (vertex != null && vertex !== '' && vertex !== '0' && vertex !== false) return true;
    }
  } catch {
    // Legacy plaintext — fall through to substring match
    if (raw.includes('CLAUDE_CODE_USE_BEDROCK')) return true;
    if (raw.includes('CLAUDE_CODE_USE_VERTEX')) return true;
  }

  return false;
}

/**
 * True when CodePilot has at least one provider the backend can dispatch to.
 *
 * fail-open on DB errors: if a read throws (e.g. not initialized yet in a
 * cold worker), we return `true` and let the downstream resolver produce the
 * real error. Rationale: blocking the user on a transient DB glitch is worse
 * than letting the request surface an accurate upstream error.
 */
export function hasCodePilotProvider(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return true;
  }

  try {
    if (getSetting('anthropic_auth_token')) return true;
  } catch {
    // getSetting failing is severe enough to fail-open
    return true;
  }

  // OpenAI OAuth is a virtual provider (no DB record) that the resolver
  // recognises under providerId='openai-oauth'. isOAuthUsable() is the
  // synchronous precheck shared with native-runtime's own auth path.
  try {
    if (isOAuthUsable()) return true;
  } catch {
    return true;
  }

  try {
    if (isXaiOAuthUsable()) return true;
  } catch {
    return true;
  }

  try {
    for (const p of getAllProviders()) {
      if (providerHasUsableCodePilotAuth(p)) return true;
    }
  } catch {
    return true;
  }

  return false;
}
