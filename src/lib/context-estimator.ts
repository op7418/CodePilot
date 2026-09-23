/**
 * Context Estimator — token estimation and context window budgeting.
 *
 * Provides rough token estimation (no API calls) for pre-flight context
 * size checks. Used by route.ts to decide whether to trigger compression,
 * and by the frontend to display context usage predictions.
 *
 * Estimation approach matches Claude Code's roughTokenCountEstimation:
 * - Default: 4 bytes per token
 * - JSON-dense content: 2 bytes per token
 */

// ── Token estimation ────────────────────────────────────────────────

/**
 * Rough token count estimate for a text string.
 * Uses byte length divided by bytes-per-token ratio.
 *
 * @param text - The text to estimate
 * @param isJson - If true, uses 2 bytes/token (JSON is denser); otherwise 4 bytes/token
 */
export function roughTokenEstimate(text: string, isJson = false): number {
  if (!text) return 0;
  const bytesPerToken = isJson ? 2 : 4;
  return Math.ceil(Buffer.byteLength(text, 'utf-8') / bytesPerToken);
}

/**
 * Estimate token count for a single message's content.
 * Detects JSON content automatically.
 */
export function estimateMessageTokens(content: string): number {
  if (!content) return 0;
  const isJson = content.startsWith('[') || content.startsWith('{');
  if (content.startsWith('[')) {
    try {
      const blocks: unknown = JSON.parse(content);
      if (Array.isArray(blocks) && blocks.some(block => block && typeof block === 'object' && 'nativeStep' in block)) {
        // Canonical replay duplicates the visible parts and carries opaque
        // signatures; neither is additional user/model text to budget twice.
        content = JSON.stringify(blocks.map(block => {
          if (!block || typeof block !== 'object') return block;
          const visible = { ...block };
          delete visible.nativeStep;
          return visible;
        }));
      }
    } catch { /* Plain text that starts with '[' keeps the existing estimate. */ }
  }
  return roughTokenEstimate(content, isJson);
}

// ── Context budget calculation ──────────────────────────────────────

export interface ContextEstimate {
  total: number;
  breakdown: {
    system: number;
    history: number;
    userMessage: number;
    summary: number;
  };
}

export interface ContextEstimateParams {
  systemPrompt?: string;
  history: Array<{ role: string; content: string }>;
  currentUserMessage: string;
  sessionSummary?: string;
}

/**
 * Estimate the total token count for the next API call's context.
 */
export function estimateContextTokens(params: ContextEstimateParams): ContextEstimate {
  const systemTokens = roughTokenEstimate(params.systemPrompt || '');
  const summaryTokens = roughTokenEstimate(params.sessionSummary || '');
  const userMessageTokens = roughTokenEstimate(params.currentUserMessage);

  let historyTokens = 0;
  for (const msg of params.history) {
    historyTokens += estimateMessageTokens(msg.content);
    historyTokens += 10; // role label overhead ("Human: " / "Assistant: ")
  }

  return {
    total: systemTokens + historyTokens + userMessageTokens + summaryTokens,
    breakdown: {
      system: systemTokens,
      history: historyTokens,
      userMessage: userMessageTokens,
      summary: summaryTokens,
    },
  };
}

// ── Context percentage + warning states ─────────────────────────────

export type ContextState = 'normal' | 'warning' | 'critical';

export interface ContextPercentage {
  percentage: number;
  state: ContextState;
  tokensRemaining: number;
}

/**
 * Calculate context usage percentage and warning state.
 *
 * @param estimatedTokens - Estimated total tokens for next turn
 * @param contextWindow - Total context window size in tokens
 */
export function calculateContextPercentage(
  estimatedTokens: number,
  contextWindow: number,
): ContextPercentage {
  if (contextWindow <= 0) {
    return { percentage: 0, state: 'normal', tokensRemaining: 0 };
  }

  const percentage = estimatedTokens / contextWindow;
  const tokensRemaining = contextWindow - estimatedTokens;

  let state: ContextState = 'normal';
  if (percentage >= 0.95) state = 'critical';
  else if (percentage >= 0.8) state = 'warning';

  return { percentage, state, tokensRemaining };
}
