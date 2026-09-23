/**
 * Phase 5c (2026-05-16) — CodePilot built-in tool bridge for Codex
 * Runtime proxy path.
 *
 * Problem: when a CodePilot provider (GLM / Kimi / OpenAI-compat /
 * Anthropic-compat / openai-oauth / CodePlan brand) is the target of
 * a Codex Runtime turn, the upstream provider can't see CodePilot's
 * built-in MCP tools (memory / image / widget / tasks / notify). Real
 * smoke (2026-05-16) showed GLM/Kimi reading `imagegen` Skill text,
 * trying to call a tool that wasn't in their function list, then
 * fabricating a fallback chain — `OPENAI_API_KEY` lookup,
 * `~/.codex/auth.json` read attempt, `npm install openai`, then
 * generation stopped.
 *
 * Solution: inject the CodePilot built-in tools INTO the ai-sdk
 * `ToolSet` the unified adapter passes to `streamText`, each tool
 * with a server-side `execute()` that calls the real underlying
 * handler. From Codex's perspective the function_call never happens
 * (the bridge suppresses it in `translate-stream.ts`); the model
 * gets the tool result inline within the same ai-sdk step and
 * continues with assistant text.
 *
 * The result reaches CodePilot's chat UI through a side-channel:
 *   1. `execute()` emits a `tool_started` + `tool_completed`
 *      `RuntimeRunEvent` on the per-session bus
 *      (`./builtin-event-bus.ts`).
 *   2. `codex/runtime.ts` is already subscribed for the same session;
 *      it forwards each event through `canonicalToSseLine` → SSE →
 *      `useSSEStream` → `MessageList`. Identical channel Codex's own
 *      `item/completed` notifications use today.
 *
 * Anti-patterns this bridge MUST NOT reintroduce — pinned by
 * `codex-builtin-no-anti-patterns.test.ts`:
 *
 *   - Reading `~/.codex/auth.json` (Codex Account's private auth).
 *   - Running `scripts/image_gen.py` or any shelled-out generator.
 *   - Triggering `npm install openai` on the fly.
 *   - Bypassing `/api/media/serve` by serving paths outside
 *     `<dataDir>/.codepilot-media`.
 *
 * Codex Account guardrail: the unified adapter must NOT mount this
 * proxy bridge when `targetProviderId === 'codex_account'`. The
 * app-server runtime may separately expose the managed Sub-agent
 * pair as native dynamic tools; see `createCodexAccountManagedTools`.
 */

import { tool, jsonSchema, type ToolSet } from 'ai';
import crypto from 'node:crypto';
import { createMemoryAdapterQueryTools } from '@/lib/memory-rerank';
import { getSessionMemoryWorkspace } from '@/lib/memory-binding';
import type { ResolvedProvider } from '@/lib/provider-resolver';
import type { JSONSchema7 } from '@ai-sdk/provider';
import type { MediaBlock } from '@/types';
import { makeToolStarted, makeToolCompleted } from '@/lib/runtime/event-adapter';
import { emitBuiltinEvent } from './builtin-event-bus';
import { materializeCodexEventMedia } from '@/lib/codex/media-import';
import {
  CODEX_SUBAGENT_TIMEOUT_MS,
  getCodexSubagentParentContext,
  isManagedCodexSubagentSession,
  resolveCodexSubagentAbortSignal,
  runCodexSubagent,
} from '@/lib/codex/subagent';
import {
  findSubagentRoute,
  getSubagentRoutingGuidance,
  listSubagentRoutes,
  subagentRouteSelector,
} from '@/lib/subagent-models';
import {
  encodeSubagentStatusResult,
  type SubagentExecutionStatus,
  type SubagentStatusError,
} from '@/lib/subagent-status';
import {
  resolveSubagentDependencies,
  validateSubagentDispatchSpec,
} from '@/lib/subagent-orchestration';
import {
  checkpointSubagentRun,
  describeSubagentRunStartRejection,
  markSubagentRunSettling,
  recordSubagentRunEvent,
  startSubagentRun,
  settleSubagentRun,
} from '@/lib/db';
import { formatSubagentRunToolResult } from '@/lib/subagent-run-context';
import { isXaiOAuthUsable } from '@/lib/xai-oauth-manager';
// Phase 5d Phase 2 slice 2e (2026-05-17) — `WIDGET_SYSTEM_PROMPT`
// import dropped: the bridge no longer holds a local WIDGET_PROMPT
// scalar. Capability prompts are produced by the Context Compiler
// and consumed by unified-adapter.ts.

/** Tool names this bridge owns. The unified adapter passes this set
 *  to `translate-stream.ts` so its tool-call / tool-result events
 *  are NOT forwarded to Codex (the bridge handled them already). */
export const CODEPILOT_BUILTIN_TOOL_NAMES = [
  'codepilot_generate_image',
  'codepilot_generate_video',
  'codepilot_import_media',
  'codepilot_memory_recent',
  'codepilot_memory_search',
  'codepilot_memory_get',
  'codepilot_load_widget_guidelines',
  'codepilot_notify',
  'codepilot_schedule_task',
  'codepilot_list_tasks',
  'codepilot_cancel_task',
  'codepilot_list_subagent_runs',
  'codepilot_spawn_subagent',
] as const;

export type CodePilotBuiltinToolName = (typeof CODEPILOT_BUILTIN_TOOL_NAMES)[number];

export interface BuiltinBridgeOpts {
  /** Originating CodePilot chat session id. Used both as the
   *  side-channel bus key and as `origin_session_id` for scheduled
   *  tasks so the runner later scopes to the right project. */
  sessionId: string;
  /** Working directory the chat was launched in. Forwarded into
   *  image-gen reference-path resolution and memory workspace
   *  lookup. Empty when the chat has no workspace bound. */
  workspacePath?: string;
  /** Target CodePilot provider id from
   *  `x-codepilot-target-provider`. Pre-checked by the unified
   *  adapter — `codex_account` should never reach here, but the
   *  guard below stays as defence in depth. */
  targetProviderId: string;
  /** The actual foreground Provider snapshot, also used for optional memory ranking. */
  resolvedProvider?: ResolvedProvider;
  /** Test seam; production resolves this from the current OAuth bundle. */
  grokVideoAvailable?: boolean;
}

/**
 * Narrow dependency seam for the managed Codex child workflow.
 *
 * Production callers use the defaults. Tests may provide a catalog fixture
 * and child runner without booting a real app-server, which lets lifecycle
 * tests cross the actual bridge execute/settle boundary.
 */
