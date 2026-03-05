/**
 * Provider model resolution mapping.
 * 
 * Maps CodePilot internal aliases (sonnet/opus/haiku) to actual API model names
 * for each provider's base_url. This is the single source of truth for model
 * name resolution across the codebase.
 * 
 * Used by:
 * - claude-client.ts: Resolves model aliases when calling provider APIs directly
 * - api/providers/models/route.ts: Provides model options in the UI selector
 * 
 * Must be kept in sync when adding new providers or updating model names.
 */
export const PROVIDER_MODEL_RESOLUTION: Record<string, Record<string, string>> = {
  'https://api.moonshot.cn/anthropic': { sonnet: 'kimi-k2.5', opus: 'kimi-k2.5', haiku: 'kimi-k2.5' },
  'https://api.moonshot.ai/anthropic': { sonnet: 'kimi-k2.5', opus: 'kimi-k2.5', haiku: 'kimi-k2.5' },
  'https://api.kimi.com/coding/': { sonnet: 'kimi-k2.5', opus: 'kimi-k2.5', haiku: 'kimi-k2.5' },
  'https://api.z.ai/api/anthropic': { sonnet: 'glm-4.7', opus: 'glm-5', haiku: 'glm-4.5-air' },
  'https://open.bigmodel.cn/api/anthropic': { sonnet: 'glm-4.7', opus: 'glm-5', haiku: 'glm-4.5-air' },
  'https://api.minimaxi.com/anthropic': { sonnet: 'MiniMax-M2.5', opus: 'MiniMax-M2.5', haiku: 'MiniMax-M2.5' },
  'https://api.minimax.io/anthropic': { sonnet: 'MiniMax-M2.5', opus: 'MiniMax-M2.5', haiku: 'MiniMax-M2.5' },
};
