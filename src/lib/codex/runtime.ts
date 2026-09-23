import { MEMORY_SEARCH_SYSTEM_PROMPT, MEMORY_WRITE_SYSTEM_PROMPT } from '@/lib/memory-service';
import { getSessionMemoryWorkspace } from '@/lib/memory-binding';
/**
 * Codex AgentRuntime implementation.
 *
 * Phase 5 Phase 3 (2026-05-13). Wires the existing CodePilot
 * `AgentRuntime` interface (stream / interrupt / isAvailable /
 * dispose) into the Codex app-server JSON-RPC channel.
 *
 * Lifecycle per call:
 *
 *   1. getCodexAppServer() — boot + initialize the app-server child
 *      process (cached singleton; subsequent calls reuse the same
 *      client).
 *   2. Resolve thread id — `thread/resume` if the session-store has
 *      a Codex ref for this chat session, else `thread/start` with
 *      the working directory.
 *   3. Subscribe to canonical notifications (agentMessage/delta,
 *      item/started, item/completed, turn/completed, etc.).
 *   4. `turn/start` with the user prompt + optional model override.
 *   5. Translate every notification into a `RuntimeRunEvent` via
 *      `translateCodexNotification`, then re-emit as SSE lines in
 *      CodePilot's existing format (`data: {"type":...,"data":...}\n\n`).
 *   6. On `turn/completed` (or `turn/failed`), close the stream.
 *
 * Server-to-client approval requests (`execCommandApproval` etc.)
 * are NOT wired into the canonical permission channel in this slice
 * — the JSON-RPC client doesn't yet support server-originated
 * requests, only notifications. Phase 6 closes that loop.
 *
 * NOTE: this module is node-only (pulls app-server-manager which
 * imports `child_process`). Don't import from client components.
 */

import type {
  AgentRuntime,
  RuntimeStreamOptions,
} from '@/lib/runtime/types';
import type { RuntimeRunEvent } from '@/lib/runtime/contract';
import type { RuntimeContextAccountingSnapshot, FileAttachment, ConversationHistoryItem } from '@/types';
import type { CodexThreadResumeResponse, CodexThreadStartResponse } from './types';
import { prepareCodexThread, startCodexTurnWithContext } from './thread-continuation';
import { composeCodexDeveloperInstructions } from './developer-instructions';
// Phase 4 — Codex Context Accounting (2026-05-20). Imported at top so
// the closure-scoped cache + run_completed supplementary result event
// don't need dynamic import inside the sync onAnyNotification handler.
import {
  resolveCodexProviderBackend,
} from '@/lib/harness/codex-context-accounting';
import {
  ToolInvocationAccumulator,
  collectAutoInvokeSnapshot,
  resolveWorkspaceClaudeMdRules,
} from '@/lib/harness/auto-invoke-accounting';
import {
  findCodexBinary,
  getCodexAutoReviewCapability,
  getCodexAppServer,
  getCodexAvailability,
} from './app-server-manager';
import { resolveCodexEffort, resolveCodexProviderEffort } from './effort';
import { getCachedCodexEffortLevels, getCachedCodexEffortVocabulary, getCodexModelForTurn } from './models';
import { getResolvedModelEffortContract, resolveProvider } from '@/lib/provider-resolver';
import { reconcileCodexPermissionEcho, resolveCodexPermissionWire } from './permission';
import { buildReviewEvent } from '@/lib/permission/review-event';
import { emitReviewEvent } from '@/lib/permission/review-audit';
import {
  translateCodexNotification,
  synthesizeFileChangedFromCompletedItem,
} from './event-mapper';
import { materializeCodexEventMedia } from './media-import';
import { handleCodexApprovalRequest } from './approval-bridge';
import {
  buildCodexThreadParams,
  resolveCodexProxyBaseUrl,
} from './provider-proxy';
import {
  buildCodexMemoryMcpConfig,
  buildCodexWidgetMcpConfig,
  buildCodexTasksMcpConfig,
  buildCodexDashboardReadMcpConfig,
  buildCodexDashboardWriteMcpConfig,
  buildCodexCliToolsReadMcpConfig,
  buildCodexCliToolsWriteMcpConfig,
  fingerprintCodexMcpConfig,
  sameRealPath,
  type CodexMcpServersConfig,
} from './mcp-config';
import { promptNeedsWidget } from '@/lib/widget-guidelines';
import { promptNeedsDashboard } from '@/lib/dashboard-mcp';
import { promptNeedsCli } from '@/lib/cli-tools-mcp';
import {
  dispatchCodexDynamicToolCall,
  isManagedLocalDynamicToolLifecycle,
  registerCodexDynamicToolRoute,
  type McpToolCallResultLike,
} from './dynamic-tool-bridge';
import {
  codexElicitationPolicy,
  handleCodexMcpElicitationApproval,
  ACCEPT_ELICITATION,
  DECLINE_ELICITATION,
} from './mcp-elicitation';
import { getSetting, getSession } from '@/lib/db';
import { subscribeBuiltinEvents } from './proxy/builtin-event-bus';
import { createCodexAccountManagedTools } from './proxy/builtin-bridge';
import {
  codexNotificationBelongsToThread,
  registerCodexSubagentParentContext,
  type CodexSubagentParentContext,
} from './subagent';
import {
  getRuntimeSessionRef,
  setRuntimeSessionRef,
} from '@/lib/runtime/session-store';
import {
  abortCodexTurnController,
  CodexTurnInterruptRegistry,
  registerCodexTurnAbortController,
  requestCodexTurnInterrupt,
} from './turn-interrupt-registry';

/**
 * Convert one canonical RuntimeRunEvent into the SSE-line format the
 * existing chat consumers expect:
 *   `data: {"type":"<sdkType>","data":"<payload>"}\n\n`
 *
 * The chat side already knows how to render these (claude-client
 * has been emitting them for v0.x). Codex's translator hits the same
 * channel; consumers don't need a new code path.
 */
