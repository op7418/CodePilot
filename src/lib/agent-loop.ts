/**
 * agent-loop.ts — Native Agent Loop (no Claude Code CLI dependency).
 *
 * Replaces the SDK's `query()` for the self-hosted runtime path.
 * Uses Vercel AI SDK `streamText()` in a manual while-loop (not maxSteps / stopWhen)
 * so we can intercept each step for permission checks, DB persistence,
 * doom-loop detection, and context-overflow handling.
 *
 * Outputs a ReadableStream<string> of SSE lines (`data: {...}\n\n`)
 * compatible with the existing frontend contract (useSSEStream.ts).
 */

import { streamText, type LanguageModel, type ToolSet, type ModelMessage } from 'ai';
import type { SSEEvent, TokenUsage, MediaBlock } from '@/types';
import { subscribeBuiltinEvents } from './harness/builtin-event-bus';
import { createModel } from './ai-provider';
import { assembleTools, READ_ONLY_TOOLS } from './agent-tools';
import { reportNativeError } from './error-classifier';
import { pruneOldToolResults } from './context-pruner';
import { shouldSuggestSkill, buildSkillNudgeStatusEvent } from './skill-nudge';
import { emit as emitEvent } from './runtime/event-bus';
import { createCheckpoint } from './file-checkpoint';
import type { PermissionMode } from './permission-checker';
import { buildCoreMessages } from './message-builder';
import { sanitizeClaudeModelOptions } from './claude-model-options';
import { buildAnthropicProviderOptions } from './agent-loop-anthropic-wire';
import { buildSamplingIgnoredNotice } from './anthropic-sampling-notice';
import { buildXaiProviderOptions } from './xai-provider-options';
import { getMessages } from './db';
import { wrapController } from './safe-stream';
import { buildNativeErrorEventData } from './agent-loop-error-event';
import { buildToolErrorResultData } from './agent-loop-tool-error';
import {
  createNativeTimeoutController,
  resolveNativeTimeoutConfig,
  TIMEOUT_CATEGORY,
  type NativeTimeoutConfig,
} from './native-timeout';
import { isAiSdkTraceEnabled, createRedactedTraceTelemetry } from './aisdk-trace';
import type { ToolInvocationRecord } from './harness/auto-invoke-accounting';
import type { ProviderCallScene } from './provider-call-policy';

// ── Types ───────────────────────────────────────────────────────

export interface AgentLoopOptions {
  /** User's prompt text */
  prompt: string;
  callScene: ProviderCallScene;
  /** Session ID (for DB persistence and SSE metadata) */
  sessionId: string;
  /** Provider ID */
  providerId?: string;
  /** Session's stored provider ID */
  sessionProviderId?: string;
  /** Model override */
  model?: string;
  /** Session's stored model */
  sessionModel?: string;
  /** System prompt string */
  systemPrompt?: string;
  /** Working directory for tool execution */
  workingDirectory?: string;
  /** AbortController for cancellation */
  abortController?: AbortController;
  /** Tools to make available to the model (if not provided, assembled from defaults) */
  tools?: ToolSet;
  /** Permission mode for tool execution */
  permissionMode?: string;
  /** MCP servers to sync before assembling tools */
  mcpServers?: Record<string, import('@/types').MCPServerConfig>;
  /** Thinking configuration (Anthropic-specific) */
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens?: number } | { type: 'disabled' };
  /** Effort level (Anthropic-specific). Opus 4.7 adds 'xhigh'. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Enable 1M context beta */
  context1m?: boolean;
  /**
   * Sampling params for the request (Anthropic path). Threaded into the shared
   * sanitizer so the adaptive family's "non-default temperature/top_p/top_k
   * returns 400" contract is enforced on the REAL request rather than only in
   * unit tests (Codex review P2, 2026-07-18: `strippedSamplingParams` had zero
   * production consumers, so a strip was silent).
   *
   * No UI surface populates these today — CodePilot doesn't expose sampling
   * controls — so the live behavior is unchanged. The plumbing exists so the
   * guard fires the moment a caller does set them, instead of the guard being
   * "safe by construction" one refactor away from a silent 400.
   */
  temperature?: number;
  topP?: number;
  topK?: number;
  /** Max agent loop steps (default 50) */
  maxSteps?: number;
  /** Whether this is an auto-trigger turn (skip rewind points) */
  autoTrigger?: boolean;
  /** Bypass all permission checks (full_access profile) */
  bypassPermissions?: boolean;
  /** File attachments from the user (images, documents, etc.) */
  files?: import('@/types').FileAttachment[];
  /** Callback when runtime status changes */
  onRuntimeStatusChange?: (status: string) => void;
  /**
   * Native timeout budgets (Phase 4 ① — src/lib/native-timeout.ts).
   * ALL DISABLED by default; may also be enabled via the
   * CODEPILOT_NATIVE_TIMEOUTS env JSON when this option is absent.
   */
  timeouts?: NativeTimeoutConfig;
}

