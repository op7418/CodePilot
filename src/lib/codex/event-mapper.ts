/**
 * Codex notification → canonical event mapper.
 *
 * Phase 5 Phase 3 (2026-05-13) + review fix round 1 (same day).
 * Maps the wide Codex app-server notification surface into:
 *
 *   - `RuntimeRunEvent` (canonical 9-type union) for chat / Run /
 *     Preview UI consumers.
 *   - `RuntimePermissionEvent` for permission UI consumers.
 *   - `null` for transport-only events (heartbeats / acks / different
 *     channel like account events).
 *
 * Unknown methods fall through to `unknown_item` per the contract.
 *
 * Schema source of truth — every method name in the switch below MUST
 * appear in `资料/codex/codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts`.
 * The `codex-method-names.test.ts` guardrail reads that file at test
 * time and fails the build if any name in this module isn't present.
 *
 * Field shapes are also pinned to schema. Three places where review
 * round 1 caught me hallucinating:
 *
 *   - `ItemStartedNotification.params.item.id` (not `params.itemId`)
 *     and `params.item.command: string` (not `string[]`) per ThreadItem
 *     commandExecution variant.
 *   - `ThreadTokenUsageUpdatedNotification.params.tokenUsage.last.{inputTokens,
 *     outputTokens}` + `params.tokenUsage.modelContextWindow` — a layered
 *     shape, not flat.
 *   - Method names like `account/login/completed` /
 *     `account/rateLimits/updated` / `thread/status/changed` — Codex
 *     uses slash-separated namespaces, not camelCase.
 */

import type {
  RuntimeRunEvent,
  RuntimePermissionEvent,
} from '@/lib/runtime/contract';
import {
  makeAssistantDelta,
  makeToolStarted,
  makeToolCompleted,
  makeCommandStarted,
  makeFileChanged,
  makeUsageUpdated,
  makeRunCompleted,
  makeRunFailed,
  makeUnknownItem,
} from '@/lib/runtime/event-adapter';
import { diagnoseCodexNetworkError } from './error-diagnostics';

interface CodexMappingContext {
  sessionId: string;
}

// ─────────────────────────────────────────────────────────────────────
// Known Codex notification methods. Pinned to upstream ServerNotification
// union; the codex-method-names.test.ts guardrail asserts this set is a
// subset of the schema file at test time.
// ─────────────────────────────────────────────────────────────────────

const KNOWN_CODEX_METHODS = new Set<string>([
  // Run lifecycle
  'thread/started',
  'thread/closed',
  'thread/status/changed',
  'thread/compacted',
  'turn/started',
  'turn/completed',
  'turn/diff/updated',
  'turn/plan/updated',
  // Streaming text / reasoning
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  // Items lifecycle
  'item/started',
  'item/completed',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  // Token usage
  'thread/tokenUsage/updated',
  // Command / process / fs streams
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'command/exec/outputDelta',
  'process/outputDelta',
  'process/exited',
  'fs/changed',
  // Account
  'account/updated',
  'account/login/completed',
  'account/rateLimits/updated',
  // Hooks / MCP
  'hook/started',
  'hook/completed',
  'item/mcpToolCall/progress',
  'mcpServer/oauthLogin/completed',
  'mcpServer/startupStatus/updated',
  // Misc
  'app/list/updated',
  'remoteControl/status/changed',
  'externalAgentConfig/import/completed',
  'thread/realtime/started',
  'thread/realtime/itemAdded',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/error',
  'thread/realtime/closed',
  'thread/name/updated',
  'thread/goal/updated',
  'thread/goal/cleared',
  'thread/archived',
  'thread/unarchived',
  'fuzzyFileSearch/sessionUpdated',
  'fuzzyFileSearch/sessionCompleted',
  'model/rerouted',
  'model/verification',
  'rawResponseItem/completed',
  'serverRequest/resolved',
  'skills/changed',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted',
  // Warnings / errors
  'error',
  'warning',
  'guardianWarning',
  'configWarning',
  'deprecationNotice',
]);

/**
 * Translate one Codex notification into a canonical `RuntimeRunEvent`.
 * Returns null when the notification is transport-only OR belongs to
 * a different channel (e.g. account events surface through
 * `/api/codex/account`, not the run-event stream).
 */