function canonicalToSseLine(event: RuntimeRunEvent): string {
  switch (event.type) {
    case 'assistant_delta':
      return `data: ${JSON.stringify({ type: 'text', data: event.text })}\n\n`;
    case 'tool_started':
      return `data: ${JSON.stringify({
        type: 'tool_use',
        data: JSON.stringify({ id: event.toolId, name: event.name, input: event.input ?? {} }),
      })}\n\n`;
    case 'tool_completed': {
      // Phase 5b smoke round 8 (2026-05-16) — forward `media` array
      // through the SSE `tool_result.media` channel. `useSSEStream.ts`
      // → `SSECallbacks.onToolResult` → `MediaPreview` consumes this
      // to render image / audio / video tool results inline. Without
      // this passthrough, Codex imageGeneration / imageView results
      // appeared as JSON inside `content` and never rendered as a
      // media card.
      //
      // Phase 5b smoke round 10 (2026-05-16) — two correctness fixes
      // at the SSE boundary:
      //
      //   1. `content` is typed `string` by both ToolResultInfo and
      //      MessageContentBlock.tool_result. Codex's imageGeneration
      //      hands us an object on `event.output`; the pre-fix code
      //      passed that object directly through JSON.stringify of
      //      the outer envelope, so the inner `content` became a
      //      JSON-encoded object inside a JSON-encoded string —
      //      working accidentally for primitives but tripping the UI
      //      when downstream code does `String(content)` or trims it.
      //      `stringifyToolResultContent` normalises to a stable
      //      string at this boundary so everything downstream can
      //      assume `content: string`.
      //
      //   2. `event.error` is the canonical "tool failed" channel,
      //      but `useSSEStream.handleSSEEvent`'s `tool_result` case
      //      reads `resultData.is_error` (matches the ClaudeCode SDK
      //      / Anthropic Messages shape). Pre-fix we emitted a raw
      //      `error: <text>` field which useSSEStream ignored, so
      //      Codex tool failures rendered as a successful result
      //      with a weird `error` extra key. Map the error onto
      //      `is_error: true` + surface the message in `content` so
      //      the UI's existing error rendering path picks it up.
      const isError = typeof event.error === 'string' && event.error.length > 0;
      const content = isError
        ? event.error!
        : stringifyToolResultContent(event.output);
      return `data: ${JSON.stringify({
        type: 'tool_result',
        data: JSON.stringify({
          tool_use_id: event.toolId,
          content,
          ...(isError ? { is_error: true } : {}),
          ...(event.media && event.media.length > 0 ? { media: event.media } : {}),
          ...(event.sources && event.sources.length > 0 ? { sources: event.sources } : {}),
        }),
      })}\n\n`;
    }
    case 'command_started':
      return `data: ${JSON.stringify({
        type: 'tool_use',
        data: JSON.stringify({ id: event.commandId, name: 'Bash', input: { command: event.command, cwd: event.cwd } }),
      })}\n\n`;
    case 'file_changed':
      // Phase 5 Phase 4 (2026-05-13) — emit as the dedicated SSE
      // `file_changed` event type. `useSSEStream.handleSSEEvent` →
      // SSECallbacks.onFileChanged → stream-session-manager →
      // dispatchFileChanged → window 'codepilot:file-changed' event →
      // PreviewPanel quiet-refresh. Same downstream path the
      // ClaudeCode SDK isWriteTool inspection uses; the runtime
      // adapter is the only place that knows where the paths come
      // from.
      return `data: ${JSON.stringify({
        type: 'file_changed',
        data: JSON.stringify({ paths: event.paths }),
      })}\n\n`;
    case 'usage_updated':
      return `data: ${JSON.stringify({
        type: 'context_usage',
        data: JSON.stringify({
          input_tokens: event.inputTokens,
          output_tokens: event.outputTokens,
          model_context_window: event.contextWindow,
        }),
      })}\n\n`;
    case 'run_completed':
      return `data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ finish_reason: event.finishReason ?? 'end_turn' }) })}\n\n`;
    case 'run_failed':
      return `data: ${JSON.stringify({ type: 'error', data: event.message })}\n\n`;
    case 'unknown_item':
      // Surface unknown items as status so the chat doesn't drop them.
      return `data: ${JSON.stringify({
        type: 'status',
        data: JSON.stringify({ kind: event.sourceType, payload: event.payload }),
      })}\n\n`;
    default: {
      const _: never = event;
      throw new Error(`canonicalToSseLine: unhandled event ${String(_)}`);
    }
  }
}

/**
 * Active Codex turn registry — Phase 5 Phase 4 Slice 3 (2026-05-13).
 *
 * `turn/interrupt` requires both `threadId` AND `turnId` per
 * upstream schema (`TurnInterruptParams = { threadId, turnId }`).
 * threadId is already persisted via session-store; turnId is
 * transient (one per send, valid until turn/completed). We keep it
 * in-process per chat session — losing it across process restart
 * is acceptable because turns don't survive restarts either.
 *
 * Map cleared when turn/completed or turn/failed lands.
 */
const activeCodexTurns = new CodexTurnInterruptRegistry();

/**
 * Issue a best-effort `turn/interrupt` for whatever turn is currently active
 * on `sessionId`. Single implementation shared by BOTH interrupt paths so they
 * can't drift (codex-stop-recovery Phase 1/2):
 *   - the public `interrupt(sessionId)` entry — HTTP `/api/chat/interrupt`
 *     fan-out (Stop button, fires immediately);
 *   - the in-stream abort-signal handler — honors the `abortController` the
 *     chat route already passes (force-abort / disconnect path).
 * Returns false (and no-ops) when there's no active turn yet — the caller uses
 * that to defer until `turn/start` resolves (the abort-before-turnId race).
 * `source` is a diagnostic tag only; never logs prompt / files / credentials.
 */
function issueCodexTurnInterrupt(sessionId: string, source: string): boolean {
  const issued = activeCodexTurns.issue(sessionId, (active) => {
    void (async () => {
      try {
        const { client } = await getCodexAppServer();
        await requestCodexTurnInterrupt(client, active);
      } catch (err) {
        console.debug(`[codex.runtime] turn/interrupt (${source}) failed (best-effort):`, err);
      }
    })();
  });
  if (!issued) {
    console.debug(`[codex.runtime] interrupt (${source}) — no active turn for`, sessionId);
  }
  return issued;
}

/**
 * Active fs/watch entries — Phase 5 review round 3 (2026-05-13).
 *
 * Codex's fs/changed notifications only fire after a corresponding
 * fs/watch subscription. We register one watch per Codex session
 * (scoped to the chat session's working directory) so shell commands
 * that write files outside the fileChange item path still surface as
 * file_changed events. Entry cleared by fs/unwatch in closeStream.
 *
 * Map value is the watchId we sent — Codex echoes it back in
 * fs/changed notifications + accepts it for fs/unwatch.
 */
const fsWatchEntries = new Map<string, string>();

/**
 * The Codex AgentRuntime singleton. Phase 5 Phase 3 registers this
 * with the runtime registry alongside `nativeRuntime` and `sdkRuntime`.
 */
