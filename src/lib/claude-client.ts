import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKPartialAssistantMessage,
  SDKSystemMessage,
  SDKToolProgressMessage,
  Options,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import type { SdkModelUsage } from './sdk-model-usage';
import type { ClaudeStreamOptions, SSEEvent, TokenUsage, MCPServerConfig, PermissionRequestEvent, FileAttachment, MediaBlock } from '@/types';
import { isImageFile } from '@/types';
import { pickModelUsage } from './sdk-model-usage';
import { registerPendingPermission, buildPermissionResolvedEvent } from './permission-registry';
import { registerConversation, unregisterConversation } from './conversation-registry';
import { captureCapabilities, isCacheFresh, setCachedPlugins } from './agent-sdk-capabilities';
import { normalizeMessageContent, microCompactMessage } from './message-normalizer';
import { roughTokenEstimate } from './context-estimator';
import { getSetting, updateSdkSessionId, createPermissionRequest, isLockOwner } from './db';
import { issueApprovalToken } from './permission-approval-token';
import { resolveForClaudeCode, resolveEffectiveAnthropicBaseUrl, type ResolvedProvider } from './provider-resolver';
import { isFirstPartyAnthropicEndpoint } from './ai-provider';
import { sanitizeClaudeModelOptions } from './claude-model-options';
import { buildSamplingIgnoredNotice } from './anthropic-sampling-notice';
import { findClaudeBinary, invalidateClaudePathCache } from './platform';
import { notifyPermissionRequest, notifyGeneric } from './telegram-bot';
import { classifyError, formatClassifiedError, isSessionStateResultError } from './error-classifier';
import { resolveWorkingDirectory } from './working-directory';
import { wrapController } from './safe-stream';
import { type ShadowHome } from './claude-home-shadow';
import { prepareSdkSubprocessEnv } from './sdk-subprocess-env';
// Static imports for resolveRuntime/detectTransport — used to be lazy
// `require('./runtime')` / `require('./provider-transport')`, but Turbopack's
// CJS↔ESM interop returns `{ default: ... }` shape that broke destructuring
// at runtime ("resolveRuntime is not a function" etc).
//
// IMPORTANT: import from `./runtime/registry` NOT from `./runtime` (== index).
// runtime/index.ts imports native-runtime AND sdk-runtime at top-level and
// registers them. sdk-runtime in turn imports FROM this file (claude-client).
// Importing `./runtime` here closes the cycle
// claude-client → runtime/index → sdk-runtime → claude-client
// and during evaluation of sdk-runtime's `export const sdkRuntime = {...}`,
// runtime/index's own `registerRuntime(sdkRuntime)` line hits the TDZ and
// throws "Cannot access 'sdkRuntime' before initialization" (caught by
// sdk-availability.test.ts under certain module load orders).
// registry.ts only imports types/db/claude-settings — no cycle. The actual
// runtime registration still happens elsewhere (runtime/index is imported
// via its own entry points at app startup).
// Import directly from registry — DO NOT switch this to the barrel
// (`./runtime`). sdk-runtime.ts imports `streamClaudeSdk` from this
// file; if claude-client also imports the barrel, the chain becomes
// runtime/index.ts → sdk-runtime.ts → claude-client.ts → runtime/index.ts
// (circular), and sdk-runtime is still mid-init when registerRuntime
// reads it, surfacing as "Cannot access 'sdkRuntime' before initialization".
// Safe because every caller of claude-client (chat route, bridge) imports
// the barrel themselves, so the registry is already populated by the time
// resolveRuntime() fires here.
import { resolveRuntime, getRuntime } from './runtime/registry';
import {
  buildClaudePermissionQueryOptions,
  decideHostToolPermission,
  resolveRuntimeAutoReview,
} from './permission/profile';
import {
  buildReviewEvent,
  buildSdkReviewerDenial,
  type PermissionReviewEvent,
} from './permission/review-event';
import { emitReviewEvent } from './permission/review-audit';
import { probeExternalMcp } from './permission/external-mcp';
import { detectTransport, isNativeCompatible } from './provider-transport';
import { assertProviderCallAllowed, type ProviderCallScene } from './provider-call-policy';
import os from 'os';
import fs from 'fs';
import path from 'path';

/**
 * Sanitize a string for use as an environment variable value.
 * Removes null bytes and control characters that cause spawn EINVAL.
 */
function sanitizeEnvValue(value: string): string {
   
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Sanitize all values in an env record so child_process.spawn won't
 * throw EINVAL due to invalid characters or non-string values.
 * On Windows, spawn is strict: every env value MUST be a string.
 * Spreading process.env can include undefined values which cause EINVAL.
 */
function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      clean[key] = sanitizeEnvValue(value);
    }
  }
  return clean;
}

/**
 * On Windows, npm installs CLI tools as .cmd wrappers that can't be
 * spawned without shell:true. Parse the wrapper to extract the real
 * .js script path so we can pass it to the SDK directly.
 */
function resolveScriptFromCmd(cmdPath: string): string | undefined {
  try {
    const content = fs.readFileSync(cmdPath, 'utf-8');
    const cmdDir = path.dirname(cmdPath);

    // npm .cmd wrappers typically contain a line like:
    //   "%~dp0\node_modules\@anthropic-ai\claude-code\cli.js" %*
    // Match paths containing claude-code or claude-agent and ending in .js
    const patterns = [
      // Quoted: "%~dp0\...\cli.js"
      /"%~dp0\\([^"]*claude[^"]*\.js)"/i,
      // Unquoted: %~dp0\...\cli.js
      /%~dp0\\(\S*claude\S*\.js)/i,
      // Quoted with %dp0%: "%dp0%\...\cli.js"
      /"%dp0%\\([^"]*claude[^"]*\.js)"/i,
    ];

    for (const re of patterns) {
      const m = content.match(re);
      if (m) {
        const resolved = path.normalize(path.join(cmdDir, m[1]));
        if (fs.existsSync(resolved)) return resolved;
      }
    }
  } catch {
    // ignore read errors
  }
  return undefined;
}

let cachedClaudePath: string | null | undefined;

function findClaudePath(): string | undefined {
  if (cachedClaudePath !== undefined) return cachedClaudePath || undefined;
  const found = findClaudeBinary();
  cachedClaudePath = found ?? null;
  return found;
}

/**
 * Invalidate the cached Claude binary path in this module AND in platform.ts.
 * Must be called after installation so the next SDK call picks up the new binary.
 */
export function invalidateClaudeClientCache(): void {
  cachedClaudePath = undefined; // reset to "not yet looked up"
  invalidateClaudePathCache();  // also reset the 60s TTL cache in platform.ts
}

/**
 * Convert our MCPServerConfig to the SDK's McpServerConfig format.
 * Supports stdio, sse, and http transport types.
 */
function toSdkMcpConfig(
  servers: Record<string, MCPServerConfig>
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    const transport = config.type || 'stdio';

    switch (transport) {
      case 'sse': {
        if (!config.url) {
          console.warn(`[mcp] SSE server "${name}" is missing url, skipping`);
          continue;
        }
        const sseConfig: McpSSEServerConfig = {
          type: 'sse',
          url: config.url,
        };
        if (config.headers && Object.keys(config.headers).length > 0) {
          sseConfig.headers = config.headers;
        }
        result[name] = sseConfig;
        break;
      }

      case 'http': {
        if (!config.url) {
          console.warn(`[mcp] HTTP server "${name}" is missing url, skipping`);
          continue;
        }
        const httpConfig: McpHttpServerConfig = {
          type: 'http',
          url: config.url,
        };
        if (config.headers && Object.keys(config.headers).length > 0) {
          httpConfig.headers = config.headers;
        }
        result[name] = httpConfig;
        break;
      }

      case 'stdio':
      default: {
        if (!config.command) {
          console.warn(`[mcp] stdio server "${name}" is missing command, skipping`);
          continue;
        }
        const stdioConfig: McpStdioServerConfig = {
          command: config.command,
          args: config.args,
          env: config.env,
        };
        result[name] = stdioConfig;
        break;
      }
    }
  }
  return result;
}

/**
 * Format an SSE line from an event object
 */
function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Session ownership — owner-gated clear of `sdk_session_id`.
 *
 * The resume/crash/PTL-retry paths below clear `sdk_session_id` (`''`) so the
 * next turn starts fresh. But that is a session-level write: if THIS turn was
 * superseded (its session lock taken over by a newer send), clearing here would
 * wipe the NEW owner's freshly-persisted session id and break its resume (I1).
 *
 * Only gate when a `lockId` was threaded through (subtask A plumbs
 * `options.lockId`). Legacy callers that omit it keep the prior unconditional-
 * clear behavior — `lockId === undefined` ⇒ no gate. `successLog`, when given,
 * is emitted only on an actual clear (preserves the crash-path log).
 */
function clearSdkSessionIfOwner(
  sessionId: string,
  lockId: string | undefined,
  successLog?: string,
): void {
  if (lockId !== undefined && !isLockOwner(sessionId, lockId)) {
    console.warn(`[claude-client] stale owner (lockId superseded), skipping updateSdkSessionId('') for session ${sessionId}`);
    return;
  }
  try {
    updateSdkSessionId(sessionId, '');
    if (successLog) console.warn(successLog);
  } catch { /* best effort */ }
}

/**
 * Extract text content from an SDK assistant message
 */
