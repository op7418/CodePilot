/**
 * Stream Session Manager — client-side singleton that manages SSE streams
 * independently of React component lifecycle.
 *
 * When a user switches sessions, the old ChatView unmounts but the stream
 * continues running here. The new ChatView (or the same one re-mounted)
 * subscribes to get the current snapshot.
 *
 * Uses globalThis pattern (same as conversation-registry.ts) to survive
 * Next.js HMR without losing state.
 */

import { consumeSSEStream } from '@/hooks/useSSEStream';
import { transferPendingToMessage } from '@/lib/image-ref-store';
import { dispatchFileChanged } from '@/lib/file-changed-event';
import {
  extractWritePath,
  isWriteTool,
  resolveToolPath,
} from '@/lib/file-write-tools';
import type {
  ToolUseInfo,
  ToolResultInfo,
  SessionStreamSnapshot,
  StreamEvent,
  StreamEventListener,
  TokenUsage,
  PermissionRequestEvent,
  FileAttachment,
  MentionRef,
} from '@/types';

// ==========================================
// Internal types
// ==========================================

interface ActiveStream {
  sessionId: string;
  /** Absolute working directory for the session. Stashed so the
   *  onToolResult handler can resolve relative tool paths into the
   *  same absolute form PreviewPanel uses, which is what the
   *  codepilot:file-changed listener matches against. */
  workingDirectory: string | null;
  abortController: AbortController;
  snapshot: SessionStreamSnapshot;
  idleCheckTimer: ReturnType<typeof setInterval> | null;
  lastEventTime: number;
  gcTimer: ReturnType<typeof setTimeout> | null;
  /** Tracked ad-hoc timeouts — cleaned up when the stream ends. */
  pendingTimers: Set<ReturnType<typeof setTimeout>>;
  // Mutable accumulators (snapshot gets new object refs on each emit)
  accumulatedText: string;
  accumulatedThinking: string;
  /** All thinking blocks concatenated (preserved for finalMessageContent) */
  fullThinking: string;
  /** Tracks whether non-thinking content has arrived since last thinking delta */
  thinkingPhaseEnded: boolean;
  toolUsesArray: ToolUseInfo[];
  toolResultsArray: ToolResultInfo[];
  toolOutputAccumulated: string;
  toolTimeoutInfo: { toolName: string; elapsedSeconds: number } | null;
  isIdleTimeout: boolean;
  sendMessageFn: ((content: string, files?: FileAttachment[]) => void) | null;
  rewindPoints: Array<{ userMessageId: string }>;
}

export interface StartStreamParams {
  sessionId: string;
  content: string;
  mode: string;
  model: string;
  providerId: string;
  files?: FileAttachment[];
  mentions?: MentionRef[];
  systemPromptAppend?: string;
  pendingImageNotices?: string[];
  /** When true, backend skips saving user message and title update (assistant auto-trigger) */
  autoTrigger?: boolean;
  /** Called when SDK mode changes (e.g. plan → code) */
  onModeChanged?: (mode: string) => void;
  /** Reference to the outer sendMessage so tool-timeout auto-retry works */
  sendMessageFn?: (content: string, files?: FileAttachment[]) => void;
  /** SDK effort level (low/medium/high/max) — only sent when model supports it */
  effort?: string;
  /** SDK thinking config */
  thinking?: { type: string; budgetTokens?: number };
  /** Enable 1M context window (beta) */
  context1m?: boolean;
  /** Called when init status event provides metadata (tools, slash_commands, skills) */
  onInitMeta?: (meta: { tools?: unknown; slash_commands?: unknown; skills?: unknown }) => void;
  /** Display-only content for user message (e.g. /skillName instead of expanded prompt) */
  displayOverride?: string;
  /**
   * Phase 2 — Context Accounting Runtime Contract (2026-05-20). Names of
   * Agent Skills selected via MessageInput badges. Used by the Context
   * Accounting producer to look up real `SKILL.md` filesizes (replaces
   * the previous regex on the prompt text that missed badge dispatch).
   */
  selectedSkills?: readonly string[];
  /** Session's working directory. When provided, the stream resolves
   *  relative tool paths to absolute before dispatching the
   *  codepilot:file-changed event, so the PreviewPanel listener (which
   *  carries absolute filePaths) can match against them. */
  workingDirectory?: string | null;
}

// ==========================================
// Singleton via globalThis
// ==========================================

const GLOBAL_KEY = '__streamSessionManager__' as const;
const LISTENERS_KEY = '__streamSessionListeners__' as const;
const STREAM_IDLE_TIMEOUT_MS = 330_000;
const GC_DELAY_MS = 5 * 60 * 1000; // 5 minutes
// stopStream: how long to wait for a graceful interrupt before force-aborting.
// The force-abort is scheduled UNCONDITIONALLY (not behind the interrupt
// request's .finally) so a hung /api/chat/interrupt can't strand the stream in
// 'active' and lock the composer's isStreaming gate (GitHub #578).
const STREAM_FORCE_ABORT_MS = 2000;
// Debounce the refresh-file-tree window event so rapid-succession write
// tool results (e.g. 5 files in one turn) trigger at most one file-tree
// re-fetch instead of one per file.
const REFRESH_FILE_TREE_DEBOUNCE_MS = 300;
let refreshFileTreeTimer: ReturnType<typeof setTimeout> | null = null;