export const codexRuntime: AgentRuntime = {
  id: 'codex_runtime',
  displayName: 'Codex Runtime',
  description: 'Routes through the local codex app-server (Codex account models + native tools)',

  isAvailable(): boolean {
    return findCodexBinary() !== null;
  },

  stream(options: RuntimeStreamOptions): ReadableStream<string> {
    return new ReadableStream<string>({
      async start(controller) {
        const sessionId = options.sessionId;

        let active = true;
        const unsubscribers: Array<() => void> = [];
        if (options.abortController) {
          unsubscribers.push(registerCodexTurnAbortController(
            sessionId,
            options.abortController,
          ));
        }
        const tryEnqueue = (line: string) => {
          if (!active) return;
          try {
            controller.enqueue(line);
          } catch {
            // Stream already closed (consumer aborted).
            active = false;
          }
        };

        // Phase 4 — Codex result event MUST carry usage + context_accounting
        // (user spec #6). Codex emits live `context_usage` events
        // (`usage_updated`) but `run_completed` carries no usage. We
        // cache the last usage_updated values here and emit a
        // supplementary `result` event right after run_completed so
        // chat/route.ts collectStreamResponse picks it up via the
        // standard `tokenUsage = resultData.usage` path.
        let codexUsageCache:
          | { inputTokens: number; cachedInputTokens: number | null; outputTokens: number; contextWindow: number | null }
          | null = null;

        // Phase 7 — per-turn ToolInvocationAccumulator. Wired in the
        // onAnyNotification handler below (tool_started / tool_completed /
        // command_started records) and drained on run_completed for the
        // supplementary result event's context_accounting field. Shares the
        // contract with ClaudeCode + Native (auto-invoke-accounting.ts).
        const toolInvocationAccumulator = new ToolInvocationAccumulator();

        const closeStream = (extra?: { error?: string }) => {
          // codebase-health A4 — drop the active-turn entry on EVERY close,
          // not just the terminal run_completed/run_failed branch. If the turn
          // is registered (turn/start resolved, activeCodexTurns.set below) and
          // the stream then closes via the error catch or an abort BEFORE a
          // terminal event arrives, closeStream is the single "explicit close
          // path" that codex-stop-recovery Phase 2 expects to do the cleanup.
          // Placed before the `active` guard + keyed by sessionId + idempotent
          // so a redundant close (consumer aborted → `active` already false,
          // then a late terminal event lands) still can't leave a stale turnId
          // for a future interrupt() to chase.
          activeCodexTurns.delete(sessionId);
          if (!active) return;
          if (extra?.error) {
            tryEnqueue(
              `data: ${JSON.stringify({ type: 'error', data: extra.error })}\n\n`,
            );
          }
          tryEnqueue(`data: ${JSON.stringify({ type: 'done', data: '' })}\n\n`);
          active = false;
          for (const u of unsubscribers.splice(0)) {
            try { u(); } catch { /* ignore */ }
          }
          try { controller.close(); } catch { /* ignore */ }
          // Phase 5 review round 3 (2026-05-13) — best-effort
          // fs/unwatch when the stream closes. We don't await: the
          // stream consumer doesn't care about the cleanup, and the
          // app-server forgets the watch on its end when the client
          // disconnects anyway. This is just hygiene to keep the
          // watch table small while CodePilot stays connected.
          const watchId = fsWatchEntries.get(sessionId);
          if (watchId) {
            fsWatchEntries.delete(sessionId);
            void (async () => {
              try {
                const { client } = await getCodexAppServer();
                await client.request('fs/unwatch', { watchId });
              } catch {
                /* best-effort; app-server cleans up on disconnect */
              }
            })();
          }
        };

        try {
          // ── env exclusion (Phase 5b) ───────────────────────────────
          // Reject empty / env providerId BEFORE booting the app-server
          // so the subprocess isn't spawned for a request we won't honor.
          // Codex Runtime is opt-out for env (Claude Code default); the
          // env provider routes via the Claude Code subprocess or
          // ANTHROPIC_API_KEY env, neither of which the Codex proxy
          // can target. Surfacing the failure here keeps the spawned
          // subprocess in the "actually used" set only.
          const requestedProviderId = (options.providerId ?? options.sessionProviderId ?? '').trim();
          if (!requestedProviderId || requestedProviderId === 'env') {
            throw new Error(
              'Codex Runtime requires an explicit provider. Pick a configured CodePilot provider or Codex Account; the env (Claude Code default) provider is not supported under Codex Runtime.',
            );
          }

          const { client } = await getCodexAppServer();
          const codexAccountManagedBridge = requestedProviderId === 'codex_account'
            ? createCodexAccountManagedTools({
                sessionId,
                workspacePath: options.workingDirectory,
                targetProviderId: requestedProviderId,
              })
            : null;
          const codexAccountLocalTools = new Map<
            string,
            (input: unknown, call: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<unknown>
          >();
          if (codexAccountManagedBridge) {
            for (const [name, definition] of Object.entries(codexAccountManagedBridge.tools)) {
              const execute = definition.execute;
              if (!execute) continue;
              codexAccountLocalTools.set(name, async (input, call) => {
                const result = execute(input, {
                  toolCallId: call.toolCallId,
                  messages: [],
                  context: undefined,
                  ...(call.abortSignal ? { abortSignal: call.abortSignal } : {}),
                });
                if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
                  throw new Error(`Streaming output is unsupported for CodePilot dynamic tool "${name}".`);
                }
                return await result;
              });
            }
          }

          // ── server-originated approval requests ──────────────────────
          // Phase 5 Phase 4 Slice 2 (2026-05-13). Wires Codex's
          // approval flow through CodePilot's existing PermissionPrompt
          // via `handleCodexApprovalRequest`:
          //   1. translateCodexApproval → canonical permission_request
          //   2. emits SDK-shape PermissionRequestEvent via SSE so
          //      useSSEStream + stream-session-manager + PermissionPrompt
          //      pick it up unchanged (UI doesn't branch on runtime)
          //   3. registers resolver in the existing permission-registry
          //      (same map ClaudeCode SDK uses); user response via
          //      /api/chat/permission resolves it
          //   4. translates PermissionResult → method-specific Codex
          //      response shape (different per approval method per
          //      `资料/codex/.../v2/{CommandExecution,FileChange,...}
          //      ApprovalDecision.ts`)
          //
          // Review round 3 (2026-05-13) — the original Slice 2 commit
          // shipped approval-bridge.ts + tests, but the runtime edit
          // got lost in a file-modification race and never replaced
          // the decline-by-default loop. This restoration completes
          // the wiring.
          //
          // item/permissions/requestApproval has a different response
          // shape (the granted subset + turn/session scope, not a decision
          // string). approval-bridge owns that method-specific mapping and
          // clamps the result to the profile Codex originally requested.
          for (const method of [
            'item/commandExecution/requestApproval',
            'item/fileChange/requestApproval',
            'item/permissions/requestApproval',
            'execCommandApproval',
            'applyPatchApproval',
          ]) {
            const unsubReq = client.onServerRequest(method, (params, ctx) =>
              handleCodexApprovalRequest({
                sessionId,
                jsonRpcId: ctx.id,
                method,
                params,
                emitSse: tryEnqueue,
              }),
            );
            unsubscribers.push(unsubReq);
          }

          // ── MCP elicitation / tool-call approval (Phase 3 + Phase 5 fix) ──
          // Codex sends `mcpServer/elicitation/request` (server→client) for
          // MCP elicitation AND — under approvalPolicy `on-request` — as the
          // approval gate for an MCP tool call. The Phase 5 login smoke
          // showed the model AUTONOMOUSLY calling codepilot_memory_recent,
          // but our original blanket DECLINE turned every memory call into
          // Codex's "user rejected MCP tool call" (root cause; see
          // docs/exec-plans/.../phase-8 decision log). Memory is safe_read
          // (auto_safe mutationLevel), so we ACCEPT the Memory server's
          // elicitation; every other server stays a safe DECLINE (no UI to
          // fill a real form, and no policy to approve other servers yet).
          const unsubElicit = client.onServerRequest(
            'mcpServer/elicitation/request',
            async (params, ctx) => {
              const p = (params ?? {}) as {
                serverName?: string;
                message?: string;
                mode?: string;
                requestedSchema?: unknown;
              };
              // Policy (mcp-elicitation.ts, registry-driven): safe-read →
              // auto_accept; mutating/side-effect → user_approval (surface to
              // the user); unknown → decline. Never blanket-accept.
              const policy = codexElicitationPolicy(p.serverName);
              console.debug('[codex.mcp-elicitation]', {
                serverName: p.serverName,
                mode: p.mode,
                hasSchema: p.requestedSchema != null,
                policy,
              });
              const emitStatus = (kind: string) =>
                tryEnqueue(
                  `data: ${JSON.stringify({
                    type: 'status',
                    data: JSON.stringify({
                      kind,
                      payload: { server: p.serverName ?? null, message: p.message ?? null },
                    }),
                  })}\n\n`,
                );

              if (policy === 'auto_accept') {
                emitStatus('codex.mcpElicitationAccepted');
                return ACCEPT_ELICITATION;
              }
              if (policy === 'user_approval') {
                // Mutating/side-effecting tool → ask the user (the
                // permission_request SSE is emitted inside the handler).
                return await handleCodexMcpElicitationApproval({
                  sessionId,
                  jsonRpcId: ctx.id,
                  serverName: p.serverName ?? '',
                  message: p.message,
                  mode: p.mode,
                  requestedSchema: p.requestedSchema,
                  emitSse: tryEnqueue,
                });
              }
              emitStatus('codex.mcpElicitationDeclined');
              return DECLINE_ELICITATION;
            },
          );
          unsubscribers.push(unsubElicit);

          // ── MCP dynamic tool call (Phase 8 Phase 5) ─────────────────
          // When the model AUTONOMOUSLY calls an MCP tool mid-turn,
          // Codex routes it to us as a server-originated `item/tool/call`
          // (dynamic tool call) — NOT the client→server mcpServer/tool/call
          // the Phase 0 POC used. Without this handler the client answers
          // -32601 and Codex marks the call rejected (the Phase 5 smoke
          // symptom). We forward the call back to Codex's own
          // MCP manager via mcpServer/tool/call (so Codex keeps owning the
          // MCP lifecycle, elicitation, and approval policy) and shape the
          // DynamicToolCallResponse. Do not add a second CodePilot allowlist.
          // One app-server client has one handler slot per server-request
          // method. Install a stable process dispatcher; per-thread owners are
          // registered after thread resolution below. Registering a closure
          // per chat would let the newest turn steal tool calls from older
          // concurrent chats.
          client.onServerRequest('item/tool/call', dispatchCodexDynamicToolCall);

          // ── CodePilot built-in tool bridge subscription (Phase 5c) ──
          // Side-channel events emitted by the proxy's bridge tools
          // (`codepilot_generate_image` execute() etc.) flow through
          // here. Subscribing BEFORE turn/start so even tools the
          // model calls in its very first step land on this listener.
          // The unsubscribe runs in closeStream via `unsubscribers`.
          //
          // Same materializeCodexEventMedia step the JSON-RPC path
          // uses — image paths outside `<dataDir>/.codepilot-media`
          // get imported here so `/api/media/serve` will accept them.
          const unsubBridge = subscribeBuiltinEvents(sessionId, (event) => {
            const materialised = materializeCodexEventMedia(event, {
              sessionId,
              cwd: options.workingDirectory,
            });
            tryEnqueue(canonicalToSseLine(materialised ?? event));
          });
          unsubscribers.push(unsubBridge);

          // ── proxy-injection params (Phase 5b) ───────────────────────
          // `buildCodexThreadParams` returns the same shape that both
          // `thread/start` and `thread/resume` accept (cwd /
          // modelProvider / config). We MUST re-attach this payload on
          // every resume too, not just on start — see provider-proxy.ts
          // for the three reload scenarios where a resume-without-config
          // would drop the codepilot_proxy injection and silently route
          // a continuation turn at the wrong upstream.
          // ── MCP injection (Phase 8 Phase 2) ─────────────────────────
          // Inject the CodePilot Memory MCP as a streamable-HTTP server
          // when the session runs in the assistant workspace — the same
          // gate the ClaudeCode path uses (claude-client.ts). It's served
          // in-process by /api/codex/mcp/memory, so it works in dev AND
          // packaged Electron without spawning a subprocess. User MCP
          // injection is deferred to the capability-flip slice (Phase 4);
          // only Memory is wired here, and the Settings capability stays
          // perception_only until then (codex-user-mcp-wiring guardrail).
          const codexMcpServers: CodexMcpServersConfig = {};
          const assistantWorkspacePath = getSetting('assistant_workspace_path');
          const memoryWorkspace = getSessionMemoryWorkspace(sessionId, options.workingDirectory);
          if (memoryWorkspace) {
            const memory = buildCodexMemoryMcpConfig({
              baseUrl: resolveCodexProxyBaseUrl(), workspacePath: memoryWorkspace, sessionId,
            });
            codexMcpServers[memory.name] = memory.entry;
            if (options.permissionMode !== 'plan') {
              const writes = buildCodexMemoryMcpConfig({
                baseUrl: resolveCodexProxyBaseUrl(), workspacePath: memoryWorkspace, sessionId,
                serverName: 'codepilot_memory_write',
              });
              codexMcpServers[writes.name] = writes.entry;
            }
          }
          // Widget MCP (Phase 8 #31) — keyword-gated, the SAME gate the
          // ClaudeCode path uses (`promptNeedsWidget`, shared from
          // widget-guidelines). Static read-only guidelines, no workspace
          // scope. Lets the model load the show-widget wire format and emit
          // widgets in Codex Account chats.
          if (options.prompt && promptNeedsWidget(options.prompt)) {
            const widget = buildCodexWidgetMcpConfig({
              baseUrl: resolveCodexProxyBaseUrl(),
              sessionId,
            });
            codexMcpServers[widget.name] = widget.entry;
          }
          // Tasks/Notify MCP (#31) — always-on built-in (matches the
          // ClaudeCode "always" trigger). Its mutating tools (schedule /
          // cancel / notify) route to USER APPROVAL at call time (see the
          // elicitation handler below), so it's safe to inject unconditionally.
          {
            const tasks = buildCodexTasksMcpConfig({
              baseUrl: resolveCodexProxyBaseUrl(),
              workspacePath: options.workingDirectory ?? '',
              sessionId,
            });
            codexMcpServers[tasks.name] = tasks.entry;
          }
          // Dashboard split (Codex review next slice, 2026-05-28) — same
          // keyword gate as the ClaudeCode SDK path (`promptNeedsDashboard`,
          // shared from dashboard-mcp.ts). Two MCPs: read tools (list /
          // refresh) auto_accept on elicitation; write tools (pin / update /
          // remove) routed to USER APPROVAL at call time.
          //
          // Workspace gate MIRRORS memory's (`sameRealPath` against the
          // configured assistant workspace, line ~512). The dashboard route
          // authorizes with the same realpath check — without this gate the
          // model would see the tools and Codex would 403 at call time.
          // (Codex review P1 fix, 2026-05-28.)
          if (
            options.prompt &&
            assistantWorkspacePath &&
            options.workingDirectory &&
            sameRealPath(options.workingDirectory, assistantWorkspacePath) &&
            promptNeedsDashboard(options.prompt)
          ) {
            const dashRead = buildCodexDashboardReadMcpConfig({
              baseUrl: resolveCodexProxyBaseUrl(),
              workspacePath: assistantWorkspacePath,
              sessionId,
            });
            codexMcpServers[dashRead.name] = dashRead.entry;
            const dashWrite = buildCodexDashboardWriteMcpConfig({
              baseUrl: resolveCodexProxyBaseUrl(),
              workspacePath: assistantWorkspacePath,
              sessionId,
            });
            codexMcpServers[dashWrite.name] = dashWrite.entry;
          }
          // CLI tools split — same keyword gate as the ClaudeCode SDK path
          // (`promptNeedsCli`, shared from cli-tools-mcp.ts). Read tools
          // (list / check_updates) auto_accept; mutating tools (install /
          // add / remove / update) routed to USER APPROVAL.
          if (options.prompt && promptNeedsCli(options.prompt)) {
            const cliRead = buildCodexCliToolsReadMcpConfig({
              baseUrl: resolveCodexProxyBaseUrl(),
              sessionId,
            });
            codexMcpServers[cliRead.name] = cliRead.entry;
            const cliWrite = buildCodexCliToolsWriteMcpConfig({
              baseUrl: resolveCodexProxyBaseUrl(),
              sessionId,
            });
            codexMcpServers[cliWrite.name] = cliWrite.entry;
          }
          const hasMcp = Object.keys(codexMcpServers).length > 0;
          // Fingerprint the injected MCP set; a resume whose fingerprint
          // differs starts a fresh thread (below) so a continuation can't
          // bind to a stale tool set.
          const rawMcpFingerprint = fingerprintCodexMcpConfig(
            hasMcp ? codexMcpServers : undefined,
          );
          // Dynamic tools are sticky thread-start capabilities. The revision
          // forces pre-feature Codex Account refs onto a fresh thread exactly
          // once; subsequent turns resume the thread without resending the
          // unsupported `dynamicTools` resume field.
          const mcpFingerprint = requestedProviderId === 'codex_account'
            ? `${rawMcpFingerprint}:codex-account-managed-subagents-v1`
            : rawMcpFingerprint;

          let codexPermission = resolveCodexPermissionWire({
            permissionMode: options.permissionMode,
            bypassPermissions: options.bypassPermissions,
          });
          let autoReviewUnavailableEmitted = false;
          const emitAutoReviewUnavailable = (reason: string) => {
            if (autoReviewUnavailableEmitted) return;
            autoReviewUnavailableEmitted = true;
            const event = emitReviewEvent(buildReviewEvent({
              state: 'unavailable',
              requestId: `codex-auto-review-unavailable-${sessionId}`,
              sessionId,
              runtimeId: 'codex_runtime',
              reviewerSource: 'sdk-reviewer',
              toolName: 'permission_profile:auto_review',
              reason,
            }));
            tryEnqueue(`data: ${JSON.stringify({
              type: 'permission_review',
              data: JSON.stringify({
                state: event.state,
                reviewerSource: event.reviewerSource,
                toolName: event.toolName,
                reason,
              }),
            })}\n\n`);
          };

          // Persisted sessions and direct API callers can still request the
          // profile after the composer has hidden it. Gate again at the
          // runtime boundary so an older app-server never receives an
          // unknown `approvalsReviewer` field. Fail closed to the ordinary
          // user-review profile and surface the downgrade on the canonical
          // review channel.
          if (codexPermission.thread.approvalsReviewer === 'auto_review') {
            const capability = getCodexAutoReviewCapability();
            if (!capability.supported) {
              codexPermission = resolveCodexPermissionWire({ permissionMode: 'default' });
              emitAutoReviewUnavailable(`codex_auto_review_${capability.reason}`);
            }
          }

          const parentAbortSignal = options.abortController?.signal;
          const subagentParentContext: CodexSubagentParentContext = {
            permission: codexPermission,
            ...(hasMcp ? { mcpServers: codexMcpServers } : {}),
            ...(parentAbortSignal ? { abortSignal: parentAbortSignal } : {}),
          };
          unsubscribers.push(registerCodexSubagentParentContext(
            sessionId,
            subagentParentContext,
          ));

          const applyPermissionEcho = (response: CodexThreadStartResponse | CodexThreadResumeResponse) => {
            const decision = reconcileCodexPermissionEcho({ requested: codexPermission, response });
            codexPermission = decision.wire;
            subagentParentContext.permission = codexPermission;
            if (!decision.degraded) return;
            const reason = decision.actualReviewer
              ? 'codex_auto_review_not_honoured'
              : 'codex_auto_review_echo_missing';
            emitAutoReviewUnavailable(reason);
          };

          const accountDelegationInstructions = codexAccountManagedBridge
            ? [
                'CodePilot exact-route delegation contract:',
                '- When the user requests a specific CodePilot Provider or a model different from this Codex Account parent, call codepilot_spawn_subagent directly.',
                '- Never use native spawn_agent/multi_agent_v1 as a substitute for a named Provider/Model; native workers inherit this parent route.',
                '- If the requested managed route is unavailable or fails, stop and ask the user what to do. Do not silently fall back.',
                '- Native collaboration remains available only for workers that intentionally inherit the parent Codex model.',
              ].join('\n')
            : '';
          const developerInstructions = composeCodexDeveloperInstructions(
            [options.systemPrompt,
              codexMcpServers.codepilot_memory ? MEMORY_SEARCH_SYSTEM_PROMPT : '',
              codexMcpServers.codepilot_memory_write ? MEMORY_WRITE_SYSTEM_PROMPT : '',
            ].filter(Boolean).join('\n\n'),
            accountDelegationInstructions,
          );
          const threadParams = {
            ...buildCodexThreadParams({
              providerId: requestedProviderId,
              workingDirectory: options.workingDirectory,
              proxyBaseUrl: resolveCodexProxyBaseUrl(),
              // Phase 5b smoke follow-up (2026-05-15) — Codex's
              // thread_start_params_from_config passes model alongside
              // modelProvider + config so the proxy resolves the selected id.
              model: options.model,
              // Phase 5c — lets the proxy mount CodePilot built-in tools and
              // address the side-channel event bus for this chat.
              sessionId,
              mcpServers: hasMcp ? codexMcpServers : undefined,
            }),
            ...codexPermission.thread,
            ...(developerInstructions
              ? { developerInstructions }
              : {}),
          };
          const threadStartParams = codexAccountManagedBridge
            ? {
                ...threadParams,
                dynamicTools: codexAccountManagedBridge.dynamicTools,
              }
            : threadParams;

          // Preserve the product chat and its old ref until a replacement
          // thread has accepted the first turn containing the saved history.
          const existingRef = getRuntimeSessionRef(sessionId, 'codex_runtime');
          const refMetadata = { providerId: requestedProviderId, mcpConfigFingerprint: mcpFingerprint };
          const thread = await prepareCodexThread({
            existingRef,
            providerId: requestedProviderId,
            mcpFingerprint,
            resume: async (threadId) => {
              const result = await client.request<CodexThreadResumeResponse>('thread/resume', {
                threadId,
                ...threadParams,
              });
              applyPermissionEcho(result);
            },
            start: async () => {
              const result = await client.request<CodexThreadStartResponse>(
                'thread/start',
                threadStartParams,
              );
              applyPermissionEcho(result);
              return result.thread.id;
            },
          });
          const { threadId } = thread;

          unsubscribers.push(registerCodexDynamicToolRoute(threadId, {
            forwardMcp: (req) =>
              client.request<McpToolCallResultLike>('mcpServer/tool/call', req),
            ...(codexAccountLocalTools.size > 0
              ? { localTools: codexAccountLocalTools }
              : {}),
            ...(parentAbortSignal ? { abortSignal: parentAbortSignal } : {}),
          }));

          // ── workspace filesystem watch ──────────────────────────────
          // Phase 5 review round 3 (2026-05-13). Register an fs/watch
          // scoped to the working directory so Codex emits fs/changed
          // notifications when shell commands (NOT through fileChange
          // items) touch files. The fileChange item path already gets
          // covered by `synthesizeFileChangedFromCompletedItem`; this
          // watch covers the remaining case where Codex runs e.g. a
          // `cargo build` that drops artifacts on disk.
          //
          // The watch is best-effort: a failure leaves preview auto-
          // refresh degraded to fileChange items only, but the turn
          // continues. fs/unwatch fires in closeStream so we don't
          // leak watch entries on the long-running app-server.
          if (options.workingDirectory) {
            const watchId = `codex-fs-${sessionId}`;
            try {
              await client.request('fs/watch', {
                watchId,
                path: options.workingDirectory,
              });
              fsWatchEntries.set(sessionId, watchId);
            } catch (err) {
              console.debug('[codex.runtime] fs/watch best-effort failed:', err);
            }
          }

          // ── notification fan-out ────────────────────────────────────
          // Phase 5 review round 2 (2026-05-13): subscribe through the
          // wildcard hook so the canonical mapper sees EVERY notification.
          // Previously we registered ~9 specific method handlers — anything
          // outside that allowlist silently dropped, contradicting the
          // mapper's `unknown_item` fallback contract. The wildcard puts
          // every notification through `translateCodexNotification`, so
          // unknown methods actually reach the chat surface as
          // `unknown_item` blocks instead of vanishing.
          const unsubAny = client.onAnyNotification((method, params) => {
            // The app-server connection is shared by every parent chat and
            // managed child thread. Never render a child's deltas as parent
            // prose or close the parent stream on the child's turn/completed.
            if (!codexNotificationBelongsToThread(params, threadId)) return;
            if (
              codexAccountManagedBridge
              && isManagedLocalDynamicToolLifecycle(
                method,
                params,
                codexAccountManagedBridge.toolNames,
              )
            ) {
              return;
            }
            const rawEvent = translateCodexNotification(method, params, { sessionId });
            // Phase 5b smoke round 9 (2026-05-16) — materialise MediaBlocks
            // before SSE encoding. Codex hands us raw paths like
            // /tmp/codex-out.png; /api/media/serve only allows
            // .codepilot-media. The import step copies the file into
            // the served directory and rewrites localPath so
            // MediaPreview can fetch it. No-op for non-image events
            // or already-imported blocks.
            const event = rawEvent
              ? materializeCodexEventMedia(rawEvent, { sessionId, cwd: options.workingDirectory })
              : null;
            if (event) {
              // Phase 4 — cache usage from live usage_updated events
              // so the supplementary run_completed result event below
              // can persist the final token count to DB.
              if (event.type === 'usage_updated') {
                codexUsageCache = {
                  inputTokens: event.inputTokens ?? 0,
                  cachedInputTokens: event.cachedInputTokens ?? null,
                  outputTokens: event.outputTokens ?? 0,
                  contextWindow: event.contextWindow ?? null,
                };
              }

              // Phase 7 — accumulate tool invocations for Context Accounting.
              // Codex Runtime's canonical RuntimeRunEvent already separates
              // tool_started / tool_completed / command_started into discrete
              // events with stable id+name+input shape (see
              // docs/research/codex-sdk-tool-call-surface.md). Just adapt
              // the field names to ToolInvocationAccumulator contract.
              if (event.type === 'tool_started') {
                toolInvocationAccumulator.recordToolUse(
                  event.toolId,
                  event.name,
                  event.input ?? {},
                );
              } else if (event.type === 'tool_completed') {
                toolInvocationAccumulator.recordToolResult(
                  event.toolId,
                  stringifyToolResultContent(event.output),
                );
              } else if (event.type === 'command_started') {
                toolInvocationAccumulator.recordToolUse(
                  event.commandId,
                  'Bash',
                  { command: event.command, cwd: event.cwd },
                );
              }

              tryEnqueue(canonicalToSseLine(event));

              // Phase 4 → Phase 7 — supplement run_completed with usage +
              // context_accounting so DB has final token account. The result
              // event canonicalToSseLine emitted just above carries only
              // `finish_reason`; chat/route.ts ignores it for usage. THIS
              // event is the one persisted.
              //
              // Phase 7 (2026-05-20): producer switched from
              // produceCodexAccountingSnapshot (rules-only) to
              // collectAutoInvokeSnapshot which extracts Skills/MCP/Tools
              // from the accumulated tool invocations.
              if (event.type === 'run_completed') {
                let accountingSnapshot: RuntimeContextAccountingSnapshot | undefined;
                try {
                  accountingSnapshot = collectAutoInvokeSnapshot({
                    workspacePath: options.workingDirectory ?? process.cwd(),
                    records: toolInvocationAccumulator.drain(),
                    producedBy: 'codex_runtime',
                    providerBackend: resolveCodexProviderBackend(
                      options.providerId || options.sessionProviderId || '',
                    ),
                    // Codex unsupported list — same Phase 7 ClaudeCode set.
                    // system_prompt opaque (app-server preset); memory not
                    // wired for any backend in Phase 7; files_attachments
                    // via composer pending channel.
                    unsupported: ['system_prompt', 'memory', 'files_attachments'],
                    resolveRulesEntry: resolveWorkspaceClaudeMdRules,
                  });
                } catch {
                  // best-effort
                }
                if (codexUsageCache || accountingSnapshot) {
                  const usage: Record<string, unknown> = {};
                  if (codexUsageCache) {
                    usage.input_tokens = codexUsageCache.inputTokens;
                    if (codexUsageCache.cachedInputTokens !== null) {
                      usage.cache_read_input_tokens = codexUsageCache.cachedInputTokens;
                    }
                    usage.output_tokens = codexUsageCache.outputTokens;
                    if (codexUsageCache.contextWindow !== null) {
                      usage.context_window = codexUsageCache.contextWindow;
                    }
                  }
                  if (accountingSnapshot) {
                    usage.context_accounting = accountingSnapshot;
                  }
                  tryEnqueue(
                    `data: ${JSON.stringify({
                      type: 'result',
                      data: JSON.stringify({ usage }),
                    })}\n\n`,
                  );
                }
              }
            }

            // Review round 3 (2026-05-13) — fileChange item/completed
            // also synthesizes a `file_changed` event so PreviewPanel
            // auto-refresh fires for patch-applied files even without
            // a separate fs/changed notification. Two events from one
            // notification is legitimate: tool_completed for the chat
            // UI + file_changed for the dispatch channel.
            if (method === 'item/completed') {
              const fcEvent = synthesizeFileChangedFromCompletedItem(params, { sessionId });
              if (fcEvent) tryEnqueue(canonicalToSseLine(fcEvent));
            }

            // Stream lifecycle close on terminal canonical events.
            // turn/completed with status=failed lands as `run_failed`
            // (per the mapper); status=completed/interrupted/inProgress
            // lands as `run_completed`. Both close the stream.
            //
            // Phase 5b smoke round 6 (2026-05-18) — `error` with
            // `willRetry=true` now maps to `unknown_item`
            // (sourceType='codex_retry') instead of `run_failed`, so
            // it does NOT match this branch and the stream stays
            // open for the upcoming retry / eventual turn/completed.
            // This is what "Codex will retry up to 5 times" looks
            // like on the canonical event surface.
            if (event?.type === 'run_completed' || event?.type === 'run_failed') {
              // Slice 3 (2026-05-13) — terminal event closes the stream.
              // The active-turn entry cleanup now lives in closeStream
              // (codebase-health A4, the single close exit) so a future
              // interrupt() against this session can't chase a stale turnId
              // regardless of WHICH close path ran (terminal / error / abort).
              closeStream();
            }
          });
          unsubscribers.push(unsubAny);

          // ── kick off the turn ───────────────────────────────────────
          // codex-stop-recovery Phase 2 — honor the abort signal the chat
          // route already hands us (chat/route.ts → streamClaude →
          // options.abortController). Without this, Stop / the 2s force-abort
          // never reaches the Codex app-server turn: the turn keeps running,
          // the stream never closes, and chat/route.ts renews the session lock
          // forever → "Stop 后无法发送新指令".
          const abortSignal = parentAbortSignal;
          if (abortSignal?.aborted) {
            // Stop landed during turn setup, before turn/start — don't kick
            // off a turn just to interrupt it.
            closeStream();
            return;
          }
          // `pendingAbort` covers the abort-before-turnId race: if Stop fires
          // after turn/start is sent but before we record the turnId, remember
          // it and interrupt the moment the id lands.
          let pendingAbort = false;
          if (abortSignal) {
            const onAbort = () => {
              if (!issueCodexTurnInterrupt(sessionId, 'abort-signal')) {
                pendingAbort = true;
              }
            };
            abortSignal.addEventListener('abort', onAbort, { once: true });
            unsubscribers.push(() => abortSignal.removeEventListener('abort', onAbort));
            // Close the tiny race where abort landed between the pre-start
            // check above and addEventListener — an already-aborted signal
            // never re-fires the listener, so defer the interrupt explicitly.
            if (abortSignal.aborted) pendingAbort = true;
          }

          // Phase 5 Phase 4 Slice 3 — capture the returned turn id so
          // `interrupt(sessionId)` can issue `turn/interrupt` with the
          // correct (threadId, turnId) pair per
          // `TurnInterruptParams = { threadId, turnId }` in the schema.
          // Phase 0 (2026-07-17) — send exactly the tier THIS model declares
          // in model/list. GPT-5.6 really supports xhigh/max, and the old
          // global clamp downgraded them to `high` behind the user's back.
          // Unknown/undeclared tiers are omitted (never coerced); a cold
          // cache yields no capability info and falls back to the
          // conservative clamp inside resolveCodexEffort. Replacement threads
          // may discover capabilities through the already-running client;
          // this must never spawn an app-server from the passive feed (P0.3).
          // codex_runtime only; Claude Code / Native keep the full union.
          let codexEffort: string | undefined;
          let supportsImages: boolean | undefined;
          if (requestedProviderId === 'codex_account') {
            if (!thread.resumed) {
              const model = await getCodexModelForTurn(options.model, async () => ({ client }));
              supportsImages = model?.inputModalities.includes('image');
            }
            const declaredEfforts = await getCachedCodexEffortLevels(options.model);
            codexEffort = resolveCodexEffort(options.effort, declaredEfforts);
          } else {
            const resolvedProvider = resolveProvider({
              providerId: requestedProviderId,
              model: options.model,
              runtime: 'codex_runtime',
              callScene: options.callScene,
            });
            const resolvedExactly = requestedProviderId === 'openai-oauth'
              ? resolvedProvider._openaiOAuth === true
              : requestedProviderId === 'xai-oauth'
                ? resolvedProvider._xaiOAuth === true
                : resolvedProvider.provider?.id === requestedProviderId;
            const contract = resolvedExactly
              ? getResolvedModelEffortContract(resolvedProvider, options.model)
              : {};
            if (resolvedExactly) {
              const ids = [options.model, resolvedProvider.model, resolvedProvider.upstreamModel];
              supportsImages = resolvedProvider.availableModels.find(candidate =>
                ids.includes(candidate.modelId) || (!!candidate.upstreamModelId && ids.includes(candidate.upstreamModelId)),
              )?.capabilities?.vision;
            }
            // The app-server is already initialized at this point, so this
            // cache-only availability read exposes its binary version without
            // requiring a Codex Account login or spawning another process.
            const availability = await getCodexAvailability();
            codexEffort = resolveCodexProviderEffort(
              options.effort,
              contract,
              await getCachedCodexEffortVocabulary(),
              availability.kind === 'ready' ? availability.version : undefined,
            );
          }
          // #632 / Phase 2 #3 — include image attachments in the turn input.
          // Files reach the runtime via runtimeOptions.files (claude-client.ts);
          // before this the input was text-only and images were silently dropped.
          // buildCodexTurnInput maps image/* attachments to the app-server's
          // image / localImage blocks (wire format from the POC — see
          // docs/research/codex-image-input-poc/FINDINGS.md).
          const turnFiles = options.runtimeOptions?.files as FileAttachment[] | undefined;
          const turnResult = await startCodexTurnWithContext({
            thread,
            prompt: options.prompt,
            files: turnFiles,
            sessionId,
            // Uploads belong to the product project, even when the native
            // session's sdk_cwd has moved into a subdirectory.
            workingDirectory: !thread.resumed
              ? getSession(sessionId)?.working_directory || options.workingDirectory
              : options.workingDirectory,
            supportsImages,
            history: options.runtimeOptions?.conversationHistory as
              ConversationHistoryItem[] | undefined,
            sessionSummary: options.runtimeOptions?.sessionSummary as string | undefined,
            sessionSummaryBoundaryRowid: options.runtimeOptions?.sessionSummaryBoundaryRowid as number | undefined,
            tokenBudget: options.runtimeOptions?.fallbackTokenBudget as number | undefined,
            startTurn: (input) => client.request<{ turn: { id: string } }>('turn/start', {
              threadId,
              input,
              ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}),
              ...(options.model ? { model: options.model } : {}),
              ...(codexEffort ? { effort: codexEffort } : {}),
              ...codexPermission.turn,
            }),
            saveThread: () => setRuntimeSessionRef(sessionId, {
              runtimeId: 'codex_runtime',
              token: threadId,
              metadata: refMetadata,
            }),
          });
          activeCodexTurns.set(sessionId, { threadId, turnId: turnResult.turn.id });
          if (pendingAbort) {
            // Stop arrived before we had a turnId — interrupt the just-started
            // turn now that the id is recorded.
            issueCodexTurnInterrupt(sessionId, 'abort-race');
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          closeStream({ error: reason });
        }
      },
    });
  },

  interrupt(sessionId: string): void {
    // Phase 5 Phase 4 Slice 3 (2026-05-13) — best-effort `turn/interrupt`
    // with (threadId, turnId) from the in-process `activeCodexTurns` map
    // (populated when `turn/start` resolves, cleared on turn/completed |
    // turn/failed). Per upstream README it resolves to `{}` on success and the
    // turn finishes with status: 'interrupted'. Delegates to the shared helper
    // so this HTTP-route entry and the in-stream abort-signal handler remain
    // one implementation (codex-stop-recovery). No-ops when the entry is
    // missing (race against turn completion / Codex unreachable).
    // Abort first: a parent blocked inside `item/tool/call` cannot process its
    // own turn/interrupt until the dynamic tool returns. The shared signal
    // cancels the managed child and wakes the chat route's lock watchdog;
    // turn/interrupt remains the app-server cleanup path.
    abortCodexTurnController(sessionId);
    issueCodexTurnInterrupt(sessionId, 'route');
  },

  dispose(): void {
    // Codex app-server lifecycle is managed centrally in
    // `app-server-manager.ts`. The runtime itself holds no
    // per-instance resources. Electron 'before-quit' / dev SIGTERM
    // calls `disposeCodexAppServer()` directly.
  },
};

/**
 * Normalize a `tool_completed.output` value into the STRING that
 * `ToolResultInfo.content` / `MessageContentBlock.tool_result.content`
 * both type. Codex hands us objects (e.g. imageGeneration carries
 * the full ThreadItem.fileChange shape on `output`); we serialise
 * stably so downstream code can assume `content: string` and the
 * persisted message blocks survive a JSON round-trip cleanly.
 *
 * Exported for the SSE-contract unit test.
 */
export function stringifyToolResultContent(output: unknown): string {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output;
  // For objects / arrays / numbers / booleans, JSON.stringify with
  // sorted-key behaviour would be ideal for stable diffs but ai-sdk
  // / persistence doesn't care about key order. Plain stringify.
  try {
    return JSON.stringify(output);
  } catch {
    // Circular / non-serialisable — fall back to toString so the
    // chat surface still gets *something* instead of an empty string.
    return String(output);
  }
}
