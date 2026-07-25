/**
 * Phase 5b — Unified Responses adapter built on ai-sdk.
 *
 * Same translator works for all three adapter families (OpenAI-compat,
 * Anthropic-compat, CodePlan) because the wire-format divergence lives
 * INSIDE ai-sdk's per-provider SDK (createAnthropic / createOpenAI /
 * createGoogleGenerativeAI / etc.). CodePilot's `createModel()` factory
 * already picks the right SDK based on `ResolvedProvider.sdkType`, so
 * once the Responses ↔ ModelMessage[] translation is done, the adapter
 * just hands the model to `streamText` / `generateText` and translates
 * the result back. The family-by-family registration in `adapter.ts`
 * is therefore a dispatch + gate concern, not a separate translator.
 *
 * Two paths:
 *
 *   stream:true  (default)  → `streamText` + `translateStream`
 *                              Returns a ReadableStream<Uint8Array>
 *                              of SSE-framed Responses events.
 *   stream:false            → `generateText` + `translateNonStreamResponse`
 *                              Returns a full JSON ResponsesNonStreamResponse.
 *
 * Adapter never throws — every failure path maps to a Responses-shaped
 * error via `classifyUpstreamError` / `makeFailureStream`.
 */

import {
  streamText,
  generateText,
  stepCountIs,
  type ModelMessage,
  type LanguageModel,
  type ToolSet,
} from 'ai';
import { createModel } from '@/lib/ai-provider';
import { translateResponsesInput } from './translate-input';
import { translateResponsesTools } from './translate-tools';
import { translateStream } from './translate-stream';
import { translateNonStreamResponse } from './translate-response';
import { encodeEvent, encodeDone, makeFailureStream } from './sse';
import { makeErrorResult, classifyUpstreamError } from './errors';
import { createCodePilotBuiltinTools } from './builtin-bridge';
import { adaptForCodexProxy } from '@/lib/harness/runtime-adapter';
import { platformCommandGuidance } from '@/lib/platform';
import type { ResponsesAdapter } from './adapter';
import type {
  ResponsesEvent,
  ResponsesRequestBody,
  ProxyResult,
} from './types';
import { buildXaiProviderOptions } from '@/lib/xai-provider-options';

/** JSON value type matching ai-sdk's SharedV3ProviderOptions inner. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type AiProviderOptions = Record<string, JsonObject>;

/**
 * Build the unified adapter. The family parameter is accepted but
 * doesn't change behaviour today — it's threaded into error context
 * so a failure surface tells us *which family* hit the issue without
 * needing to grep through provider ids. When a family later needs a
 * provider-specific tweak (e.g. CodePlan brand requires header X),
 * branch on it here rather than splitting into N adapter files.
 */
