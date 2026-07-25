/**
 * Context Compressor — automatic conversation compression engine.
 *
 * When estimated context usage exceeds 80% of the window, compresses older
 * messages into a summary stored in the session. Subsequent fallback contexts
 * use "summary + recent messages" instead of raw full history.
 *
 * Model resolution uses `resolveAuxiliaryModel('compact')` from
 * provider-resolver.ts, which gives us the 5-tier fallback chain:
 *   1. Per-task env override (AUXILIARY_COMPACT_PROVIDER/_MODEL)
 *   2. Main provider's roleModels.small (if not sdkProxyOnly)
 *   3. Main provider's roleModels.haiku
 *   4. Other non-sdkProxyOnly provider's small/haiku slot
 *   5. Main provider + main model (ultimate floor — never null)
 *
 * This was upgraded from the simpler `resolveProvider({ useCase: 'small' })`
 * call in an earlier version, which only implemented tier 2 and had no
 * cross-provider fallback for sdkProxyOnly main providers. See
 * docs/research/hermes-agent-analysis.md §3.2 and docs/exec-plans/active/
 * hermes-inspired-runtime-upgrade.md task 3.5b for the rationale.
 */

import { roughTokenEstimate } from './context-estimator';

// ── Types ────────────────────────────────────────────────────────────

export interface CompressionResult {
  summary: string;
  messagesCompressed: number;
  estimatedTokensSaved: number;
}

/**
 * Payload shape for the `context_compressed` SSE status event. Both the
 * pre-compression wrapper (app/api/chat/route.ts) and the reactive-compact
 * retry path (claude-client.ts) MUST emit this exact shape — the SSE consumer
 * at useSSEStream.ts dispatches onContextCompressed only when
 * `subtype === 'context_compressed'`. An earlier shape
 * `{ message: 'context_compressed' }` was silently ignored after the consumer
 * was upgraded; see sse-stream.test.ts for the locked-in contract.
 */
export function buildContextCompressedStatus(stats: {
  messagesCompressed: number;
  tokensSaved?: number;
}): {
  notification: true;
  subtype: 'context_compressed';
  message: string;
  stats: { messagesCompressed: number; tokensSaved: number };
} {
  const messagesCompressed = stats.messagesCompressed;
  const tokensSaved = stats.tokensSaved ?? 0;
  const message = tokensSaved > 0
    ? `Context compressed: ${messagesCompressed} older messages summarized, ~${tokensSaved.toLocaleString()} tokens saved`
    : `Context compressed: ${messagesCompressed} older messages summarized`;
  return {
    notification: true,
    subtype: 'context_compressed',
    message,
    stats: { messagesCompressed, tokensSaved },
  };
}

/**
 * Decide what (sdkSessionId, conversationHistory) to hand to streamClaude
 * after a compaction attempt.
 *
 * Rule: once CodePilot has produced a fresh context_summary (manual /compact or
 * auto pre-compression), we MUST stop resuming the old SDK session. Otherwise
 * the Claude Code SDK resumes with its own full transcript and ignores our
 * summary, defeating the whole point of compressing. On the next turn the
 * context would still blow past the window and trigger reactive compact again.
 *
 * When `compressed` is true:
 *   - sdkSessionId is cleared (caller must also updateSdkSessionId(id, '') in DB)
 *   - conversationHistory is truncated to `messagesToKeep`, so fallback context
 *     is {summary + messagesToKeep + prompt} — not {summary + full history}
 *     (which would double-count the turns summary already covers)
 *
 * When `compressed` is false, the original values pass through unchanged.
 *
 * This is a pure function so the handoff contract is unit-testable without
 * standing up the full chat route.
 */
export function planStreamHandoffAfterCompaction<T>(input: {
  compressed: boolean;
  originalHistory: T[];
  messagesToKeep: T[];
  originalSdkSessionId: string | undefined;
}): {
  sdkSessionId: string | undefined;
  conversationHistory: T[];
} {
  if (input.compressed) {
    return {
      sdkSessionId: undefined,
      conversationHistory: input.messagesToKeep,
    };
  }
  return {
    sdkSessionId: input.originalSdkSessionId,
    conversationHistory: input.originalHistory,
  };
}