export interface BuiltinBridgeDependencies {
  listSubagentRoutes?: typeof listSubagentRoutes;
  getCodexSubagentParentContext?: typeof getCodexSubagentParentContext;
  resolveSubagentDependencies?: typeof resolveSubagentDependencies;
  runCodexSubagent?: typeof runCodexSubagent;
}

export interface BuiltinBridgeResult {
  /** AI SDK tool set for `streamText({ tools })`. */
  readonly tools: ToolSet;
  /** Names the unified adapter uses to suppress Codex-bound
   *  function_call events for these tools. */
  readonly toolNames: ReadonlySet<string>;
  /** System prompt fragments describing what each tool does, joined
   *  with double-newlines. The adapter prepends this to whatever
   *  `instructions` Codex sent so the model knows the tools exist. */
  readonly systemPrompt: string;
  /** When the bridge declined to mount (no session id / Codex
   *  Account / etc.), `reason` tells the caller why. `undefined`
   *  means the bridge is fully active. */
  readonly skippedReason?: string;
}

export interface CodexDynamicFunctionToolSpec {
  type: 'function';
  name: string;
  description: string;
  inputSchema: JSONSchema7;
}

export interface CodexAccountManagedBridgeResult extends BuiltinBridgeResult {
  readonly dynamicTools: readonly CodexDynamicFunctionToolSpec[];
}

/**
 * Build the CodePilot built-in tool bridge for the current turn.
 *
 * Empty result (no tools, no system prompt) when:
 *   - `sessionId` empty (older runtime build, or smoke without
 *     CodexRuntime).
 *   - `targetProviderId === 'codex_account'` — Codex Account routes
 *     natively, bridge tools would be a routing bug.
 */
export function createCodePilotBuiltinTools(
  opts: BuiltinBridgeOpts,
  dependencies: BuiltinBridgeDependencies = {},
): BuiltinBridgeResult {
  if (!opts.sessionId) {
    return emptyResult('Empty sessionId — runtime did not supply x-codepilot-session-id header.');
  }
  if (opts.targetProviderId === 'codex_account') {
    return emptyResult('Codex Account target — bridge intentionally disabled (native path owns these capabilities).');
  }
  if (isManagedCodexSubagentSession(opts.sessionId)) {
    return emptyResult('Managed Codex Sub Agent — delegation depth is limited to one and bridge tools are disabled.');
  }

  const tools: ToolSet = {};

  tools.codepilot_generate_image = buildImageGenerationTool(opts);
  if (opts.grokVideoAvailable ?? isXaiOAuthUsable()) {
    tools.codepilot_generate_video = buildVideoGenerationTool(opts);
  }
  tools.codepilot_import_media = buildImportMediaTool(opts);
  tools.codepilot_load_widget_guidelines = buildWidgetGuidelinesTool(opts);
  tools.codepilot_notify = buildNotifyTool(opts);
  tools.codepilot_schedule_task = buildScheduleTaskTool(opts);
  tools.codepilot_list_tasks = buildListTasksTool(opts);
  tools.codepilot_cancel_task = buildCancelTaskTool(opts);
  tools.codepilot_list_subagent_runs = buildCodexSubagentRunsTool(opts);
  tools.codepilot_spawn_subagent = buildCodexSubagentTool(opts, dependencies);

  // Memory tools are workspace-gated — without a workspace there's
  // no manifest to read. We still register the names in the set so
  // the model can be told they're unavailable, but skipping the
  // tool registration keeps the model from calling them and getting
  // a generic "Failed: ENOENT" message.
  if (opts.workspacePath && getSessionMemoryWorkspace(opts.sessionId, opts.workspacePath)) {
    tools.codepilot_memory_recent = buildMemoryRecentTool(opts);
    tools.codepilot_memory_search = buildMemorySearchTool(opts);
    tools.codepilot_memory_get = buildMemoryGetTool(opts);
  }

  // Phase 5d Phase 2 slice 2e (2026-05-17) — bridge no longer assembles
  // its own systemPrompt. The Harness Context Compiler
  // (`src/lib/harness/context-compiler.ts`) is the sole producer of
  // capability prompts across all three runtimes; unified-adapter.ts
  // calls `compileContext({ runtimeId: 'codex_runtime', ... })` and
  // prepends `compiled.systemPromptText` to Codex's instructions. The
  // empty string is a stable signal to callers that haven't migrated
  // yet — slice 2e leaves no Codex-local prompt scalars.
  return {
    tools,
    toolNames: new Set(Object.keys(tools)),
    systemPrompt: '',
  };
}

/**
 * Exact cross-model delegation for a Codex Account parent.
 *
 * Codex's native collaboration workers inherit the parent model route. These
 * two tools instead reuse CodePilot's durable managed workflow while leaving
 * Codex Account auth, native tools, MCP, sandbox, and approvals untouched.
 */
