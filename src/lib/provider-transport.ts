/**
 * provider-transport.ts — Provider transport capability detection.
 *
 * Determines HOW to talk to a provider (what wire protocol / request format).
 * This is separate from Runtime (WHO runs the agent loop).
 *
 * Three transport capabilities:
 * - standard-messages: Official Anthropic Messages API (api.anthropic.com only)
 *   → Uses @ai-sdk/anthropic directly
 * - claude-code-compat: ALL third-party Anthropic proxies (any non-official base URL)
 *   → Uses ClaudeCodeCompatAdapter (superset of standard Messages API)
 * - cloud-managed: AWS Bedrock / Google Vertex (their own auth + wrapper)
 *   → Uses dedicated AI SDK providers
 */

import { resolveProvider, type ResolvedProvider } from './provider-resolver';
import type { ProviderCallScene } from './provider-call-policy';

export type TransportCapability = 'standard-messages' | 'claude-code-compat' | 'cloud-managed';

/**
 * Detect the transport capability of the current provider.
 */
export function detectTransport(opts: {
  callScene: ProviderCallScene;
  providerId?: string;
  sessionProviderId?: string;
}): { transport: TransportCapability; resolved: ResolvedProvider } {
  const resolved = resolveProvider({
    callScene: opts.callScene,
    providerId: opts.providerId,
    sessionProviderId: opts.sessionProviderId,
  });

  const transport = inferTransport(resolved);
  return { transport, resolved };
}

function inferTransport(resolved: ResolvedProvider): TransportCapability {
  const protocol = resolved.protocol;

  // Cloud-managed providers have their own transport
  if (protocol === 'bedrock') return 'cloud-managed';
  if (protocol === 'vertex') return 'cloud-managed';

  // Non-anthropic protocols → standard
  if (protocol === 'openrouter' || protocol === 'openai-compatible') return 'standard-messages';
  if (protocol === 'xai') return 'standard-messages';
  if (protocol === 'google' || protocol === 'gemini-image') return 'standard-messages';
  if (protocol === 'openai-image') return 'standard-messages';

  // Anthropic protocol: official API vs third-party proxy
  if (protocol === 'anthropic') {
    const baseUrl = resolved.provider?.base_url || process.env.ANTHROPIC_BASE_URL;
    if (baseUrl) {
      try {
        const hostname = new URL(baseUrl).hostname;
        const isOfficial = hostname === 'api.anthropic.com' || hostname.endsWith('.anthropic.com');
        if (!isOfficial) return 'claude-code-compat';
      } catch {
        return 'claude-code-compat';
      }
    }
    // No base URL (env mode, official default) → standard
    return 'standard-messages';
  }

  return 'standard-messages';
}

/**
 * Check if NativeRuntime can directly talk to this provider.
 * All transports are now native-compatible thanks to ClaudeCodeCompatAdapter.
 */
export function isNativeCompatible(transport: TransportCapability): boolean {
  return transport === 'standard-messages' || transport === 'cloud-managed' || transport === 'claude-code-compat';
}
