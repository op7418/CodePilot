/**
 * CodePilot-managed Claude Code sub-agents.
 *
 * Claude's built-in Agent tool can change a model role (sonnet/opus/haiku),
 * but it cannot change the Provider endpoint owned by the parent subprocess.
 * This MCP tool starts a separate Claude Agent SDK subprocess so an explicit
 * provider + model pair from CodePilot's Claude Code model catalog is real,
 * rather than a prompt label that silently falls back to the parent model.
 */

import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKAssistantMessage,
  type SDKResultError,
  type SDKResultSuccess,
  type SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  checkpointSubagentRun,
  describeSubagentRunStartRejection,
  getAllProviders,
  getProvider,
  markSubagentRunSettling,
  recordSubagentRunEvent,
  settleSubagentRun,
  startSubagentRun,
} from './db';
import { resolveForClaudeCode, type ResolvedProvider } from './provider-resolver';
import { getModelCompat, getProviderCompat } from './runtime-compat';
import { prepareSdkSubprocessEnv } from './sdk-subprocess-env';
import { findClaudeBinary } from './platform';
import { assertCliProviderLaunchAllowed } from './cli-maintenance-lease';
import {
  encodeSubagentStatusResult,
  type SubagentExecutionStatus,
  type SubagentStatusError,
} from './subagent-status';
import { getCachedModels } from './agent-sdk-capabilities';
import type { CatalogModel } from './provider-catalog';
import {
  resolveSubagentDependencies,
  validateSubagentDispatchSpec,
} from './subagent-orchestration';
import { listManagedVirtualProviderModelGroups } from './managed-virtual-provider-models';

export const CLAUDE_SUBAGENT_SERVER_KEY = 'codepilot-subagent';
export const CLAUDE_SUBAGENT_TOOL_NAME = 'codepilot_spawn_subagent';
export const CLAUDE_SUBAGENT_QUALIFIED_TOOL_NAME =
  `mcp__${CLAUDE_SUBAGENT_SERVER_KEY}__${CLAUDE_SUBAGENT_TOOL_NAME}`;

const MAX_CONCURRENT_SUBAGENTS = 2;
const SUBAGENT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SUBAGENT_HARD_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_SUBAGENT_CHECKPOINT_CHARS = 64 * 1024;
const activeRuns = new Map<string, number>();
const writeRunQueues = new Map<string, { tail: Promise<void>; pending: number }>();

const CLAUDE_SUBAGENT_PERMISSION_ATTRIBUTION =
  '__codepilotClaudeSubagentPermissionAttribution' as const;

export type ClaudeSubagentCapability =
  | 'read_workspace'
  | 'network_search'
  | 'write_workspace';

type ClaudeSubagentTerminalStatus = Exclude<SubagentExecutionStatus, 'running'>;
export type ClaudeSubagentTimeoutKind = 'idle' | 'hard';

export type ClaudeSubagentToolOptions = Pick<
  Options,
  | 'tools'
  | 'allowedTools'
  | 'disallowedTools'
  | 'permissionMode'
  | 'allowDangerouslySkipPermissions'
  | 'canUseTool'
  | 'mcpServers'
>;

export interface ClaudeSubagentPermissionAttribution {
  agentRunId: string;
  childSessionId: string;
  agentName: string;
}

type ClaudeCanUseTool = NonNullable<ClaudeSubagentToolOptions['canUseTool']>;
type ClaudeCanUseToolContext = Parameters<ClaudeCanUseTool>[2];
type AttributedClaudeCanUseToolContext = ClaudeCanUseToolContext & {
  [CLAUDE_SUBAGENT_PERMISSION_ATTRIBUTION]?: ClaudeSubagentPermissionAttribution;
};

