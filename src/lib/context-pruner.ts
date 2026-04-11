/**
 * context-pruner.ts — Microcompact: prune old tool results before each API call.
 *
 * Reduces token usage by replacing detailed tool_result content from older
 * turns with a short summary. Recent turns are preserved in full.
 *
 * This runs before every streamText() call in the agent loop.
 */

import type { ModelMessage } from 'ai';

const RECENT_TURNS_TO_KEEP = 16; // Keep last N messages fully intact (~8 exchanges)

/**
 * Prune old tool results from message history to reduce token usage.
 *
 * Strategy:
 * - Last RECENT_TURNS_TO_KEEP messages: keep in full
 * - Older messages: replace tool-result content with a short marker
 * - Never modify user or system messages
 * - Keep tool-call info (name + args summary) for context
 */
export function pruneOldToolResults(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length <= RECENT_TURNS_TO_KEEP) {
    return messages; // nothing to prune
  }

  const cutoff = messages.length - RECENT_TURNS_TO_KEEP;

  return messages.map((msg, index) => {
    if (index >= cutoff) return msg; // recent — keep as-is

    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      // Truncate tool result content
      return {
        ...msg,
        content: (msg.content as Array<{ type: string; [k: string]: unknown }>).map((part) => {
          if (part.type === 'tool-result') {
            const toolName = ('toolName' in part && typeof part.toolName === 'string') ? part.toolName : 'unknown';
            const original = ('output' in part && part.output && typeof part.output === 'object' && 'value' in (part.output as Record<string, unknown>))
              ? String((part.output as Record<string, string>).value) : '';
            const excerpt = original.slice(0, 200);
            const marker = `[Pruned ${toolName} result${excerpt ? ': ' + excerpt + (original.length > 200 ? '...' : '') : ''}]`;
            return {
              ...part,
              output: { type: 'text' as const, value: marker },
            };
          }
          return part;
        }),
      } as ModelMessage;
    }

    return msg;
  });
}

/**
 * Estimate token count for a message array.
 * Rough heuristic: ~4 chars per token for English, ~2 for CJK.
 */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part && typeof part.text === 'string') {
          chars += part.text.length;
        } else if ('input' in part) {
          chars += JSON.stringify(part.input).length;
        } else if ('output' in part) {
          chars += JSON.stringify(part.output).length;
        }
      }
    }
  }

  // Rough estimate: mix of English (~4 chars/token) and code (~3.5 chars/token)
  return Math.ceil(chars / 3.5);
}

/**
 * Check if the message history exceeds a token threshold.
 * Used by agent-loop to decide when to trigger auto-compact.
 */
export function shouldAutoCompact(messages: ModelMessage[], contextWindowTokens: number): boolean {
  const estimated = estimateTokens(messages);
  // Trigger at 80% of context window
  return estimated > contextWindowTokens * 0.8;
}