export function createUnifiedAdapter(family: string): ResponsesAdapter {
  return async (input, resolved): Promise<ProxyResult> => {
    const responseId = makeResponseId();

    // 1. Resolve the LanguageModel via the same factory native uses.
    //    Pass the RAW targetProviderId from the inbound header — NOT
    //    `resolved.provider?.id` — so virtual providers like
    //    `openai-oauth` / `xai-oauth` (which have
    //    `resolved.provider === undefined`)
    //    flow through to ai-provider.ts's per-virtual-id branches
    //    (createOpenAI with Codex endpoint + OAuth fetch, etc.).
    //    Dropping the id here was the original Phase 5b P0 bug: the
    //    proxy route accepted openai-oauth then silently fell back to
    //    the default provider inside createModel.
    let languageModel: LanguageModel;
    try {
      const created = createModel({
        callScene: 'interactive_chat',
        providerId: input.targetProviderId,
        model: input.body.model,
      });
      languageModel = created.languageModel;
    } catch (err) {
      const classified = classifyUpstreamError(err);
      return makeErrorResult(classified.code, classified.message, {
        ...classified.context,
        family,
        providerId: input.targetProviderId,
      });
    }

    // Phase 5d Phase 2 slice 2e + P0 fix (2026-05-17) — bridge,
    // compileContext, and bodyWithBridgePrompt MUST run BEFORE
    // buildMessages. Pre-fix the adapter ran `buildMessages(input.body)`
    // first, so the compiler prompt only reached the upstream model
    // via `providerOptions.openai.instructions` — visible to OpenAI
    // Responses-API paths but invisible to Anthropic-compat /
    // CodePlan / OpenAI chat-completions paths whose system content
    // lives entirely in the `messages` array. That made every
    // non-Responses provider lose the wire-format spec, image-gen
    // rule, memory/tasks tool descriptions, etc. on the send path.
    //
    // The new order:
    //   1. Mount the bridge (capability gating + tool factories)
    //   2. Translate Codex's incoming tools[] (the function-typed
    //      ones) so we have the merged tool surface
    //   3. Run compileContext → systemPromptText
    //   4. Splice systemPromptText into body.instructions
    //   5. Now call buildMessages(bodyWithBridgePrompt) so the
    //      compiler's content lands as the first system message
    //
    // This way EVERY provider family sees the compiler prompt
    // through whichever channel the underlying SDK uses (Anthropic
    // reads the `system` role; OpenAI reads `system` content +
    // instructions; CodePlan vendors get whichever ai-sdk chose).

    const bridge = createCodePilotBuiltinTools({
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      targetProviderId: input.targetProviderId,
    });

    let codexTools: ToolSet | undefined;
    try {
      codexTools = translateResponsesTools(input.body.tools) as ToolSet | undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = /unsupported tool kind/i.test(message)
        ? 'unsupported_tool_kind'
        : 'invalid_request';
      return makeErrorResult(code, message, { family });
    }
    const tools: ToolSet | undefined = mergeToolSets(codexTools, bridge.tools);

    // Phase 5d Phase 3 (2026-05-17) — capability prompt assembly +
    // stopWhen / builtinToolNames hints routed through the Runtime
    // Capability Adapter (`adaptForCodexProxy`). The adapter wraps
    // Phase 2's compileContext call so this entry point no longer
    // touches the compiler directly.
    //
    // `enabledCapabilities` still mirrors what the bridge actually
    // mounted so the compiler can't disagree with which tools the
    // model sees (workspace-gated memory tools drop out of both
    // sides naturally when `workspacePath` is empty). The suppression
    // set passed to translate-stream stays as `bridge.toolNames`
    // (the authoritative "what ai-sdk actually executed" surface) —
    // the adapter's `builtinToolNames` hint is the catalog-derived
    // mirror and could differ if a future catalog drift sneaks in.
    const bridgeMounted = bridge.toolNames.size > 0;
    // Phase 5e review fix P1 #2 (2026-05-18) — scan User + External
    // Harness extensions and pass through the adapter so the model
    // sees the user's MCP servers / Skills / commands / external
    // framework configs as a perception fragment. External scans
    // tag executable=true only when activeFramework matches; for
    // Codex Runtime that's `codex`, so the user's `~/.codex/*`
    // entries are callable while `~/.claude/*` entries are perception-
    // only with a "switch to ClaudeCode Runtime" hint. Best-effort
    // import — scan failures degrade silently to "no extensions".
    let userExtensions: ReturnType<
      typeof import('@/lib/harness/user-codepilot-extensions').scanUserCodePilotExtensions
    > = [];
    let externalExtensions: ReturnType<
      typeof import('@/lib/harness/external-framework-harness').scanExternalFrameworkExtensions
    > = [];
    try {
      const { scanUserCodePilotExtensions } = await import(
        '@/lib/harness/user-codepilot-extensions'
      );
      userExtensions = scanUserCodePilotExtensions({
        workspacePath: input.workspacePath,
        runtimeId: 'codex_runtime',
      });
    } catch { /* best effort */ }
    try {
      const { scanExternalFrameworkExtensions } = await import(
        '@/lib/harness/external-framework-harness'
      );
      externalExtensions = scanExternalFrameworkExtensions({
        activeFramework: 'codex',
      });
    } catch { /* best effort */ }

    const adapted = adaptForCodexProxy({
      sessionId: input.sessionId || 'codex-anonymous',
      workingDirectory: input.workspacePath || undefined,
      providerId: input.targetProviderId,
      model: input.body.model,
      userPrompt: '',
      enabledCapabilities: bridgeMounted
        ? capabilitiesFromBridgeToolNames(bridge.toolNames)
        : new Set<string>(),
      userExtensions,
      externalExtensions,
    });
    // #28: append the platform shell-dialect hint (no-op off Windows-PowerShell)
    // so Codex emits PowerShell-compatible commands on Windows.
    const bridgePrompt = [adapted.systemPromptInstructions, platformCommandGuidance()]
      .filter((s) => s.length > 0)
      .join('\n\n');

    // Splice the compiler prompt into the request body's
    // `instructions`. `buildPrompt` below merges `body.instructions`
    // (plus any system/developer input items) into the AI SDK 7
    // `instructions` OPTION — ai@7 forbids system messages inside
    // `messages`, so the option is the only channel for system text
    // and the SDK forwards it per provider (system message for chat
    // skins, top-level instructions for Responses).
    const bodyWithBridgePrompt = bridgePrompt.length > 0
      ? { ...input.body, instructions: combineInstructions(input.body.instructions, bridgePrompt) }
      : input.body;

    let messages: ModelMessage[];
    let instructions: string | undefined;
    try {
      ({ instructions, messages } = buildPrompt(bodyWithBridgePrompt));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return makeErrorResult('invalid_request', message, { family });
    }

    const providerOptions = buildProviderOptions(bodyWithBridgePrompt);
    const wantsStream = input.body.stream !== false;

    // Phase 5d Phase 3 review fix #1 (2026-05-17) — Path inputs read
    // builtinToolNames / stopWhen / stepCount FROM THE ADAPTER, not
    // local state. Previously `streamPath` received `bridge.toolNames`
    // directly and hard-coded `BUILTIN_BRIDGE_STEP_LIMIT = 8`. That
    // made `runtime-adapter.ts`'s `stopWhen / stepCount` hint
    // half-dead — changing the compiler hint would NOT have changed
    // the real send path. The adapter is now the single source for
    // these values; the compiler owns `CODEX_BRIDGE_STEP_LIMIT`.
    if (wantsStream) {
      return streamPath({
        responseId,
        body: bodyWithBridgePrompt,
        languageModel,
        instructions,
        messages,
        tools,
        builtinToolNames: adapted.builtinToolNames,
        stopWhen: adapted.stopWhen,
        stepCount: adapted.stepCount,
        providerOptions,
        signal: input.signal,
        family,
      });
    }

    return nonStreamPath({
      responseId,
      body: bodyWithBridgePrompt,
      languageModel,
      instructions,
      messages,
      tools,
      builtinToolNames: adapted.builtinToolNames,
      stopWhen: adapted.stopWhen,
      stepCount: adapted.stepCount,
      providerOptions,
      signal: input.signal,
      family,
    });
  };
}