interface ClaudeSubagentRunOutcome {
  status: ClaudeSubagentTerminalStatus;
  text: string;
  effectiveModel?: string;
  error?: SubagentStatusError;
  usage?: {
    requests?: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
}

export interface ClaudeSubagentRoute {
  providerId: string;
  providerName: string;
  modelId: string;
  upstreamModelId?: string;
  displayName: string;
}

export interface ClaudeSubagentMcpOptions {
  sessionId: string;
  workingDirectory: string;
  abortSignal?: AbortSignal;
  routes?: readonly ClaudeSubagentRoute[];
  toolUseCorrelation?: ClaudeSubagentToolUseCorrelation;
  /** Read lazily so tools registered after this MCP server are inherited. */
  getParentToolOptions?: () => ClaudeSubagentToolOptions;
}

interface ClaudeSubagentToolInput {
  prompt?: unknown;
  agent_name?: unknown;
  provider_id?: unknown;
  model?: unknown;
  logical_run_id?: unknown;
  workflow_id?: unknown;
  task_key?: unknown;
  depends_on?: unknown;
  required_capabilities?: unknown;
}

export interface ClaudeSubagentToolUseCorrelation {
  record(toolUseId: string, input: ClaudeSubagentToolInput): void;
  claim(input: ClaudeSubagentToolInput): string | undefined;
}

const MAX_CORRELATED_TOOL_USES = 128;

function fingerprintClaudeSubagentToolInput(input: ClaudeSubagentToolInput): string {
  return JSON.stringify({
    prompt: input.prompt,
    agent_name: input.agent_name,
    provider_id: input.provider_id,
    model: input.model,
    logical_run_id: input.logical_run_id,
    workflow_id: input.workflow_id,
    task_key: input.task_key,
    depends_on: input.depends_on,
    required_capabilities: input.required_capabilities,
  });
}

/**
 * Bridge the Claude SDK's PreToolUse id to the in-process MCP handler.
 *
 * The MCP callback does not receive Claude's tool-use id, but the transcript
 * does. Keeping that id as the physical attempt id makes the running capsule,
 * durable row, permission attribution, and details API refer to one fact.
 * Entries are request-local, bounded, and claimed once. LIFO prevents a
 * denied/stale identical invocation from stealing the id of a newer call.
 */
export function createClaudeSubagentToolUseCorrelation(): ClaudeSubagentToolUseCorrelation {
  const entries = new Map<string, string[]>();
  const insertionOrder: Array<{ fingerprint: string; toolUseId: string }> = [];
  const pendingIds = new Set<string>();
  return {
    record(toolUseId, input) {
      if (pendingIds.has(toolUseId)) return;
      const fingerprint = fingerprintClaudeSubagentToolInput(input);
      const ids = entries.get(fingerprint) || [];
      ids.push(toolUseId);
      entries.set(fingerprint, ids);
      pendingIds.add(toolUseId);
      insertionOrder.push({ fingerprint, toolUseId });
      while (insertionOrder.length > MAX_CORRELATED_TOOL_USES) {
        const oldest = insertionOrder.shift();
        if (!oldest) break;
        const pending = entries.get(oldest.fingerprint);
        const index = pending?.indexOf(oldest.toolUseId) ?? -1;
        if (!pending || index < 0) continue;
        pending.splice(index, 1);
        pendingIds.delete(oldest.toolUseId);
        if (pending.length === 0) entries.delete(oldest.fingerprint);
      }
    },
    claim(input) {
      const fingerprint = fingerprintClaudeSubagentToolInput(input);
      const ids = entries.get(fingerprint);
      const toolUseId = ids?.pop();
      if (!ids || ids.length === 0) entries.delete(fingerprint);
      if (toolUseId) pendingIds.delete(toolUseId);
      return toolUseId;
    },
  };
}

/**
 * Build the same semantic route set as the Claude Code model picker:
 * enabled provider models whose canonical compatibility includes
 * `claude_code`. Incompatible xAI/OpenAI-skin routes are deliberately absent.
 */
export function listClaudeSubagentRoutes(): ClaudeSubagentRoute[] {
  const providers = [
    {
      id: 'env',
      name: 'Claude Code',
      provider: undefined,
      providerCompat: 'claude_code_ready' as const,
    },
    ...getAllProviders().map(provider => ({
      id: provider.id,
      name: provider.name,
      provider,
      providerCompat: getProviderCompat(provider),
    })),
    ...listManagedVirtualProviderModelGroups().map(group => ({
      id: group.providerId,
      name: group.providerName,
      provider: undefined,
      providerCompat: group.compat,
    })),
  ];
  const routes: ClaudeSubagentRoute[] = [];

  for (const candidate of providers) {
    let resolved: ResolvedProvider;
    try {
      resolved = resolveForClaudeCode(candidate.provider, {
        callScene: 'delegated_interactive',
        providerId: candidate.id,
        runtime: 'claude_code',
      });
    } catch {
      continue;
    }
    const availableModels: CatalogModel[] = candidate.id === 'env' && getCachedModels('env').length > 0
      ? getCachedModels('env').map(cached => {
          const catalog = resolved.availableModels.find(model => model.modelId === cached.value);
          return {
            modelId: cached.value,
            upstreamModelId: catalog?.upstreamModelId,
            displayName: cached.displayName,
            capabilities: catalog?.capabilities,
          };
        })
      : [...resolved.availableModels];
    // The picker also exposes role mappings that have not yet materialized as
    // provider_model rows. Keep this tail in lock-step with that surface.
    for (const roleModel of Object.values(resolved.roleModels)) {
      if (!roleModel || availableModels.some(model =>
        model.modelId === roleModel || model.upstreamModelId === roleModel)) continue;
      availableModels.push({ modelId: roleModel, displayName: roleModel });
    }

    for (const model of availableModels) {
      const compat = getModelCompat({
          providerBaseUrl: resolved.provider?.base_url,
        modelId: model.modelId,
        upstreamModelId: model.upstreamModelId,
        providerCompat: candidate.providerCompat,
        capabilities: model.capabilities,
      });
      if (compat.media || !compat.supportedRuntimes?.includes('claude_code')) continue;
      routes.push({
        providerId: candidate.id,
        providerName: candidate.name,
        modelId: model.modelId,
        upstreamModelId: model.upstreamModelId,
        displayName: model.displayName || model.upstreamModelId || model.modelId,
      });
    }
  }

  return deduplicateRoutes(routes);
}

export function getClaudeSubagentRoutingGuidance(
  routes: readonly ClaudeSubagentRoute[],
): string {
  const routeLines = routes.map(route =>
    `  - provider_id=${JSON.stringify(route.providerId)}, model=${JSON.stringify(route.modelId)}: ${route.displayName} (${route.providerName})`,
  );
  return [
    'CodePilot model-specific sub-agent contract:',
    `- To run a child on a named model, call ${CLAUDE_SUBAGENT_TOOL_NAME}. It starts a separate Claude Code Runtime subprocess on the exact provider_id + model pair; do not use Claude\'s built-in Agent/Task tool for a named-model request.`,
    '- Each call is a blocking one-shot foreground run. It cannot be resumed, steered, or used as a placeholder. The tool returns only after the child reaches a terminal status; no background child remains running.',
    '- Treat terminal=true plus the returned status and body as the child result immediately. Never describe a returned call as merely submitted, launched, queued, still processing, or waiting for later monitoring.',
    '- Never spawn a child just to confirm, stand by, or wait for later input. CodePilot rejects undeclared placeholder prompts before Provider execution.',
    '- For dependent work in one plan, assign one workflow_id, a unique task_key per child, and depends_on upstream task keys; emit upstream task calls before their dependents. CodePilot waits on durable terminal facts and injects the upstream results when the downstream Runtime actually starts. You may also wait for the prior tool return yourself and include its result directly, but never pre-generate a wait-only prompt.',
    '- Omit logical_run_id on the first attempt. When retrying the same logical task, reuse the exact logicalRunId returned by the failed attempt; never reuse it for different work. CodePilot keeps the attempts in one capsule.',
    '- CodePilot rejects logical_run_id reuse while its prior attempt is running/settling or after it completed successfully. Wait for active work; read completed work; omit the ID for a genuinely new logical task.',
    '- For factual or research handoffs, pass source URLs beside the claims they support. Exact dates, statistics, rankings, and quotations without a cited source are unverified input; do not ask another child to present them as fact.',
    '- Declare required_capabilities truthfully. The child inherits the parent turn\'s available Claude Code built-ins, MCP servers, permission profile, and approval callback. WebSearch/WebFetch, file edits, and shell are allowed when the parent exposes them.',
    '- Children declaring write_workspace are serialized per working directory; do not plan simultaneous edits to the same working tree.',
    `- Active children may run for up to ${Math.round(SUBAGENT_HARD_TIMEOUT_MS / 60_000)} minutes. The ${Math.round(SUBAGENT_IDLE_TIMEOUT_MS / 60_000)}-minute idle timeout renews whenever the SDK emits child activity; it is not a fixed wall-clock deadline.`,
    '- If a task requires an unavailable capability, expect CAPABILITY_UNAVAILABLE and ask the user how to proceed. Never replace live research with training knowledge or stale local copy.',
    '- If a child returns failed or timed_out, report the exact child status. You may either ask the user how to proceed or explicitly take over with the parent\'s real tools when that can still satisfy the request. Never silently fall back, attribute parent work to the failed child, or treat partial output as verified completion.',
    '- The routes below are catalog-compatible candidates, not entitlement proof. Authentication, plan, and per-model access are verified only by the child call:',
    ...(routeLines.length > 0 ? routeLines : ['  - (none)']),
    '- Never substitute sonnet/opus/haiku, the parent model, or another provider when the requested model is absent.',
    '- If the user requests a model that is not listed (for example Grok on an incompatible xAI route), say SUBAGENT_MODEL_UNAVAILABLE, explain that it cannot run under Claude Code Runtime, and ask whether to choose an available model or switch Runtime. Do not continue as if that child ran.',
  ].join('\n');
}

export function findClaudeSubagentRoute(
  routes: readonly ClaudeSubagentRoute[],
  providerId: unknown,
  modelId: unknown,
): ClaudeSubagentRoute | undefined {
  if (typeof providerId !== 'string' || typeof modelId !== 'string') return undefined;
  return routes.find(route =>
    route.providerId === providerId
    && (route.modelId === modelId || route.upstreamModelId === modelId),
  );
}

export function isClaudeManagedSubagentToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === CLAUDE_SUBAGENT_TOOL_NAME
    || lower === CLAUDE_SUBAGENT_QUALIFIED_TOOL_NAME
    || lower.endsWith(`__${CLAUDE_SUBAGENT_TOOL_NAME}`);
}

