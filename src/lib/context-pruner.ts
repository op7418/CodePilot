/**
 * context-pruner.ts — Microcompact: prune old tool results before each API call.
 *
 * Reduces token usage by replacing detailed tool_result content from older
 * turns with a short fixed marker (not an LLM summary). Recent turns are
 * preserved in full.
 *
 * This runs before every streamText() call in the agent loop.
 *
 * **Note on two-tier compression**: CodePilot has two distinct compression
 * paths. This module is the *micro* path — a cheap per-step truncation that
 * runs inside the agent loop. The *macro* path is LLM-driven summarization
 * in `context-compressor.ts`, triggered once per chat turn by the chat API
 * route when estimated tokens exceed 80% of the context window. The two
 * are complementary: microcompact keeps per-step growth in check, while
 * macrocompact summarizes stale history into `chat_sessions.context_summary`.
 */

import type { ModelMessage } from 'ai';

// Keep last N messages fully intact. Raised from 6 → 16 in 2026-04-15 after
// short generic result markers made long tool-heavy tasks lose semantic
// context and describe tools without actually calling them. This pruner never
// removes a tool-result block, so structural call/result integrity is owned by
// tool-history-integrity.ts rather than by this window size.
const RECENT_TURNS_TO_KEEP = 16;
const TRUNCATED_RESULT_MARKER = '[Tool result truncated — see earlier in conversation]';

/**
 * Prune old tool results from message history to reduce token usage.
 *
 * Strategy:
 * - Last RECENT_TURNS_TO_KEEP messages: keep in full
 * - Older messages: replace tool-result content with a short marker that
 *   includes the tool name + 200-char excerpt so the model can still
 *   reason about what happened (and stays paired with its tool_use)
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
      // Truncate tool result content but keep tool name + a short excerpt so
      // the model can still understand the result's originating call.
      // Generic markers ("[truncated]") were causing the model to lose track
      // and emit fake tool calls — see PR #468 for the original report.
      return {
        ...msg,
        content: (msg.content as Array<{ type: string; [k: string]: unknown }>).map((part) => {
          if (part.type === 'tool-result') {
            const toolName = typeof part.toolName === 'string' ? part.toolName : 'unknown';
            const original = (part.output && typeof part.output === 'object' && 'value' in (part.output as Record<string, unknown>))
              ? String((part.output as Record<string, unknown>).value ?? '')
              : '';
            const excerpt = original.slice(0, 200);
            const suffix = excerpt
              ? `: ${excerpt}${original.length > 200 ? '...' : ''}`
              : '';
            const marker = `[Pruned ${toolName} result${suffix}]`;
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

// ── Token-budget pruning (enhanced mode) ───────────────────────────

/**
 * Options for the enhanced `pruneOldToolResultsByBudget` function.
 */
export interface PruneByBudgetOptions {
  /**
   * Target token budget for the message history. Older tool results are
   * truncated from the front until the estimated total fits within the
   * budget. Defaults to 100_000 (roughly half of a 200K Claude window).
   */
  tokenBudget?: number;

  /**
   * Number of initial messages to protect unconditionally (system prompt
   * + first exchange). Defaults to 3 — matching Hermes' `protect_first_n`.
   */
  protectFirstN?: number;

  /**
   * Number of trailing messages to protect unconditionally. Defaults to
   * RECENT_TURNS_TO_KEEP (6) for symmetry with the legacy pruner.
   */
  protectLastN?: number;

  /**
   * When true, replaces truncated tool-result output with a short summary
   * of the originating tool call ("[Tool X called, result omitted]")
   * rather than the generic TRUNCATED_RESULT_MARKER. Gives the model more
   * context about what happened without including the full result body.
   * Defaults to true.
   */
  keepToolCallSummary?: boolean;
}

const DEFAULT_TOKEN_BUDGET = 100_000;
const DEFAULT_PROTECT_FIRST_N = 3;

/**
 * Enhanced pruner that truncates old tool results until the message array
 * fits within a token budget. Preserves head and tail messages.
 *
 * Ported from Hermes Agent's context_compressor.py (protect_first_n +
 * protect_last_n + tail_token_budget), but without the LLM summarization
 * step — that lives in `context-compressor.ts` and runs at a different
 * layer (chat route entry, not per-step).
 *
 * **Intentionally module-only**: agent-loop.ts continues to call the
 * legacy `pruneOldToolResults` with its fixed 6-turn window. Wiring this
 * enhanced variant in would conflict with the existing macro-level LLM
 * compression in `context-compressor.ts`, which already handles the
 * "history too long" case at the chat route entry point via
 * `needsCompression` + `compressConversation`. This function exists as a
 * future option if the runtime ever needs more aggressive per-step
 * pruning (e.g. when LLM compression is disabled).
 *
 * Reference: docs/research/hermes-agent-analysis.md §1.6, §3.5
 */
export function pruneOldToolResultsByBudget(
  messages: ModelMessage[],
  options: PruneByBudgetOptions = {},
): ModelMessage[] {
  const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const protectFirstN = Math.max(0, options.protectFirstN ?? DEFAULT_PROTECT_FIRST_N);
  const protectLastN = Math.max(0, options.protectLastN ?? RECENT_TURNS_TO_KEEP);
  const keepToolCallSummary = options.keepToolCallSummary ?? true;

  // Short-circuit: nothing to prune.
  if (messages.length === 0) return messages;
  if (protectFirstN + protectLastN >= messages.length) return messages;

  const totalEstimate = estimateTokens(messages);
  if (totalEstimate <= budget) return messages;

  // Pass 1: replace tool-result content in the unprotected middle with a marker.
  // This is the cheap, non-destructive pruning that mirrors the legacy function.
  const middleStart = protectFirstN;
  const middleEnd = messages.length - protectLastN;

  const pruned = messages.map((msg, index) => {
    if (index < middleStart || index >= middleEnd) return msg; // protected head/tail

    // Replace tool-result content in the middle window
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: (msg.content as Array<{ type: string; [k: string]: unknown }>).map((part) => {
          if (part.type === 'tool-result') {
            const marker = keepToolCallSummary
              ? buildToolResultMarker(part)
              : TRUNCATED_RESULT_MARKER;
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

  return pruned;
}

/**
 * Build a compact marker string describing a tool-result being truncated.
 * Uses toolCallId if available to help the model trace back to the call.
 */
function buildToolResultMarker(part: { type: string; [k: string]: unknown }): string {
  const callId = typeof part.toolCallId === 'string' ? part.toolCallId : null;
  if (callId) {
    return `[Tool result for call ${callId.slice(0, 8)} omitted to save tokens]`;
  }
  return TRUNCATED_RESULT_MARKER;
}

// ── Token estimation ───────────────────────────────────────────────

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