export function translateCodexNotification(
  method: string,
  params: unknown,
  ctx: CodexMappingContext,
): RuntimeRunEvent | null {
  const base = { runtimeId: 'codex_runtime' as const, sessionId: ctx.sessionId };

  switch (method) {
    // ─── streaming text ────────────────────────────────────────────
    // AgentMessageDeltaNotification = { threadId, turnId, itemId, delta }
    case 'item/agentMessage/delta': {
      const p = params as { delta?: string };
      if (typeof p.delta !== 'string' || p.delta.length === 0) return null;
      return makeAssistantDelta(base, p.delta);
    }
    // ReasoningTextDeltaNotification + ReasoningSummaryTextDeltaNotification
    // both expose `delta: string` at top level.
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      const p = params as { delta?: string };
      if (typeof p.delta !== 'string' || p.delta.length === 0) return null;
      return makeAssistantDelta(base, p.delta);
    }

    // ─── item lifecycle ────────────────────────────────────────────
    // ItemStartedNotification = { item: ThreadItem, threadId, turnId,
    //                             startedAtMs }
    // ThreadItem is a discriminated union; id and type live INSIDE
    // `item`, not at the top level.
    case 'item/started': {
      const p = params as { item?: ThreadItemLike };
      if (!p.item) return null;
      return translateItemStarted(p.item, base);
    }
    // ItemCompletedNotification = { item: ThreadItem, threadId, turnId,
    //                               completedAtMs }
    case 'item/completed': {
      const p = params as { item?: ThreadItemLike };
      if (!p.item) return null;
      return translateItemCompleted(p.item, base);
    }

    // ─── token usage ───────────────────────────────────────────────
    // ThreadTokenUsageUpdatedNotification = { threadId, turnId, tokenUsage }
    // ThreadTokenUsage = { total, last, modelContextWindow }
    // TokenUsageBreakdown = { totalTokens, inputTokens, cachedInputTokens,
    //                          outputTokens, reasoningOutputTokens }
    // We surface the LAST turn's input/output + the model window.
    case 'thread/tokenUsage/updated': {
      const p = params as {
        tokenUsage?: {
          last?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number };
          modelContextWindow?: number | null;
        };
      };
      const usage = p.tokenUsage;
      if (!usage) return null;
      return makeUsageUpdated(base, {
        inputTokens: usage.last?.inputTokens,
        cachedInputTokens: usage.last?.cachedInputTokens,
        outputTokens: usage.last?.outputTokens,
        contextWindow: usage.modelContextWindow ?? undefined,
      });
    }

    // ─── turn lifecycle ────────────────────────────────────────────
    // TurnCompletedNotification = { threadId, turn: Turn }
    // Turn = { id, items, itemsView, status: TurnStatus,
    //         error: TurnError | null, startedAt, completedAt, durationMs }
    // TurnStatus = "completed" | "interrupted" | "failed" | "inProgress"
    // TurnError = { message, codexErrorInfo, additionalDetails }
    //
    // Phase 5 review round 2 fix (2026-05-13) — earlier revision read
    // `params.status` (flat, doesn't exist) → every turn appeared as
    // a successful end_turn, including failed and interrupted ones.
    case 'turn/completed': {
      const p = params as {
        turn?: {
          status?: 'completed' | 'interrupted' | 'failed' | 'inProgress';
          error?: { message?: string; additionalDetails?: string | null } | null;
        };
      };
      const status = p.turn?.status;
      if (status === 'failed') {
        const err = p.turn?.error;
        const rawMessage =
          (err?.message && err.message.trim().length > 0 ? err.message : null) ??
          err?.additionalDetails ??
          'Codex turn failed';
        const diagnosticInput = [rawMessage, err?.additionalDetails]
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .join(' ');
        const diagnosis = diagnoseCodexNetworkError(diagnosticInput);
        return makeRunFailed(base, {
          code: diagnosis.code ?? 'codex_turn_failed',
          message: diagnosis.code ? diagnosis.message : rawMessage,
        });
      }
      // For completed / interrupted / inProgress (and missing status —
      // be conservative): preserve the real status as finishReason so
      // downstream can distinguish user-interrupt from natural end_turn.
      return makeRunCompleted(base, { finishReason: status ?? 'completed' });
    }
    // ErrorNotification — top-level Codex error channel. Schema (per
    // codex-rs/.../v2/ErrorNotification.ts):
    //   { error: TurnError, willRetry, threadId, turnId }
    // TurnError: { message, codexErrorInfo, additionalDetails }
    // CodexErrorInfo: string variant (e.g. 'unauthorized') OR an
    //   object like `{ httpConnectionFailed: { httpStatusCode } }`.
    //
    // Pre-5b smoke fix (2026-05-15) — the previous reader looked for
    // `p.code` / `p.message` at the top level, which never matched the
    // real schema, so every Codex error surfaced as the bare string
    // "Codex error" with no context. We now read `p.error.message`
    // (always present per schema) and append `additionalDetails` +
    // the CodexErrorInfo classification so the chat surface shows
    // what actually went wrong upstream.
    case 'error': {
      const p = params as {
        error?: {
          message?: string;
          codexErrorInfo?: unknown;
          additionalDetails?: string | null;
        } | null;
        willRetry?: boolean;
        turnId?: string;
      };
      const rawBaseMessage = p.error?.message?.trim() || 'Codex error (no message)';
      const additional = p.error?.additionalDetails?.trim();
      const diagnosticInput = [rawBaseMessage, additional]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' ');
      const diagnosis = diagnoseCodexNetworkError(diagnosticInput);
      const wasDiagnosed = diagnosis.code !== undefined;
      const baseMessage = wasDiagnosed ? diagnosis.message : rawBaseMessage;
      const errorInfo = p.error?.codexErrorInfo;
      const classification = describeCodexErrorInfo(errorInfo);
      const parts = [baseMessage];
      if (!wasDiagnosed && additional && additional !== baseMessage) parts.push(additional);
      if (classification) parts.push(`(${classification})`);

      // Phase 5b smoke round 6 (2026-05-18, user-driven) — willRetry
      // is non-terminal. Pre-fix this branch unconditionally emitted
      // `run_failed`, which the runtime wildcard handler closes the
      // stream on. Real Codex behaviour after `error willRetry=true`:
      // the app-server keeps retrying internally up to 5 times
      // ("stream disconnected - retrying sampling request (n/5)").
      // CodePilot was prematurely closing on the first retry signal,
      // so the user saw "error + done" while Codex was still working
      // — and a subsequent `thread/resume` could trip the "config
      // overrides ignored for running thread" path.
      //
      // Fix: map willRetry=true to `unknown_item` (the canonical
      // fallback for adapter-side payloads that don't fit the main
      // event set; documented as MUST be rendered, never dropped).
      // sourceType='codex_retry' lets the UI render a passive
      // "Reconnecting…" hint. Only `willRetry !== true` (terminal
      // error) keeps the old `run_failed` mapping, and the eventual
      // `turn/completed status=failed` still lands as `run_failed`.
      if (p.willRetry === true) {
        return {
          type: 'unknown_item',
          runtimeId: base.runtimeId,
          sessionId: base.sessionId,
          sourceType: 'codex_retry',
          payload: {
            message: parts.join(' '),
            willRetry: true,
            turnId: p.turnId,
            errorCode:
              typeof errorInfo === 'string'
                ? errorInfo
                : typeof errorInfo === 'object' && errorInfo
                  ? `codex:${Object.keys(errorInfo as Record<string, unknown>)[0] ?? 'unknown'}`
                  : 'codex_error',
          },
        };
      }

      return makeRunFailed(base, {
        code: diagnosis.code ?? (
          typeof errorInfo === 'string'
            ? errorInfo
            : typeof errorInfo === 'object' && errorInfo
              ? `codex:${Object.keys(errorInfo as Record<string, unknown>)[0] ?? 'unknown'}`
              : 'codex_error'
        ),
        message: parts.join(' '),
      });
    }

    // ─── file changes ──────────────────────────────────────────────
    // FsChangedNotification = { watchId, changedPaths }
    case 'fs/changed': {
      const p = params as { changedPaths?: string[] };
      if (!Array.isArray(p.changedPaths) || p.changedPaths.length === 0) return null;
      return makeFileChanged(base, { paths: p.changedPaths });
    }

    // ─── transport-only / different channel ────────────────────────
    case 'thread/started':
    case 'thread/closed':
    case 'thread/status/changed':
    case 'thread/compacted':
    case 'thread/name/updated':
    case 'thread/goal/updated':
    case 'thread/goal/cleared':
    case 'thread/archived':
    case 'thread/unarchived':
    case 'turn/started':
    case 'turn/diff/updated':
    case 'turn/plan/updated':
    case 'item/plan/delta':
    case 'item/reasoning/summaryPartAdded':
    case 'mcpServer/startupStatus/updated': {
      // Phase 8 Phase 3 — a failed MCP startup must remain diagnosable so a
      // broken Memory / user MCP is explainable instead of looking like a
      // missing tool. Successful readiness, however, is internal lifecycle
      // noise: surfacing it through the generic status fallback exposes the
      // raw `{ kind, payload }` envelope in the chat Thinking area. Keep
      // `ready` and the transient `starting` state quiet; only failures cross
      // the canonical boundary, where the clients render human copy while
      // retaining the structured payload for diagnostics.
      const sp = params as { name?: string; status?: string; error?: string | null };
      if (sp.status === 'failed') {
        return makeUnknownItem(base, {
          sourceType: 'codex.mcpServerStartupFailed',
          payload: { server: sp.name ?? null, error: sp.error ?? null },
        });
      }
      return null;
    }
    case 'item/commandExecution/outputDelta':
    case 'item/commandExecution/terminalInteraction':
    case 'item/fileChange/outputDelta':
    case 'item/fileChange/patchUpdated':
    case 'item/autoApprovalReview/started':
    case 'item/autoApprovalReview/completed':
    case 'item/mcpToolCall/progress':
    case 'command/exec/outputDelta':
    case 'process/outputDelta':
    case 'process/exited':
    case 'rawResponseItem/completed':
    case 'serverRequest/resolved':
    case 'skills/changed':
    case 'account/updated':
    case 'account/login/completed':
    case 'account/rateLimits/updated':
    case 'app/list/updated':
    case 'remoteControl/status/changed':
    case 'externalAgentConfig/import/completed':
    case 'hook/started':
    case 'hook/completed':
    case 'mcpServer/oauthLogin/completed':
    case 'thread/realtime/started':
    case 'thread/realtime/itemAdded':
    case 'thread/realtime/transcript/delta':
    case 'thread/realtime/transcript/done':
    case 'thread/realtime/outputAudio/delta':
    case 'thread/realtime/sdp':
    case 'thread/realtime/error':
    case 'thread/realtime/closed':
    case 'fuzzyFileSearch/sessionUpdated':
    case 'fuzzyFileSearch/sessionCompleted':
    case 'model/rerouted':
    case 'model/verification':
    case 'warning':
    case 'guardianWarning':
    case 'configWarning':
    case 'deprecationNotice':
    case 'windows/worldWritableWarning':
    case 'windowsSandbox/setupCompleted':
      return null;

    default:
      // Unknown → fallback per contract. Adapter MUST surface, never drop.
      return makeUnknownItem(base, {
        sourceType: `codex.${method}`,
        payload: params,
      });
  }
}