/**
 * Merge Codex's function tools with the bridge's executable tools.
 * Bridge tools win on name collision (see comment in the call site).
 * Returns `undefined` when both sides are empty so ai-sdk gets the
 * "no tools" signal (it distinguishes `tools: undefined` from
 * `tools: {}` in some places).
 */
function mergeToolSets(codex: ToolSet | undefined, bridge: ToolSet): ToolSet | undefined {
  const merged: ToolSet = { ...(codex ?? {}), ...bridge };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Phase 5d Phase 2 slice 2e (2026-05-17) — map the bridge's mounted
 * tool names back to capability ids so the Context Compiler emits
 * fragments for exactly those capabilities. Workspace-gated cases
 * (memory tools mounted only when workspacePath is present) flow
 * through naturally because the bridge only mounts `codepilot_memory_*`
 * tools when it has a workspace.
 */
function capabilitiesFromBridgeToolNames(toolNames: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  // Capability id ← tool name mapping mirrors capability-contract.ts.
  // The compiler will then look up exposure / fragment / artifact
  // details from the catalog.
  if (toolNames.has('codepilot_generate_image')) out.add('image_generation');
  if (toolNames.has('codepilot_import_media')) out.add('media_import');
  if (toolNames.has('codepilot_load_widget_guidelines')) out.add('widget');
  if (
    toolNames.has('codepilot_memory_recent') ||
    toolNames.has('codepilot_memory_search') ||
    toolNames.has('codepilot_memory_get')
  ) {
    out.add('memory');
  }
  if (
    toolNames.has('codepilot_notify') ||
    toolNames.has('codepilot_schedule_task') ||
    toolNames.has('codepilot_list_tasks') ||
    toolNames.has('codepilot_cancel_task')
  ) {
    out.add('tasks_and_notify');
  }
  return out;
}

function combineInstructions(codexInstructions: string | undefined, bridgePrompt: string): string {
  if (!codexInstructions || codexInstructions.length === 0) return bridgePrompt;
  // Bridge prompt FIRST so the tool capability declarations land at
  // the top of the system message; Codex's own instructions follow
  // and can still reference them.
  return `${bridgePrompt}\n\n${codexInstructions}`;
}

interface PathInput {
  responseId: string;
  body: ResponsesRequestBody;
  languageModel: LanguageModel;
  /** System text for the AI SDK 7 `instructions` option — ai@7 rejects
   *  system messages inside `messages`, so this is the only channel. */
  instructions: string | undefined;
  messages: ModelMessage[];
  tools: ToolSet | undefined;
  /** Names belonging to the bridge — Codex doesn't need their
   *  function_call events because the bridge already executed them.
   *  See `translate-stream.ts` for the suppression logic. Sourced
   *  from `adaptForCodexProxy().builtinToolNames` so the value is
   *  the catalog-derived single source, not a bridge-local copy. */
  builtinToolNames: ReadonlySet<string>;
  /** AI SDK multi-step ceiling decision. Sourced from
   *  `adaptForCodexProxy().stopWhen`; the compiler decides this based
   *  on whether any built-in capability is enabled. */
  stopWhen: 'stepCountIs' | 'never';
  /** Step ceiling when `stopWhen === 'stepCountIs'`. Sourced from
   *  `adaptForCodexProxy().stepCount`; the compiler holds the
   *  canonical `CODEX_BRIDGE_STEP_LIMIT` constant. */
  stepCount: number;
  providerOptions: AiProviderOptions | undefined;
  signal: AbortSignal;
  family: string;
}

/**
 * Phase 5c (2026-05-16) — multi-step ceiling for streamText. The
 * actual constant value lives in `src/lib/harness/context-compiler.ts`
 * (`CODEX_BRIDGE_STEP_LIMIT`); both stream and non-stream paths read
 * it from `adapted.stepCount` via PathInput, so the value is the
 * compiler's choice rather than a parallel local constant.
 *
 * 8 is empirical: enough for chained tools (memory read → image gen →
 * narration → schedule task), low enough that a confused model loop
 * terminates instead of looping indefinitely on tool calls.
 */
function buildStopWhen(
  stopWhen: 'stepCountIs' | 'never',
  stepCount: number,
): { stopWhen: ReturnType<typeof stepCountIs> } | Record<string, never> {
  // Phase 5c: only enable multi-step when the adapter says we should
  // (i.e. bridge tools mounted). For pre-5c chat-only smoke runs (no
  // sessionId, no bridge), keep the single-step legacy behaviour so
  // we don't accidentally change the wire of currently passing
  // smoke matrix entries.
  return stopWhen === 'stepCountIs' ? { stopWhen: stepCountIs(stepCount) } : {};
}

function streamPath(args: PathInput): ProxyResult {
  const { responseId, body, languageModel, instructions, messages, tools, builtinToolNames, stopWhen, stepCount, providerOptions, signal, family } = args;

  let result: ReturnType<typeof streamText>;
  try {
    result = streamText({
      model: languageModel,
      ...(instructions ? { instructions } : {}),
      messages,
      tools,
      providerOptions,
      abortSignal: signal,
      ...buildStopWhen(stopWhen, stepCount),
    });
  } catch (err) {
    const classified = classifyUpstreamError(err);
    return {
      kind: 'stream',
      body: makeFailureStream({
        type: 'response.failed',
        response: {
          id: responseId,
          error: {
            code: classified.code,
            message: classified.message,
          },
        },
      }),
    };
  }

  const sseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const events = translateStream({
          responseId,
          body,
          source: result.fullStream,
          builtinToolNames,
        });
        for await (const event of events) {
          controller.enqueue(encodeEvent(event));
        }
        controller.enqueue(encodeDone());
      } catch (err) {
        const classified = classifyUpstreamError(err);
        const failed: ResponsesEvent = {
          type: 'response.failed',
          response: {
            id: responseId,
            error: {
              code: classified.code,
              message: classified.message,
            },
          },
        };
        controller.enqueue(encodeEvent(failed));
        controller.enqueue(encodeDone());
      } finally {
        controller.close();
      }
    },
    cancel() {
      // The translator's `for await` exits when the source stream
      // closes; ai-sdk cancels the upstream call via abortSignal.
    },
  });

  return { kind: 'stream', body: sseStream };
}