function getStreamsMap(): Map<string, ActiveStream> {
  if (!(globalThis as Record<string, unknown>)[GLOBAL_KEY]) {
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = new Map<string, ActiveStream>();
  }
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as Map<string, ActiveStream>;
}

/** Listener registry — persists independently of stream entries so GC doesn't orphan listeners */
function getListenersMap(): Map<string, Set<StreamEventListener>> {
  if (!(globalThis as Record<string, unknown>)[LISTENERS_KEY]) {
    (globalThis as Record<string, unknown>)[LISTENERS_KEY] = new Map<string, Set<StreamEventListener>>();
  }
  return (globalThis as Record<string, unknown>)[LISTENERS_KEY] as Map<string, Set<StreamEventListener>>;
}

// ==========================================
// Helpers
// ==========================================

/**
 * Build the persisted `messages.content` JSON for a completed turn.
 *
 * Phase 5b smoke round 10 (2026-05-16) — extracted into a pure helper
 * so the active-stream completion path and the persistence path share
 * one definition, and so we can unit-test all four corner cases:
 *
 *   text only          → return `accumulated.trim()` (no JSON envelope)
 *   thinking only      → blocks: [thinking]
 *   tool-only          → blocks: [tool_use+tool_result pairs + orphan
 *                                 tool_results]
 *   any combination    → blocks include text + thinking + tool pairs
 *
 * The pre-fix guard `(hasTools || hasThinking) && (messageContent ||
 * hasThinking)` returned null when only tools were present without any
 * text, which is exactly the GPT-Image / imageView shape: tool_use +
 * tool_result with media, no continuation prose. Net result: the
 * stream completed, but `finalMessageContent: null` meant
 * stream-session-manager never appended the assistant message to
 * the current chat, and the user had to switch sessions for the
 * DB re-fetch to pick it up.
 *
 * Orphan results (matched tool_result with no matching tool_use in
 * the array) used to be dropped on persistence even though
 * MessageItem.pairTools() can render them. The new helper walks the
 * remaining tool_results AFTER pairing and writes each one as a
 * standalone tool_result block.
 *
 * `tool_result.content` is forced to string defensively — the SSE
 * boundary in `codex/runtime.ts:stringifyToolResultContent` is the
 * primary normalisation, but a non-string here would still break the
 * MessageContentBlock type contract.
 *
 * Returns null only when EVERY signal is empty (no text, no thinking,
 * no tools at all). Caller treats null as "no assistant message
 * worth persisting", which is correct for that case.
 */
export function buildFinalMessageContent(args: {
  accumulated: string;
  thinking: string;
  toolUses: readonly ToolUseInfo[];
  toolResults: readonly ToolResultInfo[];
}): string | null {
  const text = args.accumulated.trim();
  const thinking = args.thinking;
  const toolUses = args.toolUses;
  const toolResults = args.toolResults;

  const hasText = text.length > 0;
  const hasThinking = thinking.length > 0;
  const hasTools = toolUses.length > 0 || toolResults.length > 0;

  if (!hasText && !hasThinking && !hasTools) return null;

  // Pure text turn — keep the lightweight string form for
  // back-compat with MessageItem's "plain text" fast path.
  if (hasText && !hasThinking && !hasTools) return text;

  const blocks: Array<Record<string, unknown>> = [];
  if (hasThinking) {
    blocks.push({ type: 'thinking', thinking });
  }
  if (hasText) {
    blocks.push({ type: 'text', text });
  }
  const consumedResultIds = new Set<string>();
  for (const tu of toolUses) {
    blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    const tr = toolResults.find(r => r.tool_use_id === tu.id && !consumedResultIds.has(r.tool_use_id));
    if (tr) {
      consumedResultIds.add(tr.tool_use_id);
      blocks.push({
        type: 'tool_result',
        tool_use_id: tr.tool_use_id,
        content: normalizeContentToString(tr.content),
        ...(tr.is_error ? { is_error: true } : {}),
        ...(tr.media && tr.media.length > 0 ? { media: tr.media } : {}),
      });
    }
  }
  // Phase 5b smoke round 10 — orphan tool_results (no matching
  // tool_use in this turn) still need to land in the persisted
  // content. MessageItem.pairTools() already renders orphan results;
  // dropping them at this layer is what made "tool completed but no
  // image" survive into history even though the stream had it.
  for (const tr of toolResults) {
    if (consumedResultIds.has(tr.tool_use_id)) continue;
    blocks.push({
      type: 'tool_result',
      tool_use_id: tr.tool_use_id,
      content: normalizeContentToString(tr.content),
      ...(tr.is_error ? { is_error: true } : {}),
      ...(tr.media && tr.media.length > 0 ? { media: tr.media } : {}),
    });
  }
  return JSON.stringify(blocks);
}

/** Defensive — content SHOULD be string by the time it reaches the
 *  persistence layer (SSE boundary stringifies). Belt and braces. */
function normalizeContentToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildSnapshot(stream: ActiveStream): SessionStreamSnapshot {
  return {
    sessionId: stream.sessionId,
    phase: stream.snapshot.phase,
    streamingContent: stream.accumulatedText,
    streamingThinkingContent: stream.accumulatedThinking,
    toolUses: [...stream.toolUsesArray],
    toolResults: [...stream.toolResultsArray],
    streamingToolOutput: stream.toolOutputAccumulated,
    statusText: stream.snapshot.statusText,
    pendingPermission: stream.snapshot.pendingPermission,
    permissionResolved: stream.snapshot.permissionResolved,
    tokenUsage: stream.snapshot.tokenUsage,
    startedAt: stream.snapshot.startedAt,
    completedAt: stream.snapshot.completedAt,
    error: stream.snapshot.error,
    finalMessageContent: stream.snapshot.finalMessageContent,
    terminalReason: stream.snapshot.terminalReason,
    rateLimitInfo: stream.snapshot.rateLimitInfo,
    contextUsageSnapshot: stream.snapshot.contextUsageSnapshot,
  };
}

function emit(stream: ActiveStream, type: StreamEvent['type']) {
  const snapshot = buildSnapshot(stream);
  stream.snapshot = snapshot; // store latest
  const event: StreamEvent = { type, sessionId: stream.sessionId, snapshot };
  const listeners = getListenersMap().get(stream.sessionId);
  if (listeners) {
    for (const listener of listeners) {
      try { listener(event); } catch { /* listener error */ }
    }
  }
  // Also dispatch window event for AppShell
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('stream-session-event', { detail: event }));
  }
}

function scheduleGC(stream: ActiveStream) {
  if (stream.gcTimer) clearTimeout(stream.gcTimer);
  stream.gcTimer = setTimeout(() => {
    const map = getStreamsMap();
    const current = map.get(stream.sessionId);
    if (current === stream && current.snapshot.phase !== 'active') {
      map.delete(stream.sessionId);
    }
  }, GC_DELAY_MS);
}

function cleanupTimers(stream: ActiveStream) {
  if (stream.idleCheckTimer) {
    clearInterval(stream.idleCheckTimer);
    stream.idleCheckTimer = null;
  }
  // Clear all tracked ad-hoc timeouts
  for (const t of stream.pendingTimers) {
    clearTimeout(t);
  }
  stream.pendingTimers.clear();
}

/** Schedule a tracked timeout on the stream. Auto-removes itself after firing. */
function streamTimeout(stream: ActiveStream, fn: () => void, ms: number): void {
  const id = setTimeout(() => {
    stream.pendingTimers.delete(id);
    fn();
  }, ms);
  stream.pendingTimers.add(id);
}

// ==========================================
// Public API
// ==========================================

export function startStream(params: StartStreamParams): void {
  const map = getStreamsMap();
  const existing = map.get(params.sessionId);

  // If already streaming this session, abort old stream first
  if (existing && existing.snapshot.phase === 'active') {
    existing.abortController.abort();
    cleanupTimers(existing);
  }

  const abortController = new AbortController();

  const stream: ActiveStream = {
    sessionId: params.sessionId,
    workingDirectory: params.workingDirectory ?? null,
    abortController,
    snapshot: {
      sessionId: params.sessionId,
      phase: 'active',
      streamingContent: '',
      streamingThinkingContent: '',
      toolUses: [],
      toolResults: [],
      streamingToolOutput: '',
      statusText: undefined,
      pendingPermission: null,
      permissionResolved: null,
      tokenUsage: null,
      startedAt: Date.now(),
      completedAt: null,
      error: null,
      finalMessageContent: null,
    },
    idleCheckTimer: null,
    lastEventTime: Date.now(),
    gcTimer: null,
    pendingTimers: new Set(),
    accumulatedText: '',
    accumulatedThinking: '',
    fullThinking: '',
    thinkingPhaseEnded: false,
    toolUsesArray: [],
    toolResultsArray: [],
    toolOutputAccumulated: '',
    toolTimeoutInfo: null,
    isIdleTimeout: false,
    sendMessageFn: params.sendMessageFn ?? null,
    rewindPoints: [],
  };

  map.set(params.sessionId, stream);
  emit(stream, 'phase-changed');

  // Run the stream in background (non-blocking)
  runStream(stream, params).catch(() => {});
}