// ─────────────────────────────────────────────────────────────────────
// ThreadItem helpers — minimal shape per upstream schema. We don't
// import the full ThreadItem union from `资料/` to avoid coupling
// production code to the vendored schema directory; this narrow shape
// covers what we read.
// ─────────────────────────────────────────────────────────────────────

interface ThreadItemLike {
  type?: string;
  id?: string;
  // commandExecution
  command?: string; // schema says string, not array
  cwd?: string;
  exitCode?: number | null;
  aggregatedOutput?: string | null;
  // mcpToolCall
  server?: string;
  // mcpToolCall + dynamicToolCall
  tool?: string;
  // dynamicToolCall
  namespace?: string | null;
  // generic tool-call status / args
  status?: string;
  arguments?: unknown;
  // collabAgentToolCall. `id` is the collaboration action id, not a
  // child-thread id. A child identity exists only when app-server reports it
  // through receiverThreadIds / agentsStates.
  receiverThreadIds?: ReadonlyArray<string>;
  agentsStates?: Readonly<Record<string, {
    status?: string;
    message?: string | null;
  }>>;
  model?: string | null;
  prompt?: string | null;
  reasoningEffort?: string | null;
  // mcpToolCall failure detail (McpToolCallError = { message })
  error?: { message?: string } | null;
  // fileChange
  changes?: ReadonlyArray<unknown>;
  // webSearch
  query?: string;
  // agentMessage / plan / reasoning
  text?: string;
  // imageGeneration
  revisedPrompt?: string | null;
  result?: string;
  savedPath?: string;
  // imageView
  path?: string;
}

