import { useMemo, useRef } from 'react';
import type { Message } from '@/types';
import { getContextWindow } from '@/lib/model-context';
import { walkContextUsage } from '@/lib/context-usage-walk';
import {
  buildContextUsageBreakdown,
  type ContextUsageBreakdown,
} from '@/lib/context-breakdown';
import { snapshotToCompilerInputs } from '@/lib/harness/context-accounting';

export interface ContextUsageData {
  modelName: string;
  contextWindow: number | null;
  /** Actual token usage from the last API response */
  used: number;
  /** Ratio of actual usage to context window */
  ratio: number;
  /** Estimated next-turn token usage (input + output + ~200 for new message overhead) */
  estimatedNextTurn: number;
  /** Ratio of estimated next-turn usage to context window */
  estimatedNextRatio: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  hasData: boolean;
  /** Warning state based on the higher of actual/estimated ratio */
  state: 'normal' | 'warning' | 'critical';
  /** Whether a session summary (compression) is active */
  hasSummary: boolean;
  /**
   * Data source the caller should render next to the number.
   * Phase 5 of agent-sdk-0-2-111:
   *   - 'snapshot': SDK.getContextUsage() capture <60s old (📌)
   *     — extension point, currently has no producer in the codebase;
   *     see claude-client.ts b65c6ac for why.
   *   - 'result_usage': computed from SDKResultMessage.usage's real
   *     input_tokens + cache_read + cache_creation fields (authoritative
   *     API numbers, not char-based estimation). This is the primary
   *     source on the chat page today (📌 accuracy, not ~ estimate).
   *   - 'none': no token data yet
   */
  source: 'snapshot' | 'result_usage' | 'none';
  /** When the snapshot was taken (epoch ms). Undefined for result_usage source. */
  snapshotCapturedAt?: number;
  /**
   * Phase 6 — 10-part token breakdown for the upcoming dot-matrix UI.
   *
   * Phase 1b wires only baseline (used / cacheRead / cacheCreation / output)
   * + contextWindow. Compiler-side fragments (system_prompt / tools / rules /
   * skills / mcp / memory) and composer pending sub-totals will land in
   * Phase 1c + Phase 2 when ChatView / MessageInput pipe them through.
   *
   * Until then, the breakdown surfaces non-zero only for `conversation`
   * and `cache_or_previous`; the other 8 parts read 0 — by design, so
   * consumers can render the dot-matrix shell without waiting for the
   * full data wire. The contract is the same as `buildContextUsageBreakdown`.
   */
  breakdown: ContextUsageBreakdown;
}

const SNAPSHOT_FRESHNESS_MS = 60_000;

/**
 * Extract a stable fingerprint from the messages array.
 * This avoids recomputing context usage when messages array reference
 * changes but the actual token usage data hasn't changed.
 *
 * The fingerprint captures:
 * - Number of messages (length)
 * - Last assistant message's token_usage (the most recent API response)
 * - Whether the array has a summary message
 */
function getMessagesFingerprint(messages: Message[]): string {
  if (messages.length === 0) return 'empty';

  // Find the last assistant message with token_usage
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.token_usage) {
      return `${messages.length}:${msg.token_usage}`;
    }
  }

  return `${messages.length}:no-usage`;
}