async function runStream(stream: ActiveStream, params: StartStreamParams): Promise<void> {
  const markActive = () => { stream.lastEventTime = Date.now(); };

  // Idle timeout checker
  stream.idleCheckTimer = setInterval(() => {
    if (Date.now() - stream.lastEventTime >= STREAM_IDLE_TIMEOUT_MS) {
      cleanupTimers(stream);
      stream.isIdleTimeout = true;
      stream.abortController.abort();
    }
  }, 10_000);

  // Flush pending image notices
  let effectiveContent = params.content;
  if (params.pendingImageNotices && params.pendingImageNotices.length > 0) {
    const notices = params.pendingImageNotices.join('\n\n');
    effectiveContent = `${notices}\n\n---\n\n${params.content}`;
  }

  // Adaptive text emit throttle — avoids excessive React re-renders during fast streaming.
  // Defined before try/catch so flushTextThrottle is accessible in the error path.
  const TEXT_THROTTLE_MS = 100;
  let textEmitTimer: ReturnType<typeof setTimeout> | null = null;
  let textDirty = false;

  const emitTextUpdate = () => {
    textDirty = false;
    emit(stream, 'snapshot-updated');
  };

  const throttledTextEmit = () => {
    textDirty = true;
    if (!textEmitTimer) {
      textEmitTimer = setTimeout(() => {
        textEmitTimer = null;
        if (textDirty) emitTextUpdate();
      }, TEXT_THROTTLE_MS);
    }
  };

  const flushTextThrottle = () => {
    if (textEmitTimer) {
      clearTimeout(textEmitTimer);
      textEmitTimer = null;
    }
    if (textDirty) emitTextUpdate();
  };

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: params.sessionId,
        content: effectiveContent,
        mode: params.mode,
        model: params.model,
        provider_id: params.providerId,
        ...(params.files && params.files.length > 0 ? { files: params.files } : {}),
        ...(params.mentions && params.mentions.length > 0 ? { mentions: params.mentions } : {}),
        ...(params.systemPromptAppend ? { systemPromptAppend: params.systemPromptAppend } : {}),
        ...(params.autoTrigger ? { autoTrigger: true } : {}),
        ...(params.effort ? { effort: params.effort } : {}),
        ...(params.thinking ? { thinking: params.thinking } : {}),
        ...(params.context1m ? { context_1m: true } : {}),
        ...(params.displayOverride ? { displayOverride: params.displayOverride } : {}),
        ...(params.selectedSkills && params.selectedSkills.length > 0
          ? { selectedSkills: params.selectedSkills }
          : {}),
      }),
      signal: stream.abortController.signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (err?.code === 'NEEDS_PROVIDER_SETUP' && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('open-setup-center', {
          detail: { initialCard: err.initialCard ?? 'provider' },
        }));
      }
      // Phase 2 Step 4b — `INVALID_SESSION_PROVIDER` 409: chat route
      // refuses to send because the session points at a deleted
      // provider. Surface as a typed window event ChatView listens
      // for, so the user gets an inline banner ("your saved provider
      // was deleted — pick another in the composer below") instead
      // of a generic toast.
      //
      // **Step 4b review**: also tag the thrown Error with a `code`
      // marker AND mark the stream so the catch block at the bottom
      // of this function knows to take the SILENT error path —
      // otherwise the `**Error:** Session points at...` text would
      // get serialized into `finalMessageContent` and render as an
      // assistant bubble in the transcript, contradicting the "red
      // banner is the only signal" UX. Generic Error is still
      // thrown so external callers' onError still fires — they just
      // can no longer rely on stream.snapshot carrying error text.
      if (err?.code === 'INVALID_SESSION_PROVIDER' && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('chat-invalid-session-provider', {
          detail: {
            sessionId: params.sessionId,
            sessionProviderId: err.sessionProviderId ?? '',
            reason: err.reason ?? 'provider-missing',
          },
        }));
      }
      const e = new Error(err?.error || 'Failed to send message');
      if (err?.code) (e as Error & { code?: string }).code = err.code;
      throw e;
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response stream');

    const result = await consumeSSEStream(reader, {
      onText: (acc) => {
        markActive();
        stream.accumulatedText = acc;
        stream.thinkingPhaseEnded = true;
        throttledTextEmit();
      },
      onThinking: (delta) => {
        markActive();
        // If non-thinking content has arrived since last thinking delta,
        // this is a new thinking phase (e.g. after a tool_use round-trip).
        // Reset the live accumulator so the UI shows only the current phase.
        if (stream.thinkingPhaseEnded) {
          // Save previous thinking to full history before resetting
          if (stream.accumulatedThinking) {
            stream.fullThinking += (stream.fullThinking ? '\n\n---\n\n' : '') + stream.accumulatedThinking;
          }
          stream.accumulatedThinking = '';
          stream.thinkingPhaseEnded = false;
        }
        stream.accumulatedThinking += delta;
        emit(stream, 'snapshot-updated');
      },
      onToolUse: (tool) => {
        markActive();
        flushTextThrottle(); // Ensure text is up-to-date before tool events
        stream.thinkingPhaseEnded = true;
        stream.toolOutputAccumulated = '';
        if (!stream.toolUsesArray.some(t => t.id === tool.id)) {
          stream.toolUsesArray = [...stream.toolUsesArray, tool];
        }
        emit(stream, 'snapshot-updated');
      },
      onToolResult: (res) => {
        markActive();
        stream.toolOutputAccumulated = '';
        const existingIdx = stream.toolResultsArray.findIndex(r => r.tool_use_id === res.tool_use_id);
        if (existingIdx >= 0) {
          const next = [...stream.toolResultsArray];
          next[existingIdx] = res;
          stream.toolResultsArray = next;
        } else {
          stream.toolResultsArray = [...stream.toolResultsArray, res];
        }
        emit(stream, 'snapshot-updated');
        // Phase 4: dispatch codepilot:file-changed when this tool_result
        // belongs to a write/edit tool and is not an error. Lookup the
        // matching tool_use by id to read the name + input, then resolve
        // any relative path against the session's workingDirectory so the
        // PreviewPanel listener (which keys on absolute paths) matches.
        // Errored tool_results are ignored — failed writes don't change
        // the file on disk and the listener shouldn't refetch.
        if (!res.is_error) {
          const matchingUse = stream.toolUsesArray.find((u) => u.id === res.tool_use_id);
          if (matchingUse && isWriteTool(matchingUse.name)) {
            const rawPath = extractWritePath(matchingUse.input);
            if (rawPath) {
              const absolutePath = resolveToolPath(rawPath, stream.workingDirectory);
              dispatchFileChanged({
                paths: [absolutePath],
                source: 'ai-tool',
              });
            }
            // Refresh file tree after write tools (debounced) —
            // non-write tools (read, grep, ls, glob) don't mutate
            // the filesystem so skipping them avoids wasted re-fetches
            // during agentic workflows with 10-30 tool calls.
            if (refreshFileTreeTimer) clearTimeout(refreshFileTreeTimer);
            refreshFileTreeTimer = setTimeout(() => {
              refreshFileTreeTimer = null;
              window.dispatchEvent(new Event('refresh-file-tree'));
            }, REFRESH_FILE_TREE_DEBOUNCE_MS);
          }
        }
      },
      onToolOutput: (data) => {
        markActive();
        const next = stream.toolOutputAccumulated + (stream.toolOutputAccumulated ? '\n' : '') + data;
        stream.toolOutputAccumulated = next.length > 2000 ? next.slice(-2000) : next;
        emit(stream, 'snapshot-updated');
      },
      onToolProgress: (toolName, elapsed) => {
        markActive();
        stream.snapshot = { ...stream.snapshot, statusText: `Running ${toolName}... (${elapsed}s)` };
        emit(stream, 'snapshot-updated');
      },
      onSkillNudge: (data) => {
        // Broadcast as window event — ChatView listens and renders a
        // persistent banner. We don't use the snapshot because the nudge
        // should persist after the stream completes (snapshot gets cleared).
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('skill-nudge', {
            detail: { sessionId: params.sessionId, ...data },
          }));
        }
      },
      onContextCompressed: (data) => {
        markActive();
        // Dispatch the 'context-compressed' window event that ChatView
        // uses to flip hasSummary state and show the context indicator.
        // Also show a brief human-readable status line so the user knows
        // compression happened.
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('context-compressed', {
            detail: { sessionId: params.sessionId, ...data },
          }));
        }
        // Show the compression message briefly in the status bar
        if (data.message) {
          stream.snapshot = { ...stream.snapshot, statusText: data.message };
          emit(stream, 'snapshot-updated');
          streamTimeout(stream, () => {
            if (stream.snapshot.statusText === data.message) {
              stream.snapshot = { ...stream.snapshot, statusText: undefined };
              emit(stream, 'snapshot-updated');
            }
          }, 5000); // Show for 5s so user can read it
        }
      },
      onStatus: (text) => {
        markActive();
        if (text === 'context_compressing_retry') {
          // Show a brief status while PTL auto-retry is in progress
          stream.snapshot = { ...stream.snapshot, statusText: 'Compressing context...' };
          emit(stream, 'snapshot-updated');
          return;
        }
        if (text?.startsWith('Connected (')) {
          stream.snapshot = { ...stream.snapshot, statusText: text };
          emit(stream, 'snapshot-updated');
          streamTimeout(stream, () => {
            // Only clear if still the same status
            if (stream.snapshot.statusText === text) {
              stream.snapshot = { ...stream.snapshot, statusText: undefined };
              emit(stream, 'snapshot-updated');
            }
          }, 2000);
        } else {
          stream.snapshot = { ...stream.snapshot, statusText: text };
          emit(stream, 'snapshot-updated');
        }
      },
      onResult: (usage, meta) => {
        markActive();
        stream.snapshot = {
          ...stream.snapshot,
          tokenUsage: usage,
          ...(meta?.terminalReason ? { terminalReason: meta.terminalReason } : {}),
        };
      },
      onRateLimit: (info) => {
        markActive();
        stream.snapshot = { ...stream.snapshot, rateLimitInfo: info };
        emit(stream, 'snapshot-updated');
      },
      onContextUsage: (snap) => {
        markActive();
        stream.snapshot = { ...stream.snapshot, contextUsageSnapshot: snap };
        emit(stream, 'snapshot-updated');
      },
      onPermissionRequest: (permData) => {
        markActive();
        stream.snapshot = {
          ...stream.snapshot,
          pendingPermission: permData,
          permissionResolved: null,
        };
        emit(stream, 'permission-request');
      },
      onToolTimeout: (toolName, elapsedSeconds) => {
        markActive();
        stream.toolTimeoutInfo = { toolName, elapsedSeconds };
      },
      onModeChanged: (sdkMode) => {
        markActive();
        if (params.onModeChanged) {
          params.onModeChanged(sdkMode);
        }
      },
      onTaskUpdate: () => {
        markActive();
        window.dispatchEvent(new CustomEvent('tasks-updated'));
      },
      onRewindPoint: (sdkUserMessageId) => {
        markActive();
        stream.rewindPoints = [...stream.rewindPoints, { userMessageId: sdkUserMessageId }];
      },
      onFileChanged: (paths) => {
        // Phase 5 Phase 4 (2026-05-13). Codex Runtime emits explicit
        // file-changed SSE events from fs/changed + fileChange item
        // lifecycle. ClaudeCode SDK doesn't emit this — its file
        // changes flow through onToolResult+isWriteTool above. Both
        // paths converge here at `dispatchFileChanged`, so PreviewPanel
        // / file-tree / artifact refresh logic is runtime-agnostic.
        markActive();
        if (paths.length === 0) return;
        // Resolve any relative path against the active session's
        // working directory — Codex sometimes reports relative paths
        // from `fs/changed`. PreviewPanel listener keys on absolute
        // paths.
        const absolute = paths.map((p) => resolveToolPath(p, stream.workingDirectory));
        dispatchFileChanged({
          paths: absolute,
          source: 'ai-tool',
        });
      },
      onKeepAlive: () => {
        markActive();
      },
      onError: (acc) => {
        markActive();
        stream.accumulatedText = acc;
        emit(stream, 'snapshot-updated');
      },
      onInitMeta: (meta) => {
        markActive();
        params.onInitMeta?.(meta);
      },
    });

    // Flush any pending throttled text update before building final content
    flushTextThrottle();

    // Stream completed successfully — build final message content via
    // the shared helper that handles text-only / thinking-only /
    // tool-only / mixed turns + orphan tool results.
    const accumulated = result.accumulated;
    const allThinking = [stream.fullThinking, stream.accumulatedThinking]
      .filter(s => s.trim()).join('\n\n---\n\n');
    const messageContent = buildFinalMessageContent({
      accumulated,
      thinking: allThinking,
      toolUses: stream.toolUsesArray,
      toolResults: stream.toolResultsArray,
    });

    // Update snapshot with completion info
    stream.snapshot = {
      ...buildSnapshot(stream),
      phase: 'completed',
      completedAt: Date.now(),
      tokenUsage: result.tokenUsage,
      finalMessageContent: messageContent,
      statusText: undefined,
      pendingPermission: null,
      permissionResolved: null,
    };
    stream.accumulatedText = '';
    stream.accumulatedThinking = '';
    stream.fullThinking = '';
    stream.thinkingPhaseEnded = false;
    stream.toolUsesArray = [];
    stream.toolResultsArray = [];
    stream.toolOutputAccumulated = '';

    cleanupTimers(stream);
    emit(stream, 'completed');
    scheduleGC(stream);

    // Refresh file tree after completion
    window.dispatchEvent(new CustomEvent('refresh-file-tree'));

  } catch (error) {
    flushTextThrottle();
    cleanupTimers(stream);

    // Helper: build finalMessageContent preserving any accumulated thinking.
    // On error/stop branches we previously only serialized accumulatedText,
    // silently dropping reasoning blocks that the user had already seen.
    const buildFinalContent = (textContent: string | null): string | null => {
      const allThinking = [stream.fullThinking, stream.accumulatedThinking]
        .filter(s => s.trim()).join('\n\n---\n\n');
      if (!allThinking) return textContent;
      // Wrap as content-block JSON so MessageItem can render the thinking block
      const blocks: Array<Record<string, unknown>> = [];
      blocks.push({ type: 'thinking', thinking: allThinking });
      if (textContent) blocks.push({ type: 'text', text: textContent });
      return JSON.stringify(blocks);
    };

    if (error instanceof DOMException && error.name === 'AbortError') {
      if (stream.isIdleTimeout) {
        // Idle timeout
        const idleSecs = Math.round(STREAM_IDLE_TIMEOUT_MS / 1000);
        const textPart = stream.accumulatedText.trim()
          ? stream.accumulatedText.trim() + `\n\n**Error:** Stream idle timeout — no response for ${idleSecs}s. The connection may have dropped.`
          : `**Error:** Stream idle timeout — no response for ${idleSecs}s. The connection may have dropped.`;

        stream.snapshot = {
          ...buildSnapshot(stream),
          phase: 'error',
          completedAt: Date.now(),
          error: `Stream idle timeout (${idleSecs}s)`,
          finalMessageContent: buildFinalContent(textPart),
          statusText: undefined,
          pendingPermission: null,
          permissionResolved: null,
        };
        stream.accumulatedText = '';
        stream.accumulatedThinking = '';
        stream.fullThinking = '';
        stream.toolUsesArray = [];
        stream.toolResultsArray = [];
        stream.toolOutputAccumulated = '';
        emit(stream, 'completed');
        // Clear stale SDK session so next message starts fresh
        fetch(`/api/chat/sessions/${encodeURIComponent(stream.sessionId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sdk_session_id: '' }),
        }).catch(() => {});
        scheduleGC(stream);
      } else if (stream.toolTimeoutInfo) {
        // Tool timeout — auto-retry
        const timeoutInfo = stream.toolTimeoutInfo;
        const textPart = stream.accumulatedText.trim()
          ? stream.accumulatedText.trim() + `\n\n*(tool ${timeoutInfo.toolName} timed out after ${timeoutInfo.elapsedSeconds}s)*`
          : null;

        stream.snapshot = {
          ...buildSnapshot(stream),
          phase: 'stopped',
          completedAt: Date.now(),
          finalMessageContent: buildFinalContent(textPart),
          statusText: undefined,
          pendingPermission: null,
          permissionResolved: null,
        };
        stream.accumulatedText = '';
        stream.accumulatedThinking = '';
        stream.fullThinking = '';
        stream.toolUsesArray = [];
        stream.toolResultsArray = [];
        stream.toolOutputAccumulated = '';
        stream.toolTimeoutInfo = null;
        emit(stream, 'completed');
        scheduleGC(stream);

        // Auto-retry via sendMessageFn
        if (stream.sendMessageFn) {
          const fn = stream.sendMessageFn;
          streamTimeout(stream, () => {
            fn(
              `The previous tool "${timeoutInfo.toolName}" timed out after ${timeoutInfo.elapsedSeconds} seconds. Please try a different approach to accomplish the task. Avoid repeating the same operation that got stuck.`
            );
          }, 500);
        }
      } else {
        // User manually stopped — add partial content with "(generation stopped)"
        const textPart = stream.accumulatedText.trim()
          ? stream.accumulatedText.trim() + '\n\n*(generation stopped)*'
          : null;

        stream.snapshot = {
          ...buildSnapshot(stream),
          phase: 'stopped',
          completedAt: Date.now(),
          finalMessageContent: buildFinalContent(textPart),
          statusText: undefined,
          pendingPermission: null,
          permissionResolved: null,
        };
        stream.accumulatedText = '';
        stream.accumulatedThinking = '';
        stream.fullThinking = '';
        stream.toolUsesArray = [];
        stream.toolResultsArray = [];
        stream.toolOutputAccumulated = '';
        emit(stream, 'completed');
        scheduleGC(stream);
      }
    } else {
      // Non-abort error
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      // Phase 2 Step 4b review — silent error path for
      // `INVALID_SESSION_PROVIDER`: the inline banner ChatView shows
      // (driven by the window event we dispatched in the !response.ok
      // branch above) is the canonical user-facing surface for this
      // failure mode. Building a `**Error:** Session points at a
      // provider that no longer exists.` assistant bubble on top of
      // the banner triples the noise (banner + error bubble + leftover
      // optimistic user message). ChatView removes the optimistic user
      // message itself; here we just keep `finalMessageContent: null`
      // so no error bubble lands in the transcript.
      const errorCode = (error as Error & { code?: string })?.code;
      const silentError = errorCode === 'INVALID_SESSION_PROVIDER';
      stream.snapshot = {
        ...buildSnapshot(stream),
        phase: 'error',
        completedAt: Date.now(),
        error: errMsg,
        finalMessageContent: silentError ? null : buildFinalContent(`**Error:** ${errMsg}`),
        statusText: undefined,
        pendingPermission: null,
        permissionResolved: null,
      };
      stream.accumulatedText = '';
      stream.accumulatedThinking = '';
      stream.fullThinking = '';
      stream.toolUsesArray = [];
      stream.toolResultsArray = [];
      stream.toolOutputAccumulated = '';
      emit(stream, 'completed');
      scheduleGC(stream);
    }
  }
}

// ==========================================
// Stop
// ==========================================

/** Minimal stream surface stopStreamWith needs — lets the stop logic be
 *  unit-tested with a fake stream + spy deps, without the (un-injectable)
 *  module-level streams map. */
interface StoppableStream {
  snapshot: { phase: string };
  abortController: Pick<AbortController, 'abort'>;
}

interface StopStreamDeps {
  /** Best-effort graceful interrupt. MUST be bounded by the caller (so a hung
   *  endpoint can't leak) and swallow its own errors. */
  requestInterrupt: () => void;
  /** Schedule the force-abort safety net (tracked on the stream's timers). */
  scheduleForceAbort: (fn: () => void, ms: number) => void;
}

/**
 * Pure/DI core of stopStream. The force-abort safety net is scheduled FIRST
 * and UNCONDITIONALLY — never gated behind the interrupt request.
 *
 * Regression (GitHub #578): the old code scheduled the force-abort inside the
 * interrupt fetch's `.finally()`. A hung `/api/chat/interrupt` never settles,
 * so `.finally` never ran, the abort was never scheduled, `phase` stayed
 * 'active' forever, and the composer's `isStreaming` gate (= phase==='active')
 * locked the user out of sending after an interrupt.
 */
export function stopStreamWith(
  stream: StoppableStream | undefined,
  deps: StopStreamDeps,
  forceAbortMs: number,
): void {
  if (!stream || stream.snapshot.phase !== 'active') return;
  // 1) Safety net FIRST — independent of (and before) the interrupt request,
  //    so a hung or throwing interrupt can't prevent the fallback abort.
  deps.scheduleForceAbort(() => {
    if (stream.snapshot.phase === 'active') {
      stream.abortController.abort();
    }
  }, forceAbortMs);
  // 2) Best-effort graceful interrupt — stops the backend faster than the
  //    force-abort when it works; purely an optimization now.
  deps.requestInterrupt();
}

export function stopStream(sessionId: string): void {
  const stream = getStreamsMap().get(sessionId);
  stopStreamWith(
    stream,
    {
      requestInterrupt: () => {
        fetch('/api/chat/interrupt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
          // Bounded so a hung endpoint can't leak a pending request; the
          // scheduled force-abort is the real fallback.
          signal: AbortSignal.timeout(STREAM_FORCE_ABORT_MS),
        }).catch(() => {
          // Interrupt failed/timed out — force-abort already scheduled.
        });
      },
      scheduleForceAbort: (fn, ms) => {
        if (stream) streamTimeout(stream, fn, ms);
      },
    },
    STREAM_FORCE_ABORT_MS,
  );
}