/**
 * ThreadItem types whose lifecycle (started/completed) is meaningful
 * to the chat / Run / Preview UI as a discrete event. Adapter emits
 * canonical events for these.
 *
 * Phase 5b smoke round 7 (2026-05-16) — `imageGeneration` and
 * `imageView` moved out of CHAT_ONLY_ITEM_TYPES into this set. They
 * have NO streaming delta channel (unlike agentMessage / plan /
 * reasoning), so `item/completed` is the ONLY surface where the
 * final image / saved path reaches the UI. Treating them as
 * chat-only silently dropped GPT-Image-2.0 results — the user saw
 * "tool ran" but no image. Promoting to tool_started/tool_completed
 * lets the existing tool-card UI render them with the result payload.
 */
const TOOL_LIKE_ITEM_TYPES = new Set<string>([
  'commandExecution',
  'mcpToolCall',
  'dynamicToolCall',
  'fileChange',
  'webSearch',
  'imageGeneration',
  'imageView',
  // Codex app-server owns the worker lifecycle. Surface it as a real tool
  // card instead of hiding it in chat-only status; model fields are preserved
  // verbatim when the installed app-server reports them.
  'collabAgentToolCall',
]);

/**
 * ThreadItem types we know about but that DON'T need a discrete
 * chat-side event from `item/started` / `item/completed`. The text
 * for agentMessage / plan / reasoning already streams through
 * `item/agentMessage/delta` / `item/plan/delta` / `item/reasoning/*`,
 * so emitting a separate canonical event would just noise the
 * transcript. userMessage is what the user sent us (already on screen).
 *
 * Phase 5 review round 2 fix (2026-05-13) — earlier revision dumped
 * these into `unknown_item`, which the runtime then surfaces as a
 * `status` SSE line. `useSSEStream.ts:229` displayed the raw JSON
 * as status text, so a normal Codex reply briefly showed
 * "codex.item/started.agentMessage" then "completed.agentMessage"
 * as chat status. Returning null suppresses that noise; the
 * agentMessage content still arrives via the streaming delta path.
 */