export function validateClaudeSubagentCapabilities(
  required: readonly ClaudeSubagentCapability[],
  toolOptions: ClaudeSubagentToolOptions = {},
): { ok: true } | { ok: false; unsupported: ClaudeSubagentCapability[] } {
  const explicitTools = Array.isArray(toolOptions.tools)
    ? new Set(toolOptions.tools)
    : undefined;
  const disallowed = new Set(toolOptions.disallowedTools || []);
  const hasBuiltin = (name: string) =>
    !disallowed.has(name) && (!explicitTools || explicitTools.has(name));
  const capabilities = new Set<ClaudeSubagentCapability>();
  // Only the actual Claude built-in surface is a synchronous capability fact
  // here. An MCP server entry proves transport configuration, not which tools
  // connected successfully or what they do. In particular, codepilot-memory
  // contains a local "search" tool but cannot satisfy live network research.
  // MCP servers are still inherited unchanged below; an unknown MCP simply
  // does not manufacture read/network/write capability for this preflight.
  if (hasBuiltin('Read') || hasBuiltin('Glob') || hasBuiltin('Grep')) {
    capabilities.add('read_workspace');
  }
  if (hasBuiltin('WebSearch') || hasBuiltin('WebFetch')) {
    capabilities.add('network_search');
  }
  if (
    toolOptions.permissionMode !== 'plan'
    && (
      hasBuiltin('Write')
      || hasBuiltin('Edit')
      || hasBuiltin('NotebookEdit')
      || hasBuiltin('Bash')
    )
  ) {
    capabilities.add('write_workspace');
  }
  const unsupported = [...new Set(required.filter(capability => !capabilities.has(capability)))];
  return unsupported.length === 0 ? { ok: true } : { ok: false, unsupported };
}

export function normalizeClaudeSubagentCapabilities(
  value: unknown,
):
  | { ok: true; capabilities: ClaudeSubagentCapability[] }
  | { ok: false; error: SubagentStatusError; message: string } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: { code: 'INVALID_SUBAGENT_SPEC', retryable: false },
      message: 'INVALID_SUBAGENT_SPEC: required_capabilities must be an array. Use [] for pure text work.',
    };
  }
  const allowed = new Set<ClaudeSubagentCapability>([
    'read_workspace',
    'network_search',
    'write_workspace',
  ]);
  const capabilities: ClaudeSubagentCapability[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.has(entry as ClaudeSubagentCapability)) {
      return {
        ok: false,
        error: { code: 'INVALID_SUBAGENT_SPEC', retryable: false },
        message: 'INVALID_SUBAGENT_SPEC: required_capabilities accepts only read_workspace, network_search, and write_workspace. Use [] for pure text work; do not send null or boolean placeholders.',
      };
    }
    if (!capabilities.includes(entry as ClaudeSubagentCapability)) {
      capabilities.push(entry as ClaudeSubagentCapability);
    }
  }
  return { ok: true, capabilities };
}

export function buildClaudeSubagentToolOptions(
  parent: ClaudeSubagentToolOptions,
  permissionAttribution?: ClaudeSubagentPermissionAttribution,
): ClaudeSubagentToolOptions {
  const mcpServers = parent.mcpServers
    ? Object.fromEntries(Object.entries(parent.mcpServers).filter(
        ([name]) => name !== CLAUDE_SUBAGENT_SERVER_KEY,
      ))
    : undefined;
  const inheritedCanUseTool = parent.canUseTool;
  const canUseTool: ClaudeCanUseTool | undefined = inheritedCanUseTool && permissionAttribution
    ? ((toolName: string, input: Record<string, unknown>, context: ClaudeCanUseToolContext) => inheritedCanUseTool(
        toolName,
        input,
        {
          ...context,
          [CLAUDE_SUBAGENT_PERMISSION_ATTRIBUTION]: permissionAttribution,
        } as AttributedClaudeCanUseToolContext,
      ))
    : inheritedCanUseTool;
  return {
    ...(parent.tools !== undefined ? { tools: parent.tools } : {}),
    ...(parent.allowedTools !== undefined ? { allowedTools: [...parent.allowedTools] } : {}),
    disallowedTools: [...new Set([...(parent.disallowedTools || []), 'Agent', 'Task'])],
    ...(parent.permissionMode !== undefined ? { permissionMode: parent.permissionMode } : {}),
    ...(parent.allowDangerouslySkipPermissions
      ? { allowDangerouslySkipPermissions: true as const }
      : {}),
    ...(canUseTool ? { canUseTool } : {}),
    ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
  };
}

export function getClaudeSubagentPermissionAttribution(
  context: unknown,
): ClaudeSubagentPermissionAttribution | undefined {
  if (!context || typeof context !== 'object') return undefined;
  const candidate = (context as AttributedClaudeCanUseToolContext)[
    CLAUDE_SUBAGENT_PERMISSION_ATTRIBUTION
  ];
  if (
    !candidate
    || typeof candidate.agentRunId !== 'string'
    || typeof candidate.childSessionId !== 'string'
    || typeof candidate.agentName !== 'string'
  ) {
    return undefined;
  }
  return candidate;
}

/**
 * Write-capable Claude managed children sharing a working tree run one at a
 * time. Read-only children keep the normal per-session concurrency of two.
 */