// ==========================================
// Subscribe
// ==========================================

export function subscribe(sessionId: string, listener: StreamEventListener): () => void {
  const listenersMap = getListenersMap();
  let listeners = listenersMap.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    listenersMap.set(sessionId, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners!.delete(listener);
    if (listeners!.size === 0) {
      listenersMap.delete(sessionId);
    }
  };
}

// ==========================================
// Snapshot access
// ==========================================

export function getSnapshot(sessionId: string): SessionStreamSnapshot | null {
  const stream = getStreamsMap().get(sessionId);
  if (!stream) return null;
  // Don't return stale placeholder entries
  if (stream.snapshot.startedAt === 0) return null;
  return stream.snapshot;
}

export function isStreamActive(sessionId: string): boolean {
  const stream = getStreamsMap().get(sessionId);
  return stream?.snapshot.phase === 'active' || false;
}

export function getRewindPoints(sessionId: string): Array<{ userMessageId: string }> {
  const stream = getStreamsMap().get(sessionId);
  return stream?.rewindPoints ?? [];
}

export function getActiveSessionIds(): string[] {
  const ids: string[] = [];
  for (const [id, stream] of getStreamsMap()) {
    if (stream.snapshot.phase === 'active') {
      ids.push(id);
    }
  }
  return ids;
}