export function useContextUsage(
  messages: Message[],
  modelName: string,
  options?: {
    context1m?: boolean;
    hasSummary?: boolean;
    /** Resolved upstream model ID from the catalog (e.g. 'claude-opus-4-7').
     *  Required for aliases whose window depends on provider (first-party
     *  opus = 1M, Bedrock/Vertex opus = 200K). */
    upstreamModelId?: string;
    /**
     * Phase 5: SDK-authoritative snapshot from Query.getContextUsage().
     * When fresh (<60s), its totalTokens / maxTokens win over the
     * char-based estimator.
     */
    snapshot?: {
      totalTokens: number;
      maxTokens: number;
      capturedAt: number;
    };
    /**
     * Phase 6 Phase 3 — composer-side pending token sub-totals. When
     * provided, flows into `buildContextUsageBreakdown` so the popover's
     * pending kinds (`files_attachments` + `pending_next_turn`) read
     * real per-source numbers instead of 0.
     */
    pending?: {
      attachmentTokens?: number;
      mentionTokens?: number;
      directoryTokens?: number;
      composerTextTokens?: number;
    };
  },
): ContextUsageData {
  // Compute a stable fingerprint to avoid unnecessary recomputation
  const fingerprint = useMemo(() => getMessagesFingerprint(messages), [messages]);

  // Cache the previous result to return when fingerprint hasn't changed
  const cachedRef = useRef<{ fingerprint: string; data: ContextUsageData } | null>(null);

  return useMemo(() => {
    // Return cached result if fingerprint hasn't changed
    if (cachedRef.current?.fingerprint === fingerprint) {
      return cachedRef.current.data;
    }

    // Catalog window — the static fallback. Plain `getContextWindow`
    // result; may be `null` for models the catalog doesn't enumerate
    // (GLM / Bailian / Volcengine / MiniMax / Kimi / DeepSeek / etc.).
    // We deliberately don't whitelist those — instead we let the SDK
    // tell us via `token_usage.context_window` (extracted from
    // `SDKResultMessage.modelUsage` in claude-client.ts). This local
    // fallback is what `noData` returns and what we use when the
    // matched message has no SDK-reported window.
    const catalogContextWindow = getContextWindow(modelName, {
      context1m: options?.context1m,
      upstream: options?.upstreamModelId,
    });

    // Phase 5 — prefer a fresh SDK snapshot over the char:token estimator.
    // Freshness window matches the plan (60s). Beyond that, the estimator
    // takes over and the `source` flag flips so the UI can signal the
    // change to the user.
    const snap = options?.snapshot;
    // Date.now() is technically impure inside useMemo, but the freshness
    // check is a one-shot snapshot-vs-now comparison that naturally
    // re-evaluates on the next render when `messages` / `modelName` /
    // snapshot identity changes — which is exactly when staleness matters.
    // eslint-disable-next-line react-hooks/purity
    const snapFresh = snap && (Date.now() - snap.capturedAt) < SNAPSHOT_FRESHNESS_MS;
    if (snap && snapFresh) {
      const used = snap.totalTokens;
      const max = snap.maxTokens || catalogContextWindow || used;
      const ratio = max ? used / max : 0;
      // No estimated-next-turn from the snapshot — we assume next turn is
      // similar to current (snapshot is authoritative on "used now" but
      // can't project future output).
      const result: ContextUsageData = {
        modelName,
        contextWindow: max,
        used,
        ratio,
        estimatedNextTurn: used,
        estimatedNextRatio: ratio,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        hasData: true,
        state: ratio >= 0.95 ? 'critical' : ratio >= 0.8 ? 'warning' : 'normal',
        hasSummary: options?.hasSummary || false,
        source: 'snapshot',
        snapshotCapturedAt: snap.capturedAt,
        breakdown: buildContextUsageBreakdown({
          baseline: {
            used,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
          },
          contextWindow: max,
          pending: options?.pending,
        }),
      };
      cachedRef.current = { fingerprint, data: result };
      return result;
    }

    // Walk assistant token_usage records from the end. The pure
    // logic — including the output-only skip + the
    // latestSdkContextWindow capture — lives in
    // `lib/context-usage-walk.ts` so it can be tested without React.
    // See that module's doc-block for the two non-obvious rules
    // (output-only baseline skip + context_window preservation).
    const { baseline, latestSdkContextWindow, contextAccounting } = walkContextUsage(messages);

    if (baseline) {
      // Resolve contextWindow priority:
      //   1. This baseline record's own SDK-reported window.
      //   2. The newest SDK window seen anywhere in the walk —
      //      typically a more-recent output-only tail.
      //   3. The static `getContextWindow()` catalog fallback.
      // Older DB rows without `context_window` correctly fall
      // through to (2) and (3).
      const sdkContextWindow = baseline.sdkContextWindow;
      const contextWindow = sdkContextWindow
        ?? latestSdkContextWindow
        ?? catalogContextWindow;

      const outputTokens = baseline.outputTokens;
      // Build breakdown first — its usedTokens may promote past baseline.used
      // when provider proxies (Native/Codex+GLM) report input_tokens=0 but
      // entries surface real per-turn tokens. Header used/ratio must match
      // breakdown sum or popover looks inconsistent ("0" header vs 3.5K rows).
      const breakdown = buildContextUsageBreakdown({
        baseline: {
          used: baseline.used,
          cacheReadTokens: baseline.cacheReadTokens,
          cacheCreationTokens: baseline.cacheCreationTokens,
          outputTokens,
        },
        contextWindow: contextWindow ?? undefined,
        pending: options?.pending,
        // Phase 1 (Context Accounting Runtime Contract, 2026-05-20):
        // feed compiler inputs from the Runtime-produced snapshot.
        // snapshotToCompilerInputs returns undefined when the snapshot
        // is missing OR every kind is unsupported / empty → all
        // compiler-side rows hide (conversation absorbs residual).
        // Old `context_breakdown` rows are intentionally NOT honored
        // — that field held 假数据 (Phase 0 deleted the writer).
        compiler: snapshotToCompilerInputs(contextAccounting),
      });
      const used = breakdown.usedTokens;
      const ratio = contextWindow ? used / contextWindow : 0;

      // Estimate next turn: current input context + this turn's output + ~200 token overhead for a new user message
      const estimatedNextTurn = used + outputTokens + 200;
      const estimatedNextRatio = contextWindow ? estimatedNextTurn / contextWindow : 0;

      // Warning state uses the higher of actual and estimated ratios
      const effectiveRatio = Math.max(ratio, estimatedNextRatio);
      let state: 'normal' | 'warning' | 'critical' = 'normal';
      if (effectiveRatio >= 0.95) state = 'critical';
      else if (effectiveRatio >= 0.8) state = 'warning';

      const result: ContextUsageData = {
        modelName,
        contextWindow,
        used,
        ratio,
        estimatedNextTurn,
        estimatedNextRatio,
        cacheReadTokens: baseline.cacheReadTokens,
        cacheCreationTokens: baseline.cacheCreationTokens,
        outputTokens,
        hasData: true,
        state,
        hasSummary: options?.hasSummary || false,
        source: 'result_usage',
        breakdown,
      };
      cachedRef.current = { fingerprint, data: result };
      return result;
    }

    // No meaningful baseline found. Still surface the SDK-reported
    // capacity if we saw one during the walk — a brand-new session
    // whose first assistant turn was output-only shouldn't lose the
    // capacity badge. `hasData` stays false because we have no real
    // `used` to draw a percent from; RunCockpit's fallback path
    // renders the breakdown without the ratio bar in that case.
    const result: ContextUsageData = {
      modelName,
      contextWindow: latestSdkContextWindow ?? catalogContextWindow,
      used: 0,
      ratio: 0,
      estimatedNextTurn: 0,
      estimatedNextRatio: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      hasData: false,
      state: 'normal',
      hasSummary: options?.hasSummary || false,
      source: 'none' as const,
      breakdown: buildContextUsageBreakdown({
        contextWindow: (latestSdkContextWindow ?? catalogContextWindow) ?? undefined,
        pending: options?.pending,
      }),
    };
    cachedRef.current = { fingerprint, data: result };
    return result;
  }, [fingerprint, modelName, options?.context1m, options?.hasSummary, options?.upstreamModelId, options?.snapshot, options?.pending]);
}