export async function serializeClaudeSubagentWriteRun<T>(
  workingDirectory: string,
  abortSignal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const key = resolveWriteQueueKey(workingDirectory);
  let queue = writeRunQueues.get(key);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: 0 };
    writeRunQueues.set(key, queue);
  }

  const previous = queue.tail.catch(() => undefined);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.tail = previous.then(() => gate);
  queue.pending += 1;

  try {
    await waitForTurnOrAbort(previous, abortSignal);
    if (abortSignal?.aborted) {
      throw abortSignal.reason instanceof Error
        ? abortSignal.reason
        : new Error('SUBAGENT_CANCELLED: the parent turn was cancelled.');
    }
    return await task();
  } finally {
    release();
    queue.pending -= 1;
    if (queue.pending === 0 && writeRunQueues.get(key) === queue) {
      writeRunQueues.delete(key);
    }
  }
}

function resolveWriteQueueKey(workingDirectory: string): string {
  try {
    return fs.realpathSync.native(workingDirectory);
  } catch {
    return path.resolve(workingDirectory);
  }
}

export function createClaudeSubagentMcpServer(options: ClaudeSubagentMcpOptions) {
  const routes = [...(options.routes ?? listClaudeSubagentRoutes())];
  const routeDescription = routes.map(route =>
    `${route.providerId} | ${route.modelId} | ${route.displayName}`,
  ).join('\n');

  return createSdkMcpServer({
    name: CLAUDE_SUBAGENT_SERVER_KEY,
    version: '1.0.0',
    tools: [
      tool(
        CLAUDE_SUBAGENT_TOOL_NAME,
        [
          'Run a Sub Agent in a separate Claude Code Runtime subprocess using an explicit CodePilot provider and model. Never invent a route and never substitute another model.',
          'Blocking one-shot foreground contract: provide the complete task once. This tool returns only after the child reaches a terminal status; no background child remains running after return.',
          'Consume terminal=true plus the returned status/body immediately. Never call it merely submitted, launched, queued, still processing, or waiting for later monitoring. Do not launch placeholders, wait-only children, or attempt to resume this run.',
          'For dependent children in one plan, use one workflow_id, a unique task_key per child, and depends_on upstream task keys; emit upstream task calls before their dependents. CodePilot waits durably and injects upstream terminal results before the downstream subprocess starts.',
          'Declare required_capabilities. The child inherits the parent turn\'s Claude Code tools, MCP servers, permission mode, and approval handler; unavailable capabilities fail closed.',
          'Calls declaring write_workspace are serialized per working directory. Do not expect two writing Sub Agents to edit the same working tree concurrently.',
          'Omit logical_run_id on the first attempt. Reuse the returned logicalRunId only when retrying that same task, so physical attempts remain separately auditable under one logical capsule.',
          'CodePilot rejects logical_run_id reuse while the prior attempt is active or after it completed successfully. Wait/read the existing run, or omit the ID for genuinely new work.',
          `SDK activity renews a ${Math.round(SUBAGENT_IDLE_TIMEOUT_MS / 60_000)}-minute idle timer; a ${Math.round(SUBAGENT_HARD_TIMEOUT_MS / 60_000)}-minute hard cap still applies. Partial child text is checkpointed while the run is active.`,
          'For factual or research work, include source URLs beside claims. Do not turn unsourced upstream text into exact dates, statistics, rankings, or quotations.',
          'Catalog presence does not prove account entitlement. SDK authentication/access errors are terminal failures, never successful completion.',
          'Available routes (provider_id | model | display name):',
          routeDescription || '(none)',
        ].join('\n'),
        {
          prompt: z.string().describe('The complete task for the Sub Agent. Include only the context it needs, plus source URLs for factual claims or upstream research it must rely on.'),
          agent_name: z.string().optional().describe('Short user-facing Sub Agent name, such as Researcher or Copywriter.'),
          provider_id: z.string().describe('Exact provider_id from the available route list.'),
          model: z.string().describe('Exact model value from the available route list.'),
          logical_run_id: z.string().max(160).optional().describe('Opaque logical task id for a retry. Omit on the first attempt; reuse the logicalRunId returned by a failed attempt so the retry remains one logical task.'),
          workflow_id: z.string().max(160).optional().describe('Stable workflow id shared by all children in one dependency graph. Provide together with task_key.'),
          task_key: z.string().max(160).optional().describe('Unique task key within workflow_id, such as research, copy, or implementation.'),
          depends_on: z.array(z.string().max(160)).optional().describe('Upstream task_key values in the same workflow. CodePilot waits for their durable completed results and injects them into this child prompt.'),
          required_capabilities: z.array(z.unknown()).describe('Complete capabilities required by this task. Allowed values: read_workspace, network_search, write_workspace. Use [] for pure text reasoning. Invalid entries return a structured error instead of spawning a child.'),
        },
        async ({
          prompt,
          agent_name,
          provider_id,
          model,
          logical_run_id,
          workflow_id,
          task_key,
          depends_on,
          required_capabilities,
        }) => {
          const route = findClaudeSubagentRoute(routes, provider_id, model);
          const displayModel = route?.displayName || model;
          const displayAgent = agent_name?.trim() || `${displayModel} Sub Agent`;
          if (!route) {
            const body = `SUBAGENT_MODEL_UNAVAILABLE: Claude Code Runtime cannot route provider "${provider_id}" model "${model}". Do not continue as if this Sub Agent ran. Ask the user whether to choose an available model or switch Runtime.`;
            return {
              content: [{
                type: 'text' as const,
                text: encodeSubagentStatusResult({
                  status: 'failed',
                  agentName: displayAgent,
                  model: displayModel,
                  runtime: 'claude_code',
                  error: { code: 'MODEL_UNAVAILABLE', retryable: false },
                }, body),
              }],
              isError: true,
            };
          }

          const normalizedCapabilities = normalizeClaudeSubagentCapabilities(
            required_capabilities,
          );
          if (!normalizedCapabilities.ok) {
            return {
              content: [{
                type: 'text' as const,
                text: encodeSubagentStatusResult({
                  status: 'failed',
                  agentName: displayAgent,
                  model: route.displayName,
                  runtime: 'claude_code',
                  error: normalizedCapabilities.error,
                }, normalizedCapabilities.message),
              }],
              isError: true,
            };
          }
          const dispatchValidation = validateSubagentDispatchSpec({
            prompt,
            workflowId: workflow_id,
            taskKey: task_key,
            dependsOn: depends_on,
          });
          if (!dispatchValidation.ok) {
            return {
              content: [{
                type: 'text' as const,
                text: encodeSubagentStatusResult({
                  status: 'failed',
                  agentName: displayAgent,
                  model: route.displayName,
                  runtime: 'claude_code',
                  error: dispatchValidation.error,
                }, dispatchValidation.message),
              }],
              isError: true,
            };
          }
          const dispatchSpec = dispatchValidation.spec;
          const requiredCapabilities = normalizedCapabilities.capabilities;
          const parentToolOptions = options.getParentToolOptions?.() || {};
          const capabilityCheck = validateClaudeSubagentCapabilities(
            requiredCapabilities,
            parentToolOptions,
          );
          if (!capabilityCheck.ok) {
            const body = `CAPABILITY_UNAVAILABLE: the parent Claude Code turn does not expose the required inherited tools. Missing: ${capabilityCheck.unsupported.join(', ')}. Do not continue with stale local knowledge or pretend this task completed. Ask the user whether to enable the required tool or change Runtime.`;
            return {
              content: [{
                type: 'text' as const,
                text: encodeSubagentStatusResult({
                  status: 'failed',
                  agentName: displayAgent,
                  model: route.displayName,
                  runtime: 'claude_code',
                  error: { code: 'CAPABILITY_UNAVAILABLE', retryable: false },
                }, body),
              }],
              isError: true,
            };
          }

          const toolInput = {
            prompt,
            agent_name,
            provider_id,
            model,
            logical_run_id,
            workflow_id,
            task_key,
            depends_on,
            required_capabilities: requiredCapabilities,
          };
          const permissionAttribution: ClaudeSubagentPermissionAttribution = {
            agentRunId: options.toolUseCorrelation?.claim(toolInput)
              || `claude-subagent-${randomUUID()}`,
            childSessionId: `claude-child-${randomUUID()}`,
            agentName: displayAgent,
          };

          let startedRun: ReturnType<typeof startSubagentRun>;
          try {
            startedRun = startSubagentRun({
              id: permissionAttribution.agentRunId,
              logicalRunId: logical_run_id,
              parentSessionId: options.sessionId,
              runtime: 'claude_code',
              toolName: CLAUDE_SUBAGENT_QUALIFIED_TOOL_NAME,
              agentName: displayAgent,
              providerId: route.providerId,
              requestedModel: route.modelId,
              workflowId: dispatchSpec.workflowId,
              taskKey: dispatchSpec.taskKey,
              dependencyTaskKeys: dispatchSpec.dependencyTaskKeys,
              prompt,
            });
          } catch (persistenceError) {
            const rejection = describeSubagentRunStartRejection(persistenceError);
            const detail = persistenceError instanceof Error
              ? persistenceError.message
              : String(persistenceError);
            return {
              content: [{
                type: 'text' as const,
                text: encodeSubagentStatusResult({
                  status: 'failed',
                  taskId: permissionAttribution.agentRunId,
                  agentName: displayAgent,
                  model: route.displayName,
                  runtime: 'claude_code',
                  error: rejection?.error || { code: 'RUNTIME_ERROR', retryable: true },
                }, rejection?.message
                  || `SUBAGENT_RUN_PERSISTENCE_UNAVAILABLE: CodePilot could not create an auditable run before launch (${detail}). The child was not started.`),
              }],
              isError: true,
            };
          }
          const logicalRunId = startedRun.logical_run_id;
          const attemptNumber = startedRun.attempt_number;
          const terminalResponse = (
            status: ClaudeSubagentTerminalStatus,
            text: string,
            error?: SubagentStatusError,
            effectiveModel?: string,
            usage?: ClaudeSubagentRunOutcome['usage'],
          ) => {
            try {
              markSubagentRunSettling(permissionAttribution.agentRunId);
              const settled = settleSubagentRun(permissionAttribution.agentRunId, {
                status,
                resultText: text,
                effectiveProviderId: route.providerId,
                effectiveModel,
                error,
                usage,
              });
              const factStatus = settled?.terminal === 1
                ? settled.status as ClaudeSubagentTerminalStatus
                : status;
              const factText = settled?.terminal === 1 ? settled.result_text : text;
              const factEffectiveModel = settled?.effective_model || effectiveModel;
              return {
                content: [{
                  type: 'text' as const,
                  text: encodeSubagentStatusResult({
                    status: factStatus,
                    phase: 'terminal',
                    taskId: permissionAttribution.agentRunId,
                    logicalRunId,
                    attemptId: permissionAttribution.agentRunId,
                    attemptNumber,
                    agentName: displayAgent,
                    requestedProviderId: route.providerId,
                    requestedModel: route.modelId,
                    effectiveProviderId: settled?.effective_provider_id || route.providerId,
                    ...(factEffectiveModel ? { effectiveModel: factEffectiveModel } : {}),
                    model: factEffectiveModel || route.displayName,
                    runtime: 'claude_code',
                    error: factStatus === status ? error : undefined,
                  }, factText),
                }],
                ...(factStatus === 'completed' ? {} : { isError: true }),
              };
            } catch (persistenceError) {
              const detail = persistenceError instanceof Error
                ? persistenceError.message
                : String(persistenceError);
              return {
                content: [{
                  type: 'text' as const,
                  text: encodeSubagentStatusResult({
                    status: 'failed',
                    phase: 'settling',
                    taskId: permissionAttribution.agentRunId,
                    logicalRunId,
                    attemptId: permissionAttribution.agentRunId,
                    attemptNumber,
                    agentName: displayAgent,
                    requestedProviderId: route.providerId,
                    requestedModel: route.modelId,
                    model: effectiveModel || route.displayName,
                    runtime: 'claude_code',
                    error: { code: 'RUNTIME_ERROR', retryable: false },
                  }, `SUBAGENT_RUN_PERSISTENCE_FAILED: child reached ${status}, but CodePilot could not persist the terminal fact (${detail}). Do not claim completion or background progress.\n\n${text}`),
                }],
                isError: true,
              };
            }
          };

          const dependencyResolution = await resolveSubagentDependencies({
            runId: permissionAttribution.agentRunId,
            parentSessionId: options.sessionId,
            prompt,
            workflowId: dispatchSpec.workflowId,
            dependencyTaskKeys: dispatchSpec.dependencyTaskKeys,
            abortSignal: options.abortSignal,
          });
          if (!dependencyResolution.ok) {
            return terminalResponse(
              dependencyResolution.status,
              dependencyResolution.message,
              dependencyResolution.error,
            );
          }
          const active = activeRuns.get(options.sessionId) || 0;
          if (active >= MAX_CONCURRENT_SUBAGENTS) {
            return terminalResponse(
              'failed',
              `SUBAGENT_CONCURRENCY_LIMIT: at most ${MAX_CONCURRENT_SUBAGENTS} Sub Agents may run at once.`,
              { code: 'CONCURRENCY_LIMIT', retryable: true },
            );
          }
          activeRuns.set(options.sessionId, active + 1);
          try {
            const execute = () => runClaudeSubagent({
              route,
              prompt: dependencyResolution.prompt,
              workingDirectory: options.workingDirectory,
              abortSignal: options.abortSignal,
              idleTimeoutMs: SUBAGENT_IDLE_TIMEOUT_MS,
              hardTimeoutMs: SUBAGENT_HARD_TIMEOUT_MS,
              permissionAttribution,
              toolOptions: buildClaudeSubagentToolOptions(
                parentToolOptions,
                permissionAttribution,
              ),
            });
            const result = requiredCapabilities.includes('write_workspace')
              ? await serializeClaudeSubagentWriteRun(
                  options.workingDirectory,
                  options.abortSignal,
                  execute,
                )
              : await execute();
            return terminalResponse(
              result.status,
              result.text,
              result.error,
              result.effectiveModel,
              result.usage,
            );
          } catch (error) {
            const aborted = options.abortSignal?.aborted;
            const status = aborted ? 'cancelled' : 'failed';
            const message = error instanceof Error ? error.message : 'Unknown Sub Agent failure';
            const classified = aborted ? undefined : classifyThrownSubagentError(error);
            return terminalResponse(status, message, aborted
              ? undefined
              : classified);
          } finally {
            const remaining = (activeRuns.get(options.sessionId) || 1) - 1;
            if (remaining > 0) activeRuns.set(options.sessionId, remaining);
            else activeRuns.delete(options.sessionId);
          }
        },
      ),
    ],
  });
}