function extractTextFromMessage(msg: SDKAssistantMessage): string {
  const parts: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

/**
 * Extract token usage from an SDK result message.
 *
 * `modelHints` lets the caller forward what the request was *for*
 * (alias + resolved upstream id) so `pickModelUsage` can find the
 * right entry in `msg.modelUsage`. Optional — when absent we still
 * pull contextWindow if there's only one entry, which covers the
 * most common third-party-proxy shape.
 */
function extractTokenUsage(
  msg: SDKResultMessage,
  modelHints: { requested?: string; upstream?: string; trustContextWindow?: boolean } = {},
): TokenUsage | null {
  if (!msg.usage) return null;
  const base: TokenUsage = {
    input_tokens: msg.usage.input_tokens,
    output_tokens: msg.usage.output_tokens,
    cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
    cost_usd: 'total_cost_usd' in msg ? msg.total_cost_usd : undefined,
  };
  // Pull contextWindow / maxOutputTokens straight from the SDK when available.
  // NOTE (#632): contextWindow is only PERSISTED for a first-party Anthropic
  // endpoint (see the trustWindow gate below). For GLM / Bailian / MiniMax /
  // Kimi / Volcengine and other third-party Anthropic-compatible proxies the
  // SDK reports a generic ~200K default, so we leave context_window absent and
  // RunCockpit shows used-tokens only (no fabricated %). maxOutputTokens /
  // usage_model_id are unaffected. The lookup stays permissive (try requested
  // key, upstream key, single-entry, first-with-window); missing modelUsage is
  // not an error — useContextUsage then falls back to the untrusted catalog.
  const modelUsage = (msg as { modelUsage?: Record<string, SdkModelUsage> }).modelUsage;
  const picked = pickModelUsage(modelUsage, modelHints);
  if (picked) {
    const [key, usage] = picked;
    // v0.56.x #632: `modelUsage.contextWindow` is the SDK's bundled-catalog
    // value, NOT the provider's API. Reliable for first-party Anthropic; for a
    // third-party Anthropic-compatible proxy (custom base_url, e.g. GLM) it's a
    // generic default (~200000) that misrepresents the real window. Only persist
    // it when the caller vouches the endpoint is first-party — otherwise leave
    // context_window absent so useContextUsage treats the window as untrusted
    // (catalog fallback) and shows used-tokens only, no fabricated percentage.
    const trustWindow = modelHints.trustContextWindow !== false;
    if (trustWindow && usage.contextWindow > 0) base.context_window = usage.contextWindow;
    if (usage.maxOutputTokens > 0) base.max_output_tokens = usage.maxOutputTokens;
    base.usage_model_id = key;
  }
  return base;
}

/**
 * Stream Claude responses using the Agent SDK.
 * Returns a ReadableStream of SSE-formatted strings.
 */
/**
 * Get file paths for non-image attachments. If the file already has a
 * persisted filePath (written by the uploads route), reuse it. Otherwise
 * fall back to writing the file to .codepilot-uploads/.
 */
function getUploadedFilePaths(files: FileAttachment[], workDir: string): string[] {
  const paths: string[] = [];
  let uploadDir: string | undefined;
  for (const file of files) {
    if (file.filePath) {
      paths.push(file.filePath);
    } else {
      // Fallback: write file to disk (should not happen in normal flow)
      if (!uploadDir) {
        uploadDir = path.join(workDir, '.codepilot-uploads');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
      }
      const safeName = path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
      const buffer = Buffer.from(file.data, 'base64');
      fs.writeFileSync(filePath, buffer);
      paths.push(filePath);
    }
  }
  return paths;
}

// Message normalization is in message-normalizer.ts (shared with context-compressor.ts).
// Imported dynamically in buildFallbackContext to avoid circular deps at module level.

/**
 * Build fallback context from conversation history with token-budget awareness.
 *
 * Instead of a fixed message count, walks backward from the newest message
 * and includes as many as fit within the token budget. Optionally prepends
 * a session summary as a context skeleton for the full conversation.
 */
function buildFallbackContext(params: {
  prompt: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  sessionSummary?: string;
  tokenBudget?: number;
}): string {
  const { prompt, history, sessionSummary, tokenBudget } = params;
  if (!history || history.length === 0) {
    if (sessionSummary) {
      return `<session-summary>\n${sessionSummary}\n</session-summary>\n\n${prompt}`;
    }
    return prompt;
  }

  // Normalize + microcompact: strip metadata, summarize tool blocks, truncate old messages
  const normalized = history.map((msg, i) => ({
    role: msg.role,
    content: microCompactMessage(
      msg.role,
      normalizeMessageContent(msg.role, msg.content),
      history.length - 1 - i, // ageFromEnd: 0 = newest
    ),
  }));

  // Select messages within token budget (walk backward from newest).
  // Floor at 10K tokens so even extreme sessions keep some recent context.
  const effectiveBudget = tokenBudget != null ? Math.max(tokenBudget, 10000) : undefined;
  let selected: typeof normalized;
  if (effectiveBudget) {
    selected = [];
    let accumulated = 0;
    for (let i = normalized.length - 1; i >= 0; i--) {
      const msgTokens = roughTokenEstimate(normalized[i].content) + 10; // role label overhead
      if (accumulated + msgTokens > effectiveBudget) break;
      selected.unshift(normalized[i]);
      accumulated += msgTokens;
    }
  } else {
    selected = normalized;
  }

  // Build the output
  const lines: string[] = [];

  if (sessionSummary) {
    lines.push('<session-summary>');
    lines.push(sessionSummary);
    lines.push('</session-summary>');
    lines.push('');
  }

  lines.push('<conversation_history>');
  lines.push('(This is a summary of earlier conversation turns for context. <prior-tool-call .../> and <prior-reasoning>...</prior-reasoning> are metadata markers describing what already happened — they are NOT assistant output format. Do not reproduce these tags. To call a tool, emit a real tool_use block; do not write tool calls as prose or as these markers.)');
  for (const msg of selected) {
    lines.push(`${msg.role === 'user' ? 'Human' : 'Assistant'}: ${msg.content}`);
  }
  lines.push('</conversation_history>');
  lines.push('');
  lines.push(prompt);
  return lines.join('\n');
}

export interface GenerateTextViaSdkParams {
  callScene: ProviderCallScene;
  providerId?: string;
  /** Provider snapshot captured by a fail-closed upstream caller. When set,
   *  this is the authority for the wire configuration and no resolver runs. */
  resolvedProvider?: ResolvedProvider;
  model?: string;
  system: string;
  prompt: string;
  abortSignal?: AbortSignal;
  /**
   * Strip this subprocess down to pure text-in / text-out.
   *
   * Set by callers that carry the user's own words into an auxiliary call and
   * must therefore be provably incapable of touching anything else — currently
   * only title generation. See `buildGenerateTextQueryOptions` for exactly what
   * it turns off and why each piece is needed.
   *
   * Omitted = unchanged legacy behavior for the dashboard / cli-tools /
   * context-compressor callers, which DO want the normal Claude Code surface.
   */
  isolate?: boolean;
  /**
   * Best-effort cap on the subprocess's output length. The SDK exposes no
   * per-request `max_tokens`, so this rides the CLI's
   * `CLAUDE_CODE_MAX_OUTPUT_TOKENS` env var — see the honesty note in
   * `buildGenerateTextQueryOptions`.
   */
  maxOutputTokens?: number;
  /**
   * Reasoning policy for an isolated auxiliary call. Isolation removes tools,
   * settings and project context; it does not imply every provider is capable
   * of disabling thinking. Omitted keeps the original low-cost behavior.
   */
  reasoningPolicy?: 'disabled' | 'provider-managed';
  /** Override the 60s auto-abort. */
  timeoutMs?: number;
}

/**
 * Build the SDK `Options` for `generateTextViaSdk`. Extracted and exported so
 * the isolation contract can be asserted on the ACTUAL wire object a test can
 * hold, rather than inferred from the call site. The previous version set
 * `allowedTools: []`, which only auto-approves an empty
 * set — it does not remove a single built-in tool).
 *
 * With `isolate`, the subprocess is stripped on five independent axes:
 *
 *  - `tools: []` — the only option that actually DISABLES built-in tools
 *    (`allowedTools` is a permission allowlist, not an availability filter).
 *  - `settingSources: []` — the resolver's normal `['user']` loads the user's
 *    MCP servers, plugins, skills, hooks and CLAUDE.md. A title call must carry
 *    none of them, so the whole layer is dropped rather than filtered.
 *  - `mcpServers: {}` — explicit belt-and-braces now that no setting source can
 *    contribute any.
 *  - permissions returned to defaults — with zero tools there is nothing to
 *    permit, so `bypassPermissions` / `allowDangerouslySkipPermissions` would be
 *    an untrue claim about this subprocess rather than a working convenience.
 *  - a STRING `systemPrompt`, which REPLACES the Claude Code preset instead of
 *    appending to it, so no memory or project instructions ride along.
 *
 * HONESTY NOTE on output length: the SDK has no `max_tokens`. We set
 * `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (best-effort, CLI-honored) and `maxTurns: 1`,
 * but the hard guarantee that a long answer cannot reach the user lives
 * downstream in `sanitizeGeneratedTitle`, which caps at 50 graphemes on one
 * line. We do not claim a wire-level 12-20 token cap on this path.
 */
export function buildGenerateTextQueryOptions(
  params: GenerateTextViaSdkParams,
  resolved: ResolvedProvider,
  sdkEnv: Record<string, string>,
  abortController: AbortController,
): Options {
  const queryOptions: Options = {
    cwd: os.homedir(),
    abortController,
    env: sanitizeEnv(sdkEnv),
    settingSources: resolved.settingSources as Options['settingSources'],
    systemPrompt: params.system,
    maxTurns: 1,
  };

  if (params.isolate) {
    queryOptions.tools = [];
    queryOptions.allowedTools = [];
    queryOptions.mcpServers = {};
    queryOptions.settingSources = [];
  } else {
    queryOptions.permissionMode = 'bypassPermissions';
    queryOptions.allowDangerouslySkipPermissions = true;
  }

  if (params.model) {
    queryOptions.model = params.model;
  }

  return queryOptions;
}

export interface PreparedGenerateTextViaSdkCall {
  resolved: ResolvedProvider;
  queryOptions: Options;
  cleanup: () => void;
}

/**
 * Apply only the auxiliary-call budget knobs to an SDK subprocess env.
 * Exported so the provider-managed-thinking exception is asserted on the
 * actual child-process environment rather than trusted from a call-site flag.
 */
export function buildGenerateTextSdkEnv(
  params: GenerateTextViaSdkParams,
  sdkEnv: Record<string, string>,
): Record<string, string> {
  let next = sdkEnv;
  if (params.isolate) {
    if (params.reasoningPolicy === 'provider-managed') {
      // prepareSdkSubprocessEnv starts from process.env. Merely declining to
      // add this variable is not enough: an inherited app/shell override would
      // still be translated by the SDK into `thinking: disabled`, which an
      // always-thinking endpoint cannot honor.
      const { MAX_THINKING_TOKENS: _inheritedThinkingOverride, ...providerManagedEnv } = next;
      next = providerManagedEnv;
    } else {
      next = { ...next, MAX_THINKING_TOKENS: '0' };
    }
  }
  if (params.maxOutputTokens) {
    next = { ...next, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(params.maxOutputTokens) };
  }
  return next;
}

/**
 * Build the provider-owned SDK wire configuration used by generateTextViaSdk.
 *
 * A caller that already performed fail-closed resolution may supply
 * `resolvedProvider`. In that mode this function deliberately does not consult
 * the provider DB again: deletion between title eligibility and wire creation
 * must not retarget the user's text to their current default provider.
 */
export function prepareGenerateTextViaSdkCall(
  params: GenerateTextViaSdkParams,
  abortController: AbortController,
): PreparedGenerateTextViaSdkCall {
  const resolved = params.resolvedProvider ?? resolveForClaudeCode(undefined, {
    callScene: params.callScene,
    providerId: params.providerId,
  });
  assertProviderCallAllowed(resolved.provider, params.callScene);

  // Same provider-owned auth isolation as the main streaming path: when an
  // explicit DB provider is selected, this auxiliary call must NOT pick up
  // cc-switch credentials from ~/.claude/settings.json or ~/.claude.json.
  // See src/lib/sdk-subprocess-env.ts.
  const setup = prepareSdkSubprocessEnv(resolved);
  const sdkEnv = buildGenerateTextSdkEnv(params, setup.env);

  return {
    resolved,
    queryOptions: buildGenerateTextQueryOptions(params, resolved, sdkEnv, abortController),
    cleanup: () => setup.shadow.cleanup(),
  };
}

/**
 * Lightweight text generation via the Claude Code SDK subprocess.
 * Uses the same provider/env resolution as streamClaude but without sessions,
 * MCP, permissions, or conversation history. Suitable for simple tasks like
 * generating tool descriptions.
 */
export async function generateTextViaSdk(params: GenerateTextViaSdkParams): Promise<string> {
  const abortController = new AbortController();
  if (params.abortSignal) {
    params.abortSignal.addEventListener('abort', () => abortController.abort());
  }

  const prepared = prepareGenerateTextViaSdkCall(params, abortController);

  // Auto-timeout to prevent indefinite hangs (60s unless the caller is stricter)
  const timeoutMs = params.timeoutMs ?? 60_000;
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  const queryOptions = prepared.queryOptions;
  let resultText = '';
  try {
    const claudePath = findClaudePath();
    if (claudePath) {
      const ext = path.extname(claudePath).toLowerCase();
      if (ext === '.cmd' || ext === '.bat') {
        const scriptPath = resolveScriptFromCmd(claudePath);
        if (scriptPath) queryOptions.pathToClaudeCodeExecutable = scriptPath;
      } else {
        queryOptions.pathToClaudeCodeExecutable = claudePath;
      }
    }

    const conversation = query({
      prompt: params.prompt,
      options: queryOptions,
    });

    // Iterate through all messages; the last one with type 'result' has the answer
    for await (const msg of conversation) {
      if (msg.type === 'result' && 'result' in msg) {
        resultText = (msg as SDKResultSuccess).result || '';
      }
    }
  } catch (err) {
    if (abortController.signal.aborted && !(params.abortSignal?.aborted)) {
      throw new Error(`SDK query timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    prepared.cleanup();
  }

  if (!resultText) {
    throw new Error('SDK query returned no result');
  }

  return resultText;
}

/**
 * Main entry point for streaming chat. Dispatches to the resolved AgentRuntime.
 *
 * All callers (chat route, bridge, onboarding) call this function.
 * It converts ClaudeStreamOptions → RuntimeStreamOptions, resolves
 * the appropriate runtime, and delegates.
 */
export function streamClaude(options: ClaudeStreamOptions): ReadableStream<string> {
  // ── Capability-aware routing ────────────────────────────────
  // Route to the right runtime based on provider + user setting.
  const cliDisabled = getSetting('cli_enabled') === 'false';
  const effectiveProvider = options.providerId || options.sessionProviderId || '';
  let runtime;

  // Non-Anthropic providers (OpenAI OAuth, etc.) historically went to
  // Native Runtime because Claude Code SDK only supports Anthropic
  // models. Phase 5b makes that branch CONDITIONAL on the runtime pin
  // / global default: when the user has explicitly selected Codex
  // Runtime, openai-oauth must route to Codex Runtime so the proxy
  // can handle it (Codex's wire format = OpenAI Responses-API, which
  // is exactly what openai-oauth speaks). Forcing Native here is the
  // pre-fix bug that returned `Session is pinned to codex_runtime
  // but resolver returned "native"`.
  const isNonAnthropicProvider = effectiveProvider === 'openai-oauth' || effectiveProvider === 'xai-oauth';

  // Phase 5 review round 5 (2026-05-13) — Codex Account models flow
  // ONLY through Codex Runtime's app-server. ClaudeCode SDK / Native
  // can't speak Codex's wire format. Fail-closed if codex_runtime
  // isn't registered (codex binary missing): downstream chat send
  // path will surface a clean "Codex not available" error instead
  // of falling through to ClaudeCode SDK with an unknown model.
  const isCodexAccountProvider = effectiveProvider === 'codex_account';

  // Phase 5b smoke follow-up (2026-05-15) — resolve the effective
  // Codex Runtime intent BEFORE the provider-shape branches so a
  // Codex pin (session pin or global default) wins over the legacy
  // openai-oauth → Native heuristic. Order is intentional:
  // 1. session pin wins outright;
  // 2. global default lights it up when no session pin is set.
  const codexIntended =
    options.sessionRuntimePin === 'codex_runtime' ||
    (!options.sessionRuntimePin && getSetting('agent_runtime') === 'codex_runtime');

  if (isCodexAccountProvider) {
    const codexRt = getRuntime('codex_runtime');
    if (codexRt?.isAvailable()) {
      runtime = codexRt;
    } else {
      throw new Error(
        'codex_account provider selected but Codex Runtime is not available — ' +
          'install codex CLI or pick a different provider.',
      );
    }
  } else if (codexIntended) {
    // Codex Runtime intent overrides every other provider-shape
    // heuristic. The proxy adapter and CodexRuntime.stream() already
    // know how to handle openai-oauth (virtual provider) and DB
    // providers; sending them through Native here would either go to
    // the wrong upstream or trip the "Session is pinned to codex_runtime
    // but resolver returned X" guardrail below.
    const codexRt = getRuntime('codex_runtime');
    if (codexRt?.isAvailable()) {
      runtime = codexRt;
    } else if (options.sessionRuntimePin === 'codex_runtime') {
      // Pin is binding — explicit user intent. Surface the error
      // rather than silently downgrading to a different runtime.
      throw new Error(
        'Session is pinned to codex_runtime but Codex Runtime is not available — ' +
          'install codex CLI or change the session runtime in the chat picker.',
      );
    }
    // No pin, global=codex but binary missing: fall through to the
    // normal resolution below so the user still gets *some* response
    // through whichever runtime is reachable.
  } else if (isNonAnthropicProvider) {
    runtime = getRuntime('native');
  } else if (!cliDisabled) {
    // Only attempt transport-based SDK forcing when CLI is enabled
    try {
      const { transport } = detectTransport({
        callScene: options.callScene,
        providerId: options.providerId,
        sessionProviderId: options.sessionProviderId,
      });

      if (!isNativeCompatible(transport)) {
        const sdkRt = getRuntime('claude-code-sdk');
        if (sdkRt?.isAvailable()) {
          runtime = sdkRt;
        }
      }
    } catch { /* ignore detection errors — fall through to normal routing */ }
  }

  if (!runtime) {
    // Phase 2 Step 3: prefer the session's `runtime_pin` over the global
    // `agent_runtime` setting. The pin is stored in chat-runtime label
    // form (`'claude_code'` / `'codepilot_runtime'` / `'codex_runtime'`);
    // translate to the `agent_runtime` registry id form. Empty / unknown
    // pin → pass `undefined`, letting `resolveRuntime()` read the global
    // setting itself in its step 3 (legacy stored-preference semantics).
    //
    // Registry id mapping (the agent_runtime setting form):
    //   claude_code       → claude-code-sdk  (legacy; CC SDK predates RuntimeId)
    //   codepilot_runtime → native           (legacy; same reason)
    //   codex_runtime     → codex_runtime    (Phase 3 — id matches RuntimeId)
    //
    // Round 5 fix (2026-05-13): the third mapping was missing, so
    // sessions pinned to codex_runtime fell through to the global
    // setting (typically claude-code-sdk) and ran GPT-5.5 through
    // ClaudeCode SDK — the bug Codex CDP smoke caught.
    //
    // Round 8 fix (2026-05-18): previously the override fell back to
    // `getSetting('agent_runtime')` — conflating "strong explicit pin
    // for THIS request" with "stale stored preference". Round 8's
    // registry-side change gives explicit overrides fail-closed
    // semantics (throw instead of silently demote to Native when the
    // CLI is gone). Mixing the global setting into that meant a
    // legitimate "global = ClaudeCode, CLI later went missing" case
    // would suddenly throw instead of quietly fall back. Fix here:
    // pass ONLY the session pin (or undefined) — the registry reads
    // the global setting itself in step 3 with the legacy
    // fall-through semantics.
    const pinAsAgentRuntime =
      options.sessionRuntimePin === 'claude_code'
        ? 'claude-code-sdk'
        : options.sessionRuntimePin === 'codepilot_runtime'
          ? 'native'
          : options.sessionRuntimePin === 'codex_runtime'
            ? 'codex_runtime'
            : undefined;
    runtime = resolveRuntime(pinAsAgentRuntime, effectiveProvider || undefined);
  }

  // Phase 5 review round 5 (2026-05-13) — guardrail: when the session
  // is pinned to codex_runtime, the resolved runtime MUST be
  // codex_runtime. Falling through to claude-code-sdk / native is
  // exactly the failure mode that produced "There's an issue with
  // the selected model (gpt-5.5)" — silent runtime mismatch. Throw
  // instead so the chat send path surfaces a clear error.
  if (options.sessionRuntimePin === 'codex_runtime' && runtime.id !== 'codex_runtime') {
    throw new Error(
      `Session is pinned to codex_runtime but resolver returned "${runtime.id}". ` +
        'Codex Runtime is not registered or not available — install codex CLI ' +
        '(or set CODEX_BIN) and retry.',
    );
  }

  // Phase 5e round 8 (2026-05-18) — symmetric guardrail for claude_code
  // session pin. registry.ts:resolveRuntime() now fail-closes when an
  // explicit override targets claude-code-sdk but the CLI is missing
  // (round 8 reorder), so this branch usually doesn't fire. But it
  // catches the residual case where the registry returns a non-SDK
  // runtime for a claude_code-pinned session — for example, if the
  // runtime registry state diverges (mis-registered SDK, race during
  // setup). The check stays narrow: pin === claude_code AND resolved
  // runtime is not claude-code-sdk → throw, never silently demote.
  if (options.sessionRuntimePin === 'claude_code' && runtime.id !== 'claude-code-sdk') {
    throw new Error(
      `Session is pinned to Claude Code but the resolver returned "${runtime.id}". `
      + 'Claude Code CLI is not installed or not detected — install Claude Code CLI, '
      + 'or switch this session to CodePilot / Codex Runtime.',
    );
  }

  console.log(
    `[streamClaude] Using runtime: ${runtime.id} `
    + `(session pin: ${options.sessionRuntimePin || 'none'}, `
    + `global setting: ${getSetting('agent_runtime') || 'auto'})`,
  );

  // ── Cross-runtime auto_review capability gate (review round #6, P1) ──────
  //
  // permissionMode:'auto' is the Claude Agent SDK's classifier reviewer;
  // Codex Runtime maps the same product profile to app-server's
  // approvalsReviewer:auto_review. This is the shipping
  // boundary that sees the REAL resolved runtime — the route computes the wire
  // mode before the runtime is known, so it cannot gate here. Catching it here
  // also closes the direct-PATCH / runtime-switch bypass: whatever a session
  // persisted (or a raw PATCH set), the next send funnels through this point and
  // re-decides against the runtime it will actually run on.
  //
  // Native would map 'auto' into NORMAL_RULES (auto-allow writes) and run as
  // plain 'normal' with no reviewer while the chip claims one. Native therefore
  // fails closed; Codex stays on 'auto' and its adapter owns the wire mapping.
  const autoReviewRuntime = resolveRuntimeAutoReview({
    permissionMode: options.permissionMode,
    runtimeId: runtime.id,
  });
  const effectivePermissionMode = autoReviewRuntime.permissionMode;
  if (autoReviewRuntime.degraded) {
    // chat-runtime label form for the canonical event's runtimeId.
    const runtimeLabel =
      runtime.id === 'native'
        ? 'codepilot_runtime'
        : runtime.id === 'codex_runtime'
          ? 'codex_runtime'
          : 'claude_code';
    console.warn(
      `[streamClaude] Session ${options.sessionId} requested auto_review but runtime `
        + `"${runtime.id}" cannot honour it — degraded to "${effectivePermissionMode}" (fail-closed)`,
    );
    // A DENYING canonical event: the session says 替我审批 while this runtime has
    // no reviewer. Emitting it is what makes the downgrade attributable rather
    // than silent (the exact "静默按 normal 运行" failure this fixes).
    emitReviewEvent(buildReviewEvent({
      state: 'unavailable',
      requestId: `auto-review-unsupported-runtime-${options.sessionId}`,
      sessionId: options.sessionId,
      runtimeId: runtimeLabel,
      reviewerSource: 'sdk-reviewer',
      toolName: '*',
      reason: 'auto_review_unsupported_runtime',
    }));
  }

  return runtime.stream({
    // Universal fields
    prompt: options.prompt,
    callScene: options.callScene,
    sessionId: options.sessionId,
    model: options.model,
    systemPrompt: options.systemPrompt,
    workingDirectory: options.workingDirectory,
    abortController: options.abortController,
    autoTrigger: options.autoTrigger,
    providerId: options.providerId,
    sessionProviderId: options.sessionProviderId,
    thinking: options.thinking,
    effort: options.effort,
    context1m: options.context1m,
    temperature: options.temperature,
    topP: options.topP,
    topK: options.topK,
    mcpServers: options.mcpServers,
    permissionMode: effectivePermissionMode,
    bypassPermissions: options.bypassPermissions,
    onRuntimeStatusChange: options.onRuntimeStatusChange,

    // Runtime-specific fields (SDK Runtime reads these from runtimeOptions)
    runtimeOptions: {
      sdkSessionId: options.sdkSessionId,
      files: options.files,
      conversationHistory: options.conversationHistory,
      sessionSummary: options.sessionSummary,
      fallbackTokenBudget: options.fallbackTokenBudget,
      toolTimeoutSeconds: options.toolTimeoutSeconds,
      outputFormat: options.outputFormat,
      agents: options.agents,
      agent: options.agent,
      enableFileCheckpointing: options.enableFileCheckpointing,
      generativeUI: options.generativeUI,
      provider: options.provider,
      lockId: options.lockId,
    },
  });
}

/**
 * SDK path — used by SdkRuntime. Contains the original Claude Code SDK query() logic.
 * Exported so sdk-runtime.ts can call it without circular dependency issues.
 */
export function streamClaudeSdk(options: ClaudeStreamOptions): ReadableStream<string> {
  const {
    prompt,
    sessionId,
    sdkSessionId,
    model,
    systemPrompt,
    workingDirectory,
    mcpServers,
    abortController,
    permissionMode,
    files,
    toolTimeoutSeconds = 0,
    conversationHistory,
    onRuntimeStatusChange,
    bypassPermissions: sessionBypassPermissions,
    thinking,
    effort,
    outputFormat,
    agents,
    agent,
    enableFileCheckpointing,
    autoTrigger,
    context1m,
    temperature,
    topP,
    topK,
    generativeUI,
    agentMode,
  } = options;
  // Codex P1 — heartbeat agentMode is a HARD restriction, not a hint.
  // It tightens defaults at the SDK level so the model literally
  // cannot reach the dangerous tools, regardless of system-prompt
  // pressure. Tools the heartbeat run is allowed to use:
  //   - mcp__codepilot-memory (codepilot_memory_recent only — for
  //     interpreting HEARTBEAT.md against recent memory)
  // Everything else is either not registered (MCP servers below) or
  // listed in disallowedTools (SDK builtins).
  const isHeartbeatMode = agentMode === 'heartbeat';

  return new ReadableStream<string>({
    async start(controllerRaw) {
      // Wrap controller so async callbacks (keep-alive timer, late tool-result
      // handlers, post-abort message processing) can call enqueue() without
      // crashing when the consumer aborts. See src/lib/safe-stream.ts.
      const controller = wrapController(controllerRaw, (kind) => {
        console.warn(`[claude-client] late ${kind} after stream close — silently dropped`);
      });
      // Flag to prevent infinite PTL retry loops (at most one retry per request)
      let ptlRetryAttempted = false;
      // #577: once the turn's `result` SSE has been emitted, the turn SUCCEEDED
      // and the result is authoritative. A post-result rejection of the SDK
      // iterator (control-channel teardown racing capability capture, late
      // stderr, etc.) lands in the catch below and would otherwise append an
      // "**Error:**" bubble after a correct answer (and clear the SDK session /
      // trigger a retry). Gate those crash behaviors on this flag.
      let resultEmitted = false;
      // U8 latency diagnostics. The SDK already reports TTFT / result duration,
      // but the old adapter discarded them before persistence. Keep request-
      // local facts only; attach them to token_usage at the terminal result.
      const latencyStartedAt = Date.now();
      let observedTtftMs: number | undefined;
      let observedApiRetryCount = 0;
      const latencyResumeAttempted = !!sdkSessionId;
      let latencyResumeFallback = false;
      // Per-request shadow ~/.claude/ for DB-provider isolation. Built lazily
      // below once we know whether we have an explicit DB provider; cleaned up
      // in the outer finally block. See src/lib/claude-home-shadow.ts.
      let shadowHome: ShadowHome | null = null;

      // Resolve provider via the unified resolver. The caller may pass an explicit
      // provider (from resolveProvider().provider), or undefined when 'env' mode is
      // intended. We do NOT fall back to getActiveProvider() here — that's handled
      // inside resolveForClaudeCode() only when no resolution was attempted at all.
      const resolved = resolveForClaudeCode(options.provider, {
        callScene: options.callScene,
        providerId: options.providerId,
        sessionProviderId: options.sessionProviderId,
      });

      // #632: trust the SDK-reported context window only for a first-party
      // Anthropic endpoint. Derive it from the EFFECTIVE base URL the SDK will
      // use (provider row → settings.anthropic_base_url → process.env.ANTHROPIC_BASE_URL),
      // not just resolved.provider — env / legacy / cc-switch sessions with no
      // owning provider can STILL point at a third-party proxy whose
      // modelUsage.contextWindow is the SDK's generic ~200K default (the GLM
      // "200K" the user reported). Computed once; both result handlers reuse it.
      const trustSdkContextWindow = isFirstPartyAnthropicEndpoint(
        resolveEffectiveAnthropicBaseUrl(resolved),
      );

      // Phase 7 Context Accounting — accumulator must outlive try/catch so
      // the CONTEXT_TOO_LONG retry path (alt path inside catch) can drain
      // the same per-turn record list as the main path. Decl here at the
      // streamClaude scope; ToolInvocationAccumulator class imported up top.
      const { ToolInvocationAccumulator: _PhaseRcAcc } = await import(
        '@/lib/harness/auto-invoke-accounting'
      );
      const toolInvocationAccumulator = new _PhaseRcAcc();

      try {
        const resolvedWorkingDirectory = resolveWorkingDirectory([
          { path: workingDirectory, source: 'requested' },
        ]);

        if (workingDirectory && resolvedWorkingDirectory.source !== 'requested') {
          console.warn(
            `[claude-client] Working directory "${workingDirectory}" is unavailable, falling back to "${resolvedWorkingDirectory.path}"`,
          );
        }

        // Build env for the Claude Code subprocess via the shared helper —
        // every SDK entry point (this stream, generateTextViaSdk, provider
        // doctor live probe) goes through `prepareSdkSubprocessEnv` so the
        // provider-group ownership rule is applied uniformly. See
        // src/lib/sdk-subprocess-env.ts.
        const setup = prepareSdkSubprocessEnv(resolved);
        const sdkEnv = setup.env;
        shadowHome = setup.shadow;

        // U8 — when macOS has no DNS configuration the SDK/CLI can stay silent
        // until the UI's 10-minute pre-first-token fuse. Resolve only the target
        // hostname before spawning the query so that impossible connections fail
        // in <=3s with the existing NETWORK_UNREACHABLE recovery message. Proxy
        // configurations are skipped because the proxy may own DNS resolution.
        const { assertProviderDnsResolvable } = await import('./provider-dns-preflight');
        await assertProviderDnsResolvable({
          baseUrl: sdkEnv.ANTHROPIC_BASE_URL,
          env: sdkEnv,
        });

        // Warn if no credentials found at all
        if (!resolved.hasCredentials && !sdkEnv.ANTHROPIC_API_KEY && !sdkEnv.ANTHROPIC_AUTH_TOKEN) {
          console.warn('[claude-client] No API key found: no active provider, no legacy settings, and no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN in environment');
        }


        // The permission-bearing slice of the options — permissionMode,
        // allowedTools, disallowedTools, allowDangerouslySkipPermissions — is
        // assembled in ONE place, lib/permission/profile.ts, and spread in
        // verbatim below. Nothing here may re-decide those four fields.
        //
        // `sessionBypassPermissions` is set ONLY by the full_access profile
        // (resolveClaudeWireOptions is the single decider). auto_review arrives
        // as permissionMode 'auto' with bypass false, and Plan as 'plan';
        // neither may be collapsed into a blanket allow by the legacy global
        // setting. That combination used to be re-widened right here, after the
        // resolver had already refused it.
        const globalSkip = getSetting('dangerously_skip_permissions') === 'true';
        // External-MCP gate (review round #4, P1). Probed HERE, at the shipping
        // boundary, with the same settingSources / mcpServers / cwd this turn
        // will actually use — an answer derived from anything else describes a
        // different turn. Only worth the filesystem reads when 'auto' is
        // actually on the table.
        const externalMcp = permissionMode === 'auto'
          ? probeExternalMcp({
              workingDirectory: resolvedWorkingDirectory.path,
              settingSources: (resolved.settingSources as string[] | undefined) ?? [],
              explicitServerNames: mcpServers ? Object.keys(mcpServers) : [],
            })
          : { present: false as const };
        const {
          // Not a wire field — must not reach SDK Options.
          degradedReason: autoReviewDegradedReason,
          ...permissionOptions
        } = buildClaudePermissionQueryOptions({
          permissionMode,
          sessionBypassPermissions: !!sessionBypassPermissions,
          globalSkip,
          isHeartbeatMode,
          externalMcp,
        });
        const skipPermissions = permissionOptions.allowDangerouslySkipPermissions === true;
        // The user picked 替我审批 and is not getting it. Silence here would be
        // the worst outcome of all: they'd believe a reviewer was running while
        // every request quietly fell back to asking them. Emit the canonical
        // `unavailable` event (a02) so the UI can say so.
        if (autoReviewDegradedReason) {
          const event = emitReviewEvent(buildReviewEvent({
            state: 'unavailable',
            requestId: `auto-review-unavailable-${sessionId}`,
            sessionId,
            runtimeId: 'claude_code',
            reviewerSource: 'rule-engine',
            toolName: 'permission_profile:auto_review',
            reason: autoReviewDegradedReason,
          }));
          controller.enqueue(formatSSE({
            type: 'permission_review',
            data: JSON.stringify({
              state: event.state,
              reviewerSource: event.reviewerSource,
              toolName: event.toolName,
              reason: 'reason' in event ? event.reason : undefined,
            }),
          }));
        }

        const queryOptions: Options = {
          cwd: resolvedWorkingDirectory.path,
          abortController,
          includePartialMessages: true,
          env: sanitizeEnv(sdkEnv),
          // Load settings so the SDK behaves like the CLI (tool permissions,
          // CLAUDE.md, etc.). For DB providers settingSources is ['user'] only;
          // for env mode it's ['user', 'project', 'local']. See provider-resolver.ts.
          //
          // Codex P2 — heartbeat narrows this to `[]` (no filesystem
          // settings loading at all). The MCP-server gates above only
          // skip the explicit registrations claude-client controls;
          // the SDK ALSO auto-loads MCP servers declared in
          // ~/.claude/settings.json (`user`), <cwd>/.claude/settings.json
          // (`project`), and .claude/settings.local.json (`local`).
          // Without this collapse, a user-level MCP would be loaded
          // by the SDK even though we never asked for it, and the
          // model could see those tools (`disallowedTools` blocks
          // SDK builtins like Bash but does not enumerate every
          // user-configured MCP server name). The cost: heartbeat
          // also won't auto-pick-up ambient CLAUDE.md / tool
          // permissions / agents — none of which heartbeat needs.
          // The in-process codepilot-memory MCP we register manually
          // does NOT depend on settingSources, so memory access
          // continues to work.
          settingSources: isHeartbeatMode
            ? ([] as Options['settingSources'])
            : (resolved.settingSources as Options['settingSources']),
          // permissionMode / allowedTools / disallowedTools /
          // allowDangerouslySkipPermissions — decided by
          // buildClaudePermissionQueryOptions and spread verbatim. Read that
          // function for why the mutating MCP servers are no longer bare-allowed
          // (a05) and why auto_review adds a deny list (a04). Deliberately last
          // so it cannot be silently overridden by a field above.
          ...(permissionOptions as Pick<Options,
            'permissionMode' | 'allowedTools' | 'disallowedTools' | 'allowDangerouslySkipPermissions'>),
        };

        // Reviewer breadcrumb (a02 / a08). The SDK's PermissionDenied hook
        // fires ONLY for auto-mode classifier denials — never for a user's own
        // Deny click — so it is an exact `sdk-reviewer` signal rather than an
        // inference from shape. Registered only under 'auto', where a reviewer
        // exists at all. Classifier APPROVALS have no equivalent hook and stay
        // unobservable; see buildSdkReviewerDenial for why that is upstream.
        // Gate on the EFFECTIVE mode, not the requested one: a turn whose
        // auto_review was refused by the external-MCP gate runs as 'default',
        // where no classifier exists and this hook would never fire anyway.
        if (permissionOptions.permissionMode === 'auto') {
          queryOptions.hooks = {
            ...queryOptions.hooks,
            PermissionDenied: [
              {
                hooks: [
                  async (input) => {
                    const denied = input as { tool_name?: string; tool_use_id?: string; reason?: string };
                    const event = emitReviewEvent(buildSdkReviewerDenial({
                      requestId: `sdk-reviewer-${denied.tool_use_id ?? denied.tool_name ?? 'unknown'}`,
                      sessionId,
                      toolName: denied.tool_name ?? 'unknown',
                      reason: denied.reason,
                    }));
                    // Surface it: a reviewer that blocks work silently is
                    // indistinguishable from the model deciding not to bother.
                    // `reviewerSource` travels with the event so the UI labels
                    // this 模型代审拒绝, never 你拒绝了 — the two are different
                    // facts about who is in control. The reason is already
                    // redacted by buildSdkReviewerDenial.
                    controller.enqueue(formatSSE({
                      type: 'permission_review',
                      data: JSON.stringify({
                        state: event.state,
                        reviewerSource: event.reviewerSource,
                        toolName: event.toolName,
                        reason: 'reason' in event ? event.reason : undefined,
                      }),
                    }));
                    // Observe only: the SDK already denied, and this hook must
                    // not be able to talk it back into allowing.
                    return {};
                  },
                ],
              },
            ],
          };
        }

        // Find claude binary for packaged app where PATH is limited.
        // On Windows, npm installs Claude CLI as a .cmd wrapper which cannot
        // be spawned directly without shell:true. Parse the wrapper to
        // extract the real .js script path and pass that to the SDK instead.
        const claudePath = findClaudePath();
        if (claudePath) {
          const ext = path.extname(claudePath).toLowerCase();
          if (ext === '.cmd' || ext === '.bat') {
            const scriptPath = resolveScriptFromCmd(claudePath);
            if (scriptPath) {
              queryOptions.pathToClaudeCodeExecutable = scriptPath;
            } else {
              console.warn('[claude-client] Could not resolve .js path from .cmd wrapper, falling back to SDK resolution:', claudePath);
            }
          } else {
            queryOptions.pathToClaudeCodeExecutable = claudePath;
          }
        }

        if (model) {
          queryOptions.model = model;
        }

        if (systemPrompt) {
          // Use preset append mode to keep Claude Code's default system prompt
          // (which includes skills, working directory awareness, etc.)
          queryOptions.systemPrompt = {
            type: 'preset',
            preset: 'claude_code',
            append: systemPrompt,
          };
        }

        // MCP servers: pass explicitly provided config (e.g. from CodePilot UI).
        // User-level MCP config from ~/.claude.json and ~/.claude/settings.json
        // is automatically loaded by the SDK via settingSources: ['user'] (DB
        // providers) or ['user', 'project', 'local'] (env mode).
        //
        // Codex P1 — heartbeat agentMode forbids external MCP entirely.
        // External servers can do anything (HTTP / shell / DB writes),
        // and a heartbeat that touches them is by definition off-spec.
        // We let `codepilot-memory` get registered later; everything
        // else is dropped here.
        if (!isHeartbeatMode && mcpServers && Object.keys(mcpServers).length > 0) {
          queryOptions.mcpServers = toSdkMcpConfig(mcpServers);
        }

        // For DB-provider requests, settingSources is ['user'] only (project
        // and local layers are dropped to prevent <cwd>/.claude/settings.json
        // env from overriding the explicit provider's auth — see
        // provider-resolver.ts ~800). That also disables SDK auto-loading of
        // `<cwd>/.mcp.json`, which is normally an auth-neutral file team
        // members commit to share project MCP servers. Re-inject it here so
        // those servers don't silently disappear for DB-provider users.
        if (!isHeartbeatMode && resolved.provider) {
          const { loadProjectMcpServers } = await import('@/lib/mcp-loader');
          const projectMcps = loadProjectMcpServers(resolvedWorkingDirectory.path);
          if (projectMcps) {
            const sdkProjectMcps = toSdkMcpConfig(projectMcps);
            // Existing entries (CodePilot UI / placeholder-managed) take
            // precedence on name collision — they're the user's currently-
            // chosen config layer, project file is the team default.
            queryOptions.mcpServers = {
              ...sdkProjectMcps,
              ...(queryOptions.mcpServers || {}),
            };
          }
        }

        // Phase 5d Phase 2 slice 2c (2026-05-17) — capability prompt
        // assembly delegated to the Harness Context Compiler. This
        // loop registers MCP servers (transport-layer concern), and
        // tracks which capabilities ended up enabled; the compiler
        // turns that set into the canonical `systemPrompt.append`
        // text in one call after the loop.
        //
        // Pre-fix this file appended per-capability `_SYSTEM_PROMPT`
        // strings inline. The strings were sourced from the right
        // MCP files, so there was no paraphrase — but each call site
        // was a separate place that could drift. The compiler is now
        // the single producer; this file is a pure consumer.
        const enabledCapabilities = new Set<string>();

        // Memory MCP: always registered in assistant mode for memory search/retrieval.
        // Unlike other MCPs which are keyword-gated, memory search is a core assistant capability.
        {
          const assistantWorkspacePath = getSetting('assistant_workspace_path');
          if (assistantWorkspacePath && resolvedWorkingDirectory.path === assistantWorkspacePath) {
            const { createMemorySearchMcpServer } = await import('@/lib/memory-search-mcp');
            queryOptions.mcpServers = {
              ...(queryOptions.mcpServers || {}),
              'codepilot-memory': createMemorySearchMcpServer(assistantWorkspacePath),
            };
            enabledCapabilities.add('memory');
          }
        }

        // Notification + Schedule MCP: globally available in all contexts
        // EXCEPT heartbeat (Codex P1) — codepilot-notify exposes
        // schedule_task / list_tasks / cancel_task / hatch_buddy /
        // notify, all of which are exactly the tools that caused the
        // heartbeat-tool-loop hang. Skipping registration is the
        // hard guarantee; the system prompt + allowedTools are
        // additional belts.
        if (!isHeartbeatMode) {
          const { createNotificationMcpServer } = await import('@/lib/notification-mcp');
          queryOptions.mcpServers = {
            ...(queryOptions.mcpServers || {}),
            // Inject hidden run context so codepilot_schedule_task can
            // POST origin_session_id + working_directory to /api/tasks/schedule
            // without exposing those fields in the model's tool schema.
            // Tasks created here will fire later in this session's
            // working dir + provider, not whatever the global default
            // is at scheduler-tick time.
            'codepilot-notify': createNotificationMcpServer({
              sessionId,
              workingDirectory: resolvedWorkingDirectory.path,
            }),
          };
          enabledCapabilities.add('tasks_and_notify');
        }

        // Widget guidelines: progressive loading strategy.
        // The system prompt always includes WIDGET_SYSTEM_PROMPT with format rules.
        // The MCP server (detailed design specs) is only registered when the
        // conversation likely involves widget generation — detected by keywords in
        // the user's prompt or existing show-widget output in conversation history.
        // This avoids SDK tool discovery overhead (~1s) on plain text conversations.
        // Codex P1 — heartbeat skips this entirely; HEARTBEAT.md is
        // text-only, no widget surface.
        if (!isHeartbeatMode && generativeUI !== false) {
          const needsWidgetSpecs = (() => {
            const widgetKeywords = /可视化|图表|流程图|时间线|架构图|对比|visualiz|diagram|chart|flowchart|timeline|infographic|interactive|widget|show-widget|hierarchy|dashboard/i;
            // Check current user prompt
            if (widgetKeywords.test(prompt)) return true;
            // Check if conversation already has widgets (resume context)
            if (conversationHistory?.some(m => m.content.includes('show-widget'))) return true;
            return false;
          })();

          if (needsWidgetSpecs) {
            const { createWidgetMcpServer } = await import('@/lib/widget-guidelines');
            const widgetServer = createWidgetMcpServer();
            queryOptions.mcpServers = {
              ...(queryOptions.mcpServers || {}),
              'codepilot-widget': widgetServer,
            };
            enabledCapabilities.add('widget');
          }
        }

        // Media MCP: import + generation tools (keyword-gated).
        // Registered when the conversation involves media/image generation tasks
        // in CODE mode. The legacy "Design Agent mode" branch was removed in
        // Phase 2D.0 (2026-04-30) — it was never user-reachable.
        // Codex P1 — heartbeat never needs media tools; skip even
        // before keyword evaluation so a HEARTBEAT.md mentioning the
        // word "图片" can't accidentally pull the MCP in.
        const needsMediaMcp = !isHeartbeatMode && (() => {
          const mediaKeywords = /生成图片|画一|图像|图片|素材|保存.*素材|import.*library|save.*library|codepilot_import_media|codepilot_generate_image/i;
          if (mediaKeywords.test(prompt)) return true;
          if (conversationHistory?.some(m =>
            mediaKeywords.test(m.content)
          )) return true;
          return false;
        })();

        if (needsMediaMcp) {
          const { createMediaImportMcpServer } = await import('@/lib/media-import-mcp');
          const { createImageGenMcpServer } = await import('@/lib/image-gen-mcp');
          queryOptions.mcpServers = {
            ...(queryOptions.mcpServers || {}),
            'codepilot-media': createMediaImportMcpServer(sessionId, resolvedWorkingDirectory.path),
            'codepilot-image-gen': createImageGenMcpServer(sessionId, resolvedWorkingDirectory.path),
          };
          enabledCapabilities.add('media_import');
          enabledCapabilities.add('image_generation');
        }

        // CLI tools MCP: tool management capabilities (keyword-gated).
        // Wide regex to cover natural phrasing like "帮我装 jq", "install uv",
        // "brew install", "pip install", "npm install -g", etc.
        // Codex P1 — heartbeat never installs CLI tools.
        // Keyword gate is shared with the Codex injection path (don't
        // per-runtime rewrite — `feedback_new_agent_must_reuse_contracts`).
        const { promptNeedsCli } = await import('@/lib/cli-tools-mcp');
        const needsCliToolsMcp = !isHeartbeatMode && promptNeedsCli(prompt, conversationHistory);

        if (needsCliToolsMcp) {
          const { createCliToolsMcpServer } = await import('@/lib/cli-tools-mcp');
          queryOptions.mcpServers = {
            ...(queryOptions.mcpServers || {}),
            'codepilot-cli-tools': createCliToolsMcpServer(),
          };
          enabledCapabilities.add('cli_tools');
        }

        // Dashboard MCP: widget management capabilities (keyword-gated).
        // Codex P1 — heartbeat never manages dashboard pins.
        // Keyword gate is shared with the Codex injection path.
        const { promptNeedsDashboard } = await import('@/lib/dashboard-mcp');
        const needsDashboardMcp = !isHeartbeatMode && promptNeedsDashboard(prompt, conversationHistory);

        if (needsDashboardMcp) {
          const { createDashboardMcpServer } = await import('@/lib/dashboard-mcp');
          queryOptions.mcpServers = {
            ...(queryOptions.mcpServers || {}),
            'codepilot-dashboard': createDashboardMcpServer(sessionId, resolvedWorkingDirectory.path),
          };
          enabledCapabilities.add('dashboard');
        }

        // Phase 5d Phase 3 (2026-05-17) — capability prompt assembly
        // routed through the Runtime Capability Adapter. The adapter
        // wraps Phase 2's compileContext + ClaudeCode-specific hints
        // so this call site no longer touches the compiler API
        // directly. Three contract invariants are now structural:
        //
        //   1. `adapted.systemPromptAppend` is ALWAYS a string —
        //      empty when no capabilities mounted, full canonical
        //      text otherwise. The `length > 0` check below is the
        //      only place that decides whether to splice it in.
        //   2. When the upstream caller did NOT pass a `systemPrompt`,
        //      we still mount the SDK preset shape with the compiled
        //      append. (Phase 2 P1 review fix — pre-fix the preset
        //      branch was skipped, leaving the model without
        //      capability rules in chat runs without a base prompt.)
        //   3. Capability fragment text comes ONLY from the adapter
        //      (compiler-sourced). No `+ _SYSTEM_PROMPT` inline appends
        //      anywhere in this file — the drift surface from
        //      pre-Phase-2 is now a structural impossibility.
        // Phase 5e review round 4 fix P2 #1 (2026-05-18) — User /
        // External Harness extension injection MUST NOT be gated on
        // `enabledCapabilities.size > 0`. Pre-fix: when no built-in
        // capability was gated in (rare but reachable — e.g. plain
        // chat with no widget keyword + no workspace memory), the
        // whole adapter branch was skipped, so the user's MCP
        // servers / Skills / commands never reached the model. The
        // adapter is now called unconditionally; the
        // `adapted.systemPromptAppend.length > 0` check below
        // continues to skip the splice when there's nothing useful
        // to inject (capability + extension fragments both empty).
        //
        // Phase 7 Context Accounting (2026-05-20): producer time-shifted
        // from streamClaude-start to result-event. Instead of guessing
        // what Claude will invoke, we accumulate the actual tool_use /
        // tool_result blocks during streaming and produce the snapshot
        // from real invocations at result time. Wire below at line ~1589
        // (main path tool_use), ~1623 (main path tool_result), ~1844
        // (main path result), and ~2086/2094/2160 (alt path retry).
        // The accumulator instance lives in streamClaude scope above so
        // CONTEXT_TOO_LONG retry can share it across try/catch boundary.
        // See src/lib/harness/auto-invoke-accounting.ts for the contract.
        {
          const { adaptForClaudeCode } = await import('@/lib/harness/runtime-adapter');
          // Phase 5e review fix P1 #2 (2026-05-18) — scan User /
          // External Harness extensions and pass them through the
          // adapter so the model sees a "Your harness extensions"
          // perception fragment. Scanners are best-effort + read-only;
          // a scan failure degrades to "no extensions visible" rather
          // than blocking the turn (try/catch guards each scan).
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
              workspacePath: resolvedWorkingDirectory.path,
              runtimeId: 'claude_code',
            });
          } catch {
            // best-effort
          }
          try {
            const { scanExternalFrameworkExtensions } = await import(
              '@/lib/harness/external-framework-harness'
            );
            externalExtensions = scanExternalFrameworkExtensions({
              activeFramework: 'claude_code',
            });
          } catch {
            // best-effort
          }
          const adapted = adaptForClaudeCode({
            sessionId,
            workingDirectory: resolvedWorkingDirectory.path,
            providerId: resolved.provider?.id || 'env',
            model: model || '',
            userPrompt: prompt || '',
            enabledCapabilities,
            userExtensions,
            externalExtensions,
          });
          if (adapted.systemPromptAppend.length > 0) {
            if (
              queryOptions.systemPrompt &&
              typeof queryOptions.systemPrompt === 'object' &&
              'append' in queryOptions.systemPrompt
            ) {
              queryOptions.systemPrompt.append =
                (queryOptions.systemPrompt.append || '') +
                '\n\n' +
                adapted.systemPromptAppend;
            } else {
              // No upstream systemPrompt. Mount the SDK's preset
              // shape with the compiled capability prompt in the
              // append slot — keeps Claude Code's default preset
              // intact while still injecting our capability rules.
              queryOptions.systemPrompt = {
                type: 'preset',
                preset: 'claude_code',
                append: adapted.systemPromptAppend,
              };
            }
          }
        }

        // Pass through SDK-specific options from ClaudeStreamOptions.
        // Shared sanitizer runs the same Opus 4.7 migration guards as the
        // native agent-loop path — manual extended thinking becomes
        // adaptive, and the context-1m beta header is dropped since 4.7
        // ships 1M by default.
        const sanitized = sanitizeClaudeModelOptions({
          model,
          thinking,
          effort,
          context1m,
          temperature,
          topP,
          topK,
        });

        if (sanitized.thinkingForcedOn) {
          // Fable 5: thinking cannot be turned off — the sanitizer omitted
          // the user's thinking:'disabled' to avoid a 400, but adaptive
          // thinking still runs. Tell the user once per send instead of
          // silently misrepresenting the "thinking off" choice
          // (Codex review P1, same surfacing as the native path).
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
        // Sampling params on the SDK runtime. Two reasons a value doesn't reach
        // the model — the sanitizer stripped it (adaptive family 400s on
        // non-defaults), or Claude Code's query() has no sampling knobs at all
        // — and neither is retryable, so tell the user once. Same shared
        // builder + code as the native path (Codex review P2).
        const samplingNotice = buildSamplingIgnoredNotice({
          runtime: 'sdk',
          model,
          sanitized,
        });
        if (samplingNotice) {
          console.warn(
            `[streamClaudeSdk] ${model}: sampling params (${samplingNotice.unsent.join(', ')}) not sent — `
              + `rejected by this model and/or unsupported by the Claude Code SDK runtime.`,
          );
          controller.enqueue(formatSSE({
            type: 'status',
            data: JSON.stringify({
              notification: true,
              code: samplingNotice.code,
              // Localized on the client from (code, reason, params) — see
              // status-notice-i18n.ts (Codex review P2). console.warn above is
              // the server-side breadcrumb.
              reason: samplingNotice.reason,
              params: samplingNotice.params,
            }),
          }));
        }
        if (sanitized.thinking) {
          queryOptions.thinking = sanitized.thinking;
        }
        // SDK-runtime effort policy: when the UI doesn't explicitly pick a
        // level, leave `effort` unset so Claude Code CLI applies its
        // per-model default (e.g. Opus 4.7 defaults to xhigh, Sonnet to
        // high). Writing 'medium' unconditionally would override that and
        // regress the 4.7 out-of-box experience.
        //
        // The previous concern about settings.json injecting 'high' is
        // mitigated by CLI defaults: they're applied with lower precedence
        // than both queryOptions.effort and settingSources, so an explicit
        // UI choice still wins and a missing one doesn't silently escalate
        // to 'high'.
        if (sanitized.effort) {
          queryOptions.effort = sanitized.effort as Options['effort'];
        }
        if (outputFormat) {
          queryOptions.outputFormat = outputFormat;
        }
        if (agents) {
          queryOptions.agents = agents as Options['agents'];
        }
        if (agent) {
          queryOptions.agent = agent;
        }
        if (enableFileCheckpointing) {
          queryOptions.enableFileCheckpointing = true;
        }
        if (sanitized.applyContext1mBeta) {
          queryOptions.betas = [
            ...(queryOptions.betas || []),
            'context-1m-2025-08-07',
          ];
        }

        // Plugins: loaded by the SDK itself via enabledPlugins in ~/.claude/settings.json.
        // CodePilot does NOT explicitly inject plugins — the SDK reads settingSources
        // ['user', 'project', 'local'] and resolves enabledPlugins on its own,
        // ensuring parity with Claude CLI.

        // Resume session if we have an SDK session ID from a previous conversation turn.
        // Pre-check: verify working_directory exists before attempting resume.
        // Resume depends on session context (cwd/project scope), so if the
        // original working_directory no longer exists, resume will fail.
        let shouldResume = !!sdkSessionId;
        if (shouldResume && workingDirectory && resolvedWorkingDirectory.source !== 'requested') {
          console.warn(
            `[claude-client] Working directory "${workingDirectory}" does not exist, skipping resume`,
          );
          shouldResume = false;
          if (sessionId) {
            clearSdkSessionIfOwner(sessionId, options.lockId);
          }
          controller.enqueue(formatSSE({
            type: 'status',
            data: JSON.stringify({
              _internal: true,
              resumeFallback: true,
              title: 'Session fallback',
              message: 'Original working directory no longer exists. Starting fresh conversation.',
            }),
          }));
        }
        if (shouldResume) {
          // Emit visible status so the user sees feedback during resume initialization
          controller.enqueue(formatSSE({
            type: 'status',
            data: JSON.stringify({
              notification: true,
              title: 'Resuming session',
              message: 'Reconnecting to previous conversation...',
            }),
          }));
          queryOptions.resume = sdkSessionId;
        }

        // Permission handler: sends SSE event and waits for user response
        queryOptions.canUseTool = async (toolName, input, opts) => {
          // Decision order (runtime-permission-modes.md Phase 1, a04/a05):
          //
          //   1. human-only → ask the user, whatever the profile says
          //   2. rule-engine auto-approve → CodePilot's own read-only + local
          //      host tools, which the user opted into by using the feature
          //   3. everything else → ask
          //
          // Step 2 replaces the old hand-written `autoApprovedTools` list.
          // That list had drifted from the mutationLevel table — it waved
          // through `codepilot_cli_tools_add` / `_remove` (shell exec) and
          // `codepilot_generate_image` (bills the user's API), which are now
          // human-only and reach the user instead.
          //
          // SCOPE, precisely (review round #2, P1): step 1 here is a backstop,
          // NOT the auto_review guarantee. Under permissionMode 'auto' the SDK
          // classifier can allow a tool without ever calling canUseTool, so a
          // human-only tool that reached this callback under 'auto' only did so
          // because the SDK itself refused to let the classifier decide (an
          // interactive tool like AskUserQuestion, or the classifier being
          // unavailable). What actually keeps the classifier away from our
          // money-spending / publishing tools is the deny list applied to
          // `disallowedTools` above — see resolveHumanOnlyDenyTools.
          const hostDecision = decideHostToolPermission(toolName);
          const humanOnlyCategory =
            hostDecision.decision === 'human-only' ? hostDecision.category : undefined;
          if (hostDecision.decision === 'rule-approved') {
            // Auto-approved, but not invisible: the audit trail records that
            // the rule engine — not a model, not the user — made this call.
            emitReviewEvent(buildReviewEvent({
              state: 'approved',
              requestId: `rule-${opts.toolUseID ?? toolName}`,
              sessionId,
              runtimeId: 'claude_code',
              reviewerSource: 'rule-engine',
              toolName,
            }));
            return { behavior: 'allow' as const, updatedInput: input };
          }

          if (humanOnlyCategory) {
            // Under auto_review the SDK reviewer would otherwise be entitled
            // to answer this. It isn't: these are the operations where the
            // user's own judgement is the product.
            console.log(`[claude-client] ${toolName} is human-only (${humanOnlyCategory}) — asking the user regardless of permission profile`);
          }

          const permissionRequestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];

          const permEvent: PermissionRequestEvent = {
            permissionRequestId,
            toolName,
            toolInput: input,
            suggestions: opts.suggestions as PermissionRequestEvent['suggestions'],
            decisionReason: opts.decisionReason,
            blockedPath: opts.blockedPath,
            toolUseId: opts.toolUseID,
            description: undefined,
            // HMAC over (id, expiresAt) — /api/chat/permission rejects
            // approvals that don't echo it (Phase 4 ② hardening).
            approvalToken: issueApprovalToken(permissionRequestId, expiresAt),
          };

          // Persist permission request to DB for audit/recovery
          try {
            createPermissionRequest({
              id: permissionRequestId,
              sessionId,
              sdkSessionId: sdkSessionId || '',
              toolName,
              toolInput: JSON.stringify(input),
              decisionReason: opts.decisionReason || '',
              expiresAt,
            });
          } catch (e) {
            console.warn('[claude-client] Failed to persist permission request to DB:', e);
          }

          emitReviewEvent(buildReviewEvent({
            state: 'requested',
            requestId: permissionRequestId,
            sessionId,
            runtimeId: 'claude_code',
            // This request reached a human prompt, so the decision ahead is
            // the user's — even under auto_review, where the SDK reviewer
            // either escalated it or was never allowed to see it.
            reviewerSource: 'user',
            toolName,
            humanOnlyCategory,
          }));

          // Send permission_request SSE event to the client
          controller.enqueue(formatSSE({
            type: 'permission_request',
            data: JSON.stringify(permEvent),
          }));

          // Notify via Telegram (fire-and-forget) — skip for auto-trigger turns
          if (!autoTrigger) {
            notifyPermissionRequest(toolName, input as Record<string, unknown>, telegramOpts).catch(() => {});
          }

          // Notify runtime status change
          onRuntimeStatusChange?.('waiting_permission');

          // Wait for user response (resolved by POST /api/chat/permission)
          // Store original input so registry can inject updatedInput on allow.
          // onTimeout pushes a permission_resolved(timeout) event down this
          // same SSE stream so the chat UI shows the auto-deny (A5 Step 2).
          const result = await registerPendingPermission(permissionRequestId, input, opts.signal, () => {
            try {
              controller.enqueue(formatSSE(buildPermissionResolvedEvent(permissionRequestId)));
            } catch {
              // stream already closed — deny still applies
            }
          });

          // Restore runtime status after permission resolved
          onRuntimeStatusChange?.('running');

          // Close the audit trail for this request. `timeout` is its own
          // state rather than a flavour of deny: the UI needs to say "nobody
          // answered" instead of implying the user refused.
          const timedOut = result.behavior === 'deny' && /timed out|timeout|expired/i.test(result.message || '');
          emitReviewEvent(buildReviewEvent({
            state: result.behavior === 'allow' ? 'approved' : timedOut ? 'timeout' : 'denied',
            requestId: permissionRequestId,
            sessionId,
            runtimeId: 'claude_code',
            reviewerSource: 'user',
            toolName,
            humanOnlyCategory,
            ...(result.behavior === 'deny' && !timedOut ? { reason: result.message } : {}),
          } as PermissionReviewEvent));

          // Cast to SDK PermissionResult (NativePermissionResult is a compatible subset)
          return result as unknown as import('@anthropic-ai/claude-agent-sdk').PermissionResult;
        };

        // Telegram notification context for hooks
        const telegramOpts = {
          sessionId,
          sessionTitle: undefined as string | undefined,
          workingDirectory: resolvedWorkingDirectory.path,
        };

        // No queryOptions.hooks — all hook types (Notification, PostToolUse) use
        // the SDK's hook_callback control_request transport, which fails with
        // "CLI output was not valid JSON" when the CLI mixes control frames with
        // normal stdout. Notifications are derived from stream messages instead
        // (task_notification, result). TodoWrite sync uses tool_use → tool_result.

        // Capture real-time stderr output from Claude Code process
        queryOptions.stderr = (data: string) => {
          // Diagnostic: log raw stderr data length to server console
          console.log(`[stderr] received ${data.length} bytes, first 200 chars:`, data.slice(0, 200).replace(/[\x00-\x1F\x7F]/g, '?'));
          // Strip ANSI escape codes, OSC sequences, and control characters
          // but preserve tabs (\x09) and carriage returns (\x0D)
          const cleaned = data
            .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')   // CSI sequences (colors, cursor)
            .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '') // OSC sequences
            .replace(/\x1B\([A-Z]/g, '')               // Character set selection
            .replace(/\x1B[=>]/g, '')                   // Keypad mode
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // Control chars (keep \t \n \r)
            .replace(/\r\n/g, '\n')                    // Normalize CRLF
            .replace(/\r/g, '\n')                      // Convert remaining CR to LF
            .replace(/\n{3,}/g, '\n\n')                // Collapse multiple blank lines
            .trim();
          if (cleaned) {
            controller.enqueue(formatSSE({
              type: 'tool_output',
              data: cleaned,
            }));
          }
        };

        // Build the prompt with file attachments and optional conversation history.
        // When resuming, the SDK has full context so we send the raw prompt.
        // When NOT resuming (fresh or fallback), prepend DB history for context.
        function buildFinalPrompt(useHistory: boolean): string | AsyncIterable<SDKUserMessage> {
          const basePrompt = useHistory
            ? buildFallbackContext({
                prompt,
                history: conversationHistory,
                sessionSummary: options.sessionSummary,
                tokenBudget: options.fallbackTokenBudget,
              })
            : prompt;

          if (!files || files.length === 0) return basePrompt;

          const imageFiles = files.filter(f => isImageFile(f.type));
          const nonImageFiles = files.filter(f => !isImageFile(f.type));

          let textPrompt = basePrompt;
          if (nonImageFiles.length > 0) {
            const workDir = resolvedWorkingDirectory.path;
            const savedPaths = getUploadedFilePaths(nonImageFiles, workDir);
            const fileReferences = savedPaths
              .map((p, i) => `[User attached file: ${p} (${nonImageFiles[i].name})]`)
              .join('\n');
            textPrompt = `${fileReferences}\n\nPlease read the attached file(s) above using your Read tool, then respond to the user's message:\n\n${basePrompt}`;
          }

          if (imageFiles.length > 0) {
            // Limit media items: keep the MOST RECENT images (drop oldest first),
            // consistent with "preserve recent context" strategy.
            const MAX_MEDIA_ITEMS = 100;
            const limitedImages = imageFiles.length > MAX_MEDIA_ITEMS
              ? imageFiles.slice(-MAX_MEDIA_ITEMS)
              : imageFiles;
            const droppedCount = imageFiles.length - limitedImages.length;

            // Append disk paths — only for the images actually included.
            // (The legacy Design-Agent branch that skipped paths was
            // removed in Phase 2D.0; it was never user-reachable.)
            const textWithImageRefs = (() => {
              const workDir = resolvedWorkingDirectory.path;
              const imagePaths = getUploadedFilePaths(limitedImages, workDir);
              const imageReferences = imagePaths
                .map((p, i) => `[User attached image: ${p} (${limitedImages[i].name})]`)
                .join('\n');
              return `${imageReferences}\n\n${textPrompt}`;
            })();

            const contentBlocks: Array<
              | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } }
              | { type: 'text'; text: string }
            > = [];

            for (const img of limitedImages) {
              // Read base64 from disk if the data was cleared after upload
              let imgData = img.data;
              if (!imgData && img.filePath) {
                try {
                  imgData = fs.readFileSync(img.filePath).toString('base64');
                } catch {
                  continue; // Skip images whose files are missing
                }
              }
              if (!imgData) continue;
              contentBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: (img.type || 'image/png') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                  data: imgData,
                },
              });
            }

            if (droppedCount > 0) {
              contentBlocks.push({ type: 'text', text: `[Note: ${droppedCount} older image(s) were omitted due to the ${MAX_MEDIA_ITEMS}-image limit per request.]` });
            }
            contentBlocks.push({ type: 'text', text: textWithImageRefs });

            const userMessage: SDKUserMessage = {
              type: 'user',
              message: {
                role: 'user',
                content: contentBlocks,
              },
              parent_tool_use_id: null,
              session_id: sdkSessionId || '',
            };

            return (async function* () {
              yield userMessage;
            })();
          }

          return textPrompt;
        }

        const finalPrompt = buildFinalPrompt(!shouldResume);

        // Try to start the conversation. If resuming a previous session fails
        // (e.g. stale/corrupt session file, CLI version mismatch), automatically
        // fall back to starting a fresh conversation without resume.
        let conversation = query({
          prompt: finalPrompt,
          options: queryOptions,
        });
        // Keep a handle to the underlying Query instance for control-API
        // calls (getContextUsage etc.). When we peek-and-rewrap below to
        // detect resume failures, `conversation` becomes a plain async
        // generator that loses the Query prototype's methods — we need
        // this original reference to call .getContextUsage() at result
        // time. Reassigned on resume-fallback to point at the fresh Query.
        let controlQuery = conversation;

        // Wrap the iterator so we can detect resume failures on the first message
        if (shouldResume) {
          try {
            // Peek at the first message to verify resume works
            const iter = conversation[Symbol.asyncIterator]();
            const first = await iter.next();

            // Re-wrap into an async iterable that yields the first message then the rest
            conversation = (async function* () {
              if (!first.done) yield first.value;
              while (true) {
                const next = await iter.next();
                if (next.done) break;
                yield next.value;
              }
            })() as ReturnType<typeof query>;
            // controlQuery still points at the original Query with
            // getContextUsage() available.
          } catch (resumeError) {
            latencyResumeFallback = true;
            const errMsg = resumeError instanceof Error ? resumeError.message : String(resumeError);
            console.warn('[claude-client] Resume failed, retrying without resume:', errMsg);
            // Clear stale sdk_session_id so future messages don't retry this broken resume
            if (sessionId) {
              clearSdkSessionIfOwner(sessionId, options.lockId);
            }
            // Notify frontend about the fallback
            controller.enqueue(formatSSE({
              type: 'status',
              data: JSON.stringify({
                _internal: true,
                resumeFallback: true,
                title: 'Session fallback',
                message: 'Previous session could not be resumed. Starting fresh conversation.',
              }),
            }));
            // Remove resume and try again as a fresh conversation with history context
            delete queryOptions.resume;
            conversation = query({
              prompt: buildFinalPrompt(true),
              options: queryOptions,
            });
            // Fresh Query replaces the old handle — control-API calls
            // now go through this one.
            controlQuery = conversation;
          }
        }

        registerConversation(sessionId, conversation, options.lockId);

        // Defer capability capture until first assistant response to avoid
        // competing with first-token latency. Skip entirely if cache is fresh.
        const capProviderId = resolved.provider?.api_key ? resolved.provider.id || 'custom' : 'env';
        let capturePending = !isCacheFresh(capProviderId);

        let tokenUsage: TokenUsage | null = null;
        // Track pending TodoWrite tool_use_ids so we can sync after successful execution
        const pendingTodoWrites = new Map<string, Array<{ content: string; status: string; activeForm?: string }>>();
        for await (const message of conversation) {
          if (abortController?.signal.aborted) {
            break;
          }

          switch (message.type) {
            case 'assistant': {
              // Deferred capability capture: trigger after first assistant message
              if (capturePending) {
                capturePending = false;
                captureCapabilities(sessionId, conversation, capProviderId).catch((err) => {
                  console.warn('[claude-client] Deferred capability capture failed:', err);
                });
              }
              const assistantMsg = message as SDKAssistantMessage;
              // Text deltas are handled by stream_event for real-time streaming.
              // Here we only process tool_use blocks.

              // Check for tool use blocks
              for (const block of assistantMsg.message.content) {
                if (block.type === 'tool_use') {
                  // Phase 7 — accumulate for Context Accounting at result time.
                  toolInvocationAccumulator.recordToolUse(block.id, block.name, block.input);

                  controller.enqueue(formatSSE({
                    type: 'tool_use',
                    data: JSON.stringify({
                      id: block.id,
                      name: block.name,
                      input: block.input,
                    }),
                  }));

                  // Track TodoWrite calls — sync deferred until tool_result confirms success
                  if (block.name === 'TodoWrite') {
                    try {
                      const toolInput = block.input as {
                        todos?: Array<{ content: string; status: string; activeForm?: string }>;
                      };
                      if (toolInput?.todos && Array.isArray(toolInput.todos)) {
                        pendingTodoWrites.set(block.id, toolInput.todos);
                      }
                    } catch (e) {
                      console.warn('[claude-client] Failed to parse TodoWrite input:', e);
                    }
                  }
                }
              }
              break;
            }

            case 'user': {
              // Tool execution results come back as user messages with tool_result blocks
              const userMsg = message as SDKUserMessage;
              const content = userMsg.message.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'tool_result') {
                    let resultContent = typeof block.content === 'string'
                      ? block.content
                      : Array.isArray(block.content)
                        ? block.content
                            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                            .map((c) => c.text)
                            .join('\n')
                        : String(block.content ?? '');

                    // Extract media blocks (image/audio) from MCP tool results.
                    // Two sources:
                    // 1. SDK content array: image/audio blocks with base64 data (external MCP servers)
                    // 2. MEDIA_RESULT_MARKER in text: localPath-based media from in-process MCP tools
                    //    (SDK strips image blocks from in-process tool results, so we use a text marker)
                    const mediaBlocks: MediaBlock[] = [];
                    if (Array.isArray(block.content)) {
                      for (const c of block.content) {
                        const cb = c as { type: string; data?: string; mimeType?: string; media_type?: string };
                        if ((cb.type === 'image' || cb.type === 'audio') && cb.data) {
                          mediaBlocks.push({
                            type: cb.type === 'audio' ? 'audio' : 'image',
                            data: cb.data,
                            mimeType: cb.mimeType || cb.media_type || (cb.type === 'image' ? 'image/png' : 'audio/wav'),
                          });
                        }
                      }
                    }
                    // Detect MEDIA_RESULT_MARKER in text result (from codepilot-image-gen MCP)
                    const MEDIA_MARKER = '__MEDIA_RESULT__';
                    const markerIdx = resultContent.indexOf(MEDIA_MARKER);
                    if (markerIdx >= 0) {
                      try {
                        const mediaJson = resultContent.slice(markerIdx + MEDIA_MARKER.length).trim();
                        const parsed = JSON.parse(mediaJson) as Array<{ type: string; mimeType: string; localPath: string; mediaId?: string }>;
                        for (const m of parsed) {
                          mediaBlocks.push({
                            type: (m.type as MediaBlock['type']) || 'image',
                            mimeType: m.mimeType,
                            localPath: m.localPath,
                            mediaId: m.mediaId,
                          });
                        }
                      } catch {
                        // Malformed marker payload — ignore
                      }
                      // Strip marker from content so it's not shown in the UI
                      resultContent = resultContent.slice(0, markerIdx).trim();
                    }

                    const ssePayload: Record<string, unknown> = {
                      tool_use_id: block.tool_use_id,
                      content: resultContent,
                      is_error: block.is_error || false,
                    };
                    if (mediaBlocks.length > 0) {
                      ssePayload.media = mediaBlocks;
                    }
                    // Phase 7 — accumulate for Context Accounting at result time.
                    // resultContent is already string-normalized (text-only join,
                    // media stripped, MEDIA_RESULT_MARKER trimmed above).
                    toolInvocationAccumulator.recordToolResult(block.tool_use_id, resultContent);

                    controller.enqueue(formatSSE({
                      type: 'tool_result',
                      data: JSON.stringify(ssePayload),
                    }));

                    // Deferred TodoWrite sync: only emit task_update after successful execution
                    if (!block.is_error && pendingTodoWrites.has(block.tool_use_id)) {
                      const todos = pendingTodoWrites.get(block.tool_use_id)!;
                      pendingTodoWrites.delete(block.tool_use_id);
                      controller.enqueue(formatSSE({
                        type: 'task_update',
                        data: JSON.stringify({
                          session_id: sessionId,
                          todos: todos.map((t, i) => ({
                            id: String(i),
                            content: t.content,
                            status: t.status,
                            activeForm: t.activeForm || '',
                          })),
                        }),
                      }));
                    }
                  }
                }
              }

              // Emit rewind_point for file checkpointing — only for prompt-level
              // user messages (parent_tool_use_id === null), and skip auto-trigger
              // turns which are invisible to the user (onboarding/check-in).
              if (
                userMsg.parent_tool_use_id === null &&
                !autoTrigger &&
                userMsg.uuid
              ) {
                controller.enqueue(formatSSE({
                  type: 'rewind_point',
                  data: JSON.stringify({ userMessageId: userMsg.uuid }),
                }));
              }
              break;
            }

            case 'stream_event': {
              const streamEvent = message as SDKPartialAssistantMessage;
              if (
                observedTtftMs === undefined &&
                typeof streamEvent.ttft_ms === 'number' &&
                Number.isFinite(streamEvent.ttft_ms) &&
                streamEvent.ttft_ms >= 0
              ) {
                observedTtftMs = streamEvent.ttft_ms;
              }
              const evt = streamEvent.event;
              if (evt.type === 'content_block_delta' && 'delta' in evt) {
                const delta = evt.delta;
                if ('text' in delta && delta.text) {
                  controller.enqueue(formatSSE({ type: 'text', data: delta.text }));
                }
                if ('thinking' in delta && (delta as { thinking?: string }).thinking) {
                  controller.enqueue(formatSSE({ type: 'thinking', data: (delta as { thinking: string }).thinking }));
                }
              }
              break;
            }

            case 'system': {
              const sysMsg = message as SDKSystemMessage;
              if ('subtype' in sysMsg) {
                if (sysMsg.subtype === 'init') {
                  const initMsg = sysMsg as SDKSystemMessage & {
                    slash_commands?: unknown;
                    skills?: unknown;
                    plugins?: Array<{ name: string; path: string }>;
                    mcp_servers?: unknown;
                    output_style?: string;
                  };
                  controller.enqueue(formatSSE({
                    type: 'status',
                    data: JSON.stringify({
                      session_id: sysMsg.session_id,
                      model: sysMsg.model,
                      requested_model: model,
                      tools: sysMsg.tools,
                      slash_commands: initMsg.slash_commands,
                      skills: initMsg.skills,
                      plugins: initMsg.plugins,
                      mcp_servers: initMsg.mcp_servers,
                      output_style: initMsg.output_style,
                    }),
                  }));

                  // Cache loaded plugins from init meta for cross-reference in skills route.
                  // Always set — including empty array — so stale data from a previous
                  // session that had plugins doesn't leak into a session without plugins.
                  // capProviderId is defined at line 786 in the same scope.
                  setCachedPlugins(capProviderId, Array.isArray(initMsg.plugins) ? initMsg.plugins : []);
                } else if (sysMsg.subtype === 'status') {
                  // SDK sends status messages when permission mode changes (e.g. ExitPlanMode)
                  const statusMsg = sysMsg as SDKSystemMessage & { permissionMode?: string };
                  if (statusMsg.permissionMode) {
                    controller.enqueue(formatSSE({
                      type: 'mode_changed',
                      data: statusMsg.permissionMode,
                    }));
                  }
                } else if (sysMsg.subtype === 'task_notification') {
                  // Agent task completed/failed/stopped — surface as notification
                  const taskMsg = sysMsg as SDKSystemMessage & {
                    status: string; summary: string; task_id: string;
                  };
                  const title = taskMsg.status === 'completed' ? 'Task completed' : `Task ${taskMsg.status}`;
                  controller.enqueue(formatSSE({
                    type: 'status',
                    data: JSON.stringify({
                      notification: true,
                      title,
                      message: taskMsg.summary || '',
                    }),
                  }));
                  if (!autoTrigger) {
                    notifyGeneric(title, taskMsg.summary || '', telegramOpts).catch(() => {});
                  }
                } else if ((sysMsg.subtype as string) === 'api_retry') {
                  // #635 — api_retry (SDKAPIRetryMessage) is the one real upstream-
                  // liveness signal during a slow turn: the SDK's own keep_alive is
                  // filtered out before the app iterator (see issue-635 design), so
                  // forward it as a status SSE → client onStatus → markActive resets
                  // the idle timer. Don't abort a turn that's actively retrying
                  // upstream. (UI copy "上游重试中" is a follow-up.)
                  const retryMsg = message as { attempt?: number; max_retries?: number };
                  observedApiRetryCount += 1;
                  controller.enqueue(formatSSE({
                    type: 'status',
                    data: JSON.stringify({
                      apiRetry: true,
                      attempt: retryMsg.attempt,
                      maxRetries: retryMsg.max_retries,
                    }),
                  }));
                }
              }
              break;
            }

            case 'tool_progress': {
              const progressMsg = message as SDKToolProgressMessage;
              controller.enqueue(formatSSE({
                type: 'tool_output',
                data: JSON.stringify({
                  _progress: true,
                  tool_use_id: progressMsg.tool_use_id,
                  tool_name: progressMsg.tool_name,
                  elapsed_time_seconds: progressMsg.elapsed_time_seconds,
                }),
              }));
              // Auto-timeout: abort if tool runs longer than configured threshold
              if (toolTimeoutSeconds > 0 && progressMsg.elapsed_time_seconds >= toolTimeoutSeconds) {
                controller.enqueue(formatSSE({
                  type: 'tool_timeout',
                  data: JSON.stringify({
                    tool_name: progressMsg.tool_name,
                    elapsed_seconds: Math.round(progressMsg.elapsed_time_seconds),
                  }),
                }));
                abortController?.abort();
              }
              break;
            }

            case 'result': {
              const resultMsg = message as SDKResultMessage;
              // Forward the requested alias + resolved upstream so
              // pickModelUsage can find the right entry in modelUsage —
              // third-party Anthropic-compat proxies sometimes key the
              // map by upstream id rather than the alias the user
              // picked. See pickModelUsage doc for the full priority.
              tokenUsage = extractTokenUsage(resultMsg, {
                requested: model,
                upstream: resolved.upstreamModel,
                // #632: only persist the SDK-reported window for a first-party
                // Anthropic endpoint (effective base URL, computed above).
                trustContextWindow: trustSdkContextWindow,
              });
              // terminal_reason is an optional field added in SDK 0.2.111.
              // When present, it enriches the end-of-turn UI chip (Phase 1 of
              // agent-sdk-0-2-111-adoption) without replacing error-classifier.
              const terminalReason = (resultMsg as SDKResultMessage & { terminal_reason?: string }).terminal_reason;
              // Phase 7 — produce Context Accounting snapshot from accumulated
              // tool_use / tool_result records. Real invocation data only;
              // empty records → entries omit (no fabrication).
              // Replaces Phase 2 streamClaude-start produce (deleted above).
              let contextAccountingSnapshot:
                | import('@/types').RuntimeContextAccountingSnapshot
                | undefined;
              try {
                const { collectAutoInvokeSnapshot, resolveWorkspaceClaudeMdRules } =
                  await import('@/lib/harness/auto-invoke-accounting');
                contextAccountingSnapshot = collectAutoInvokeSnapshot({
                  workspacePath: resolvedWorkingDirectory.path,
                  records: toolInvocationAccumulator.drain(),
                  producedBy: 'claude_code',
                  selectedSkills: options.selectedSkills,
                  // Phase 7 ClaudeCode unsupported list — system_prompt opaque
                  // (SDK preset), memory not wired (Phase 6.x), files_attachments
                  // goes through composer pending channel not Runtime.
                  unsupported: ['system_prompt', 'memory', 'files_attachments'],
                  resolveRulesEntry: resolveWorkspaceClaudeMdRules,
                });
              } catch {
                // Best-effort: producer failed → snapshot stays undefined,
                // result event falls back to raw tokenUsage (popover hides
                // Runtime kinds rather than showing fake data).
              }
              const usageWithAccounting =
                tokenUsage && contextAccountingSnapshot
                  ? { ...tokenUsage, context_accounting: contextAccountingSnapshot }
                  : tokenUsage;
              const { attachClaudeRuntimeLatency, logClaudeRuntimeLatency } = await import('./claude-latency');
              const usageWithLatency = attachClaudeRuntimeLatency(usageWithAccounting, {
                ttftMs: observedTtftMs,
                durationMs: resultMsg.duration_ms,
                durationApiMs: resultMsg.duration_api_ms,
                wallMs: Date.now() - latencyStartedAt,
                apiRetryCount: observedApiRetryCount,
                terminalType: resultMsg.subtype,
                resumeAttempted: latencyResumeAttempted,
                resumeFallback: latencyResumeFallback,
              });
              logClaudeRuntimeLatency(usageWithLatency);
              // #629 — SDKResultError carries errors[]; SDKResultSuccess doesn't,
              // so read it via cast (mirrors the terminal_reason access above).
              const resultErrors = (resultMsg as SDKResultMessage & { errors?: string[] }).errors ?? [];
              controller.enqueue(formatSSE({
                type: 'result',
                data: JSON.stringify({
                  subtype: resultMsg.subtype,
                  is_error: resultMsg.is_error,
                  num_turns: resultMsg.num_turns,
                  duration_ms: resultMsg.duration_ms,
                  usage: usageWithLatency,
                  session_id: resultMsg.session_id,
                  // #629 — surface raw errors / stop_reason for diagnostics so the
                  // UI and logs see more than the generic `error_during_execution`.
                  ...(resultMsg.is_error && resultErrors.length ? { errors: resultErrors } : {}),
                  ...(resultMsg.stop_reason ? { stop_reason: resultMsg.stop_reason } : {}),
                  ...(terminalReason ? { terminal_reason: terminalReason } : {}),
                }),
              }));
              resultEmitted = true; // #577 — turn succeeded; suppress any post-result error
              // Notify on conversation-level errors (e.g. rate limit, auth failure)
              if (resultMsg.is_error) {
                // #629 — a stale/bad resume returns as an is_error RESULT (not a
                // throw): third-party Anthropic proxies send errors[0]="No
                // conversation found with session ID: <sid>". The resume-peek catch
                // (~1574) and the crash cleanup (~2350, gated on !resultEmitted)
                // don't cover this — resultEmitted is already true here. Clear the
                // bad sdk_session_id so the next message starts fresh, but ONLY for
                // resume/session-state errors; transient rate-limit/auth/budget must
                // keep it (clearing drops SDK-side context). Orthogonal to #577:
                // that guard is in the post-result catch; this is the result itself.
                if (sessionId && isSessionStateResultError(resultErrors, {
                  providerName: resolved.provider?.name,
                  baseUrl: resolved.provider?.base_url,
                })) {
                  clearSdkSessionIfOwner(sessionId, options.lockId);
                }
                const errTitle = 'Conversation error';
                const errMsg = resultMsg.subtype || 'The conversation ended with an error';
                controller.enqueue(formatSSE({
                  type: 'status',
                  data: JSON.stringify({ notification: true, title: errTitle, message: errMsg }),
                }));
                // Skip Telegram for auto-trigger turns (onboarding/heartbeat)
                if (!autoTrigger) {
                  notifyGeneric(errTitle, errMsg, telegramOpts).catch(() => {});
                }
              }

              // Phase 5 — context-usage snapshot via Query.getContextUsage()
              // is intentionally NOT called here.
              //
              // getContextUsage() is a SDK control-API request that shares
              // the same message channel as the for-await-of iterator we're
              // inside. Awaiting it blocks the iterator from advancing,
              // which prevents the control-response frame from arriving —
              // the Query then closes on result and the call errors out
              // with "Query closed before response received". There's no
              // stable place outside the iteration loop where the Query
              // is still alive.
              //
              // The chat-page indicator doesn't suffer from this: it
              // already computes used-tokens from the SDKResultMessage's
              // own `usage` field (input + cache_read + cache_creation),
              // which is SDK-authoritative and carries <5% drift against
              // what getContextUsage would report. The snapshot would
              // only add category-level breakdown (system prompt / tools
              // / user / memory) that the current UI doesn't surface.
              //
              // The SSE 'context_usage' event type and stream-session-
              // manager snapshot field stay in place as extension points
              // — a future Phase that needs category breakdown can fire
              // them from a different point in the SDK lifecycle (e.g.
              // from a background control-channel timer, or from a
              // lifecycle hook the SDK may expose later).
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const _unusedControlQuery = controlQuery;
              break;
            }

            default: {
              const mType = (message as { type: string }).type;
              if (mType === 'keep_alive') {
                // #635 — DEAD BRANCH: the SDK transport (Query.readMessages) does
                // `continue` on keep_alive before the app iterator, so the public
                // query() iterator never yields it. Kept for completeness; the real
                // fix for slow-proxy idle is the two-tier budget in
                // stream-session-manager + the api_retry status above.
                controller.enqueue(formatSSE({ type: 'keep_alive', data: '' }));
              } else if (mType === 'rate_limit_event') {
                // SDK 0.2.111+ — subscription rate limit telemetry. SDK
                // only emits these for claude.ai subscription paths, so
                // API-key / third-party provider sessions won't see this
                // branch. Forward verbatim so the UI can render a
                // warning banner (allowed_warning) or a closable recovery
                // panel (rejected) per Phase 2 of agent-sdk-0-2-111.
                const rlEvent = message as {
                  type: 'rate_limit_event';
                  rate_limit_info: {
                    status: 'allowed' | 'allowed_warning' | 'rejected';
                    resetsAt?: number;
                    rateLimitType?: string;
                    utilization?: number;
                    overageStatus?: string;
                    overageResetsAt?: number;
                    overageDisabledReason?: string;
                    isUsingOverage?: boolean;
                  };
                  session_id: string;
                };
                controller.enqueue(formatSSE({
                  type: 'rate_limit',
                  data: JSON.stringify(rlEvent.rate_limit_info),
                }));
              }
              break;
            }
          }
        }

        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : 'Unknown error';
        // Log full error details for debugging (visible in terminal / dev tools)
        const stderrContent = error instanceof Error ? (error as { stderr?: string }).stderr : undefined;
        console.error('[claude-client] Stream error:', {
          message: rawMessage,
          stack: error instanceof Error ? error.stack : undefined,
          cause: error instanceof Error ? (error as { cause?: unknown }).cause : undefined,
          stderr: stderrContent,
          code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
        });

        // Look up preset meta for recovery action URLs
        const presetForMeta = resolved.provider?.base_url
          ? (await import('./provider-catalog')).findPresetForLegacy(resolved.provider.base_url, resolved.provider.provider_type, resolved.protocol, resolved.provider.preset_key)
          : undefined;

        // Classify the error using structured pattern matching
        const classified = classifyError({
          error,
          stderr: stderrContent,
          providerName: resolved.provider?.name,
          baseUrl: resolved.provider?.base_url,
          hasImages: files && files.some(f => isImageFile(f.type)),
          thinkingEnabled: !!thinking,
          context1mEnabled: !!context1m,
          effortSet: !!effort,
          providerMeta: presetForMeta?.meta ? {
            apiKeyUrl: presetForMeta.meta.apiKeyUrl,
            docsUrl: presetForMeta.meta.docsUrl,
            pricingUrl: presetForMeta.meta.pricingUrl,
          } : undefined,
        });

        // ── Reactive compact: auto-compress and retry on CONTEXT_TOO_LONG ──
        if (classified.category === 'CONTEXT_TOO_LONG' && !ptlRetryAttempted && !resultEmitted && conversationHistory && conversationHistory.length > 4) {
          ptlRetryAttempted = true;
          try {
            console.log('[claude-client] CONTEXT_TOO_LONG detected — attempting auto-compress + retry');
            controller.enqueue(formatSSE({ type: 'status', data: JSON.stringify({ notification: true, message: 'context_compressing_retry' }) }));

            const { compressConversation, resolveReactiveCompactBoundaryRowid } = await import('./context-compressor');
            const { updateSessionSummary: updateSummary, getSessionSummary } = await import('@/lib/db');
            const compResult = await compressConversation({
              sessionId,
              messages: conversationHistory,
              existingSummary: options.sessionSummary,
              providerId: options.providerId || options.sessionProviderId,
              sessionModel: model,
            });
            // Derive boundary from rowids plumbed through conversationHistory.
            // Invariant: reactive compact here hands the WHOLE
            // conversationHistory to compressConversation — no keep/compress
            // split — so the last row with a known _rowid is exactly the
            // last DB row this summary covers.
            //
            // Fallback (no _rowid in history): use Math.max of the DB's
            // CURRENT boundary and the caller's hint. Re-reading DB here
            // matters because an auto pre-compression earlier in the same
            // request may have already advanced the boundary past what
            // options.sessionSummaryBoundaryRowid captured (that value was
            // snapshotted in chat/route.ts before auto pre-compression ran).
            // Without the re-read, a degraded reactive compact could
            // silently roll the DB boundary back to a stale value.
            const existingBoundary = Math.max(
              getSessionSummary(sessionId).boundaryRowid,
              options.sessionSummaryBoundaryRowid ?? 0,
            );
            const reactiveBoundaryRowid = resolveReactiveCompactBoundaryRowid({
              history: conversationHistory,
              existingBoundaryRowid: existingBoundary,
            });
            updateSummary(sessionId, compResult.summary, reactiveBoundaryRowid);
            options.sessionSummary = compResult.summary;
            // Recalculate fallback budget with new summary size
            const newSummaryTokens = roughTokenEstimate(compResult.summary);
            const promptTokens = roughTokenEstimate(prompt);
            const systemTokens = roughTokenEstimate(systemPrompt || '');
            // Use a conservative 50% of actual context window for retry
            const { getContextWindow } = await import('./model-context');
            const ctxWindow = getContextWindow(model || 'sonnet', { context1m: !!context1m }) || 200000;
            const retryBudget = Math.max(10000, Math.floor(ctxWindow * 0.5 - systemTokens - newSummaryTokens - promptTokens));
            console.log(`[claude-client] Compressed ${compResult.messagesCompressed} messages for PTL retry, budget=${retryBudget}`);

            // Clear stale session so retry starts fresh
            if (sessionId) {
              clearSdkSessionIfOwner(sessionId, options.lockId);
            }

            // Build retry prompt using compressed context with recalculated budget
            const retryPrompt = buildFallbackContext({
              prompt,
              history: conversationHistory,
              sessionSummary: options.sessionSummary,
              tokenBudget: retryBudget,
            });

            // Rebuild minimal query options from closure variables
            // (queryOptions is scoped to the try block and not accessible here)
            const retryOptions: Options = {
              cwd: options.workingDirectory || os.homedir(),
              abortController,
              permissionMode: 'bypassPermissions' as Options['permissionMode'],
              allowDangerouslySkipPermissions: true,
              env: { ...process.env as Record<string, string> },
              maxTurns: undefined,
            };
            if (model) retryOptions.model = model;
            if (systemPrompt) {
              retryOptions.systemPrompt = { type: 'preset', preset: 'claude_code', append: systemPrompt };
            }

            const retryConversation = query({ prompt: retryPrompt, options: retryOptions });

            // Forward retry stream events (simplified — covers the critical path)
            for await (const msg of retryConversation) {
              if (abortController?.signal.aborted) break;
              switch (msg.type) {
                case 'system': {
                  // Forward init event so the chat route persists the NEW
                  // sdk_session_id. Without this, the session row keeps an
                  // empty sdk_session_id (cleared above at line ~1619) and the
                  // next user message goes back through buildFallbackContext,
                  // re-exposing prior-tool-call history to the model.
                  const sysMsg = msg as SDKSystemMessage;
                  if ('subtype' in sysMsg && sysMsg.subtype === 'init') {
                    controller.enqueue(formatSSE({
                      type: 'status',
                      data: JSON.stringify({
                        session_id: sysMsg.session_id,
                        model: sysMsg.model,
                        requested_model: model,
                        tools: sysMsg.tools,
                      }),
                    }));
                  } else if ('subtype' in sysMsg && (sysMsg.subtype as string) === 'api_retry') {
                    const retryMsg = msg as { attempt?: number; max_retries?: number };
                    observedApiRetryCount += 1;
                    controller.enqueue(formatSSE({
                      type: 'status',
                      data: JSON.stringify({
                        apiRetry: true,
                        attempt: retryMsg.attempt,
                        maxRetries: retryMsg.max_retries,
                      }),
                    }));
                  }
                  break;
                }
                case 'assistant': {
                  // Text deltas are forwarded via stream_event below; here we
                  // only emit tool_use blocks (matches main path at L1213).
                  const aMsg = msg as SDKAssistantMessage;
                  for (const block of aMsg.message.content) {
                    if (block.type === 'tool_use') {
                      // Phase 7 — accumulator shared with main path so retry tool calls also count.
                      toolInvocationAccumulator.recordToolUse(block.id, block.name, block.input);
                      controller.enqueue(formatSSE({ type: 'tool_use', data: JSON.stringify({ id: block.id, name: block.name, input: block.input }) }));
                    }
                  }
                  break;
                }
                case 'user': {
                  const uMsg = msg as { type: 'user'; message: { content: Array<{ type: string; content?: string | Array<Record<string, unknown>>; tool_use_id?: string; is_error?: boolean }> } };
                  for (const block of uMsg.message.content) {
                    if (block.type === 'tool_result') {
                      const retryMedia: MediaBlock[] = [];
                      let retryContent = '';

                      if (Array.isArray(block.content)) {
                        // Array-form tool result (external MCP): extract text + image/audio blocks
                        const textParts: string[] = [];
                        for (const c of block.content) {
                          const cb = c as { type: string; text?: string; data?: string; mimeType?: string; media_type?: string };
                          if (cb.type === 'text' && cb.text) {
                            textParts.push(cb.text);
                          } else if ((cb.type === 'image' || cb.type === 'audio') && cb.data) {
                            retryMedia.push({
                              type: cb.type === 'audio' ? 'audio' : 'image',
                              data: cb.data,
                              mimeType: cb.mimeType || cb.media_type || (cb.type === 'image' ? 'image/png' : 'audio/wav'),
                            });
                          }
                        }
                        retryContent = textParts.join('\n').slice(0, 2000);
                      } else if (typeof block.content === 'string') {
                        retryContent = block.content.slice(0, 2000);
                      }

                      // Extract __MEDIA_RESULT__ markers from text content
                      const RETRY_MEDIA_MARKER = '__MEDIA_RESULT__';
                      const retryMarkerIdx = retryContent.indexOf(RETRY_MEDIA_MARKER);
                      if (retryMarkerIdx >= 0) {
                        try {
                          const mediaJson = retryContent.slice(retryMarkerIdx + RETRY_MEDIA_MARKER.length).trim();
                          const parsed = JSON.parse(mediaJson) as Array<{ type: string; mimeType: string; localPath: string; mediaId?: string }>;
                          for (const m of parsed) {
                            retryMedia.push({
                              type: (m.type as MediaBlock['type']) || 'image',
                              mimeType: m.mimeType,
                              localPath: m.localPath,
                              mediaId: m.mediaId,
                            });
                          }
                        } catch { /* malformed marker */ }
                        retryContent = retryContent.slice(0, retryMarkerIdx).trim();
                      }

                      // Phase 7 — accumulator shared; pair with main path tool_use ids.
                      if (block.tool_use_id) {
                        toolInvocationAccumulator.recordToolResult(block.tool_use_id, retryContent);
                      }
                      controller.enqueue(formatSSE({ type: 'tool_result', data: JSON.stringify({
                        tool_use_id: block.tool_use_id,
                        content: retryContent,
                        ...(block.is_error ? { is_error: true } : {}),
                        ...(retryMedia.length > 0 ? { media: retryMedia } : {}),
                      }) }));
                    }
                  }
                  break;
                }
                case 'stream_event': {
                  const se = msg as SDKPartialAssistantMessage;
                  if (
                    observedTtftMs === undefined &&
                    typeof se.ttft_ms === 'number' &&
                    Number.isFinite(se.ttft_ms) &&
                    se.ttft_ms >= 0
                  ) {
                    observedTtftMs = se.ttft_ms;
                  }
                  if (se.event.type === 'content_block_delta') {
                    const delta = 'delta' in se.event ? se.event.delta : undefined;
                    if (delta && 'text' in delta && delta.text) {
                      controller.enqueue(formatSSE({ type: 'text', data: delta.text }));
                    }
                    if (delta && 'thinking' in delta && delta.thinking) {
                      controller.enqueue(formatSSE({ type: 'thinking', data: delta.thinking }));
                    }
                  }
                  break;
                }
                case 'result': {
                  const rMsg = msg as SDKResultMessage;
                  const usage = 'result' in rMsg
                    ? extractTokenUsage(rMsg as SDKResultSuccess, {
                        requested: model,
                        upstream: resolved.upstreamModel,
                        // #632: see the primary result path above.
                        trustContextWindow: trustSdkContextWindow,
                      })
                    : undefined;
                  // Phase 7 — alt path also produces Context Accounting snapshot
                  // from the same shared accumulator. Without this, retry-after-
                  // compression turns would lose Skills/MCP/Tools visibility.
                  // resolvedWorkingDirectory is scoped to outer try (line 736);
                  // use the same expression line 2057 uses for retry cwd.
                  const altWorkspacePath = options.workingDirectory || os.homedir();
                  let altContextAccounting:
                    | import('@/types').RuntimeContextAccountingSnapshot
                    | undefined;
                  try {
                    const { collectAutoInvokeSnapshot, resolveWorkspaceClaudeMdRules } =
                      await import('@/lib/harness/auto-invoke-accounting');
                    altContextAccounting = collectAutoInvokeSnapshot({
                      workspacePath: altWorkspacePath,
                      records: toolInvocationAccumulator.drain(),
                      producedBy: 'claude_code',
                      selectedSkills: options.selectedSkills,
                      unsupported: ['system_prompt', 'memory', 'files_attachments'],
                      resolveRulesEntry: resolveWorkspaceClaudeMdRules,
                    });
                  } catch {
                    // Best-effort; degrade to raw usage if producer fails.
                  }
                  const altUsageWithAccounting =
                    usage && altContextAccounting
                      ? { ...usage, context_accounting: altContextAccounting }
                      : usage;
                  const { attachClaudeRuntimeLatency, logClaudeRuntimeLatency } = await import('./claude-latency');
                  const altUsageWithLatency = attachClaudeRuntimeLatency(altUsageWithAccounting, {
                    ttftMs: observedTtftMs,
                    durationMs: rMsg.duration_ms,
                    durationApiMs: rMsg.duration_api_ms,
                    wallMs: Date.now() - latencyStartedAt,
                    apiRetryCount: observedApiRetryCount,
                    terminalType: rMsg.subtype,
                    resumeAttempted: latencyResumeAttempted,
                    resumeFallback: true,
                  });
                  logClaudeRuntimeLatency(altUsageWithLatency);
                  // Match main-path result shape so the chat route can persist
                  // the new sdk_session_id (route reads result.session_id as a
                  // safety net when status init was missed).
                  controller.enqueue(formatSSE({
                    type: 'result',
                    data: JSON.stringify({
                      subtype: rMsg.subtype,
                      is_error: rMsg.is_error,
                      num_turns: rMsg.num_turns,
                      duration_ms: rMsg.duration_ms,
                      usage: altUsageWithLatency,
                      session_id: rMsg.session_id,
                    }),
                  }));
                  resultEmitted = true; // #577 — retry produced a result; same guard applies
                  // Emit compression notification via the shared builder so
                  // useSSEStream's subtype=context_compressed dispatch fires.
                  const { buildContextCompressedStatus } = await import('./context-compressor');
                  controller.enqueue(formatSSE({
                    type: 'status',
                    data: JSON.stringify(buildContextCompressedStatus({
                      messagesCompressed: compResult.messagesCompressed,
                      tokensSaved: compResult.estimatedTokensSaved,
                    })),
                  }));
                  break;
                }
              }
            }
            controller.enqueue(formatSSE({ type: 'done', data: '' }));
            controller.close();
            return; // Retry succeeded — skip normal error path
          } catch (retryErr) {
            console.warn('[claude-client] PTL retry failed, falling through to error display:', retryErr);
            // Fall through to normal error handling below
          }
        }

        // Send structured error JSON so frontend can parse category + hints
        // (falls back gracefully for older frontends that only read raw text) —
        // but ONLY if the turn hadn't already emitted its result. #577: a
        // post-result rejection (iterator teardown racing capability capture,
        // late stderr, etc.) must not append an error bubble after a correct
        // answer; the result is authoritative, so we just finish the stream.
        if (!resultEmitted) {
          const errorMessage = formatClassifiedError(classified);
          controller.enqueue(formatSSE({
            type: 'error',
            data: JSON.stringify({
              category: classified.category,
              userMessage: classified.userMessage,
              actionHint: classified.actionHint,
              retryable: classified.retryable,
              providerName: classified.providerName,
              details: classified.details,
              rawMessage: classified.rawMessage,
              recoveryActions: classified.recoveryActions,
              // Include formatted text for backward compatibility
              _formattedMessage: errorMessage,
            }),
          }));
        } else {
          console.warn('[claude-client] suppressing post-result error (#577):', rawMessage);
        }
        controller.enqueue(formatSSE({ type: 'done', data: '' }));

        // Clear sdk_session_id on a genuine crash so the next message starts
        // fresh. Even for fresh sessions — the SDK may emit a session_id via
        // status event before crashing, which gets persisted by consumeStream/
        // SSE handlers. Leaving it would cause repeated resume failures.
        // #577: but NOT when the turn already produced a result — that session
        // is valid and the next turn should resume it; only post-result teardown
        // noise reached here, so preserve the session.
        if (sessionId && !resultEmitted) {
          clearSdkSessionIfOwner(
            sessionId,
            options.lockId,
            `[claude-client] Cleared stale sdk_session_id for session ${sessionId}`,
          );
        }

        controller.close();
      } finally {
        unregisterConversation(sessionId, options.lockId);
        // Tear down shadow ~/.claude/ if we built one. Best-effort — the OS
        // will eventually GC tmpdir even if this fails.
        if (shadowHome) {
          shadowHome.cleanup();
          shadowHome = null;
        }
      }
    },

    cancel() {
      abortController?.abort();
    },
  });
}