export function createCodexAccountManagedTools(
  opts: BuiltinBridgeOpts,
  dependencies: BuiltinBridgeDependencies = {},
): CodexAccountManagedBridgeResult {
  if (!opts.sessionId) {
    return {
      ...emptyResult('Empty sessionId — Codex Account managed tools require an auditable parent session.'),
      dynamicTools: [],
    };
  }
  if (opts.targetProviderId !== 'codex_account') {
    return {
      ...emptyResult('Non-Codex-Account target — proxy bridge owns managed delegation.'),
      dynamicTools: [],
    };
  }
  if (isManagedCodexSubagentSession(opts.sessionId)) {
    return {
      ...emptyResult('Managed Codex Sub Agent — delegation depth is limited to one.'),
      dynamicTools: [],
    };
  }

  const routes = (dependencies.listSubagentRoutes || listSubagentRoutes)('codex_runtime');
  const tools: ToolSet = {
    codepilot_spawn_subagent: buildCodexSubagentTool(opts, dependencies),
    codepilot_list_subagent_runs: buildCodexSubagentRunsTool(opts),
  };
  return {
    tools,
    toolNames: new Set(Object.keys(tools)),
    systemPrompt: '',
    dynamicTools: [
      {
        type: 'function',
        name: 'codepilot_spawn_subagent',
        description: buildCodexSubagentDescription(routes),
        inputSchema: CODEX_SUBAGENT_INPUT_SCHEMA,
      },
      {
        type: 'function',
        name: 'codepilot_list_subagent_runs',
        description: CODEX_SUBAGENT_RUNS_DESCRIPTION,
        inputSchema: CODEX_SUBAGENT_RUNS_INPUT_SCHEMA,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────
// Managed Codex Sub Agent — a separate app-server thread with an exact
// CodePilot Provider + Model route. This is intentionally not Codex's native
// spawnAgent: native children inherit the parent's modelProvider config and
// therefore cannot truthfully switch to another CodePilot Provider.
// ─────────────────────────────────────────────────────────────────────

const activeCodexDelegations = new Map<string, number>();
const MAX_CONCURRENT_CODEX_DELEGATIONS = 2;

interface CodexSubagentToolInput {
  prompt: string;
  agent_name?: string;
  provider_id: string;
  model: string;
  logical_run_id?: string;
  workflow_id?: string;
  task_key?: string;
  depends_on?: string[];
}

const CODEX_SUBAGENT_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt', 'provider_id', 'model'],
  properties: {
    prompt: { type: 'string', description: 'Complete one-shot task for the Sub Agent.' },
    agent_name: { type: 'string', description: 'Short user-facing name, such as Researcher or Copywriter.' },
    provider_id: { type: 'string', description: 'Exact provider_id from the route list.' },
    model: { type: 'string', description: 'Exact model selector from the route list.' },
    logical_run_id: {
      type: 'string',
      maxLength: 160,
      description: 'Opaque logical task id for a retry. Omit on first attempt; reuse logicalRunId returned by a failed attempt.',
    },
    workflow_id: {
      type: 'string',
      maxLength: 160,
      description: 'Stable workflow id shared by all children in one dependency graph. Provide together with task_key.',
    },
    task_key: {
      type: 'string',
      maxLength: 160,
      description: 'Unique task key within workflow_id, such as research, copy, or implementation.',
    },
    depends_on: {
      type: 'array',
      items: { type: 'string', maxLength: 160 },
      description: 'Upstream task_key values in the same workflow. CodePilot waits for their durable completed results and injects them into this child prompt.',
    },
  },
} satisfies JSONSchema7;

function buildCodexSubagentDescription(
  routes: ReturnType<typeof listSubagentRoutes>,
): string {
  return [
    'Run a one-shot Sub Agent in a separate Codex Runtime thread using an exact CodePilot Provider + Model route.',
    'The child inherits the parent Codex native tools, MCP servers, sandbox, approval policy, and tool-call lifecycle. CodePilot only changes the child Provider + Model route.',
    'For any user-requested CodePilot Provider or non-parent model, this managed tool is the only Sub Agent entry point. Call it directly once per requested child; never wrap it with Codex native multi_agent_v1/spawn_agent/wait_agent workers, because native workers inherit the parent route.',
    'If the requested route is unavailable or the call fails, stop and ask the user what to do; never silently fall back to the parent model or another route.',
    'This is a blocking foreground call: it returns only after the child reaches a terminal status, and no background child remains running afterward. Consume terminal=true plus the returned status/body immediately; never describe it as merely submitted, launched, queued, or still processing.',
    'For dependent children in one plan, use one workflow_id, a unique task_key per child, and depends_on upstream task keys; emit upstream task calls before their dependents. CodePilot waits durably and injects upstream terminal results before the downstream child thread starts. Undeclared wait-only placeholders are rejected.',
    'Omit logical_run_id on a first attempt. If retrying the same logical task, reuse the exact logicalRunId returned by the failed attempt; never reuse it for different work.',
    'CodePilot rejects logical_run_id reuse while the prior attempt is running/settling or after it completed successfully. Wait/read the existing run, or omit the ID for genuinely new work.',
    'Never claim success after a failed status and never substitute another route.',
    getSubagentRoutingGuidance('codex_runtime', routes),
  ].join('\n');
}

function buildCodexSubagentTool(
  opts: BuiltinBridgeOpts,
  dependencies: BuiltinBridgeDependencies,
) {
  const loadSubagentRoutes = dependencies.listSubagentRoutes || listSubagentRoutes;
  const getParentContext = dependencies.getCodexSubagentParentContext
    || getCodexSubagentParentContext;
  const resolveDependencies = dependencies.resolveSubagentDependencies
    || resolveSubagentDependencies;
  const runChild = dependencies.runCodexSubagent || runCodexSubagent;
  const routes = loadSubagentRoutes('codex_runtime');
  return tool({
    description: buildCodexSubagentDescription(routes),
    inputSchema: jsonSchema(CODEX_SUBAGENT_INPUT_SCHEMA),
    execute: async (rawInput: unknown, execOptions) => {
      const input = rawInput as CodexSubagentToolInput;
      return runWithEvents(opts, 'codepilot_spawn_subagent', input, async (runId) => {
        const route = findSubagentRoute(routes, input.provider_id, input.model);
        const displayModel = route?.displayName || input.model;
        const displayAgent = input.agent_name?.trim() || `${displayModel} Sub Agent`;
        const dispatchValidation = validateSubagentDispatchSpec({
          prompt: input.prompt,
          workflowId: input.workflow_id,
          taskKey: input.task_key,
          dependsOn: input.depends_on,
        });
        if (!dispatchValidation.ok) {
          return {
            text: encodeSubagentStatusResult({
              status: 'failed',
              phase: 'terminal',
              taskId: runId,
              agentName: displayAgent,
              requestedProviderId: input.provider_id,
              requestedModel: input.model,
              model: displayModel,
              runtime: 'codex_runtime',
              error: dispatchValidation.error,
            }, dispatchValidation.message),
          };
        }
        if (!route) {
          return {
            text: encodeSubagentStatusResult({
              status: 'failed',
              phase: 'terminal',
              taskId: runId,
              agentName: displayAgent,
              requestedProviderId: input.provider_id,
              requestedModel: input.model,
              model: displayModel,
              runtime: 'codex_runtime',
              error: { code: 'MODEL_UNAVAILABLE', retryable: false },
            }, `SUBAGENT_MODEL_UNAVAILABLE: Codex Runtime cannot route provider "${input.provider_id}" model "${input.model}". The request was rejected before a durable workflow attempt was created. Do not continue as if this Sub Agent ran. Ask the user whether to choose an available route or change Runtime.`),
          };
        }
        const dispatchSpec = dispatchValidation.spec;
        let logicalRunId = runId;
        let attemptNumber = 1;
        const encode = (
          status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'timed_out',
          text: string,
          error?: import('@/lib/subagent-status').SubagentStatusError,
          effectiveModel?: string,
        ) => encodeSubagentStatusResult({
          status,
          phase: 'terminal',
          taskId: runId,
          logicalRunId,
          attemptId: runId,
          attemptNumber,
          agentName: displayAgent,
          requestedProviderId: input.provider_id,
          requestedModel: input.model,
          ...(effectiveModel && route ? { effectiveProviderId: route.providerId } : {}),
          ...(effectiveModel ? { effectiveModel } : {}),
          model: effectiveModel || displayModel,
          runtime: 'codex_runtime',
          error,
        }, text);
        const terminalResult = (
          status: Exclude<SubagentExecutionStatus, 'running'>,
          text: string,
          error?: SubagentStatusError,
          effectiveModel?: string,
        ): HandlerSuccess => {
          try {
            markSubagentRunSettling(runId);
            const settled = settleSubagentRun(runId, {
              status,
              resultText: text,
              effectiveProviderId: effectiveModel ? route?.providerId : undefined,
              effectiveModel,
              error,
            });
            // A parent Stop/recovery barrier may have won the terminal race
            // while the child transport was still unwinding. Never encode the
            // late handler outcome over the immutable durable fact.
            const factStatus = settled?.terminal === 1
              ? settled.status as Exclude<SubagentExecutionStatus, 'running'>
              : status;
            const factText = settled?.terminal === 1 ? settled.result_text : text;
            const factModel = settled?.effective_model || effectiveModel;
            return {
              text: encode(
                factStatus,
                factText,
                factStatus === status ? error : undefined,
                factModel,
              ),
            };
          } catch (persistenceError) {
            const detail = persistenceError instanceof Error
              ? persistenceError.message
              : String(persistenceError);
            return {
              text: encode(
                'failed',
                `SUBAGENT_RUN_PERSISTENCE_FAILED: child reached ${status}, but CodePilot could not persist the terminal fact (${detail}). Do not claim completion or background progress.\n\n${text}`,
                { code: 'RUNTIME_ERROR', retryable: false },
              ),
            };
          }
        };

        try {
          const startedRun = startSubagentRun({
            id: runId,
            logicalRunId: input.logical_run_id,
            parentSessionId: opts.sessionId,
            runtime: 'codex_runtime',
            toolName: 'codepilot_spawn_subagent',
            agentName: displayAgent,
            providerId: input.provider_id,
            requestedModel: input.model,
            workflowId: dispatchSpec.workflowId,
            taskKey: dispatchSpec.taskKey,
            dependencyTaskKeys: dispatchSpec.dependencyTaskKeys,
            prompt: input.prompt,
          });
          logicalRunId = startedRun.logical_run_id;
          attemptNumber = startedRun.attempt_number;
        } catch (persistenceError) {
          const rejection = describeSubagentRunStartRejection(persistenceError);
          const detail = persistenceError instanceof Error
            ? persistenceError.message
            : String(persistenceError);
          return {
            text: encodeSubagentStatusResult({
              status: 'failed',
              phase: 'terminal',
              taskId: runId,
              agentName: displayAgent,
              requestedProviderId: input.provider_id,
              requestedModel: input.model,
              model: displayModel,
              runtime: 'codex_runtime',
              error: rejection?.error || { code: 'RUNTIME_ERROR', retryable: true },
            }, rejection?.message
              || `SUBAGENT_RUN_PERSISTENCE_UNAVAILABLE: CodePilot could not create an auditable run before launch (${detail}). The child was not started. Ask the user to retry after fixing local storage.`),
          };
        }

        const parentContext = getParentContext(opts.sessionId);
        const delegationAbortSignal = resolveCodexSubagentAbortSignal(
          parentContext,
          execOptions.abortSignal,
        );

        const dependencyResolution = await resolveDependencies({
          runId,
          parentSessionId: opts.sessionId,
          prompt: input.prompt,
          workflowId: dispatchSpec.workflowId,
          dependencyTaskKeys: dispatchSpec.dependencyTaskKeys,
          abortSignal: delegationAbortSignal,
        });
        if (!dependencyResolution.ok) {
          return terminalResult(
            dependencyResolution.status,
            dependencyResolution.message,
            dependencyResolution.error,
          );
        }
        const active = activeCodexDelegations.get(opts.sessionId) || 0;
        if (active >= MAX_CONCURRENT_CODEX_DELEGATIONS) {
          return terminalResult(
            'failed',
            `SUBAGENT_CONCURRENCY_LIMIT: at most ${MAX_CONCURRENT_CODEX_DELEGATIONS} Codex Sub Agents may run at once.`,
            { code: 'CONCURRENCY_LIMIT', retryable: true },
          );
        }
        activeCodexDelegations.set(opts.sessionId, active + 1);
        try {
          // Re-resolve immediately before the credential-bearing call. A route
          // removed after this tool description was built must fail closed.
          const currentRoute = findSubagentRoute(
            loadSubagentRoutes('codex_runtime'),
            route.providerId,
            subagentRouteSelector(route),
          );
          if (!currentRoute) {
            return terminalResult(
              'failed',
              `SUBAGENT_MODEL_UNAVAILABLE: ${route.displayName} is no longer enabled for Codex Runtime.`,
              { code: 'MODEL_UNAVAILABLE', retryable: false },
            );
          }
          const outcome = await runChild({
            route: currentRoute,
            prompt: dependencyResolution.prompt,
            workingDirectory: opts.workspacePath,
            abortSignal: delegationAbortSignal,
            timeoutMs: CODEX_SUBAGENT_TIMEOUT_MS,
            parentContext,
            onLifecycleEvent: (update) => {
              if (update.partialText !== undefined || update.effectiveModel) {
                checkpointSubagentRun(runId, {
                  ...(update.partialText !== undefined
                    ? { resultText: update.partialText }
                    : {}),
                  ...(update.effectiveModel
                    ? { effectiveModel: update.effectiveModel }
                    : {}),
                  currentActivity: update.event.activity,
                });
              }
              recordSubagentRunEvent(runId, update.event);
            },
          });
          return terminalResult(
            outcome.status,
            outcome.text,
            outcome.error,
            outcome.effectiveModel,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return terminalResult(
            'failed',
            message,
            { code: 'RUNTIME_ERROR', retryable: false },
          );
        } finally {
          const remaining = (activeCodexDelegations.get(opts.sessionId) || 1) - 1;
          if (remaining > 0) activeCodexDelegations.set(opts.sessionId, remaining);
          else activeCodexDelegations.delete(opts.sessionId);
        }
      }, execOptions.toolCallId);
    },
  });
}

const CODEX_SUBAGENT_RUNS_DESCRIPTION = [
  'Read the authoritative durable lifecycle records for managed Sub Agents in this CodePilot chat session.',
  'Use this before answering any progress/status/history question. Never infer Sub-agent progress from update_plan, assistant narration, elapsed time, or workspace files.',
  'terminal=false means running. terminal=true means the child has stopped; status then distinguishes completed, partial, failed, cancelled, or timed_out.',
].join('\n');

const CODEX_SUBAGENT_RUNS_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 20,
      description: 'Maximum number of newest physical runs to return. Defaults to 10.',
    },
    include_results: {
      type: 'boolean',
      description: 'Include bounded child result excerpts when true. Defaults to false.',
    },
  },
} satisfies JSONSchema7;

function buildCodexSubagentRunsTool(opts: BuiltinBridgeOpts) {
  return tool({
    description: CODEX_SUBAGENT_RUNS_DESCRIPTION,
    inputSchema: jsonSchema(CODEX_SUBAGENT_RUNS_INPUT_SCHEMA),
    execute: async (rawInput: unknown, execOptions) => {
      const input = rawInput as { limit?: number; include_results?: boolean };
      return runWithEvents(opts, 'codepilot_list_subagent_runs', input, async () => ({
        text: formatSubagentRunToolResult({
          sessionId: opts.sessionId,
          limit: input.limit,
          includeResults: input.include_results === true,
        }),
      }), execOptions.toolCallId);
    },
  });
}

function emptyResult(reason: string): BuiltinBridgeResult {
  return {
    tools: {},
    toolNames: new Set(),
    systemPrompt: '',
    skippedReason: reason,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helper — wrap an execute() body with side-channel event emission.
//
// Every built-in tool follows the same shape:
//   1. Generate a fresh toolId so the UI can pair tool_started ↔
//      tool_completed by id (same convention `useSSEStream` uses for
//      the Codex notification path).
//   2. Emit tool_started BEFORE the handler runs so the chat UI
//      shows the "tool running…" affordance.
//   3. Run the handler, catching everything.
//   4. Emit tool_completed AFTER, either with `output` text (success)
//      + optional MediaBlock, or with `error` string (failure).
//   5. Return text to ai-sdk so the model sees the result inline.
//
// The wrapper centralises the emit/catch pattern so each tool body
// stays focused on its own business logic.
// ─────────────────────────────────────────────────────────────────────

interface HandlerSuccess {
  /** Text the model sees (and CodePilot UI shows as tool result content). */
  text: string;
  /** Optional MediaBlock[] for image/audio/video results. */
  media?: MediaBlock[];
}

async function runWithEvents(
  opts: BuiltinBridgeOpts,
  toolName: string,
  input: unknown,
  handler: (toolId: string) => Promise<HandlerSuccess>,
  toolIdOverride?: string,
): Promise<string> {
  const toolId = toolIdOverride?.trim() || `cpb_${crypto.randomBytes(8).toString('hex')}`;
  const base = { runtimeId: 'codex_runtime' as const, sessionId: opts.sessionId };
  emitBuiltinEvent(opts.sessionId, makeToolStarted(base, { toolId, name: toolName, input }));
  try {
    const result = await handler(toolId);
    // Media import boundary: if any block carries a localPath that
    // sits outside `<dataDir>/.codepilot-media`, copy it in BEFORE
    // emitting so `/api/media/serve` will accept it. The same helper
    // codex/runtime.ts uses for native imageGeneration events — keeps
    // every path-bearing event family honest.
    let materializedMedia = result.media;
    if (result.media && result.media.length > 0) {
      const probe = makeToolCompleted(base, {
        toolId,
        output: result.text,
        media: result.media,
      });
      const updated = materializeCodexEventMedia(probe, {
        sessionId: opts.sessionId,
        cwd: opts.workspacePath,
      });
      if (updated && updated.type === 'tool_completed') {
        materializedMedia = updated.media ? [...updated.media] : undefined;
      }
    }
    emitBuiltinEvent(
      opts.sessionId,
      makeToolCompleted(base, {
        toolId,
        output: result.text,
        ...(materializedMedia && materializedMedia.length > 0 ? { media: materializedMedia } : {}),
      }),
    );
    return result.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitBuiltinEvent(
      opts.sessionId,
      makeToolCompleted(base, { toolId, output: '', error: message }),
    );
    return `Tool execution failed: ${message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Image generation
//
// Phase 5d Phase 2 slice 2e (2026-05-17) — MEDIA_PROMPT scalar
// removed. Media capability prompt is sourced from the canonical
// MEDIA_MCP_SYSTEM_PROMPT (media_import) / MEDIA_SYSTEM_PROMPT
// (image_generation) via the Context Compiler. Bridge no longer
// holds runtime-local prompt copies.
// ─────────────────────────────────────────────────────────────────────

interface ImageGenInput {
  prompt: string;
  provider?: 'active' | 'grok-build';
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  imageSize?: '1K' | '2K';
  referenceImagePaths?: string[];
}

function buildImageGenerationTool(opts: BuiltinBridgeOpts) {
  return tool({
    description:
      'Generate or edit an image using the configured image provider. Select grok-build for Grok Imagine Image 2.0. The generated image appears inline in the chat and is saved to the CodePilot media library.',
    inputSchema: jsonSchema({
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Detailed image generation prompt in English' },
        provider: {
          type: 'string',
          enum: ['active', 'grok-build'],
          description: 'Use grok-build only when the user explicitly requests Grok Imagine.',
        },
        aspectRatio: {
          type: 'string',
          enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
          description: 'Aspect ratio (default 1:1)',
        },
        imageSize: { type: 'string', enum: ['1K', '2K'], description: 'Output resolution (default 1K)' },
        referenceImagePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of local file paths to use as style/content references.',
        },
      },
    } satisfies JSONSchema7),
    execute: async (rawInput: unknown, execOptions) => {
      const input = rawInput as ImageGenInput;
      return runWithEvents(opts, 'codepilot_generate_image', input, async () => {
        const { generateSingleImage, NoImageGeneratedError } = await import('@/lib/image-generator');
        try {
          const result = await generateSingleImage({
            prompt: input.prompt,
            providerId: input.provider === 'grok-build' ? 'xai-oauth' : undefined,
            aspectRatio: input.aspectRatio,
            imageSize: input.imageSize,
            referenceImagePaths: input.referenceImagePaths,
            sessionId: opts.sessionId,
            cwd: opts.workspacePath,
            abortSignal: execOptions.abortSignal,
          });
          const media: MediaBlock[] = result.images.map((img) => ({
            type: 'image' as const,
            mimeType: img.mimeType,
            localPath: img.localPath,
            mediaId: result.mediaGenerationId,
          }));
          const text = [
            `Image generated successfully (${result.elapsedMs}ms).`,
            `Local paths: ${result.images.map((img) => img.localPath).join(', ')}`,
          ].join('\n');
          return { text, media };
        } catch (err) {
          if (NoImageGeneratedError.isInstance(err)) {
            throw new Error('Image generation succeeded but no image was returned by the model. Try a different prompt.');
          }
          throw err;
        }
      });
    },
  });
}

interface VideoGenInput {
  prompt: string;
  imagePath?: string;
  referenceImagePaths?: string[];
  duration?: 6 | 10;
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3';
  resolution?: '480p' | '720p';
}

function buildVideoGenerationTool(opts: BuiltinBridgeOpts) {
  return tool({
    description:
      'Generate a video with Grok Imagine Video 1.5 through the connected Grok Build OAuth account. Supports text-to-video, a single source image as the first frame, or multiple reference images. The result appears inline and is saved to Gallery.',
    inputSchema: jsonSchema({
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Detailed video generation prompt.' },
        imagePath: { type: 'string', description: 'Optional source image to animate as the first frame.' },
        referenceImagePaths: {
          type: 'array',
          maxItems: 7,
          items: { type: 'string' },
          description: 'Optional style/content reference images.',
        },
        duration: { type: 'number', enum: [6, 10], description: 'Video duration in seconds.' },
        aspectRatio: {
          type: 'string',
          enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
        },
        resolution: { type: 'string', enum: ['480p', '720p'] },
      },
    } satisfies JSONSchema7),
    execute: async (rawInput: unknown, execOptions) => {
      const input = rawInput as VideoGenInput;
      return runWithEvents(opts, 'codepilot_generate_video', input, async () => {
        const { generateGrokVideo } = await import('@/lib/xai-imagine');
        const result = await generateGrokVideo({
          prompt: input.prompt,
          imagePath: input.imagePath,
          referenceImagePaths: input.referenceImagePaths,
          duration: input.duration,
          aspectRatio: input.aspectRatio,
          resolution: input.resolution,
          sessionId: opts.sessionId,
          runtimeId: 'codex_runtime',
          cwd: opts.workspacePath,
          abortSignal: execOptions.abortSignal,
        });
        const media: MediaBlock[] = [{
          type: 'video',
          mimeType: result.mimeType,
          localPath: result.localPath,
          mediaId: result.mediaGenerationId,
        }];
        return {
          text: `Video generated successfully (${result.elapsedMs}ms). Local path: ${result.localPath}`,
          media,
        };
      });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Media import
// ─────────────────────────────────────────────────────────────────────

interface ImportMediaInput {
  filePath: string;
  prompt?: string;
  source?: string;
  model?: string;
  tags?: string[];
}

function buildImportMediaTool(opts: BuiltinBridgeOpts) {
  return tool({
    description:
      'Import an existing local file (image, video, audio) into the CodePilot media library. Use when the user wants to add a file they already have on disk into the library so it can be referenced later.',
    inputSchema: jsonSchema({
      type: 'object',
      additionalProperties: false,
      required: ['filePath'],
      properties: {
        filePath: { type: 'string', description: 'Local file path to import.' },
        prompt: { type: 'string', description: 'Optional description / title.' },
        source: { type: 'string', description: 'Optional source label (e.g. "user-upload").' },
        model: { type: 'string', description: 'Optional model that produced the file (if AI-generated).' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    } satisfies JSONSchema7),
    execute: async (rawInput: unknown) => {
      const input = rawInput as ImportMediaInput;
      return runWithEvents(opts, 'codepilot_import_media', input, async () => {
        const { importFileToLibrary } = await import('@/lib/media-saver');
        const result = importFileToLibrary(input.filePath, {
          sessionId: opts.sessionId,
          source: input.source,
          prompt: input.prompt,
          model: input.model,
          tags: input.tags,
          cwd: opts.workspacePath,
        });
        // P2 fix (smoke round, 2026-05-16) — the bridge's tool
        // DESCRIPTION promises image/video/audio support, but
        // pre-fix every imported file got `type: 'image'` regardless.
        // MediaPreview is type-discriminated (image → <img>, video
        // → <video>, audio → <audio>), so importing a .mp4 or .wav
        // landed in the wrong renderer. Infer mediaType from the
        // mimeType prefix the same way `media-saver.mimeToMediaType`
        // does — we can't reach that helper directly without
        // exporting it, but the prefix check is two lines.
        const mimeType = inferMimeFromPath(result.localPath);
        const mediaType: 'image' | 'video' | 'audio' = mediaTypeOf(mimeType);
        const block: MediaBlock = {
          type: mediaType,
          mimeType,
          localPath: result.localPath,
          mediaId: result.mediaId,
        };
        return {
          text: `File imported to media library. mediaId=${result.mediaId}, localPath=${result.localPath}, mediaType=${mediaType}`,
          media: [block],
        };
      });
    },
  });
}

function inferMimeFromPath(localPath: string): string {
  const ext = localPath.toLowerCase().slice(localPath.lastIndexOf('.'));
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.avif': return 'image/avif';
    case '.svg': return 'image/svg+xml';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.mkv': return 'video/x-matroska';
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    case '.flac': return 'audio/flac';
    case '.aac': return 'audio/aac';
    default: return 'application/octet-stream';
  }
}

/** Mirrors `media-saver.ts mimeToMediaType` — kept inline to avoid
 *  exporting a helper from media-saver just for this caller. Drift
 *  guard: both sides default to `image` so non-AV files still render
 *  in the gallery as a fallback. */
function mediaTypeOf(mimeType: string): 'image' | 'video' | 'audio' {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'image';
}

// ─────────────────────────────────────────────────────────────────────
// Memory
//
// Phase 5d Phase 2 slice 2e (2026-05-17) — MEMORY_PROMPT scalar
// removed. Memory capability prompt is sourced from the canonical
// MEMORY_SEARCH_SYSTEM_PROMPT (memory-search-mcp.ts) via the
// Context Compiler.
// ─────────────────────────────────────────────────────────────────────

// The proxy executes read-only queries through the same service as Native and
// MCP. Memory writes use Codex's memory_write MCP server and its approval gate;
// they must never be duplicated here as direct, unapproved SDK executions.
function buildMemorySearchTool(opts: BuiltinBridgeOpts) {
  const definition = createMemoryAdapterQueryTools(opts.workspacePath!, { sourceSessionId: opts.sessionId, providerId: opts.targetProviderId, resolvedProvider: opts.resolvedProvider }).codepilot_memory_search;
  return tool({ ...definition, execute: async input => runWithEvents(
    opts, 'codepilot_memory_search', input, async () => ({ text: await definition.execute(input) }),
  ) });
}

function buildMemoryGetTool(opts: BuiltinBridgeOpts) {
  const definition = createMemoryAdapterQueryTools(opts.workspacePath!, { sourceSessionId: opts.sessionId, providerId: opts.targetProviderId }).codepilot_memory_get;
  return tool({ ...definition, execute: async input => runWithEvents(
    opts, 'codepilot_memory_get', input, async () => ({ text: await definition.execute(input) }),
  ) });
}

function buildMemoryRecentTool(opts: BuiltinBridgeOpts) {
  const definition = createMemoryAdapterQueryTools(opts.workspacePath!, { sourceSessionId: opts.sessionId, providerId: opts.targetProviderId }).codepilot_memory_recent;
  return tool({ ...definition, execute: async input => runWithEvents(
    opts, 'codepilot_memory_recent', input, async () => ({ text: await definition.execute(input) }),
  ) });
}

// ─────────────────────────────────────────────────────────────────────
// Widget guidelines
//
// Phase 5d Phase 2 slice 2e (2026-05-17) — WIDGET_PROMPT scalar
// removed. The Harness Context Compiler emits the canonical
// WIDGET_SYSTEM_PROMPT + the widget artifactContract; bridge holds
// no local copy. The compiler is consulted by unified-adapter.ts.
// ─────────────────────────────────────────────────────────────────────

interface WidgetInput {
  modules: Array<'interactive' | 'chart' | 'mockup' | 'art' | 'diagram'>;
}

function buildWidgetGuidelinesTool(opts: BuiltinBridgeOpts) {
  return tool({
    description:
      'Load detailed design guidelines for generating visual widgets. Call this before generating your first widget in the conversation. Available modules: interactive (HTML controls), chart (Chart.js), mockup (UI mockups), art (SVG illustrations), diagram (flowcharts / timelines / hierarchies).',
    inputSchema: jsonSchema({
      type: 'object',
      additionalProperties: false,
      required: ['modules'],
      properties: {
        modules: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', enum: ['interactive', 'chart', 'mockup', 'art', 'diagram'] },
        },
      },
    } satisfies JSONSchema7),
    execute: async (rawInput: unknown) => {
      const input = rawInput as WidgetInput;
      return runWithEvents(opts, 'codepilot_load_widget_guidelines', input, async () => {
        const { getGuidelines } = await import('@/lib/widget-guidelines');
        const text = getGuidelines(input.modules as string[]);
        return { text };
      });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Notify + tasks
//
// Phase 5d Phase 2 slice 2e (2026-05-17) — NOTIFY_PROMPT scalar
// removed. Tasks + notify capability prompt is sourced from the
// canonical NOTIFICATION_MCP_SYSTEM_PROMPT via the Context Compiler.
// ─────────────────────────────────────────────────────────────────────

interface NotifyInput {
  title: string;
  body: string;
  priority?: 'low' | 'normal' | 'urgent';
}

function buildNotifyTool(opts: BuiltinBridgeOpts) {
  return tool({
    description:
      'Send an immediate notification to the user. low = toast only, normal = toast + system, urgent = toast + system + Telegram.',
    inputSchema: jsonSchema({
      type: 'object',
      additionalProperties: false,
      required: ['title', 'body'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'urgent'] },
      },
    } satisfies JSONSchema7),
    execute: async (rawInput: unknown) => {
      const input = rawInput as NotifyInput;
      return runWithEvents(opts, 'codepilot_notify', input, async () => {
        const { sendNotification } = await import('@/lib/notification-manager');
        await sendNotification({
          title: input.title,
          body: input.body,
          priority: input.priority ?? 'normal',
        });
        return { text: `Notification sent: "${input.title}"` };
      });
    },
  });
}

interface ScheduleTaskInput {
  name: string;
  prompt: string;
  kind: 'reminder' | 'ai_task';
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  priority?: 'low' | 'normal' | 'urgent';
  notify_on_complete?: boolean;
  durable?: boolean;
}

function buildScheduleTaskTool(opts: BuiltinBridgeOpts) {
  return tool({
    description:
      'Create a scheduled task. kind=reminder shows a notification on schedule (no AI call); kind=ai_task feeds the prompt to the configured provider. Supports cron, interval, or one-off.',
    inputSchema: jsonSchema({
      type: 'object',
      additionalProperties: false,
      required: ['name', 'prompt', 'kind', 'schedule_type', 'schedule_value'],
      properties: {
        name: { type: 'string' },
        prompt: { type: 'string' },
        kind: { type: 'string', enum: ['reminder', 'ai_task'] },
        schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'] },
        schedule_value: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'urgent'] },
        notify_on_complete: { type: 'boolean' },
        durable: { type: 'boolean' },
      },
    } satisfies JSONSchema7),
    execute: async (rawInput: unknown) => {
      const input = rawInput as ScheduleTaskInput;
      return runWithEvents(opts, 'codepilot_schedule_task', input, async () => {
        // P1 fix (smoke round, 2026-05-16) — `durable: false` MUST
        // take the session-only branch (writes into the in-process
        // map via addSessionTask), NOT POST to /api/tasks/schedule.
        // Pre-fix the bridge accepted the param then ignored it,
        // breaking parity with `notification-mcp.ts` + the AI SDK
        // builtin variant: a Codex Runtime task with durable=false
        // would have ended up persistent, surviving restarts the
        // user didn't expect, and showing up in the durable
        // dashboard. Mirror `notification-mcp.ts` lines 121-173.
        if (input.durable === false) {
          const cryptoMod = await import('node:crypto');
          const { addSessionTask, parseInterval, getNextCronTime } = await import('@/lib/task-scheduler');
          const id = cryptoMod.randomBytes(8).toString('hex');
          const now = new Date();
          let next_run: string;
          if (input.schedule_type === 'once') {
            next_run = input.schedule_value;
          } else if (input.schedule_type === 'interval') {
            next_run = new Date(now.getTime() + parseInterval(input.schedule_value)).toISOString();
          } else {
            const cronNext = getNextCronTime(input.schedule_value);
            if (!cronNext) {
              return {
                text: `Cron expression "${input.schedule_value}" has no valid occurrence within 4 years. Task not created.`,
              };
            }
            next_run = cronNext.toISOString();
          }
          const task = {
            id,
            name: input.name,
            prompt: input.prompt,
            kind: input.kind,
            schedule_type: input.schedule_type,
            schedule_value: input.schedule_value,
            next_run,
            consecutive_errors: 0,
            status: 'active' as const,
            priority: input.priority || 'normal',
            notify_on_complete: input.notify_on_complete === false ? 0 : 1,
            permanent: 0,
            // Hidden run context — closure-captured, model can't
            // override. Same rationale as the MCP variant: scheduled
            // tasks need to know which project / chat they belong
            // to so the runner re-uses the right workspace.
            origin_session_id: opts.sessionId,
            working_directory: opts.workspacePath,
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
          };
          addSessionTask(task);
          return {
            text: `Session task "${input.name}" scheduled (${input.kind}, non-durable). ID: ${id}, next run: ${next_run}`,
          };
        }

        const baseUrl = `http://127.0.0.1:${process.env.PORT || '3000'}`;
        const res = await fetch(`${baseUrl}/api/tasks/schedule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: input.name,
            prompt: input.prompt,
            kind: input.kind,
            schedule_type: input.schedule_type,
            schedule_value: input.schedule_value,
            priority: input.priority,
            notify_on_complete: input.notify_on_complete === false ? 0 : 1,
            origin_session_id: opts.sessionId,
            working_directory: opts.workspacePath,
            // The model can't override these — they come from the
            // bridge closure, matching the SDK MCP version's hidden-
            // context contract.
          }),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        return {
          text: `Task "${input.name}" scheduled (${input.kind}). ID: ${data.task.id}, next run: ${data.task.next_run}`,
        };
      });
    },
  });
}

interface ListTasksInput {
  status?: 'active' | 'paused' | 'completed' | 'disabled' | 'all';
}

function buildListTasksTool(opts: BuiltinBridgeOpts) {
  return tool({
    description: 'List scheduled tasks. Returns id, name, schedule, status, and next run time.',
    inputSchema: jsonSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['active', 'paused', 'completed', 'disabled', 'all'] },
      },
    } satisfies JSONSchema7),
    execute: async (rawInput: unknown) => {
      const input = rawInput as ListTasksInput;
      return runWithEvents(opts, 'codepilot_list_tasks', input, async () => {
        const baseUrl = `http://127.0.0.1:${process.env.PORT || '3000'}`;
        const url = input.status && input.status !== 'all'
          ? `${baseUrl}/api/tasks/list?status=${input.status}`
          : `${baseUrl}/api/tasks/list`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        type TaskRow = {
          id: string; name: string; schedule_type: string; schedule_value: string;
          status: string; next_run: string; last_status?: string; durable?: boolean;
        };
        const tasks: TaskRow[] = ((data.tasks ?? []) as Omit<TaskRow, 'durable'>[]).map((t) => ({
          ...t,
          durable: true,
        }));

        // P1 fix (smoke round, 2026-05-16) — also merge session-only
        // tasks from the in-process map. Mirror notification-mcp.ts
        // lines 224-240. Without this merge, a user who scheduled a
        // non-durable task earlier in the same chat couldn't see it
        // here even though it was very much alive.
        try {
          const { getSessionTasks } = await import('@/lib/task-scheduler');
          for (const [, task] of getSessionTasks()) {
            if (input.status && input.status !== 'all' && task.status !== input.status) continue;
            tasks.push({
              id: task.id,
              name: `${task.name} (session)`,
              schedule_type: task.schedule_type,
              schedule_value: task.schedule_value,
              status: task.status,
              next_run: task.next_run,
              last_status: task.last_status,
              durable: false,
            });
          }
        } catch {
          // Best-effort: scheduler module not loaded → durable list only.
        }

        if (tasks.length === 0) {
          return { text: 'No scheduled tasks found.' };
        }
        const formatted = tasks
          .map((t, i) =>
            `${i + 1}. [${t.id}] ${t.name}\n   Type: ${t.schedule_type} (${t.schedule_value})\n   Status: ${t.status} | Next: ${t.next_run}${t.last_status ? ` | Last: ${t.last_status}` : ''}${t.durable === false ? ' | Session-only' : ''}`,
          )
          .join('\n\n');
        return { text: formatted };
      });
    },
  });
}