const CHAT_ONLY_ITEM_TYPES = new Set<string>([
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'plan',
  'reasoning',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
  // NOTE: imageGeneration / imageView are NOT chat-only — they have no
  // streaming delta channel and their final item/completed is the only
  // way the result reaches the user. See TOOL_LIKE_ITEM_TYPES above for
  // the round-7 (2026-05-16) fix.
]);

function translateItemStarted(
  item: ThreadItemLike,
  base: { runtimeId: 'codex_runtime'; sessionId: string },
): RuntimeRunEvent | null {
  const id = item.id ?? 'unknown';
  if (item.type === 'commandExecution') {
    // ThreadItem.commandExecution.command is a string (not array).
    return makeCommandStarted(base, {
      commandId: id,
      command: item.command ?? '',
      cwd: item.cwd,
    });
  }
  if (item.type === 'mcpToolCall') {
    const name = item.tool
      ? (item.server ? `${item.server}.${item.tool}` : item.tool)
      : 'mcpToolCall';
    return makeToolStarted(base, { toolId: id, name, input: item.arguments });
  }
  if (item.type === 'dynamicToolCall') {
    const name = item.tool
      ? (item.namespace ? `${item.namespace}.${item.tool}` : item.tool)
      : 'dynamicToolCall';
    return makeToolStarted(base, { toolId: id, name, input: item.arguments });
  }
  if (item.type === 'fileChange') {
    return makeToolStarted(base, {
      toolId: id,
      name: 'fileChange',
      input: { changes: item.changes },
    });
  }
  if (item.type === 'webSearch') {
    return makeToolStarted(base, {
      toolId: id,
      name: 'web_search',
      input: { query: item.query },
    });
  }
  if (item.type === 'imageGeneration') {
    // Phase 5b smoke round 7 (2026-05-16) — emit a tool_started so the
    // chat UI shows a card while the image generates. Input carries
    // only the metadata available at this point (revisedPrompt is
    // filled in by item/completed). The actual image result lands on
    // tool_completed via the generic TOOL_LIKE branch below.
    return makeToolStarted(base, {
      toolId: id,
      name: 'image_generation',
      input: { revisedPrompt: item.revisedPrompt ?? null },
    });
  }
  if (item.type === 'imageView') {
    // imageView is Codex referencing an image FILE the user uploaded
    // or the model wants to surface. The path is the load-bearing
    // piece — chat side renders it through PreviewPanel / inline image.
    return makeToolStarted(base, {
      toolId: id,
      name: 'image_view',
      input: { path: item.path },
    });
  }
  if (item.type === 'collabAgentToolCall') {
    return makeToolStarted(base, {
      toolId: id,
      name: codexCollabToolName(item),
      input: item,
    });
  }
  // Known chat-only item types — text / reasoning / review markers
  // etc. carry no extra info in the lifecycle event; the actual
  // content streams through dedicated delta methods. Return null
  // instead of polluting the chat status surface.
  if (typeof item.type === 'string' && CHAT_ONLY_ITEM_TYPES.has(item.type)) {
    return null;
  }
  // Truly unknown item type — surface via fallback so we don't drop
  // brand-new Codex item variants silently.
  if (typeof item.type === 'string') {
    return makeUnknownItem(base, {
      sourceType: `codex.item/started.${item.type}`,
      payload: item,
    });
  }
  return null;
}

function translateItemCompleted(
  item: ThreadItemLike,
  base: { runtimeId: 'codex_runtime'; sessionId: string },
): RuntimeRunEvent | null {
  const id = item.id ?? 'unknown';
  // For commandExecution: output is `aggregatedOutput`; error implied
  // by non-zero exitCode.
  if (item.type === 'commandExecution') {
    const errorIfAny =
      typeof item.exitCode === 'number' && item.exitCode !== 0
        ? `exit ${item.exitCode}`
        : undefined;
    return makeToolCompleted(base, {
      toolId: id,
      output: item.aggregatedOutput ?? '',
      error: errorIfAny,
    });
  }
  // imageGeneration / imageView — emit MediaBlock so the chat-side
  // MediaPreview renders the image inline. Without this, the result
  // lived inside the JSON-stringified `output` and never reached
  // the SSE `tool_result.media` channel that `useSSEStream.ts`
  // forwards to `MediaPreview` — the silent-completion behaviour the
  // user saw on GPT-Image-2.0 even after round 7 surfaced the
  // tool_completed event.
  if (item.type === 'imageGeneration') {
    const media = buildImageGenerationMedia(item);
    return makeToolCompleted(base, {
      toolId: id,
      output: item,
      ...(media ? { media: [media] } : {}),
    });
  }
  if (item.type === 'imageView') {
    const media = buildImageViewMedia(item);
    return makeToolCompleted(base, {
      toolId: id,
      output: item,
      ...(media ? { media: [media] } : {}),
    });
  }
  if (item.type === 'collabAgentToolCall') {
    const isChildLifecycle = getSingleCodexCollabChildId(item) !== undefined;
    return makeToolCompleted(base, {
      toolId: id,
      output: item,
      // The outer status belongs to this collaboration action (wait,
      // sendInput, closeAgent…), not to the child. Only anonymous/ambiguous
      // collaboration activities surface that action failure as a tool error.
      // Identity-bound child status is derived separately from agentsStates.
      error: !isChildLifecycle && item.status === 'failed'
        ? `Codex collaboration ${item.tool || 'action'} failed`
        : undefined,
    });
  }
  // mcpToolCall — Phase 8 Phase 3. Surface the MCP tool error into the
  // canonical `error` field (not just buried in the output payload) so a
  // failed Memory / user MCP call renders as an errored tool card, the
  // same as a native command failure above.
  if (item.type === 'mcpToolCall') {
    const errMsg =
      item.error?.message ?? (item.status === 'failed' ? 'MCP tool call failed' : undefined);
    return makeToolCompleted(base, { toolId: id, output: item, error: errMsg });
  }
  // For tool-like items — generic output via item shape; runtime
  // adapter doesn't need to differentiate.
  if (item.type && TOOL_LIKE_ITEM_TYPES.has(item.type)) {
    return makeToolCompleted(base, { toolId: id, output: item });
  }
  // Known chat-only types — no completion event for the UI (the
  // content already arrived via the streaming delta path).
  if (typeof item.type === 'string' && CHAT_ONLY_ITEM_TYPES.has(item.type)) {
    return null;
  }
  // Truly unknown item type — fallback so new variants stay visible.
  if (typeof item.type === 'string') {
    return makeUnknownItem(base, {
      sourceType: `codex.item/completed.${item.type}`,
      payload: item,
    });
  }
  return null;
}

