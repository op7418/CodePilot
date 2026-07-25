/**
 * agent-loop-toolloop-poc.ts — AI SDK 7 Phase 3 side-by-side POC.
 *
 * EXPERIMENTAL — NOT WIRED INTO ANY RUNTIME. Nothing on the default chat
 * path imports this module. The only entry points are:
 *   - src/__tests__/unit/toolloop-poc-parity.test.ts (SSE / DB / permission
 *     parity against agent-loop.ts)
 *   - scripts/smoke-ai-sdk7-phase3-poc.mjs (live gateway smoke)
 *
 * What it is: `runAgentLoop()` re-implemented on top of AI SDK 7's
 * `ToolLoopAgent` instead of the manual while-loop around single-step
 * `streamText()`. The goal is to measure parity, not to replace the loop —
 * Experimental AI SDK 7 ToolLoop agent parity POC.
 *
 * Deliberate mirroring rules:
 *   - Same `AgentLoopOptions` input type as agent-loop.ts.
 *   - Same SSE event contract (text / thinking / tool_use / tool_result /
 *     status / result / error / permission_request / rewind_point /
 *     keep_alive / done) with identical payload field names.
 *   - Same tool assembly (assembleTools + permission wrapping) — the
 *     permission_request / permission_resolved flow lives INSIDE the wrapped
 *     tool's execute(), so it is shared verbatim with the production loop.
 *     ToolLoopAgent's own `toolApproval` / `needsApproval` machinery is
 *     intentionally NOT used: it pauses the loop and requires an
 *     approval-response resubmission round-trip, which would change
 *     CodePilot's blocking-approval semantics (documented as a Phase 3 gap).
 *   - providerOptions construction is copied verbatim from agent-loop.ts
 *     (lines ~284-414). agent-loop recomputes it every step but the value is
 *     step-invariant; the step===1 one-shot notifications map to "emit once
 *     before starting the agent" here.
 *
 * Known intentional differences (tracked in the Phase 3 gap list):
 *   - Per-step history pruning uses `prepareStep` returning a pruned
 *     `messages` override (which carries forward) instead of re-pruning a
 *     fresh copy of the accumulated list each iteration. Output-equivalent
 *     because pruneOldToolResults only rewrites messages OLDER than the
 *     keep-window, and once a message leaves the window it never re-enters.
 *   - agent-loop's doom-loop "detection" is a no-op stub (computes keys,
 *     never breaks); the POC does not carry the stub.
 */

import {
  ToolLoopAgent,
  stepCountIs,
  type ToolSet,
  type ModelMessage,
} from 'ai';
import type { SSEEvent, TokenUsage, MediaBlock } from '@/types';
import { subscribeBuiltinEvents } from '../harness/builtin-event-bus';
import { createModel } from '../ai-provider';
import { assembleTools, READ_ONLY_TOOLS } from '../agent-tools';
import { reportNativeError } from '../error-classifier';
import { pruneOldToolResults } from '../context-pruner';
import { shouldSuggestSkill, buildSkillNudgeStatusEvent } from '../skill-nudge';
import { emit as emitEvent } from '../runtime/event-bus';
import { createCheckpoint } from '../file-checkpoint';
import type { PermissionMode } from '../permission-checker';
import { buildCoreMessages } from '../message-builder';
import { sanitizeClaudeModelOptions } from '../claude-model-options';
import { buildAnthropicProviderOptions } from '../agent-loop-anthropic-wire';
import { getMessages } from '../db';
import { wrapController } from '../safe-stream';
import { buildNativeErrorEventData } from '../agent-loop-error-event';
import { buildToolErrorResultData } from '../agent-loop-tool-error';
import type { AgentLoopOptions } from '../agent-loop';
import type { ToolInvocationRecord } from '../harness/auto-invoke-accounting';

const DEFAULT_MAX_STEPS = 50;
const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Run the ToolLoopAgent-backed POC loop and return a ReadableStream of SSE
 * events with the same contract as `runAgentLoop()`.
 */
