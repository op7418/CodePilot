import { normalizeMessageContent, microCompactMessage } from './message-normalizer';
import { roughTokenEstimate } from './context-estimator';

/**
 * Build fallback context from conversation history with token-budget awareness.
 *
 * Instead of a fixed message count, walks backward from the newest message
 * and includes as many as fit within the token budget. Optionally prepends
 * a session summary as a context skeleton for the full conversation.
 */
export function buildFallbackContext(params: {
  prompt: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  sessionSummary?: string;
  tokenBudget?: number;
  /** Codex normal provider continuation has already selected intact turns by
   * budget. Claude's emergency fallback keeps its existing microcompaction. */
  preserveContent?: boolean;
}): string {
  const { prompt, history, sessionSummary, tokenBudget } = params;
  if (!history || history.length === 0) {
    if (sessionSummary) {
      return `<session-summary>\n${sessionSummary}\n</session-summary>\n\n${prompt}`;
    }
    return prompt;
  }

  // Normalize + microcompact: strip metadata, summarize tool blocks, truncate old messages
  const normalized = history.map((msg, i) => ({
    role: msg.role,
    content: params.preserveContent ? normalizeMessageContent(msg.role, msg.content) : microCompactMessage(
      msg.role,
      normalizeMessageContent(msg.role, msg.content),
      history.length - 1 - i, // ageFromEnd: 0 = newest
    ),
  }));

  // Select messages within token budget (walk backward from newest).
  // Floor at 10K tokens so even extreme sessions keep some recent context.
  const effectiveBudget = tokenBudget != null ? Math.max(tokenBudget, 10000) : undefined;
  let selected: typeof normalized;
  if (effectiveBudget) {
    selected = [];
    let accumulated = 0;
    for (let i = normalized.length - 1; i >= 0; i--) {
      const msgTokens = roughTokenEstimate(normalized[i].content) + 10; // role label overhead
      if (accumulated + msgTokens > effectiveBudget) break;
      selected.unshift(normalized[i]);
      accumulated += msgTokens;
    }
  } else {
    selected = normalized;
  }

  // Build the output
  const lines: string[] = [];

  if (sessionSummary) {
    lines.push('<session-summary>');
    lines.push(sessionSummary);
    lines.push('</session-summary>');
    lines.push('');
  }

  lines.push('<conversation_history>');
  lines.push('(This is a summary of earlier conversation turns for context. <prior-tool-call .../> and <prior-reasoning>...</prior-reasoning> are metadata markers describing what already happened — they are NOT assistant output format. Do not reproduce these tags. To call a tool, emit a real tool_use block; do not write tool calls as prose or as these markers.)');
  for (const msg of selected) {
    lines.push(`${msg.role === 'user' ? 'Human' : 'Assistant'}: ${msg.content}`);
  }
  lines.push('</conversation_history>');
  lines.push('');
  lines.push(prompt);
  return lines.join('\n');
}
