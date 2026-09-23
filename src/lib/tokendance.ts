/** Public TokenDance contract. Safe to import from the renderer. */
export const TOKENDANCE_ORIGIN = 'https://tokendance.space';
export const TOKENDANCE_APP_URL = 'https://www.codepilot.sh/';
export const TOKENDANCE_PRESETS = ['tokendance', 'tokendance-anthropic'] as const;

/** Product defaults, verified against the public catalog on 2026-09-05.
 * IDs are exact wire identities, not fuzzy family matches. */
export const TOKENDANCE_FEATURED_MODEL_IDS = [
  'glm-5.3', 'kimi-k3', 'minimax-m3', 'deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.3-flash',
] as const;

/** Claude Code protocol snapshot: https://tokendance.space/gateway/v1/models
 * 2026-09-05 supported_protocols includes anthropic:messages. Unknown IDs
 * remain Native/Codex-only until their Messages contract is verified. */
export const TOKENDANCE_ANTHROPIC_MODEL_IDS: ReadonlySet<string> = new Set([
  'glm-5', 'qwen3-max', 'minimax-m2.5', 'kimi-k2.5', 'minimax-m2.7', 'glm-4.5-air',
  'glm-5.1', 'qwen3-vl-plus', 'kimi-k2.6', 'deepseek-v4-pro', 'mimo-v2.5-pro',
  'mimo-v2.5', 'qwen3.7-plus', 'qwen3.7-max', 'step-3.7-flash', 'hy3-preview',
  'kimi-k2.7-code', 'glm-5.2', 'minimax-m3', 'deepseek-v4-flash-0731',
  'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'glm-5.3', 'dots-3-note-preview',
  'ling-3.0-flash', 'deepseek-v4-pro-0813', 'glm-5.3-flash', 'qwen3.8-flash',
  'spark-x2.5-1.7b', 'spark-x2.5-4b',
]);

export function isTokenDanceBaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.origin === TOKENDANCE_ORIGIN && !url.username && !url.password
      && !url.search && !url.hash && ['/gateway', '/gateway/v1'].includes(url.pathname.replace(/\/+$/, ''));
  } catch { return false; }
}

/** Protocol membership is authoritative; a model's name is not a capability. */
export function parseTokenDanceModels(body: unknown, protocol: string): { ids: string[] } {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('Invalid TokenDance model catalog');
  const required = protocol === 'anthropic' ? 'anthropic:messages' : 'openai:chat-completions';
  const ids: string[] = [];
  for (const model of data) {
    if (!model || typeof model.id !== 'string' || !Array.isArray(model.supported_protocols)) {
      throw new Error('Invalid TokenDance model protocol metadata');
    }
    if (model.supported_protocols.includes(required)) ids.push(model.id);
  }
  return { ids: [...new Set(ids)] };
}

export const TOKENDANCE_RECOVERY_ERRORS = {
  top_up_balance: '[TOKENDANCE_TOP_UP] TokenDance balance is insufficient. Top up your account at https://tokendance.space/ and retry; your API key is still valid.',
  reauthorize_api_key: '[TOKENDANCE_REAUTHORIZE] TokenDance API key is unavailable. Open Settings → Providers, edit this TokenDance connection and authorize again or replace its API key.',
  api_key_quota: '[TOKENDANCE_QUOTA] TokenDance API key has reached its periodic limit. Wait for the quota to reset, or edit this connection in Settings → Providers and authorize a new key.',
} as const;

export function tokenDanceRecoveryMessage(response: Response): string | undefined {
  if (response.ok) return undefined;
  const action = response.headers.get('TokenDance-Recovery-Action');
  return action && Object.hasOwn(TOKENDANCE_RECOVERY_ERRORS, action)
    ? TOKENDANCE_RECOVERY_ERRORS[action as keyof typeof TOKENDANCE_RECOVERY_ERRORS] : undefined;
}