/**
 * Native Codex collaboration notifications describe collaboration actions,
 * not necessarily child lifecycles. The app-server item id is per action, so
 * treating every wait/sendInput/close call as a child creates duplicate
 * capsules. Only an item that proves exactly one child identity may enter the
 * Sub-agent rendering path. Anonymous or multi-child actions stay ordinary
 * collaboration tool activity.
 */
function codexCollabToolName(item: ThreadItemLike): string {
  if (getSingleCodexCollabChildId(item)) return 'codex_subagent';
  const action = typeof item.tool === 'string' && item.tool.trim()
    ? item.tool.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    : 'action';
  return `codex_collaboration_${action}`;
}

function getSingleCodexCollabChildId(item: ThreadItemLike): string | undefined {
  const ids = new Set<string>();
  for (const id of item.receiverThreadIds || []) {
    if (typeof id === 'string' && id.trim()) ids.add(id.trim());
  }
  for (const id of Object.keys(item.agentsStates || {})) {
    if (id.trim()) ids.add(id.trim());
  }
  if (ids.size !== 1) return undefined;
  return ids.values().next().value;
}

/**
 * Translate Codex's server-to-client approval requests into the
 * canonical `permission_request` event. Server-originated requests
 * are handled by `CodexAppServerClient.onServerRequest`; this helper
 * produces the canonical event the UI consumes.
 *
 * Subjects today:
 *   - `item/commandExecution/requestApproval` → `Bash · <command>`
 *   - `item/fileChange/requestApproval`       → `Patch`
 *   - `item/permissions/requestApproval`      → `Permissions`
 *   - Legacy `execCommandApproval`            → `Bash · <command>`
 *   - Legacy `applyPatchApproval`             → `Patch · N files`
 *
 * Future Codex approval kinds fall through to `permission_unavailable`
 * per the conservative-default contract.
 */