// ── Constants ───────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 50;
const DOOM_LOOP_THRESHOLD = 3; // same tool called 3 times in a row
const KEEPALIVE_INTERVAL_MS = 15_000;

// ── Main ────────────────────────────────────────────────────────

/**
 * Run the native Agent Loop and return a ReadableStream of SSE events.
 *
 * The stream emits the same SSE event types the frontend expects:
 * text, thinking, tool_use, tool_result, tool_output, status, result,
 * error, permission_request, rewind_point, keep_alive, done.
 */
export function runAgentLoop(options: AgentLoopOptions): ReadableStream<string> {
  const {
    prompt,
    callScene,
    sessionId,
    providerId,
    sessionProviderId,
    model: modelOverride,
    sessionModel,
    systemPrompt,
    workingDirectory,
    abortController = new AbortController(),
    tools: toolsOverride,
    thinking,
    effort,
    context1m,
    temperature,
    topP,
    topK,
    maxSteps = DEFAULT_MAX_STEPS,
    autoTrigger,
    onRuntimeStatusChange,
    permissionMode,
    mcpServers,
    bypassPermissions,
    files,
    timeouts,
  } = options;

  return new ReadableStream<string>({
    async start(controllerRaw) {
      // Wrap controller so async callbacks (onStepFinish, late tool-result
      // handlers, keep-alive timer) can call enqueue() without crashing
      // when the consumer aborts. See src/lib/safe-stream.ts.
      const controller = wrapController(controllerRaw, (kind) => {
        console.warn(`[agent-loop] late ${kind} after stream close — silently dropped`);
      });
      const keepAliveTimer = setInterval(() => {
        controller.enqueue(formatSSE({ type: 'keep_alive', data: '' }));
      }, KEEPALIVE_INTERVAL_MS);

      // Phase 4 ① — native timeout reason codes. With no configured budget
      // (the default) this controller arms no timers and its signal merely
      // mirrors the user's abortController: zero behavior change. When a
      // budget fires it aborts the SAME signal streamText and the permission
      // waits listen to, and the catch tail below classifies the turn with
      // the accurate TIMEOUT_* reason code instead of a generic abort.
      const timeoutCtl = createNativeTimeoutController(
        resolveNativeTimeoutConfig(timeouts),
        abortController.signal,
      );

      // Phase 4 ③ — redacted AI SDK trace. Requires the explicit
      // CODEPILOT_AISDK_TRACE=1 env switch; default is OFF and the
      // streamText call below then carries NO telemetry option (wire- and
      // behavior-identical to before). When enabled, every event is
      // structurally redacted (see aisdk-trace.ts) before reaching stdout —
      // prompts / tool payloads / credentials never land in the trace.
      const traceIntegration = isAiSdkTraceEnabled() ? createRedactedTraceTelemetry() : null;

      // Phase 5e Phase 0.5 P1 (2026-05-17) — subscribe to the harness
      // side-channel for `tool_completed` events that built-in tools
      // (currently `codepilot_generate_image` / `codepilot_import_media`)
      // use to ship MediaBlock[] payloads to the chat UI. The tool's
      // `execute()` returns plain text to the model; this listener
      // caches the structured MediaBlock by `toolCallId` so the
      // `case 'tool-result'` handler below can splice it into the SSE
      // `tool_result.media` field.
      //
      // Subscribed BEFORE the streamText loop runs so even the very
      // first tool call's emit lands on this listener (the bus drops
      // emits without subscribers, no buffering — see contract note
      // in `harness/builtin-event-bus.ts`).
      const pendingMediaByCallId = new Map<string, MediaBlock[]>();

      // Phase 7 Context Accounting — per-turn ToolInvocationAccumulator.
      // Lives in start(controller) closure so step loop tool_use/tool_result
      // events accumulate across all steps. Drained at result emit (line ~588).
      const { ToolInvocationAccumulator } = await import(
        '@/lib/harness/auto-invoke-accounting'
      );
      const toolInvocationAccumulator = new ToolInvocationAccumulator();
      const unsubscribeMediaSideChannel = subscribeBuiltinEvents(
        sessionId,
        (event) => {
          if (event.type !== 'tool_completed') return;
          const media = event.media;
          if (!media || media.length === 0) return;
          const callId = event.toolId;
          if (!callId) return;
          pendingMediaByCallId.set(callId, [...media]);
        },
      );

      try {
        // 0. Sync MCP servers before assembling tools (await to avoid race condition)
        if (mcpServers && Object.keys(mcpServers).length > 0) {
          console.log(`[agent-loop] Syncing ${Object.keys(mcpServers).length} MCP servers: ${Object.keys(mcpServers).join(', ')}`);
          try {
            const { syncMcpConnections } = await import('./mcp-connection-manager');
            await syncMcpConnections(mcpServers);
          } catch (err) {
            console.warn('[agent-loop] MCP sync error:', err instanceof Error ? err.message : err);
            reportNativeError('MCP_CONNECTION_ERROR', err, { sessionId });
          }
        } else {
          console.log('[agent-loop] No MCP servers to sync');
        }

        // 0b. Assemble tools with permission context (needs controller for SSE emission)
        // When bypassPermissions is true (full_access profile), skip permission wrapping entirely.
        let tools: import('ai').ToolSet;
        let toolSystemPrompts: string[] = [];
        if (toolsOverride) {
          tools = toolsOverride;
        } else {
          const assembled = assembleTools({
            workingDirectory: workingDirectory || process.cwd(),
            prompt,
            mode: permissionMode,
            providerId,
            sessionProviderId,
            model: modelOverride || sessionModel,
            permissionContext: bypassPermissions ? undefined : {
              sessionId,
              permissionMode: (permissionMode || 'normal') as PermissionMode,
              emitSSE: (event) => {
                controller.enqueue(formatSSE(event as SSEEvent));
              },
              // Combined signal: user abort OR fired timeout budget — a
              // timed-out run must also unblock any pending approval wait.
              abortSignal: timeoutCtl.signal,
            },
          });
          tools = assembled.tools;
          toolSystemPrompts = assembled.systemPrompts;
        }

        // Phase 5d Phase 2 P1 fix (2026-05-17) — augment system
        // prompt with tool-specific context snippets EVEN WHEN no
        // base systemPrompt was provided. The compiler-produced
        // tool prompts are how the model learns about capability
        // surfaces (codepilot_load_widget_guidelines, the wire
        // format spec, image-gen / memory / tasks rules, etc.). If
        // the upstream caller didn't pass a base systemPrompt, we
        // STILL need to inject the capability prompts — they're a
        // contract the bridge layer ships, not optional decoration.
        //
        // Pre-fix: `length > 0 && systemPrompt ? join : systemPrompt`
        // silently dropped toolSystemPrompts whenever the base was
        // empty. Now both halves combine through filter(Boolean) so
        // either side can be empty without losing the other.
        const effectiveSystemPrompt =
          [systemPrompt, ...toolSystemPrompts].filter(Boolean).join('\n\n') ||
          undefined;

        // 1. Create model
        const { languageModel, modelId, config, isThirdPartyProxy } = createModel({
          callScene,
          providerId,
          sessionProviderId,
          model: modelOverride,
          sessionModel,
        });

        // 2. Load conversation history from DB
        const { messages: dbMessages } = getMessages(sessionId, { limit: 200, excludeHeartbeatAck: true });
        const historyMessages = buildCoreMessages(dbMessages);

        // The chat route persists the user message to DB BEFORE calling us,
        // so for normal messages it's already the last entry in historyMessages.
        //
        // autoTrigger messages are NOT saved to DB (route.ts skips addMessage),
        // so they must always be appended here.
        //
        // For non-autoTrigger: the last user message in history IS the current
        // prompt (already includes any file attachments via buildUserMessage).
        if (autoTrigger || historyMessages.length === 0 || historyMessages[historyMessages.length - 1]?.role !== 'user') {
          historyMessages.push({ role: 'user' as const, content: prompt });
        }

        // Debug: uncomment to trace message assembly issues
        // console.log(`[agent-loop] Messages: ${historyMessages.map(m => `${m.role}:${typeof m.content === 'string' ? m.content.slice(0, 30) : 'array'}`).join(' | ')}`);

        // 3. Emit status init event
        const toolNames = tools ? Object.keys(tools) : [];
        console.log(`[agent-loop] Session ${sessionId}: model=${modelId}, tools=[${toolNames.join(', ')}] (${toolNames.length} total)`);
        controller.enqueue(formatSSE({
          type: 'status',
          data: JSON.stringify({
            session_id: sessionId,
            model: modelId,
            requested_model: modelOverride || sessionModel || modelId,
            tools: toolNames,
            output_style: 'native',
          }),
        }));

        // 4. Emit rewind point for this user message (unless autoTrigger)
        // Use the actual DB message ID so the rewind route can find it
        if (!autoTrigger) {
          const lastDbUserMsg = [...dbMessages].reverse().find(m => m.role === 'user');
          const rewindMessageId = lastDbUserMsg?.id || sessionId;
          controller.enqueue(formatSSE({
            type: 'rewind_point',
            data: JSON.stringify({ userMessageId: rewindMessageId }),
          }));
          // Create file checkpoint at this rewind point
          createCheckpoint(sessionId, rewindMessageId, workingDirectory || process.cwd());
        }

        // 5. Agent Loop
        emitEvent('session:start', { sessionId, model: modelId });
        onRuntimeStatusChange?.('streaming');
        timeoutCtl.onRunStart();
        let step = 0;
        const totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
        let lastToolNames: string[] = []; // for doom loop detection
        const distinctTools = new Set<string>(); // for skill-nudge heuristic
        let messages = historyMessages;

        while (step < maxSteps) {
          step++;

          // Build provider options (Anthropic-specific).
          // Shared sanitizer applies Opus 4.7 migration guards (manual
          // thinking → adaptive, skip context-1m beta). Same function is
          // also called from the Claude Code SDK path in claude-client.ts
          // so the two runtimes can't drift on 4.7 semantics.
          //
          // Third-party proxies still get additional filtering (no adaptive
          // thinking or effort) — those are proxy compatibility concerns,
          // not Opus 4.7 migration concerns, so they stay inline here.
          //
          // Effort on the native path (@ai-sdk/anthropic 4.0.5): sent per model
          // via GA `output_config.effort` (no beta header) for the models on
          // Anthropic's effort list, omitted + announced for everything else.
          // The old workaround that dropped effort for the whole Opus 4.7+
          // family is reverted; the per-model gate lives in
          // buildAnthropicProviderOptions (model plan Phase 2 / s05).
          const sanitized = sanitizeClaudeModelOptions({
            model: config.modelId,
            thinking,
            effort,
            context1m,
            temperature,
            topP,
            topK,
          });
          if (sanitized.thinkingForcedOn && step === 1) {
            // Fable 5: thinking cannot be turned off — the sanitizer omitted
            // the user's thinking:'disabled' to stay wire-valid, but adaptive
            // thinking still runs. Surface it once instead of silently
            // misrepresenting the "thinking off" choice (Codex review P1).
            console.warn(
              `[agent-loop] Fable 5: thinking cannot be disabled — request runs with adaptive thinking despite thinking_mode='disabled'.`,
            );
            controller.enqueue(formatSSE({
              type: 'status',
              data: JSON.stringify({
                notification: true,
                code: 'THINKING_ALWAYS_ON',
                title: 'Thinking stays on for this model',
                message: `Fable 5 always uses adaptive thinking — the "thinking off" setting can't apply to this model. Use Effort to tune thinking depth instead.`,
              }),
            }));
          }
          // The adaptive family 400s on non-default temperature/top_p/top_k, so
          // the sanitizer strips them to keep the request valid. Say so once
          // instead of silently sending a different request than the caller
          // asked for (Codex review P2 — same surface-don't-swallow rule as
          // thinkingForcedOn / RUNTIME_EFFORT_IGNORED). Shared with the SDK
          // runtime so the two can't drift.
          const samplingNotice = buildSamplingIgnoredNotice({
            runtime: 'native',
            model: config.modelId,
            sanitized,
          });
          if (samplingNotice && step === 1) {
            console.warn(
              `[agent-loop] ${config.modelId}: sampling params (${samplingNotice.unsent.join(', ')}) not sent — this model rejects non-default values.`,
            );
            controller.enqueue(formatSSE({
              type: 'status',
              data: JSON.stringify({
                notification: true,
                code: samplingNotice.code,
                // Decision + interpolation values only — the client renders it
                // from src/i18n (Codex review P2). The console.warn above stays
                // as the server-side diagnostic breadcrumb; it names the param
                // keys, never their values.
                reason: samplingNotice.reason,
                params: samplingNotice.params,
              }),
            }));
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let providerOptions: any;
          if (config.sdkType === 'anthropic') {
            // Build the exact `providerOptions.anthropic` wire object. Effort
            // rides GA output_config.effort on the official path, but only for
            // models on Anthropic's effort list; unsupported models and
            // third-party proxies drop it and raise their own drop signal so we
            // surface a one-shot toast. See buildAnthropicProviderOptions for
            // the full policy + s05 rationale.
            const wire = buildAnthropicProviderOptions({
              isThirdPartyProxy,
              model: config.modelId,
              sanitized,
            });
            if (wire.effortDroppedUnsupportedModel && step === 1) {
              console.warn(
                `[agent-loop] ${config.modelId} is not on Anthropic's effort-capable model list — dropping explicit effort='${sanitized.effort}'. The model runs at its own default reasoning depth.`,
              );
              controller.enqueue(formatSSE({
                type: 'status',
                data: JSON.stringify({
                  notification: true,
                  code: 'RUNTIME_EFFORT_IGNORED',
                  // Client-localized (Codex review P2) — see status-notice-i18n.ts.
                  reason: 'unsupported-model',
                  params: { model: config.modelId || '', effort: sanitized.effort || '' },
                }),
              }));
            }
            if (wire.effortDroppedForProxy && step === 1) {
              console.warn(
                `[agent-loop] Third-party Anthropic proxy: dropping explicit effort='${sanitized.effort}' — effort GA beta header may not be supported by proxies. Switch to SDK runtime or the official Anthropic endpoint to control effort.`,
              );
              controller.enqueue(formatSSE({
                type: 'status',
                data: JSON.stringify({
                  notification: true,
                  code: 'RUNTIME_EFFORT_IGNORED',
                  title: 'Effort ignored on this runtime',
                  message: `Third-party Anthropic proxies may not support the effort parameter — your "${sanitized.effort}" choice wasn't sent. Switch to SDK runtime or an official Anthropic provider to control effort explicitly.`,
                }),
              }));
            }
            if (wire.anthropic) {
              providerOptions = { anthropic: wire.anthropic };
            }
          }

          // OpenAI Responses API (Codex) — pass system prompt + reasoning
          // Follows OpenCode's approach: default effort=medium, verbosity=medium
          if (config.useResponsesApi) {
            providerOptions = {
              ...providerOptions,
              openai: {
                ...(effectiveSystemPrompt ? { instructions: effectiveSystemPrompt } : {}),
                store: false,
                reasoningEffort: 'medium',
                textVerbosity: 'medium',
              },
            };
          }
          if (config.sdkType === 'xai') {
            providerOptions = {
              ...providerOptions,
              xai: buildXaiProviderOptions(sanitized.effort),
            };
          }

          // Prune old tool results to reduce token usage
          const prunedMessages = pruneOldToolResults(messages);

          // Determine activeTools based on mode (plan = read-only subset)
          const isPlanMode = permissionMode === 'plan';
          const hasTools = tools && Object.keys(tools).length > 0;
          const activeToolNames = isPlanMode && hasTools
            ? Object.keys(tools).filter(name => READ_ONLY_TOOLS.includes(name as typeof READ_ONLY_TOOLS[number]))
            : undefined; // undefined = all tools active

          // Phase 4 ① — arm connect + first-token budgets for this step's
          // provider request (cleared by the fullStream observer below).
          timeoutCtl.onStepRequest();

          // Call streamText (single step — we control the loop)
          const result = streamText({
            model: languageModel,
            // ai@7: `system` is a deprecated alias of `instructions` (wire-identical);
            // renamed to stay off the deprecation path.
            instructions: effectiveSystemPrompt,
            messages: prunedMessages,
            tools: hasTools ? tools : undefined,
            // activeTools: limit available tools in plan mode (AI SDK feature)
            ...(activeToolNames ? { activeTools: activeToolNames } : {}),
            // toolChoice: auto by default, none if no tools
            toolChoice: hasTools ? 'auto' : 'none',
            providerOptions,
            // Sampling params that survived sanitization. Spread (not
            // `temperature: x ?? undefined`) so an absent value leaves the
            // option off the call entirely — wire-identical to before for every
            // caller that doesn't set them. Values stripped by the sanitizer
            // never reach here; the user was told about them above.
            ...sanitized.sampling,
            abortSignal: timeoutCtl.signal,
            // Codex API doesn't support max_output_tokens
            ...(config.useResponsesApi ? {} : { maxOutputTokens: 16384 }),
            // Phase 4 ③ — redacted trace, only when explicitly enabled via
            // CODEPILOT_AISDK_TRACE=1 (null → option absent → no change).
            ...(traceIntegration
              ? { telemetry: { isEnabled: true, functionId: 'native-agent-loop', integrations: [traceIntegration] } }
              : {}),

            // onStepFinish: token tracking per step
            onStepFinish: ({ usage: stepUsage, finishReason, toolCalls }) => {
              if (stepUsage) {
                totalUsage.input_tokens += stepUsage.inputTokens || 0;
                totalUsage.output_tokens += stepUsage.outputTokens || 0;
              }
              // Emit step progress for frontend token display
              controller.enqueue(formatSSE({
                type: 'status',
                data: JSON.stringify({
                  subtype: 'step_complete',
                  step,
                  usage: totalUsage,
                  finishReason,
                  toolsUsed: toolCalls?.map(tc => tc.toolName) || [],
                }),
              }));
            },

            // onAbort: cleanup on interruption. A fired timeout budget also
            // aborts this signal but is an ERROR (classified in the catch
            // tail), not a user interruption — skip the aborted teardown.
            onAbort: () => {
              if (timeoutCtl.fired) return;
              onRuntimeStatusChange?.('idle');
              emitEvent('session:end', { sessionId, steps: step, aborted: true });
            },

            // repairToolCall: auto-fix invalid tool calls before failing
            experimental_repairToolCall: async ({ toolCall, tools: availableTools, error }) => {
              // Log the repair attempt for debugging
              console.warn(`[agent-loop] Repairing tool call "${toolCall.toolName}": ${error.message}`);
              // Return null to let the SDK retry with the model
              // (the model sees the error and can fix the call)
              return null;
            },

            onError: (event) => {
              const err = event.error;
              const msg = err instanceof Error ? err.message : String(err);
              console.error('[agent-loop] streamText error:', msg);
              if (err && typeof err === 'object') {
                const anyErr = err as Record<string, unknown>;
                if (anyErr.responseBody) console.error('[agent-loop] Response body:', anyErr.responseBody);
                if (anyErr.statusCode) console.error('[agent-loop] Status code:', anyErr.statusCode);
              }
              // Classify and report to Sentry
              const isAuthError = /unauthorized|forbidden|401|403/i.test(msg);
              const category = config.useResponsesApi && isAuthError
                ? 'OPENAI_AUTH_FAILED' as const
                : 'NATIVE_STREAM_ERROR' as const;
              reportNativeError(category, err, { modelId, sessionId });
            },
          });

          // Consume the fullStream
          let hasToolCalls = false;
          let hasContent = false; // tracks whether any actual content was produced
          const stepToolNames: string[] = [];

          // guardStream: a fired budget must unblock this loop even when a
          // hung tool ignores the abort signal (ai@7 awaits execute() and
          // would otherwise keep fullStream open forever). No budgets → the
          // iterable passes through unchanged.
          for await (const event of timeoutCtl.guardStream(result.fullStream)) {
            // Phase 4 ① — timeout observer: clears connect on start-step,
            // first-token on the first output part; tracks per-tool timers.
            timeoutCtl.onStreamPart(event as { type: string; toolCallId?: string });
            switch (event.type) {
              case 'text-delta':
                hasContent = true;
                controller.enqueue(formatSSE({ type: 'text', data: event.text }));
                break;

              case 'reasoning-delta':
                hasContent = true;
                controller.enqueue(formatSSE({ type: 'thinking', data: event.text }));
                break;

              case 'tool-call':
                hasToolCalls = true;
                stepToolNames.push(event.toolName);
                distinctTools.add(event.toolName);
                // Phase 7 — accumulate for Context Accounting at result time.
                toolInvocationAccumulator.recordToolUse(
                  event.toolCallId,
                  event.toolName,
                  event.input,
                );
                controller.enqueue(formatSSE({
                  type: 'tool_use',
                  data: JSON.stringify({
                    id: event.toolCallId,
                    name: event.toolName,
                    input: event.input,
                  }),
                }));
                break;

              case 'tool-result': {
                // Phase 5e Phase 0.5 P1 (2026-05-17) — splice any
                // MediaBlock the tool emitted via the harness
                // side-channel (`harness/builtin-event-bus.ts`) into
                // the SSE `tool_result.media` field. useSSEStream on
                // the frontend already reads `tool_result.media` and
                // pipes it into `MediaPreview` (the same path the
                // Codex bridge already used). Tool text stays clean
                // — the model only sees the plain output below, never
                // the MediaBlock payload.
                const media = pendingMediaByCallId.get(event.toolCallId);
                if (media) pendingMediaByCallId.delete(event.toolCallId);
                const resultText = typeof event.output === 'string'
                  ? event.output
                  : JSON.stringify(event.output);
                // Phase 7 — accumulate for Context Accounting.
                toolInvocationAccumulator.recordToolResult(event.toolCallId, resultText);
                controller.enqueue(formatSSE({
                  type: 'tool_result',
                  data: JSON.stringify({
                    tool_use_id: event.toolCallId,
                    content: resultText,
                    is_error: false,
                    ...(media && media.length > 0 ? { media } : {}),
                  }),
                }));
                break;
              }

              case 'tool-error': {
                // #49 — a tool's execute() threw. The AI SDK emits a
                // `tool-error` fullStream part (not `tool-result`); before
                // this case existed it fell to `default` and was silently
                // swallowed, leaving the tool_use bubble with no result.
                // Forward it as an is_error:true tool_result so the UI shows
                // an error bubble (same channel a normal tool failure uses).
                const errorResult = buildToolErrorResultData(event);
                // Accounting parity with the tool-result branch: the tool WAS
                // invoked and its error output is fed back to the model, so
                // record it (otherwise the accumulator holds a recordToolUse
                // with no matching result).
                toolInvocationAccumulator.recordToolResult(
                  errorResult.tool_use_id,
                  errorResult.content,
                );
                controller.enqueue(formatSSE({
                  type: 'tool_result',
                  data: JSON.stringify(errorResult),
                }));
                break;
              }

              case 'error':
                controller.enqueue(formatSSE({
                  type: 'error',
                  data: typeof event.error === 'string' ? event.error : JSON.stringify({ userMessage: String(event.error) }),
                }));
                break;

              // Events we don't forward to the frontend
              default:
                break;
            }
          }

          // Step's stream fully consumed — clear step-scoped timeout budgets.
          timeoutCtl.onStepEnd();

          // Usage is accumulated in onStepFinish callback above

          // If no tool calls, the model is done
          if (!hasToolCalls) {
            // Detect truly empty response (no text, no thinking, no tools)
            if (!hasContent) {
              const finishReason = await result.finishReason;
              console.error(`[agent-loop] Empty response: finishReason=${finishReason}, model=${modelId}`);
              reportNativeError('EMPTY_RESPONSE', new Error(`Empty response: finishReason=${finishReason}`), { modelId, sessionId });
              controller.enqueue(formatSSE({
                type: 'error',
                data: JSON.stringify({
                  category: 'EMPTY_RESPONSE',
                  userMessage: `模型未返回任何内容 (finishReason: ${finishReason})。可能是 API 代理不兼容或模型 ID "${modelId}" 不被支持。`,
                }),
              }));
            }
            break;
          }

          // Doom loop detection: same tool(s) called 3 times in a row
          const toolKey = stepToolNames.sort().join(',');
          const lastKey = lastToolNames.sort().join(',');
          if (toolKey === lastKey) {
            const repeatCount = (step > 1) ? DOOM_LOOP_THRESHOLD : 1;
            // Simple heuristic: track repeats via a counter we'd need to add
            // For now, just detect immediate repeats and break after threshold
          }
          lastToolNames = stepToolNames;

          // Update messages for next iteration.
          // streamText returns the full message list including our input + model response.
          // Use response.messages which contains properly typed ModelMessage[].
          const responseData = await result.response;
          messages = [...messages, ...responseData.messages] as ModelMessage[];
        }

        // 6a. Emit skill-nudge if the run was complex enough to warrant saving as a Skill.
        // Heuristic: >= 8 agent steps AND >= 3 distinct tools used. See skill-nudge.ts.
        //
        // Event shape is designed to be consumed by BOTH web and bridge:
        //   - Web SSE parser (useSSEStream.ts): `notification: true` + `message`
        //     routes through the status/notification branch so the message
        //     shows in the status bar.
        //   - Bridge parser (conversation-engine.ts): `subtype: 'skill_nudge'`
        //     routes through a dedicated handler that appends the nudge to
        //     the assistant message as a separated text block.
        //   - Future dedicated UI: `subtype: 'skill_nudge'` + full `payload`
        //     provides structured data for a rich nudge card.
        if (shouldSuggestSkill({ step, distinctTools })) {
          controller.enqueue(formatSSE({
            type: 'status',
            data: JSON.stringify(buildSkillNudgeStatusEvent({ step, distinctTools })),
          }));
        }

        // 6. Emit result event (Phase 7 — Context Accounting Runtime Contract:
        // collectAutoInvokeSnapshot replaces produceNativeAccountingSnapshot,
        // unifying with ClaudeCode/Codex via auto-invoke-accounting.ts.
        // Skills/MCP/Tools now come from real per-turn invocations accumulated
        // during streaming, not from filesystem guesses).
        //
        // Context window (2026-06-19, v0.56.x #632): Native's Vercel AI SDK
        // LanguageModelUsage doesn't expose a model context window — unlike
        // ClaudeCode (SDKResultMessage.modelUsage) and Codex
        // (ThreadTokenUsage.modelContextWindow), which get it from upstream.
        // We DELIBERATELY no longer fall back to the static catalog here:
        // writing the catalog GUESS into `context_window` laundered it into
        // the field `useContextUsage` treats as SDK-authoritative, so the UI
        // rendered a "trusted" capacity / percentage against a window the
        // runtime never reported (the GLM "200K" the user flagged). Leaving it
        // absent lets useContextUsage fall back to the catalog as UNtrusted →
        // used-tokens only, no fabricated percentage. The runtime-agnostic
        // TRUSTED source is a real per-model window override (provider config)
        // — see the v0.56.x plan Phase 2 context-window source-priority design.

        const nativeAccountingSnapshot = await buildNativeAccountingSnapshot(
          toolInvocationAccumulator.drain(),
          workingDirectory || process.cwd(),
        );
        const usageWithAccounting =
          totalUsage && nativeAccountingSnapshot
            ? { ...totalUsage, context_accounting: nativeAccountingSnapshot }
            : totalUsage;
        controller.enqueue(formatSSE({
          type: 'result',
          data: JSON.stringify({
            usage: usageWithAccounting,
            session_id: sessionId,
            num_turns: step,
          }),
        }));

        emitEvent('session:end', { sessionId, steps: step });
        onRuntimeStatusChange?.('idle');
      } catch (err: unknown) {
        // Phase 4 ① — a fired timeout budget aborts the combined signal, so
        // it surfaces here as an AbortError. It must be classified as a
        // TIMEOUT_* error (reason code from the controller, never inferred
        // from the message), NOT swallowed as a user abort.
        const timedOut = timeoutCtl.fired;
        const isAbort = !timedOut && err instanceof Error && (
          err.name === 'AbortError' ||
          abortController.signal.aborted
        );

        if (!isAbort) {
          console.error('[agent-loop] Error:', err instanceof Error ? err.message : err);
          reportNativeError(
            timedOut ? TIMEOUT_CATEGORY[timedOut.reason] : 'NATIVE_STREAM_ERROR',
            err,
            { sessionId },
          );
          // A3 (audit 2026-06): the success path drains the accumulator at
          // result time; if we threw inside the step loop that drain never
          // ran, so drain here too and attach the snapshot to the error event
          // (the same context_accounting field the result event carries).
          // Only collect when this turn actually invoked tools before the
          // throw — an empty turn would otherwise pay collectAutoInvokeSnapshot's
          // CLAUDE.md file read for nothing. (Codex P2)
          const errorRecords = toolInvocationAccumulator.drain();
          const errorAccounting =
            errorRecords.length > 0
              ? await buildNativeAccountingSnapshot(
                  errorRecords,
                  workingDirectory || process.cwd(),
                )
              : undefined;
          controller.enqueue(formatSSE({
            type: 'error',
            data: JSON.stringify(buildNativeErrorEventData(err, errorAccounting, timedOut)),
          }));
        }

        // 用户主动中止不是错误：状态标 'idle'，否则会话在 route 收尾竞态窗口内
        // 显示假 error（语义失真）。真实错误与 timeout 仍标 'error'。
        onRuntimeStatusChange?.(isAbort ? 'idle' : 'error');
      } finally {
        timeoutCtl.dispose();
        clearInterval(keepAliveTimer);
        // Phase 5e Phase 0.5 P1 — release the side-channel listener.
        // Leaving it attached across turns would leak MediaBlock from
        // one turn's tool call into the next turn's UI if the same
        // session id gets reused (see contract note in
        // harness/builtin-event-bus.ts about cross-turn leakage).
        unsubscribeMediaSideChannel();
        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      }
    },
  });
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Build the Native-runtime context-accounting snapshot from the turn's drained
 * tool records. Shared by the success path (result event) and the error path
 * (error event) so an error-terminated turn reports the same snapshot shape it
 * would have had on success. Best-effort: returns undefined if the producer
 * import or collection fails. (audit A3)
 */
async function buildNativeAccountingSnapshot(
  records: readonly ToolInvocationRecord[],
  workspacePath: string,
): Promise<import('@/types').RuntimeContextAccountingSnapshot | undefined> {
  try {
    const { collectAutoInvokeSnapshot, resolveWorkspaceClaudeMdRules } =
      await import('@/lib/harness/auto-invoke-accounting');
    return collectAutoInvokeSnapshot({
      workspacePath,
      records,
      producedBy: 'codepilot_runtime',
      // Native unsupported list — same as ClaudeCode (system_prompt is ai-sdk
      // preset opaque; memory not wired; files_attachments via composer
      // pending channel not Runtime).
      unsupported: ['system_prompt', 'memory', 'files_attachments'],
      resolveRulesEntry: resolveWorkspaceClaudeMdRules,
    });
  } catch {
    return undefined; // best-effort — snapshot omitted on producer failure
  }
}

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