async function runClaudeSubagent(input: {
  route: ClaudeSubagentRoute;
  prompt: string;
  workingDirectory: string;
  abortSignal?: AbortSignal;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  toolOptions: ClaudeSubagentToolOptions;
  permissionAttribution: ClaudeSubagentPermissionAttribution;
}): Promise<ClaudeSubagentRunOutcome> {
  const provider = input.route.providerId === 'env'
    ? undefined
    : getProvider(input.route.providerId);
  if (input.route.providerId !== 'env' && !provider) {
    throw new Error(`SUBAGENT_MODEL_UNAVAILABLE: provider "${input.route.providerId}" no longer exists.`);
  }

  const resolved = resolveForClaudeCode(provider, {
    callScene: 'delegated_interactive',
    providerId: input.route.providerId,
    model: input.route.modelId,
    runtime: 'claude_code',
  });
  const currentRoute = findClaudeSubagentRoute(
    listClaudeSubagentRoutes(),
    input.route.providerId,
    input.route.modelId,
  );
  if (!currentRoute) {
    throw new Error(`SUBAGENT_MODEL_UNAVAILABLE: ${input.route.displayName} is no longer enabled for Claude Code Runtime.`);
  }

  const abortController = new AbortController();
  const abortChild = () => abortController.abort(input.abortSignal?.reason);
  if (input.abortSignal?.aborted) abortChild();
  else input.abortSignal?.addEventListener('abort', abortChild, { once: true });
  const activityTimeout = createClaudeSubagentActivityTimeout({
    abortController,
    idleTimeoutMs: input.idleTimeoutMs,
    hardTimeoutMs: input.hardTimeoutMs,
  });
  const setup = prepareSdkSubprocessEnv(resolved);
  let success: SDKResultSuccess | undefined;
  let failure: SDKResultError | undefined;
  let effectiveModel: string | undefined;
  let partialText = '';

  try {
    const queryOptions: Options = {
      cwd: input.workingDirectory,
      abortController,
      env: sanitizeSpawnEnv(setup.env),
      settingSources: resolved.settingSources as Options['settingSources'],
      ...input.toolOptions,
      maxTurns: 30,
      model: resolved.upstreamModel || resolved.model || input.route.modelId,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: [
          'You are a one-shot CodePilot Sub Agent running with isolated conversational context.',
          'Complete the assigned task and return a concise, self-contained result with concrete evidence.',
          'Use the tools inherited from the parent turn. Follow the inherited permission mode and request approval when the Runtime requires it.',
          'Do not spawn another agent. If a required tool is unavailable, say so explicitly instead of fabricating a result.',
          'For current or external facts, every exact date, statistic, ranking, and quotation must come from tool output or a source URL in the task. Keep source URLs attached to the claims they support; never fill missing details from training knowledge.',
          'When writing files, report only paths that a completed tool call actually created or modified. Do not claim the file task completed before the tool confirms it.',
          `Working directory: ${input.workingDirectory}`,
        ].join('\n'),
      },
    };
    applyClaudeExecutable(queryOptions);

    assertCliProviderLaunchAllowed('claude');
    const conversation = query({ prompt: input.prompt, options: queryOptions });
    for await (const message of conversation) {
      activityTimeout.markActivity();
      if (message.type === 'system' && message.subtype === 'init') {
        if (typeof message.session_id === 'string' && message.session_id.trim()) {
          input.permissionAttribution.childSessionId = message.session_id;
        }
        const reportedModel = (message as SDKSystemMessage).model;
        if (
          typeof reportedModel === 'string'
          && reportedModel.trim()
          && !claudeReportedModelMatchesRoute(reportedModel, input.route, resolved)
        ) {
          const detail = `SUBAGENT_ROUTE_MISMATCH: requested ${input.route.providerId}/${input.route.modelId}, but Claude SDK reported model "${reportedModel}". CodePilot stopped this attempt instead of silently accepting a fallback.`;
          recordSubagentRunEvent(input.permissionAttribution.agentRunId, {
            type: 'route_warning',
            activity: 'Effective model did not match the requested route',
            payload: {
              requestedProviderId: input.route.providerId,
              requestedModel: input.route.modelId,
              reportedModel,
            },
          });
          abortController.abort(detail);
          return {
            status: 'failed',
            text: detail,
            effectiveModel: reportedModel,
            error: { code: 'ROUTE_MISMATCH', retryable: false },
          };
        }
        effectiveModel = normalizeClaudeSubagentEffectiveModel(
          reportedModel,
          input.route,
          resolved,
        );
        recordSubagentRunEvent(input.permissionAttribution.agentRunId, {
          type: 'activity',
          activity: 'Claude child runtime initialized',
          payload: {
            childSessionId: input.permissionAttribution.childSessionId,
            reportedModel: reportedModel || undefined,
          },
          coalesceKey: 'runtime-init',
        });
        checkpointSubagentRun(input.permissionAttribution.agentRunId, {
          effectiveModel,
          currentActivity: 'Claude child runtime initialized',
        });
      } else if (message.type === 'assistant') {
        for (const toolName of extractClaudeAssistantToolNames(message as SDKAssistantMessage)) {
          recordSubagentRunEvent(input.permissionAttribution.agentRunId, {
            type: 'tool_started',
            activity: `Running ${toolName}`,
            toolName,
          });
        }
        const text = extractAssistantText(message as SDKAssistantMessage);
        if (text.trim()) {
          partialText = appendBoundedSubagentText(partialText, text);
          checkpointSubagentRun(input.permissionAttribution.agentRunId, {
            resultText: partialText,
            effectiveModel,
            currentActivity: 'Generating Sub-agent result',
          });
        }
      } else if (message.type === 'result') {
        if (message.subtype === 'success') success = message as SDKResultSuccess;
        else failure = message as SDKResultError;
        recordSubagentRunEvent(input.permissionAttribution.agentRunId, {
          type: 'activity',
          activity: 'Claude child returned a terminal envelope',
          coalesceKey: 'terminal-envelope',
        });
      }
    }
  } catch (error) {
    if (success) return { ...normalizeClaudeSubagentTerminalResult(success, partialText), effectiveModel };
    if (failure) return { ...normalizeClaudeSubagentTerminalResult(failure, partialText), effectiveModel };
    if (input.abortSignal?.aborted || abortController.signal.aborted) {
      return {
        ...normalizeClaudeSubagentInterruption({
          parentAborted: Boolean(input.abortSignal?.aborted),
          displayName: input.route.displayName,
          timeoutKind: activityTimeout.getTimeoutKind(),
          timeoutMs: activityTimeout.getTimeoutKind() === 'hard'
            ? input.hardTimeoutMs
            : input.idleTimeoutMs,
          partialText,
        }),
        effectiveModel,
      };
    }
    return {
      status: 'failed',
      text: error instanceof Error ? error.message : 'Unknown Sub Agent failure',
      effectiveModel,
      error: classifyThrownSubagentError(error),
    };
  } finally {
    activityTimeout.clear();
    input.abortSignal?.removeEventListener('abort', abortChild);
    setup.shadow.cleanup();
  }

  if (success) return { ...normalizeClaudeSubagentTerminalResult(success, partialText), effectiveModel };
  if (failure) return { ...normalizeClaudeSubagentTerminalResult(failure, partialText), effectiveModel };
  if (abortController.signal.aborted) {
    return {
      ...normalizeClaudeSubagentInterruption({
        parentAborted: Boolean(input.abortSignal?.aborted),
        displayName: input.route.displayName,
        timeoutKind: activityTimeout.getTimeoutKind(),
        timeoutMs: activityTimeout.getTimeoutKind() === 'hard'
          ? input.hardTimeoutMs
          : input.idleTimeoutMs,
        partialText,
      }),
      effectiveModel,
    };
  }
  return {
    status: 'failed',
    text: 'SUBAGENT_EMPTY_RESULT: the Sub Agent returned no terminal result.',
    effectiveModel,
    error: { code: 'EMPTY_RESULT', retryable: true },
  };
}