export function translateCodexApproval(args: {
  method: string;
  params: unknown;
  sessionId: string;
  requestId: string;
}): RuntimePermissionEvent {
  const { method, params, sessionId, requestId } = args;
  const base = {
    runtimeId: 'codex_runtime' as const,
    sessionId,
    requestId,
  };

  switch (method) {
    // CommandExecutionRequestApprovalParams (current canonical):
    // { threadId, turnId, itemId, startedAtMs, approvalId?, reason?,
    //   command? (string!), cwd?, commandActions? }
    case 'item/commandExecution/requestApproval': {
      const p = params as { command?: string; cwd?: string; reason?: string };
      const detailLines: string[] = [];
      if (p.cwd) detailLines.push(`cwd: ${p.cwd}`);
      if (p.reason) detailLines.push(p.reason);
      return {
        type: 'permission_request',
        ...base,
        toolName: 'Bash',
        toolInput: { command: p.command ?? '', cwd: p.cwd },
        subject: p.command ? `Bash · ${p.command}` : 'Bash',
        details: detailLines.length > 0 ? detailLines.join('\n') : undefined,
        nativeRequestRef: {
          runtimeId: 'codex_runtime',
          raw: { method, params },
        },
      };
    }

    // Legacy ExecCommandApprovalParams (server-side variant):
    // { conversationId, callId, approvalId?, command: string[], cwd, reason?, parsedCmd }
    // command is an array on this legacy path; join for display.
    case 'execCommandApproval': {
      const p = params as { command?: string[]; cwd?: string; reason?: string };
      const cmd = Array.isArray(p.command) ? p.command.join(' ') : '';
      const detailLines: string[] = [];
      if (p.cwd) detailLines.push(`cwd: ${p.cwd}`);
      if (p.reason) detailLines.push(p.reason);
      return {
        type: 'permission_request',
        ...base,
        toolName: 'Bash',
        toolInput: { command: p.command ?? [], cwd: p.cwd },
        subject: cmd ? `Bash · ${cmd}` : 'Bash',
        details: detailLines.length > 0 ? detailLines.join('\n') : undefined,
        nativeRequestRef: {
          runtimeId: 'codex_runtime',
          raw: { method, params },
        },
      };
    }

    // FileChangeRequestApprovalParams (current canonical):
    // { threadId, turnId, itemId, startedAtMs, reason?, grantRoot? }
    // No fileChanges in the canonical shape — the file list lives in
    // the corresponding `item/started` event with the same itemId.
    case 'item/fileChange/requestApproval': {
      const p = params as { reason?: string; itemId?: string };
      return {
        type: 'permission_request',
        ...base,
        toolName: 'Patch',
        toolInput: { itemId: p.itemId },
        subject: 'Patch',
        details: p.reason ?? undefined,
        nativeRequestRef: {
          runtimeId: 'codex_runtime',
          raw: { method, params },
        },
      };
    }

    // Legacy ApplyPatchApprovalParams: has fileChanges map; counter for UI.
    case 'applyPatchApproval': {
      const p = params as { fileChanges?: Record<string, unknown>; reason?: string };
      const files = p.fileChanges ? Object.keys(p.fileChanges) : [];
      const subject = files.length > 0
        ? `Patch · ${files.length} file${files.length === 1 ? '' : 's'}`
        : 'Patch';
      return {
        type: 'permission_request',
        ...base,
        toolName: 'Patch',
        toolInput: { files, fileChanges: p.fileChanges },
        subject,
        details: p.reason ?? undefined,
        nativeRequestRef: {
          runtimeId: 'codex_runtime',
          raw: { method, params },
        },
      };
    }

    case 'item/permissions/requestApproval': {
      const p = params as {
        reason?: string | null;
        cwd?: string;
        environmentId?: string | null;
        permissions?: unknown;
      };
      return {
        type: 'permission_request',
        ...base,
        toolName: 'Permissions',
        toolInput: {
          permissions: p.permissions ?? {},
          ...(p.cwd ? { cwd: p.cwd } : {}),
          ...(p.environmentId !== undefined ? { environmentId: p.environmentId } : {}),
        },
        subject: 'Codex requests elevated permissions',
        details: p.reason ?? undefined,
        // The generic UI exposes "Allow for session" only when at least one
        // suggestion is present. The response bridge never trusts this
        // renderer-round-tripped object as the grant itself: it echoes only
        // the subset originally requested by Codex and uses this hint solely
        // to select the session scope.
        permissionHints: [{
          type: 'codexPermissionGrant',
          behavior: 'allow',
          destination: 'session',
        }],
        nativeRequestRef: {
          runtimeId: 'codex_runtime',
          raw: { method, params },
        },
      };
    }

    default:
      // Conservative default — unknown approval kind. Adapter must
      // emit unavailable rather than fall through to granted.
      return {
        type: 'permission_unavailable',
        ...base,
        reason: `Codex approval kind not yet mapped: ${method}`,
      };
  }
}

/** Exposed for tests + contract pinning. */
export const CODEX_KNOWN_NOTIFICATION_METHODS = Array.from(KNOWN_CODEX_METHODS);

/**
 * Synthesize a canonical `file_changed` event from a fileChange item
 * payload at item/completed time.
 *
 * Phase 5 review round 3 (2026-05-13) — earlier revision only
 * translated fs/changed notifications into file_changed. But fs/changed
 * only fires when CodePilot has explicitly subscribed via fs/watch,
 * and ThreadItem.fileChange completions already carry the touched
 * paths inside `changes[]` (FileUpdateChange = { path, kind, diff }).
 * Without this synthesizer, Codex applying a patch via fileChange
 * wouldn't trigger preview auto-refresh even though the runtime
 * knows exactly which files changed.
 *
 * The runtime emits BOTH `tool_completed` (so chat shows "fileChange
 * done") AND this `file_changed` event (so PreviewPanel quiet-
 * refreshes). Two events from one item is legitimate — they serve
 * different downstream channels (chat UI vs preview dispatch).
 *
 * Returns null when params don't carry a fileChange item with
 * non-empty changes.
 */