/**
 * Filter DB history to messages strictly after the compact coverage boundary.
 *
 * The boundary is `chat_sessions.context_summary_boundary_rowid` — the
 * SQLite rowid of the last message ACTUALLY covered by the current summary.
 * Messages with `_rowid <= boundary` are in the summary; messages with
 * `_rowid > boundary` are post-compaction turns not yet covered and MUST
 * stay. Pass `0` as boundary when unknown (legacy rows, reactive compact
 * paths with no DB rowid metadata) — filter then passes history through
 * unchanged.
 *
 * Why rowid and not created_at: earlier iterations used timestamps. DB
 * addMessage writes `YYYY-MM-DD HH:MM:SS` (second precision). If the last
 * compressed message and the first kept message land in the same second —
 * very possible on fast paths — the strict-greater-than filter would either
 * drop the first kept message (if > boundary timestamp) or keep a
 * compressed message (if >= boundary). rowid is monotonic per insert and
 * disambiguates regardless of wall-clock precision. Claude Code's own
 * compact implementation uses message uuids for the same reason (see
 * compact.ts:328, messages.ts:4530).
 *
 * Do NOT pass summary WRITE time (context_summary_updated_at) here; that's a
 * different quantity — write time lands AFTER the current user turn's
 * created_at on the auto pre-compression path, which would silently drop
 * the unsummarized user turn. Always use last-covered rowid.
 *
 * Filter is NOT gated on sdk_session_id. A historical version passed through
 * when sdk_session_id was set, assuming SDK resume ignored our local
 * history. Wrong — the same history feeds assembleContext,
 * estimateContextTokens, and needsCompression. streamClaude's SDK-resume
 * path runs with useHistory=false and never reads conversationHistory, so
 * filtering uniformly is safe for resume and correct for estimation.
 *
 * Messages without `_rowid` (synthesized in-memory objects, not loaded from
 * DB via `getMessages`) are always kept — they can't be compared against
 * the rowid boundary.
 */
export function filterHistoryByCompactBoundary<T extends { _rowid?: number }>(input: {
  history: T[];
  summary: string;
  summaryBoundaryRowid: number;
}): T[] {
  if (!input.summary || input.summaryBoundaryRowid <= 0) return input.history;
  const boundary = input.summaryBoundaryRowid;
  return input.history.filter(m => m._rowid == null || m._rowid > boundary);
}

/**
 * Derive the coverage boundary rowid to persist after a reactive compact
 * (CONTEXT_TOO_LONG retry inside streamClaude).
 *
 * Reactive compact, as currently implemented in claude-client.ts, hands the
 * ENTIRE `conversationHistory` to `compressConversation` (no keep/compress
 * split). So the last row of that history whose `_rowid` is known is, by
 * construction, the last DB row this summary covers. If the caller plumbed
 * through `_rowid` metadata, we use that rowid.
 *
 * RESULT IS NEVER LOWER THAN `existingBoundaryRowid`. Two layers of guard:
 *
 *   1. If no row carries a `_rowid` (synthetic callers, stripped metadata),
 *      fall back to `existingBoundaryRowid`. A degraded reactive compact
 *      MUST NOT reset a previously-established boundary to 0, otherwise
 *      the next turn's filter silently regresses to passthrough and
 *      CodePilot re-feeds already-summarized rows.
 *
 *   2. If some row DOES carry a `_rowid` but it's lower than
 *      `existingBoundaryRowid` (e.g. caller accidentally passed unfiltered
 *      history, or mixed old + new rows), we still return
 *      `existingBoundaryRowid`. Boundary only advances — never retreats.
 *      Under current route invariants this never fires (history is
 *      boundary-filtered upstream), but belt-and-suspenders against future
 *      callers that don't filter.
 *
 * Returns 0 only when both the history has no known rowid AND no existing
 * boundary was provided — first-ever reactive compact on a session whose
 * caller didn't plumb rowids.
 *
 * IMPORTANT: this relies on the invariant that reactive compact compresses
 * the WHOLE conversationHistory. If a future refactor splits reactive into
 * messagesToCompress/messagesToKeep (as auto pre-compression already does),
 * "last _rowid in history" is no longer "last covered rowid" — the boundary
 * must then come from the last ROW ACTUALLY COMPRESSED. Update both the
 * caller and this helper together.
 */
export function resolveReactiveCompactBoundaryRowid(input: {
  history: Array<{ _rowid?: number }>;
  existingBoundaryRowid: number;
}): number {
  const existing = input.existingBoundaryRowid > 0 ? input.existingBoundaryRowid : 0;
  for (let i = input.history.length - 1; i >= 0; i--) {
    const rowid = input.history[i]?._rowid;
    if (typeof rowid === 'number' && rowid > 0) {
      return Math.max(rowid, existing);
    }
  }
  return existing;
}

export interface CompressParams {
  sessionId: string;
  messages: Array<{ role: string; content: string }>;
  existingSummary?: string;
  providerId?: string;
  /** Session model to use as fallback if small/haiku is unavailable */
  sessionModel?: string;
}

// ── Circuit breaker ─────────────────────────────────────────────────

const compressionFailures = new Map<string, number>();
const MAX_CONSECUTIVE_FAILURES = 3;

export function shouldCompress(sessionId: string): boolean {
  return (compressionFailures.get(sessionId) || 0) < MAX_CONSECUTIVE_FAILURES;
}

function recordFailure(sessionId: string): void {
  compressionFailures.set(sessionId, (compressionFailures.get(sessionId) || 0) + 1);
}

function recordSuccess(sessionId: string): void {
  compressionFailures.delete(sessionId);
}