// ==========================================
// Permission response
// ==========================================

export async function respondToPermission(
  sessionId: string,
  decision: 'allow' | 'allow_session' | 'deny',
  updatedInput?: Record<string, unknown>,
  denyMessage?: string,
): Promise<void> {
  const stream = getStreamsMap().get(sessionId);
  if (!stream || !stream.snapshot.pendingPermission) return;

  const perm = stream.snapshot.pendingPermission;

  const body = {
    permissionRequestId: perm.permissionRequestId,
    decision: decision === 'deny'
      ? { behavior: 'deny' as const, message: denyMessage || 'User denied permission' }
      : {
          behavior: 'allow' as const,
          ...(decision === 'allow_session' && perm.suggestions
            ? { updatedPermissions: perm.suggestions }
            : {}),
          ...(updatedInput ? { updatedInput } : {}),
        },
  };

  // Update snapshot immediately
  stream.snapshot = {
    ...stream.snapshot,
    permissionResolved: decision === 'deny' ? 'deny' : 'allow',
  };
  emit(stream, 'snapshot-updated');

  try {
    await fetch('/api/chat/permission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // Best effort
  }

  // Clear permission state after delay (only if no new request arrived)
  const answeredId = perm.permissionRequestId;
  streamTimeout(stream, () => {
    if (stream.snapshot.pendingPermission?.permissionRequestId === answeredId) {
      stream.snapshot = {
        ...stream.snapshot,
        pendingPermission: null,
        permissionResolved: null,
      };
      emit(stream, 'snapshot-updated');
    }
  }, 1000);
}

// ==========================================
// Cleanup
// ==========================================

export function clearSnapshot(sessionId: string): void {
  const stream = getStreamsMap().get(sessionId);
  if (stream && stream.snapshot.phase !== 'active') {
    if (stream.gcTimer) clearTimeout(stream.gcTimer);
    // Reset the snapshot (listeners are in a separate registry)
    stream.snapshot = {
      ...stream.snapshot,
      startedAt: 0,
      finalMessageContent: null,
    };
  }
}

/**
 * Seed a snapshot with initial patch for paths that don't go through
 * startStream() — currently only the first-message flow in
 * `app/chat/page.tsx`, which hand-parses SSE, creates a session row, and
 * redirects to /chat/[id]. Without this seed, the snapshot the redirected
 * ChatView reads is null and first-turn signals (terminal_reason,
 * rate_limit_info) never reach the chip/banner UI.
 *
 * Registers a minimal ActiveStream with phase='completed' if none exists.
 * If a full stream is already registered (shouldn't normally happen on
 * first turn), just merges the patch into the existing snapshot.
 */
export function seedSnapshotPatch(
  sessionId: string,
  patch: Partial<SessionStreamSnapshot>,
): void {
  const map = getStreamsMap();
  const existing = map.get(sessionId);
  if (existing) {
    existing.snapshot = { ...existing.snapshot, ...patch };
    emit(existing, 'snapshot-updated');
    return;
  }
  // Register a placeholder stream. It's not 'active' so the ChatView will
  // treat it as post-stream state; no subscription wiring needed because
  // the ChatView that reads it will re-subscribe on mount (its own useEffect).
  const placeholder: ActiveStream = {
    sessionId,
    workingDirectory: null,
    abortController: new AbortController(),
    idleCheckTimer: null,
    lastEventTime: Date.now(),
    gcTimer: null,
    pendingTimers: new Set(),
    accumulatedText: '',
    accumulatedThinking: '',
    fullThinking: '',
    thinkingPhaseEnded: false,
    toolUsesArray: [],
    toolResultsArray: [],
    toolOutputAccumulated: '',
    toolTimeoutInfo: null,
    isIdleTimeout: false,
    sendMessageFn: null,
    rewindPoints: [],
    snapshot: {
      sessionId,
      phase: 'completed',
      streamingContent: '',
      streamingThinkingContent: '',
      toolUses: [],
      toolResults: [],
      streamingToolOutput: '',
      statusText: undefined,
      pendingPermission: null,
      permissionResolved: null,
      tokenUsage: null,
      startedAt: Date.now(),
      completedAt: Date.now(),
      error: null,
      finalMessageContent: null,
      ...patch,
    },
  };
  map.set(sessionId, placeholder);
}