interface CancelTaskInput {
  task_id: string;
}

function buildCancelTaskTool(opts: BuiltinBridgeOpts) {
  return tool({
    description: 'Cancel (delete) a scheduled task by id.',
    inputSchema: jsonSchema({
      type: 'object',
      additionalProperties: false,
      required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    } satisfies JSONSchema7),
    execute: async (rawInput: unknown) => {
      const input = rawInput as CancelTaskInput;
      return runWithEvents(opts, 'codepilot_cancel_task', input, async () => {
        // P1 fix (smoke round, 2026-05-16) — try the session-only
        // map first, fall through to durable DELETE if not found.
        // Mirror notification-mcp.ts lines 263-281. Pre-fix the
        // bridge only hit /api/tasks/:id, which returns 404 for
        // any in-memory session task and surfaced as a tool error
        // even though the task was very much cancellable.
        try {
          const { getSessionTasks, removeSessionTask } = await import('@/lib/task-scheduler');
          const sessionTasks = getSessionTasks();
          if (sessionTasks.has(input.task_id)) {
            removeSessionTask(input.task_id);
            return { text: `Session task ${input.task_id} cancelled.` };
          }
        } catch {
          // Scheduler module not loaded → fall through to durable.
        }

        const baseUrl = `http://127.0.0.1:${process.env.PORT || '3000'}`;
        const res = await fetch(`${baseUrl}/api/tasks/${input.task_id}`, { method: 'DELETE' });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || `HTTP ${res.status}`);
        }
        return { text: `Task ${input.task_id} cancelled.` };
      });
    },
  });
}