// ── Provider Connection Test ─────────────────────────────────────

export interface ConnectionTestResult {
  success: boolean;
  error?: {
    code: string;
    message: string;
    suggestion: string;
    recoveryActions?: Array<{ label: string; url?: string; action?: string }>;
  };
}

/**
 * Test a provider connection by sending a direct HTTP request to the API endpoint.
 * Bypasses the Claude Code SDK subprocess entirely to avoid false positives
 * from keychain/OAuth credentials leaking into the test.
 */
export async function testProviderConnection(config: {
  callScene: 'connection_test';
  apiKey: string;
  baseUrl: string;
  protocol: string;
  authStyle: string;
  envOverrides?: Record<string, string>;
  modelName?: string;
  presetKey?: string;
  providerName?: string;
  providerMeta?: { apiKeyUrl?: string; docsUrl?: string; pricingUrl?: string };
}): Promise<ConnectionTestResult> {
  const { getPreset, findPresetForLegacy } = await import('./provider-catalog');

  // Look up preset for default model
  const preset = config.presetKey
    ? getPreset(config.presetKey)
    : (config.baseUrl ? findPresetForLegacy(config.baseUrl, 'custom', config.protocol as import('./provider-catalog').Protocol, '') : undefined);

  // Determine model to use in test request
  const model = config.modelName
    || preset?.defaultRoleModels?.default
    || (preset?.defaultModels?.[0]?.upstreamModelId || preset?.defaultModels?.[0]?.modelId)
    || 'sonnet';

  // For bedrock/vertex/env_only protocols, we can't do a simple HTTP test
  if (config.protocol === 'bedrock' || config.protocol === 'vertex' || config.authStyle === 'env_only') {
    return {
      success: false,
      error: { code: 'SKIPPED', message: 'Cloud providers (Bedrock/Vertex) require IAM or OAuth credentials — connection test is not available for this provider type', suggestion: 'Save the configuration and send a message to verify' },
    };
  }

  // Media-only protocols: the rest of this function builds an Anthropic
  // /v1/messages probe with anthropic-version + x-api-key. That endpoint
  // doesn't exist for GPT Image or Nano Banana, so the generic probe would
  // always report failure even for correctly-configured providers. Route
  // them to a minimal image-API probe instead (both endpoints return a
  // 401/403 for bad auth and a 400/422 for a valid-but-rejected request,
  // which is enough to verify that the key reaches the right service).
  if (config.protocol === 'openai-image' || config.protocol === 'gemini-image') {
    return testMediaProviderConnection(config);
  }

  // OpenAI-compatible chat gateways speak /v1/chat/completions with Bearer
  // auth, NOT the Anthropic /v1/messages + x-api-key shape the generic probe
  // below builds. Without this branch an openai-compatible gateway is tested
  // against /v1/messages (always fails); worse, an empty base URL would fall
  // through to https://api.anthropic.com and send the user's key to the
  // official Anthropic API. Route to a dedicated OpenAI-shape probe.
  if (config.protocol === 'openai-compatible') {
    return testOpenAICompatibleConnection(config);
  }
  if (config.protocol === 'xai') {
    return testXaiConnection(config);
  }

  // Reject third-party / custom Anthropic providers without a base URL.
  // Otherwise the fallback to https://api.anthropic.com would test the
  // official endpoint, giving a misleading green signal before saving a
  // provider that in production would also resolve to api.anthropic.com
  // via the same fallback and silently inherit first-party catalog.
  // Users who genuinely want official Anthropic must pass the URL
  // explicitly (or choose the anthropic-official preset).
  if (config.protocol === 'anthropic' && !config.baseUrl?.trim()) {
    return {
      success: false,
      error: {
        code: 'MISSING_BASE_URL',
        message: 'Base URL is required for Anthropic-protocol providers',
        suggestion: 'Use https://api.anthropic.com for the official API or your third-party endpoint',
      },
    };
  }

  // Build the API URL — Anthropic-compatible endpoint.
  // baseUrl is guaranteed non-empty above for protocol='anthropic';
  // other protocols retain the historical fallback behavior.
  let apiUrl = config.baseUrl || 'https://api.anthropic.com';
  // Ensure URL ends with /v1/messages for Anthropic-compatible providers
  if (!apiUrl.endsWith('/v1/messages')) {
    apiUrl = apiUrl.replace(/\/+$/, '');
    if (!apiUrl.endsWith('/v1')) {
      apiUrl += '/v1';
    }
    apiUrl += '/messages';
  }

  // Build headers based on auth style
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (config.authStyle === 'auth_token') {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  } else {
    headers['x-api-key'] = config.apiKey;
  }

  // Minimal request body — just enough to verify auth + endpoint
  const body = JSON.stringify({
    model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    // 2xx = success (even if model returns an error in body, auth works)
    if (response.ok) {
      return { success: true };
    }

    // Parse error response
    let errorBody = '';
    try { errorBody = await response.text(); } catch { /* ignore */ }

    const classified = classifyError({
      error: new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`),
      providerName: config.providerName,
      baseUrl: config.baseUrl,
      providerMeta: config.providerMeta,
    });

    return {
      success: false,
      error: {
        code: classified.category,
        message: classified.userMessage,
        suggestion: classified.actionHint,
        recoveryActions: classified.recoveryActions,
      },
    };
  } catch (err) {
    clearTimeout(timeoutId);

    // Network errors (ECONNREFUSED, ENOTFOUND, timeout, etc.)
    const classified = classifyError({
      error: err,
      providerName: config.providerName,
      baseUrl: config.baseUrl,
      providerMeta: config.providerMeta,
    });

    return {
      success: false,
      error: {
        code: classified.category,
        message: classified.userMessage,
        suggestion: classified.actionHint,
        recoveryActions: classified.recoveryActions,
      },
    };
  }
}

/** Cheap, non-generating xAI API-key probe against the official model endpoint. */
async function testXaiConnection(config: {
  apiKey: string;
  baseUrl: string;
  providerName?: string;
  providerMeta?: { apiKeyUrl?: string; docsUrl?: string; pricingUrl?: string };
}): Promise<ConnectionTestResult> {
  const baseUrl = (config.baseUrl || 'https://api.x.ai/v1').replace(/\/+$/, '');
  if (baseUrl !== 'https://api.x.ai/v1') {
    return {
      success: false,
      error: {
        code: 'INVALID_ENDPOINT',
        message: 'xAI API Key connection tests only send credentials to https://api.x.ai/v1',
        suggestion: 'Choose the branded xAI API Key preset or restore its official Base URL',
      },
    };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${baseUrl}/models/grok-4.5`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (response.ok) return { success: true };

    let errorBody = '';
    try { errorBody = await response.text(); } catch { /* ignore */ }
    const classified = classifyError({
      error: new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`),
      providerName: config.providerName || 'xAI',
      baseUrl,
      providerMeta: config.providerMeta,
    });
    return {
      success: false,
      error: {
        code: classified.category,
        message: classified.userMessage,
        suggestion: classified.actionHint,
        recoveryActions: classified.recoveryActions,
      },
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const classified = classifyError({
      error: err,
      providerName: config.providerName || 'xAI',
      baseUrl,
      providerMeta: config.providerMeta,
    });
    return {
      success: false,
      error: {
        code: classified.category,
        message: classified.userMessage,
        suggestion: classified.actionHint,
        recoveryActions: classified.recoveryActions,
      },
    };
  }
}

/**
 * Connection probe for OpenAI-compatible chat gateways. Uses GET {base}/models
 * with Bearer auth — the same cheap, body-less, model-agnostic probe the OpenAI
 * image provider uses: 200 → auth + endpoint reachable, 401/403 → bad key. A
 * non-empty base URL is REQUIRED: an empty one must never fall back to
 * api.openai.com / api.anthropic.com (wrong service + the user's third-party
 * key would leak there).
 */
async function testOpenAICompatibleConnection(config: {
  apiKey: string;
  baseUrl: string;
  providerName?: string;
  providerMeta?: { apiKeyUrl?: string; docsUrl?: string; pricingUrl?: string };
}): Promise<ConnectionTestResult> {
  if (!config.baseUrl?.trim()) {
    return {
      success: false,
      error: {
        code: 'MISSING_BASE_URL',
        message: 'Base URL is required for OpenAI-compatible providers',
        suggestion: 'Enter your gateway endpoint, e.g. https://your-gateway.example.com/v1',
      },
    };
  }

  const apiUrl = `${config.baseUrl.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(apiUrl, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timeoutId);

    if (response.ok) return { success: true };

    let errorBody = '';
    try { errorBody = await response.text(); } catch { /* ignore */ }

    const classified = classifyError({
      error: new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`),
      providerName: config.providerName,
      baseUrl: config.baseUrl,
      providerMeta: config.providerMeta,
    });

    return {
      success: false,
      error: {
        code: classified.category,
        message: classified.userMessage,
        suggestion: classified.actionHint,
        recoveryActions: classified.recoveryActions,
      },
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const classified = classifyError({
      error: err,
      providerName: config.providerName,
      baseUrl: config.baseUrl,
      providerMeta: config.providerMeta,
    });

    return {
      success: false,
      error: {
        code: classified.category,
        message: classified.userMessage,
        suggestion: classified.actionHint,
        recoveryActions: classified.recoveryActions,
      },
    };
  }
}

/**
 * Connection probe for media providers (Gemini image, OpenAI image). Each
 * provider has a different authentication scheme and endpoint shape:
 *
 *   OpenAI Image:   Bearer auth, GET /v1/models is the cheapest reachable
 *                   probe (no body; returns 401 for bad keys, 200 for good).
 *   Gemini Image:   Google uses an API key query parameter, not a header.
 *                   GET /v1beta/models?key=... mirrors the same 401/200 shape.
 *
 * Using these instead of the Anthropic /v1/messages probe means a valid
 * media configuration no longer reports a false failure because it never
 * had /v1/messages to hit.
 */
async function testMediaProviderConnection(config: {
  apiKey: string;
  baseUrl: string;
  protocol: string;
  providerName?: string;
  providerMeta?: { apiKeyUrl?: string; docsUrl?: string; pricingUrl?: string };
}): Promise<ConnectionTestResult> {
  const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';
  const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const trimmed = (config.baseUrl || '').replace(/\/+$/, '');

  let apiUrl: string;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (config.protocol === 'openai-image') {
    const base = trimmed || DEFAULT_OPENAI_BASE;
    apiUrl = `${base}/models`;
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  } else {
    // gemini-image: Google AI Studio uses ?key=... query-string auth.
    const base = trimmed || DEFAULT_GEMINI_BASE;
    apiUrl = `${base}/models?key=${encodeURIComponent(config.apiKey)}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(apiUrl, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timeoutId);

    if (response.ok) return { success: true };

    let errorBody = '';
    try { errorBody = await response.text(); } catch { /* ignore */ }

    const classified = classifyError({
      error: new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`),
      providerName: config.providerName,
      baseUrl: config.baseUrl,
      providerMeta: config.providerMeta,
    });

    return {
      success: false,
      error: {
        code: classified.category,
        message: classified.userMessage,
        suggestion: classified.actionHint,
        recoveryActions: classified.recoveryActions,
      },
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const classified = classifyError({
      error: err,
      providerName: config.providerName,
      baseUrl: config.baseUrl,
      providerMeta: config.providerMeta,
    });
    return {
      success: false,
      error: {
        code: classified.category,
        message: classified.userMessage,
        suggestion: classified.actionHint,
        recoveryActions: classified.recoveryActions,
      },
    };
  }
}