export function synthesizeFileChangedFromCompletedItem(
  params: unknown,
  ctx: CodexMappingContext,
): RuntimeRunEvent | null {
  const p = params as { item?: ThreadItemLike };
  if (!p.item || p.item.type !== 'fileChange') return null;
  const changes = p.item.changes;
  if (!Array.isArray(changes) || changes.length === 0) return null;
  const paths: string[] = [];
  for (const c of changes) {
    if (c && typeof c === 'object' && 'path' in (c as Record<string, unknown>)) {
      const path = (c as { path?: unknown }).path;
      if (typeof path === 'string' && path.length > 0) paths.push(path);
    }
  }
  if (paths.length === 0) return null;
  return makeFileChanged(
    { runtimeId: 'codex_runtime' as const, sessionId: ctx.sessionId },
    { paths },
  );
}

/**
 * Render a CodexErrorInfo value (string variant OR single-key object
 * variant) into a short, human-readable classification suffix. The
 * Codex schema (codex-rs/.../v2/CodexErrorInfo.ts) is a union of
 * either a string like `'unauthorized'` / `'contextWindowExceeded'`
 * OR an object like `{ httpConnectionFailed: { httpStatusCode } }`.
 *
 * Returns `null` for `null` / unknown inputs so the caller can omit
 * the suffix instead of appending an empty parenthesis.
 */
/**
 * Phase 5b smoke round 8 (2026-05-16) — derive a MediaBlock from a
 * Codex `imageGeneration` item. Codex's schema (see
 * `资料/codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts`):
 *
 *   { type: 'imageGeneration', id, status, revisedPrompt, result, savedPath? }
 *
 * `savedPath` is what Codex auto-saved to disk; `result` is the raw
 * base64 (only present when Codex didn't save automatically). Both
 * can be absent if the generation failed mid-flight — in that case
 * we return null and the chat-side falls back to the structured
 * `output` JSON, which at least surfaces "image generation finished"
 * without an image.
 *
 * mimeType: there's no explicit field, so we infer from `savedPath`
 * extension when present, else fall back to image/png (the GPT-Image-2.0
 * default).
 */
function buildImageGenerationMedia(item: ThreadItemLike): import('@/types').MediaBlock | null {
  const savedPath = typeof item.savedPath === 'string' ? item.savedPath : undefined;
  const result = typeof item.result === 'string' ? item.result : undefined;
  if (!savedPath && !result) return null;
  const mimeType = savedPath ? mimeTypeFromPath(savedPath) ?? 'image/png' : 'image/png';
  // Capture the REAL generation context so the import layer can populate
  // the library row with `prompt = revisedPrompt` + a real model id —
  // otherwise the gallery shows `prompt = filename` and the image is
  // unsearchable / unidentifiable. (Codex protocol exposes `revisedPrompt`
  // but no model id on this item, so we tag with the fixed identifier
  // 'codex-image' that downstream UI / filters can recognize.)
  const revisedPrompt = typeof item.revisedPrompt === 'string' ? item.revisedPrompt : undefined;
  const sourceMetadata = {
    ...(revisedPrompt
      ? { prompt: revisedPrompt, model: 'codex-image' }
      : {}),
    persistence: 'durable_asset' as const,
  };
  return {
    type: 'image',
    mimeType,
    ...(savedPath ? { localPath: savedPath } : {}),
    ...(result && !savedPath ? { data: result } : {}),
    sourceMetadata,
  };
}

/**
 * Phase 5b smoke round 8 (2026-05-16) — derive a MediaBlock from a
 * Codex `imageView` item. Schema:
 *
 *   { type: 'imageView', id, path: AbsolutePathBuf }
 *
 * imageView always has a path (Codex doesn't surface raw base64 here).
 * mimeType is inferred from the extension.
 */
function buildImageViewMedia(item: ThreadItemLike): import('@/types').MediaBlock | null {
  const path = typeof item.path === 'string' ? item.path : undefined;
  if (!path) return null;
  return {
    type: 'image',
    mimeType: mimeTypeFromPath(path) ?? 'image/png',
    localPath: path,
    sourceMetadata: {
      persistence: 'preview_only',
    },
  };
}

/** Map a small set of common image extensions to MIME types. Anything
 *  unknown returns null so the caller can fall back to a sensible
 *  default. */
function mimeTypeFromPath(path: string): string | null {
  const idx = path.lastIndexOf('.');
  if (idx < 0) return null;
  const ext = path.slice(idx + 1).toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'bmp': return 'image/bmp';
    case 'avif': return 'image/avif';
    default: return null;
  }
}

function describeCodexErrorInfo(info: unknown): string | null {
  if (info == null) return null;
  if (typeof info === 'string') return info;
  if (typeof info === 'object') {
    const entries = Object.entries(info as Record<string, unknown>);
    if (entries.length === 0) return null;
    const [variant, payload] = entries[0]!;
    if (payload && typeof payload === 'object') {
      const httpStatus = (payload as { httpStatusCode?: unknown }).httpStatusCode;
      if (typeof httpStatus === 'number') return `${variant} HTTP ${httpStatus}`;
    }
    return variant;
  }
  return null;
}