async function nonStreamPath(args: PathInput): Promise<ProxyResult> {
  const { responseId, body, languageModel, instructions, messages, tools, builtinToolNames, stopWhen, stepCount, providerOptions, signal, family } = args;
  try {
    const result = await generateText({
      model: languageModel,
      ...(instructions ? { instructions } : {}),
      messages,
      tools,
      providerOptions,
      abortSignal: signal,
      // Same step ceiling as streamPath — kept symmetric so the
      // non-stream path doesn't surprise callers that switch
      // between stream:true/false at runtime. Source: adapter.
      ...buildStopWhen(stopWhen, stepCount),
    });
    const responseBody = translateNonStreamResponse({
      responseId,
      model: body.model,
      result: {
        text: result.text,
        toolCalls: result.toolCalls.map(c => ({
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          input: c.input,
        })),
        finishReason: result.finishReason,
        totalUsage: result.totalUsage,
        usage: result.usage,
      },
      builtinToolNames,
    });
    return { kind: 'json', body: responseBody };
  } catch (err) {
    const classified = classifyUpstreamError(err);
    return makeErrorResult(classified.code, classified.message, {
      ...classified.context,
      family,
    });
  }
}

/**
 * Split the prompt for AI SDK 7: system text must travel via the
 * `instructions` OPTION — ai@7 rejects `role: 'system'` inside `messages`
 * ("System messages are not allowed in the prompt or messages fields.
 * Use the instructions option instead."). Merged into `instructions`
 * in order: Codex's top-level `body.instructions`, then any
 * system/developer items translated out of `body.input` (translate-input
 * emits those as role:'system'; they are extracted here at the single
 * choke point before streamText/generateText). Exported for unit tests.
 */