export function runToolLoopAgentPoc(options: AgentLoopOptions): ReadableStream<string> {
  const {
    prompt,
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
    maxSteps = DEFAULT_MAX_STEPS,
    autoTrigger,
    onRuntimeStatusChange,
    permissionMode,
    mcpServers,
    bypassPermissions,
  } = options;

  return new ReadableStream<string>({
    async start(controllerRaw) {
      const controller = wrapController(controllerRaw, (kind) => {
        console.warn(`[toolloop-poc] late ${kind} after stream close — silently dropped`);
      });
      const keepAliveTimer = setInterval(() => {
        controller.enqueue(formatSSE({ type: 'keep_alive', data: '' }));
      }, KEEPALIVE_INTERVAL_MS);

      // Media side-channel — same subscription contract as agent-loop.ts.
      const pendingMediaByCallId = new Map<string, MediaBlock[]>();
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

      // Mirrors agent-loop step-scoped state; step counted via start-step.
      let step = 0;
      const totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
      const distinctTools = new Set<string>();

      try {
        // 0. Sync MCP servers (same as agent-loop step 0)
        if (mcpServers && Object.keys(mcpServers).length > 0) {
          try {
            const { syncMcpConnections } = await import('../mcp-connection-manager');
            await syncMcpConnections(mcpServers);
          } catch (err) {
            console.warn('[toolloop-poc] MCP sync error:', err instanceof Error ? err.message : err);
            reportNativeError('MCP_CONNECTION_ERROR', err, { sessionId });
          }
        }

        // 0b. Assemble tools with permission context (same as agent-loop 0b)
        let tools: ToolSet;
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
              abortSignal: abortController.signal,
            },
          });
          tools = assembled.tools;
          toolSystemPrompts = assembled.systemPrompts;
        }

        const effectiveSystemPrompt =
          [systemPrompt, ...toolSystemPrompts].filter(Boolean).join('\n\n') ||
          undefined;

        // 1. Create model (same factory as agent-loop)
        const { languageModel, modelId, config, isThirdPartyProxy } = createModel({
          callScene: 'interactive_chat',
          providerId,
          sessionProviderId,
          model: modelOverride,
          sessionModel,
        });

        // 2. Load conversation history from DB (same as agent-loop step 2)
        const { messages: dbMessages } = getMessages(sessionId, { limit: 200, excludeHeartbeatAck: true });
        const historyMessages = buildCoreMessages(dbMessages);
        if (autoTrigger || historyMessages.length === 0 || historyMessages[historyMessages.length - 1]?.role !== 'user') {
          historyMessages.push({ role: 'user' as const, content: prompt });
        }

        // 3. Emit status init event (same shape as agent-loop step 3)
        const toolNames = tools ? Object.keys(tools) : [];
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

        // 4. Emit rewind point + checkpoint (same as agent-loop step 4)
        if (!autoTrigger) {
          const lastDbUserMsg = [...dbMessages].reverse().find(m => m.role === 'user');
          const rewindMessageId = lastDbUserMsg?.id || sessionId;
          controller.enqueue(formatSSE({
            type: 'rewind_point',
            data: JSON.stringify({ userMessageId: rewindMessageId }),
          }));
          createCheckpoint(sessionId, rewindMessageId, workingDirectory || process.cwd());
        }

        // 5. providerOptions — copied verbatim from agent-loop.ts (~284-414).
        // agent-loop recomputes per step but the value never varies across
        // steps; the step===1 one-shot notifications become emit-once here.
        const sanitized = sanitizeClaudeModelOptions({
          model: config.modelId,
          thinking,
          effort,
          context1m,
        });
        if (sanitized.thinkingForcedOn) {
          console.warn(
            `[toolloop-poc] Fable 5: thinking cannot be disabled — request runs with adaptive thinking despite thinking_mode='disabled'.`,
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let providerOptions: any;
        if (config.sdkType === 'anthropic') {
          // Parity with agent-loop.ts via the SAME shared builder (model plan
          // Phase 2 / s05) — the wire shape and both effort-drop rules
          // (unsupported model on the official path, any model on a proxy) can
          // no longer drift between the two native paths.
          const wire = buildAnthropicProviderOptions({
            isThirdPartyProxy,
            model: config.modelId,
            sanitized,
          });
          if (wire.effortDroppedForProxy) {
            console.warn(
              `[toolloop-poc] Third-party Anthropic proxy: dropping explicit effort='${sanitized.effort}' — effort GA beta header may not be supported by proxies. Switch to SDK runtime or the official Anthropic endpoint to control effort.`,
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
          if (wire.effortDroppedUnsupportedModel) {
            console.warn(
              `[toolloop-poc] ${config.modelId} is not on Anthropic's effort-capable model list — dropping explicit effort='${sanitized.effort}'. The model runs at its own default reasoning depth.`,
            );
            controller.enqueue(formatSSE({
              type: 'status',
              data: JSON.stringify({
                notification: true,
                code: 'RUNTIME_EFFORT_IGNORED',
                // Client-localized, same key as agent-loop (no drift between
                // the two native paths) — see status-notice-i18n.ts.
                reason: 'unsupported-model',
                params: { model: config.modelId || '', effort: sanitized.effort || '' },
              }),
            }));
          }
          if (wire.anthropic) {
            providerOptions = { anthropic: wire.anthropic };
          }
        }

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

        const isPlanMode = permissionMode === 'plan';
        const hasTools = tools && Object.keys(tools).length > 0;
        const activeToolNames = isPlanMode && hasTools
          ? Object.keys(tools).filter(name => READ_ONLY_TOOLS.includes(name as typeof READ_ONLY_TOOLS[number]))
          : undefined;

        emitEvent('session:start', { sessionId, model: modelId });
        onRuntimeStatusChange?.('streaming');

        // 6. ToolLoopAgent — replaces the manual while-loop. Loop-continuation
        // rule: SDK continues while the last step has tool RESULTS and no stop
        // condition is met; agent-loop continues while the step made tool
        // CALLS. Divergence only when a call produces no result (execute-less
        // tool) — not a shape CodePilot's assembled tools produce.
        const agent = new ToolLoopAgent({
          model: languageModel,
          ...(effectiveSystemPrompt ? { instructions: effectiveSystemPrompt } : {}),
          tools: hasTools ? tools : undefined,
          ...(activeToolNames ? { activeTools: activeToolNames } : {}),
          toolChoice: hasTools ? 'auto' : 'none',
          providerOptions,
          ...(config.useResponsesApi ? {} : { maxOutputTokens: 16384 }),
          stopWhen: stepCountIs(maxSteps),
          // Per-step history pruning — agent-loop applies pruneOldToolResults
          // before every streamText call; prepareStep is the SDK's equivalent
          // interception point.
          prepareStep: ({ messages }) => ({
            messages: pruneOldToolResults(messages as ModelMessage[]),
          }),
          experimental_repairToolCall: async ({ toolCall, error }) => {
            console.warn(`[toolloop-poc] Repairing tool call "${toolCall.toolName}": ${error.message}`);
            return null;
          },
        });

        const result = await agent.stream({
          messages: historyMessages,
          abortSignal: abortController.signal,
          onStepFinish: ({ usage: stepUsage, finishReason, toolCalls }) => {
            if (stepUsage) {
              totalUsage.input_tokens += stepUsage.inputTokens || 0;
              totalUsage.output_tokens += stepUsage.outputTokens || 0;
            }
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
        });

        // 7. Consume the fullStream — same switch as agent-loop's inner loop,
        // plus start-step bookkeeping (agent-loop resets these per while-pass).
        let lastStepHadToolCalls = false;
        let lastStepHadContent = false;

        for await (const event of result.fullStream) {
          switch (event.type) {
            case 'start-step':
              step++;
              lastStepHadToolCalls = false;
              lastStepHadContent = false;
              break;

            // agent-loop wires streamText's onAbort callback for this;
            // ToolLoopAgent surfaces abort as a stream part instead.
            case 'abort':
              onRuntimeStatusChange?.('idle');
              emitEvent('session:end', { sessionId, steps: step, aborted: true });
              break;

            case 'text-delta':
              lastStepHadContent = true;
              controller.enqueue(formatSSE({ type: 'text', data: event.text }));
              break;

            case 'reasoning-delta':
              lastStepHadContent = true;
              controller.enqueue(formatSSE({ type: 'thinking', data: event.text }));
              break;

            case 'tool-call':
              lastStepHadToolCalls = true;
              distinctTools.add(event.toolName);
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
              const media = pendingMediaByCallId.get(event.toolCallId);
              if (media) pendingMediaByCallId.delete(event.toolCallId);
              const resultText = typeof event.output === 'string'
                ? event.output
                : JSON.stringify(event.output);
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
              // #49 parity with agent-loop.ts — a tool's execute() threw.
              // ToolLoopAgent surfaces it as a `tool-error` stream part;
              // forward it as an is_error:true tool_result instead of letting
              // it fall to `default` and get swallowed (no UI error bubble).
              const errorResult = buildToolErrorResultData(event);
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

            case 'error': {
              const err = event.error;
              const msg = err instanceof Error ? err.message : String(err);
              console.error('[toolloop-poc] stream error:', msg);
              const isAuthError = /unauthorized|forbidden|401|403/i.test(msg);
              const category = config.useResponsesApi && isAuthError
                ? 'OPENAI_AUTH_FAILED' as const
                : 'NATIVE_STREAM_ERROR' as const;
              reportNativeError(category, err, { modelId, sessionId });
              controller.enqueue(formatSSE({
                type: 'error',
                data: typeof event.error === 'string' ? event.error : JSON.stringify({ userMessage: String(event.error) }),
              }));
              break;
            }

            // start / finish / abort / tool-input-* / text-start etc. — not
            // forwarded, same as agent-loop's default branch.
            default:
              break;
          }
        }

        // 8a. Abort routing parity. When the user aborts while the last step
        // still had pending tool calls, agent-loop tries to CONTINUE the
        // while-loop (await result.response / next streamText call) and
        // throws AbortError → its catch tail: no empty-response check, no
        // skill nudge, NO result event (finally still emits done). When the
        // abort lands on a step WITHOUT tool calls (mid-text abort),
        // agent-loop breaks normally and DOES emit the result event.
        // ToolLoopAgent ends its stream gracefully in both cases, so route
        // the tool-call case to the same tail agent-loop's throw reaches.
        if (abortController.signal.aborted && lastStepHadToolCalls) {
          onRuntimeStatusChange?.('error'); // mirrors agent-loop's catch tail
          return; // finally emits done + closes
        }

        // 8. Empty-response detection — agent-loop checks the FINAL step (the
        // one that made no tool calls) for content before breaking, and it
        // does so by awaiting result.finishReason — which REJECTS when the
        // provider errored (NoOutputGeneratedError). That throw is what routes
        // agent-loop's error turns through the catch block (generic
        // AGENT_ERROR event, NO result event), so the POC must await the same
        // promise at the same point instead of tracking finish-step parts.
        if (!lastStepHadToolCalls && !lastStepHadContent) {
          const finishReason = await result.finishReason;
          console.error(`[toolloop-poc] Empty response: finishReason=${finishReason}, model=${modelId}`);
          reportNativeError('EMPTY_RESPONSE', new Error(`Empty response: finishReason=${finishReason}`), { modelId, sessionId });
          controller.enqueue(formatSSE({
            type: 'error',
            data: JSON.stringify({
              category: 'EMPTY_RESPONSE',
              userMessage: `模型未返回任何内容 (finishReason: ${finishReason})。可能是 API 代理不兼容或模型 ID "${modelId}" 不被支持。`,
            }),
          }));
        }

        // 9. Skill nudge (same heuristic + event as agent-loop step 6a)
        if (shouldSuggestSkill({ step, distinctTools })) {
          controller.enqueue(formatSSE({
            type: 'status',
            data: JSON.stringify(buildSkillNudgeStatusEvent({ step, distinctTools })),
          }));
        }

        // 10. Result event with context accounting (same as agent-loop step 6)
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
        const isAbort = err instanceof Error && (
          err.name === 'AbortError' ||
          abortController.signal.aborted
        );

        if (!isAbort) {
          console.error('[toolloop-poc] Error:', err instanceof Error ? err.message : err);
          reportNativeError('NATIVE_STREAM_ERROR', err, { sessionId });
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
            data: JSON.stringify(buildNativeErrorEventData(err, errorAccounting)),
          }));
        }

        onRuntimeStatusChange?.('error');
      } finally {
        clearInterval(keepAliveTimer);
        unsubscribeMediaSideChannel();
        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      }
    },
  });
}

// Mirror of agent-loop.ts buildNativeAccountingSnapshot (not exported there —
// this POC must not modify the production module).
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
      unsupported: ['system_prompt', 'memory', 'files_attachments'],
      resolveRulesEntry: resolveWorkspaceClaudeMdRules,
    });
  } catch {
    return undefined;
  }
}

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