/** Reset circuit breaker for a session (e.g., on manual /compact). */
export function resetCompressionState(sessionId: string): void {
  compressionFailures.delete(sessionId);
}

// ── Compression threshold check ─────────────────────────────────────

const COMPRESSION_THRESHOLD = 0.8; // 80% of context window

/**
 * Check whether context should be compressed based on estimated usage.
 */
export function needsCompression(
  estimatedTokens: number,
  contextWindow: number,
  sessionId: string,
): boolean {
  if (contextWindow <= 0) return false;
  if (!shouldCompress(sessionId)) return false;
  return (estimatedTokens / contextWindow) >= COMPRESSION_THRESHOLD;
}

// ── Main compression function ───────────────────────────────────────

/**
 * Compress older conversation messages into a concise summary.
 *
 * Takes messages that would be truncated by the token budget and summarizes
 * them. If an existing summary exists, incorporates it as prior context.
 */
export async function compressConversation(params: CompressParams): Promise<CompressionResult> {
  const { sessionId, messages, existingSummary, providerId, sessionModel } = params;

  if (messages.length === 0) {
    return { summary: existingSummary || '', messagesCompressed: 0, estimatedTokensSaved: 0 };
  }

  try {
    const { generateTextViaSdk } = await import('./claude-client');
    const { resolveAuxiliaryModel } = await import('./provider-resolver');
    const { normalizeMessageContent } = await import('./message-normalizer');

    // Resolve auxiliary model via the 5-tier chain introduced in task 3.2.
    // Produces { providerId, modelId, source } — never null.
    // When `source === 'main_floor'`, the chain found no small/haiku slot
    // anywhere, so compression will run on the main model (at main-model
    // cost). This is an intentional floor so compression never silently
    // fails just because no cheap model is configured.
    //
    // **Session context is critical**: pass providerId + sessionModel so
    // that "main" resolves to THIS session's active provider, not the
    // global default. Without this, a session that overrides the default
    // provider would get auxiliary models from the wrong credentials.
    const auxiliary = resolveAuxiliaryModel('compact', {
      callScene: 'active_turn_compact',
      providerId,
      sessionProviderId: providerId,
      sessionModel,
    });

    // Prefer the task-level override's provider/model when it gave us one
    // that matches neither null nor the main. Otherwise we keep the
    // caller-supplied providerId so SDK subprocess routing stays stable.
    const effectiveModel = auxiliary.modelId || sessionModel || 'haiku';
    const effectiveProviderId = auxiliary.providerId !== 'env' ? auxiliary.providerId : providerId;

    if (auxiliary.source === 'main_floor') {
      console.warn(
        `[context-compressor] No cheap auxiliary model configured — ` +
        `falling back to main provider/model (${effectiveProviderId}/${effectiveModel}). ` +
        `Set AUXILIARY_COMPACT_PROVIDER + AUXILIARY_COMPACT_MODEL or configure ` +
        `roleModels.small on a non-sdkProxyOnly provider to save cost.`,
      );
    }

    // Clean messages before summarizing: strip file metadata, extract tool summaries
    const formatted = messages.map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const cleaned = normalizeMessageContent(m.role, m.content);
      const content = cleaned.length > 800 ? cleaned.slice(0, 800) + '...' : cleaned;
      return `${role}: ${content}`;
    }).join('\n\n');

    const existingSummaryBlock = existingSummary
      ? `\n\nPrevious summary of even earlier conversation:\n${existingSummary}\n`
      : '';

    const system = `You are a conversation summarizer. Produce a concise summary that preserves:
- Key decisions and conclusions
- File paths, function names, and code references mentioned
- Open tasks or action items
- Important user preferences or constraints expressed
Do NOT include greetings, filler, or restate obvious context. Write in the same language as the conversation.`;

    const prompt = `Summarize the following conversation excerpt into a concise summary (max 500 words).${existingSummaryBlock}

Conversation to summarize:
${formatted}

Summary:`;

    // SDK subprocess for transport (compatible with third-party proxies),
    // model + provider selected via resolveAuxiliaryModel's 5-tier chain.
    const result = await generateTextViaSdk({
      callScene: 'active_turn_compact',
      providerId: effectiveProviderId || undefined,
      model: effectiveModel,
      system,
      prompt,
    });

    if (!result || result.trim().length < 10) {
      console.warn('[context-compressor] Summary too short:', result?.trim().length, 'chars');
      throw new Error('Compression produced empty or too-short summary');
    }

    const summary = result.trim();
    const originalTokens = messages.reduce((sum, m) => sum + roughTokenEstimate(m.content), 0);
    const summaryTokens = roughTokenEstimate(summary);

    recordSuccess(sessionId);

    return {
      summary,
      messagesCompressed: messages.length,
      estimatedTokensSaved: Math.max(0, originalTokens - summaryTokens),
    };
  } catch (error) {
    recordFailure(sessionId);
    console.error('[context-compressor] Compression failed:', error);
    throw error;
  }
}