export function buildPrompt(body: ResponsesRequestBody): {
  instructions: string | undefined;
  messages: ModelMessage[];
} {
  const translated = translateResponsesInput(body.input);
  const systemParts: string[] = [];
  if (body.instructions && body.instructions.length > 0) {
    systemParts.push(body.instructions);
  }
  const messages = translated.filter((m) => {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      return false;
    }
    return true;
  });
  return {
    instructions: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages,
  };
}

/**
 * Translate Codex's `reasoning.effort` into per-SDK providerOptions.
 *
 * Anthropic exposes thinking budget via `providerOptions.anthropic.thinking`.
 * OpenAI Responses-API exposes reasoning via `providerOptions.openai.reasoningEffort`.
 * Other SDKs ignore unknown keys.
 *
 * The translator picks BOTH possible paths so whichever underlying SDK
 * is used picks up the option without the adapter needing to know
 * which one upfront. ai-sdk silently drops options the model doesn't
 * recognise — confirmed by reading providerOptions handling in each
 * @ai-sdk/* package.
 */
/** Exported for unit testing — see codex-proxy-translators.test.ts. */
export function buildProviderOptions(
  body: ResponsesRequestBody,
): AiProviderOptions | undefined {
  const out: AiProviderOptions = {};

  // Phase 5b smoke follow-up (2026-05-15) — Codex's `/responses`
  // endpoint (chatgpt.com/backend-api/codex/responses) REQUIRES a
  // non-empty `instructions` top-level field. ai-sdk's openai
  // `responses(...)` model only populates that field from
  // `providerOptions.openai.instructions` — system messages in the
  // `messages` array end up as input items, not as the top-level
  // instructions. So forward Codex's body.instructions verbatim into
  // the provider options so the openai-oauth path stops returning
  // HTTP 400 "Instructions are required". Harmless for other openai
  // wire targets (regular openai.chat / .responses both accept it).
  if (body.instructions && body.instructions.trim().length > 0) {
    out.openai = { ...(out.openai ?? {}), instructions: body.instructions };
  }

  // Phase 5b smoke follow-up (2026-05-15) — Codex's `/responses`
  // endpoint also REQUIRES `store: false`. ai-sdk's openai `responses(...)`
  // path defaults store to true (the public OpenAI API stores by
  // default for the dashboard). When Codex's HTTP client forwards a
  // body with `store: false` we honour it; when it's absent we still
  // force false because the Codex endpoint never accepts true. Other
  // openai targets (public OpenAI, OpenRouter `/v1`) tolerate
  // `store: false` so this is safe to set unconditionally on every
  // openai-flavoured call we make.
  out.openai = { ...(out.openai ?? {}), store: body.store ?? false };
  // xAI Responses has its own `store` contract. @ai-sdk/xai defaults it to
  // true; CodePilot does not use previousResponseId, so the shared xAI helper
  // explicitly disables upstream retention for this channel.
  out.xai = buildXaiProviderOptions(body.reasoning?.effort);

  const effort = body.reasoning?.effort;
  if (effort) {
    // Anthropic thinking — only enabled for medium/high/max budgets.
    // Mapping mirrors how CodePilot's native runtime maps effort →
    // budget (see src/lib/effort.ts for the canonical table).
    const anthropicThinking = mapEffortToAnthropicThinking(effort);
    const openaiReasoning = mapEffortToOpenAI(effort);
    if (anthropicThinking) {
      out.anthropic = { thinking: { type: anthropicThinking.type, budgetTokens: anthropicThinking.budgetTokens } };
    }
    if (openaiReasoning) {
      out.openai = { ...(out.openai ?? {}), reasoningEffort: openaiReasoning };
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function mapEffortToAnthropicThinking(
  effort: 'minimal' | 'low' | 'medium' | 'high' | 'max',
): { type: 'enabled'; budgetTokens: number } | undefined {
  switch (effort) {
    case 'low':
      return { type: 'enabled', budgetTokens: 1024 };
    case 'medium':
      return { type: 'enabled', budgetTokens: 4096 };
    case 'high':
      return { type: 'enabled', budgetTokens: 16384 };
    case 'max':
      return { type: 'enabled', budgetTokens: 32000 };
    case 'minimal':
    default:
      return undefined;
  }
}

function mapEffortToOpenAI(
  effort: 'minimal' | 'low' | 'medium' | 'high' | 'max',
): 'minimal' | 'low' | 'medium' | 'high' | undefined {
  switch (effort) {
    case 'minimal':
      return 'minimal';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'max':
      return 'high';
    default:
      return undefined;
  }
}

function makeResponseId(): string {
  return `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