function waitForTurnOrAbort(
  turn: Promise<unknown>,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (!abortSignal) return turn.then(() => undefined);
  if (abortSignal.aborted) {
    return Promise.reject(
      abortSignal.reason instanceof Error
        ? abortSignal.reason
        : new Error('SUBAGENT_CANCELLED: the parent turn was cancelled.'),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(
      abortSignal.reason instanceof Error
        ? abortSignal.reason
        : new Error('SUBAGENT_CANCELLED: the parent turn was cancelled.'),
    );
    abortSignal.addEventListener('abort', onAbort, { once: true });
    turn.then(
      () => {
        abortSignal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error) => {
        abortSignal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Normalize the Claude SDK terminal contract before it reaches the parent
 * agent or UI. In particular, SDKResultSuccess means the stream protocol
 * completed; `is_error` still decides whether the child task succeeded.
 */
export function normalizeClaudeSubagentTerminalResult(
  result: SDKResultSuccess | SDKResultError,
  partialText = '',
): Omit<ClaudeSubagentRunOutcome, 'effectiveModel'> {
  const usage = {
    ...(typeof result.num_turns === 'number' ? { requests: result.num_turns } : {}),
    ...(typeof result.usage?.input_tokens === 'number'
      ? { inputTokens: result.usage.input_tokens }
      : {}),
    ...(typeof result.usage?.output_tokens === 'number'
      ? { outputTokens: result.usage.output_tokens }
      : {}),
    ...(typeof result.total_cost_usd === 'number' ? { costUsd: result.total_cost_usd } : {}),
  };
  const usageField = Object.keys(usage).length > 0 ? { usage } : {};
  if (result.subtype === 'success') {
    if (result.is_error) {
      const error = classifyApiErrorStatus(result.api_error_status);
      const providerDetail = result.result?.trim()
        || `${error.code}: Claude SDK reported an unsuccessful provider call.`;
      const detail = `${providerDetail}\n\nDo not continue dependent work or silently substitute another model. Report this failure and ask the user whether to retry, choose another available route, or change Runtime.`;
      return { status: 'failed', text: detail, error, ...usageField };
    }
    if (!result.result?.trim()) {
      return {
        status: 'failed',
        text: 'SUBAGENT_EMPTY_RESULT: Claude SDK reported success without a result.',
        error: { code: 'EMPTY_RESULT', retryable: true },
        ...usageField,
      };
    }
    return { status: 'completed', text: result.result, ...usageField };
  }

  const terminalText = partialText.trim()
    || result.errors?.join('; ')
    || result.stop_reason
    || 'Sub Agent did not complete.';
  if (result.subtype === 'error_max_turns') {
    return {
      status: 'partial',
      text: terminalText,
      error: { code: 'MAX_TURNS', retryable: false },
      ...usageField,
    };
  }
  if (result.subtype === 'error_max_budget_usd') {
    return {
      status: 'failed',
      text: terminalText,
      error: { code: 'MAX_BUDGET', retryable: false },
      ...usageField,
    };
  }
  return {
    status: 'failed',
    text: terminalText,
    error: { code: 'RUNTIME_ERROR', retryable: false },
    ...usageField,
  };
}

export function normalizeClaudeSubagentInterruption(input: {
  parentAborted: boolean;
  displayName: string;
  timeoutMs: number;
  timeoutKind?: ClaudeSubagentTimeoutKind;
  partialText?: string;
}): Omit<ClaudeSubagentRunOutcome, 'effectiveModel'> {
  if (input.parentAborted) {
    return {
      status: 'cancelled',
      text: appendInterruptionNotice(
        input.partialText,
        'SUBAGENT_CANCELLED: the parent turn was cancelled.',
      ),
    };
  }
  const timeoutLabel = input.timeoutKind === 'hard' ? 'hard runtime limit' : 'idle limit';
  return {
    status: 'timed_out',
    text: appendInterruptionNotice(
      input.partialText,
      `SUBAGENT_TIMED_OUT: ${input.displayName} reached the ${Math.round(input.timeoutMs / 1000)}-second ${timeoutLabel}.`,
    ),
    error: { code: 'TIMEOUT', retryable: true },
  };
}

export function createClaudeSubagentActivityTimeout(input: {
  abortController: AbortController;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
}): {
  markActivity: () => void;
  clear: () => void;
  getTimeoutKind: () => ClaudeSubagentTimeoutKind | undefined;
} {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutKind: ClaudeSubagentTimeoutKind | undefined;
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const clear = () => {
    clearIdle();
    if (hardTimer) clearTimeout(hardTimer);
    hardTimer = undefined;
  };
  const abortFor = (kind: ClaudeSubagentTimeoutKind) => {
    if (input.abortController.signal.aborted) return;
    timeoutKind = kind;
    clear();
    input.abortController.abort(
      kind === 'idle' ? 'SUBAGENT_IDLE_TIMED_OUT' : 'SUBAGENT_HARD_TIMED_OUT',
    );
  };
  const scheduleIdle = () => {
    clearIdle();
    idleTimer = setTimeout(
      () => abortFor('idle'),
      Math.max(1, input.idleTimeoutMs),
    );
  };
  if (!input.abortController.signal.aborted) {
    scheduleIdle();
    hardTimer = setTimeout(
      () => abortFor('hard'),
      Math.max(1, input.hardTimeoutMs),
    );
  }
  return {
    markActivity: () => {
      if (!timeoutKind && !input.abortController.signal.aborted) scheduleIdle();
    },
    clear,
    getTimeoutKind: () => timeoutKind,
  };
}

function classifyApiErrorStatus(status: number | null | undefined): SubagentStatusError {
  if (status === 401 || status === 403) {
    return { code: 'AUTH_FORBIDDEN', httpStatus: status, retryable: false };
  }
  if (status === 429) {
    return { code: 'RATE_LIMITED', httpStatus: status, retryable: true };
  }
  return {
    code: 'RUNTIME_ERROR',
    ...(typeof status === 'number' ? { httpStatus: status } : {}),
    retryable: typeof status === 'number' && status >= 500,
  };
}

function classifyThrownSubagentError(error: unknown): SubagentStatusError {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/SUBAGENT_MODEL_UNAVAILABLE|model (?:is )?(?:unavailable|not found|denied)/i.test(message)) {
    return { code: 'MODEL_UNAVAILABLE', retryable: false };
  }
  if (/\b(?:401|403)\b|authentication|unauthori[sz]ed|access denied|forbidden/i.test(message)) {
    return { code: 'AUTH_FORBIDDEN', retryable: false };
  }
  if (/\b429\b|rate.?limit/i.test(message)) {
    return { code: 'RATE_LIMITED', retryable: true };
  }
  return { code: 'RUNTIME_ERROR', retryable: false };
}

function extractAssistantText(message: SDKAssistantMessage): string {
  return message.message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('');
}

function extractClaudeAssistantToolNames(message: SDKAssistantMessage): string[] {
  return message.message.content
    .filter((block): block is Extract<typeof block, { type: 'tool_use' }> => block.type === 'tool_use')
    .map(block => block.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

function appendBoundedSubagentText(current: string, next: string): string {
  const combined = current.trim()
    ? `${current.trimEnd()}\n\n${next.trim()}`
    : next.trim();
  if (combined.length <= MAX_SUBAGENT_CHECKPOINT_CHARS) return combined;
  const prefix = '[Earlier Sub Agent output truncated from running checkpoint]\n';
  return `${prefix}${combined.slice(-(MAX_SUBAGENT_CHECKPOINT_CHARS - prefix.length))}`;
}

function appendInterruptionNotice(partialText: string | undefined, notice: string): string {
  const partial = partialText?.trim();
  return partial ? `${partial}\n\n${notice}` : notice;
}

/**
 * Claude-compatible providers commonly expose an Anthropic protocol slot such
 * as `sonnet` while routing it to Kimi / GLM / another concrete model. Treat a
 * reported value as that verified route only when it matches the selected
 * resolver identities. A genuinely different SDK-reported model remains
 * visible so an upstream fallback cannot be disguised.
 */
export function normalizeClaudeSubagentEffectiveModel(
  reportedModel: string | undefined,
  route: ClaudeSubagentRoute,
  resolved: Pick<ResolvedProvider, 'model' | 'upstreamModel'>,
): string | undefined {
  const reported = reportedModel?.trim();
  if (!reported) return undefined;
  const selectedIdentities = new Set([
    route.modelId,
    route.upstreamModelId,
    resolved.model,
    resolved.upstreamModel,
  ].filter((value): value is string => Boolean(value)));
  return selectedIdentities.has(reported) ? route.displayName : reported;
}

export function claudeReportedModelMatchesRoute(
  reportedModel: string | undefined,
  route: ClaudeSubagentRoute,
  resolved: Pick<ResolvedProvider, 'model' | 'upstreamModel'>,
): boolean {
  const reported = reportedModel?.trim();
  if (!reported) return true;
  return new Set([
    route.modelId,
    route.upstreamModelId,
    route.displayName,
    resolved.model,
    resolved.upstreamModel,
  ].filter((value): value is string => Boolean(value))).has(reported);
}

function deduplicateRoutes(routes: ClaudeSubagentRoute[]): ClaudeSubagentRoute[] {
  const seen = new Set<string>();
  return routes.filter(route => {
    const key = `${route.providerId}\u0000${route.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeSpawnEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, value]) => [key, value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')]),
  );
}

function applyClaudeExecutable(options: Options): void {
  const claudePath = findClaudeBinary();
  if (!claudePath) return;
  const ext = path.extname(claudePath).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') {
    options.pathToClaudeCodeExecutable = claudePath;
    return;
  }
  const scriptPath = resolveScriptFromCmd(claudePath);
  if (scriptPath) options.pathToClaudeCodeExecutable = scriptPath;
}

function resolveScriptFromCmd(cmdPath: string): string | undefined {
  try {
    const content = fs.readFileSync(cmdPath, 'utf-8');
    const cmdDir = path.dirname(cmdPath);
    const patterns = [
      /"%~dp0\\([^"]*claude[^"]*\.js)"/i,
      /%~dp0\\(\S*claude\S*\.js)/i,
      /"%dp0%\\([^"]*claude[^"]*\.js)"/i,
    ];
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (!match?.[1]) continue;
      const resolved = path.normalize(path.join(cmdDir, match[1]));
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch {
    // Let the SDK's own executable resolution report the failure.
  }
  return undefined;
}
