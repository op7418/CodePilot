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
import type { ClaudeStreamOptions, SSEEvent, TokenUsage, MCPServerConfig, PermissionRequestEvent, FileAttachment, MediaBlock } from '@/types';
import { isImageFile } from '@/types';
import { registerPendingPermission } from './permission-registry';
import { registerConversation, unregisterConversation } from './conversation-registry';
import { captureCapabilities, isCacheFresh, setCachedPlugins } from './agent-sdk-capabilities';
import { normalizeMessageContent, microCompactMessage } from './message-normalizer';
import { roughTokenEstimate } from './context-estimator';
import { getSetting, updateSdkSessionId, createPermissionRequest } from './db';
// Auto-approval is now handled at the CodePilot level, not via SDK bypassPermissions
import { resolveForClaudeCode, toClaudeCodeEnv } from './provider-resolver';
import { findClaudeBinary, findGitBash, getExpandedPath, invalidateClaudePathCache } from './platform';
import { notifyPermissionRequest, notifyGeneric } from './telegram-bot';
import { classifyError, formatClassifiedError } from './error-classifier';
import { resolveWorkingDirectory } from './working-directory';
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
 * Extract token usage from an SDK result message
 */
function extractTokenUsage(msg: SDKResultMessage): TokenUsage | null {
  if (!msg.usage) return null;
  return {
    input_tokens: msg.usage.input_tokens,
    output_tokens: msg.usage.output_tokens,
    cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
    cost_usd: 'total_cost_usd' in msg ? msg.total_cost_usd : undefined,
  };
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
  lines.push('(This is a summary of earlier conversation turns for context. Tool calls shown here were already executed — do not repeat them or output their markers as text.)');
  for (const msg of selected) {
    lines.push(`${msg.role === 'user' ? 'Human' : 'Assistant'}: ${msg.content}`);
  }
  lines.push('</conversation_history>');
  lines.push('');
  lines.push(prompt);
  return lines.join('\n');
}

/**
 * Lightweight text generation via the Claude Code SDK subprocess.
 * Uses the same provider/env resolution as streamClaude but without sessions,
 * MCP, permissions, or conversation history. Suitable for simple tasks like
 * generating tool descriptions.
 */
export async function generateTextViaSdk(params: {
  providerId?: string;
  model?: string;
  system: string;
  prompt: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const resolved = resolveForClaudeCode(undefined, {
    providerId: params.providerId,
  });

  const sdkEnv: Record<string, string> = { ...process.env as Record<string, string> };
  if (!sdkEnv.HOME) sdkEnv.HOME = os.homedir();
  if (!sdkEnv.USERPROFILE) sdkEnv.USERPROFILE = os.homedir();
  sdkEnv.PATH = getExpandedPath();
  delete sdkEnv.CLAUDECODE;

  if (process.platform === 'win32' && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    const gitBashPath = findGitBash();
    if (gitBashPath) sdkEnv.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath;
  }

  const resolvedEnv = toClaudeCodeEnv(sdkEnv, resolved);
  Object.assign(sdkEnv, resolvedEnv);

  const abortController = new AbortController();
  if (params.abortSignal) {
    params.abortSignal.addEventListener('abort', () => abortController.abort());
  }

  // Auto-timeout after 60s to prevent indefinite hangs
  const timeoutId = setTimeout(() => abortController.abort(), 60_000);

  const queryOptions: Options = {
    cwd: os.homedir(),
    abortController,
    permissionMode: 'acceptEdits',
    env: sanitizeEnv(sdkEnv),
    settingSources: resolved.settingSources as Options['settingSources'],
    systemPrompt: params.system,
    maxTurns: 1,
  };

  // Add auto-approval handler for this simple query
  const globalAutoApprove = getSetting('dangerously_skip_permissions') === 'true';
  if (globalAutoApprove) {
    queryOptions.canUseTool = async (toolName, _input, opts) => {
      console.log(`[claude-client] Auto-approved ${toolName} (auto-approval enabled)`);
      return {
        behavior: 'allow',
        updatedInput: _input,
        ...(opts.suggestions ? { updatedPermissions: opts.suggestions } : {}),
      };
    };
  }

  if (params.model) {
    queryOptions.model = params.model;
  }

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
  let resultText = '';
  try {
    for await (const msg of conversation) {
      if (msg.type === 'result' && 'result' in msg) {
        resultText = (msg as SDKResultSuccess).result || '';
      }
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (abortController.signal.aborted && !(params.abortSignal?.aborted)) {
      throw new Error('SDK query timed out after 60s');
    }
    throw err;
  }

  clearTimeout(timeoutId);

  if (!resultText) {
    throw new Error('SDK query returned no result');
  }

  return resultText;
}

export function streamClaude(options: ClaudeStreamOptions): ReadableStream<string> {
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
    imageAgentMode,
    bypassPermissions: sessionBypassPermissions,
    thinking,
    effort,
    outputFormat,
    agents,
    agent,
    enableFileCheckpointing,
    autoTrigger,
    context1m,
    generativeUI,
  } = options;

  return new ReadableStream<string>({
    async start(controller) {
      // Flag to prevent infinite PTL retry loops (at most one retry per request)
      let ptlRetryAttempted = false;

      // Resolve provider via the unified resolver. The caller may pass an explicit
      // provider (from resolveProvider().provider), or undefined when 'env' mode is
      // intended. We do NOT fall back to getActiveProvider() here — that's handled
      // inside resolveForClaudeCode() only when no resolution was attempted at all.
      const resolved = resolveForClaudeCode(options.provider, {
        providerId: options.providerId,
        sessionProviderId: options.sessionProviderId,
      });

      try {
        const resolvedWorkingDirectory = resolveWorkingDirectory([
          { path: workingDirectory, source: 'requested' },
        ]);

        if (workingDirectory && resolvedWorkingDirectory.source !== 'requested') {
          console.warn(
            `[claude-client] Working directory "${workingDirectory}" is unavailable, falling back to "${resolvedWorkingDirectory.path}"`,
          );
        }

        // Build env for the Claude Code subprocess.
        // Start with process.env (includes user shell env from Electron's loadUserShellEnv).
        // Then overlay any API config the user set in CodePilot settings (optional).
        const sdkEnv: Record<string, string> = { ...process.env as Record<string, string> };

        // Ensure HOME/USERPROFILE are set so Claude Code can find ~/.claude/commands/
        if (!sdkEnv.HOME) sdkEnv.HOME = os.homedir();
        if (!sdkEnv.USERPROFILE) sdkEnv.USERPROFILE = os.homedir();
        // Ensure SDK subprocess has expanded PATH (consistent with Electron mode)
        sdkEnv.PATH = getExpandedPath();

        // Remove CLAUDECODE env var to prevent "nested session" detection.
        // When CodePilot is launched from within a Claude Code CLI session
        // (e.g. during development), the child process inherits this variable
        // and the SDK refuses to start.
        delete sdkEnv.CLAUDECODE;

        // On Windows, auto-detect Git Bash if not already configured
        if (process.platform === 'win32' && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
          const gitBashPath = findGitBash();
          if (gitBashPath) {
            sdkEnv.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath;
          }
        }

        // Build env from resolved provider
        const resolvedEnv = toClaudeCodeEnv(sdkEnv, resolved);
        // toClaudeCodeEnv returns a full env — merge back into sdkEnv
        // (preserves HOME, USERPROFILE, PATH, Git Bash detection set above)
        Object.assign(sdkEnv, resolvedEnv);

        // Warn if no credentials found at all
        if (!resolved.hasCredentials && !sdkEnv.ANTHROPIC_API_KEY && !sdkEnv.ANTHROPIC_AUTH_TOKEN) {
          console.warn('[claude-client] No API key found: no active provider, no legacy settings, and no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN in environment');
        }

        // Check if auto-approval is enabled globally or per-session
        const globalAutoApprove = getSetting('dangerously_skip_permissions') === 'true';
        const shouldAutoApprove = globalAutoApprove || !!sessionBypassPermissions;

        const queryOptions: Options = {
          cwd: resolvedWorkingDirectory.path,
          abortController,
          includePartialMessages: true,
          permissionMode: (permissionMode as Options['permissionMode']) || 'acceptEdits',
          env: sanitizeEnv(sdkEnv),
          // Load settings so the SDK behaves like the CLI (tool permissions,
          // CLAUDE.md, etc.). When an active provider is configured in
          // CodePilot, skip 'user' settings because ~/.claude/settings.json
          // may contain env overrides (ANTHROPIC_BASE_URL, ANTHROPIC_MODEL,
          // etc.) that would conflict with the provider's configuration.
          settingSources: resolved.settingSources as Options['settingSources'],
        };

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

        // MCP servers: only pass explicitly provided config (e.g. from CodePilot UI).
        // User-level MCP config from ~/.claude.json and ~/.claude/settings.json
        // is now automatically loaded by the SDK via settingSources: ['user', 'project', 'local'].
        if (mcpServers && Object.keys(mcpServers).length > 0) {
          queryOptions.mcpServers = toSdkMcpConfig(mcpServers);
        }

        // Memory MCP: always registered in assistant mode for memory search/retrieval.
        // Unlike other MCPs which are keyword-gated, memory search is a core assistant capability.
        {
          const assistantWorkspacePath = getSetting('assistant_workspace_path');
          if (assistantWorkspacePath && resolvedWorkingDirectory.path === assistantWorkspacePath) {
            const { createMemorySearchMcpServer, MEMORY_SEARCH_SYSTEM_PROMPT } = await import('@/lib/memory-search-mcp');
            queryOptions.mcpServers = {
              ...(queryOptions.mcpServers || {}),
              'codepilot-memory': createMemorySearchMcpServer(assistantWorkspacePath),
            };
            if (queryOptions.systemPrompt && typeof queryOptions.systemPrompt === 'object' && 'append' in queryOptions.systemPrompt) {
              queryOptions.systemPrompt.append = (queryOptions.systemPrompt.append || '') + '\n\n' + MEMORY_SEARCH_SYSTEM_PROMPT;
            }
          }
        }

        // Notification + Schedule MCP: globally available in all contexts
        {
          const { createNotificationMcpServer, NOTIFICATION_MCP_SYSTEM_PROMPT } =
            await import('@/lib/notification-mcp');
          queryOptions.mcpServers = {
            ...(queryOptions.mcpServers || {}),
            'codepilot-notify': createNotificationMcpServer(),
          };
          if (queryOptions.systemPrompt && typeof queryOptions.systemPrompt === 'object' && 'append' in queryOptions.systemPrompt) {
            queryOptions.systemPrompt.append = (queryOptions.systemPrompt.append || '') + '\n\n' + NOTIFICATION_MCP_SYSTEM_PROMPT;
          }
        }

        // Widget guidelines: progressive loading strategy.
        // The system prompt always includes WIDGET_SYSTEM_PROMPT with format rules.
        // The MCP server (detailed design specs) is only registered when the
        // conversation likely involves widget generation — detected by keywords in
        // the user's prompt or existing show-widget output in conversation history.
        // This avoids SDK tool discovery overhead (~1s) on plain text conversations.
        if (generativeUI !== false) {
          const needsWidgetSpecs = (() => {
            const widgetKeywords = /可视化|图表|流程图|时间线|架构图|对比|visualiz|diagram|chart|flowchart|timeline|infographic|interactive|widget|show-widget|hierarchy|dashboard/i;
            // Check current user prompt
            if (widgetKeywords.test(prompt)) return true;
            // Check if conversation already has widgets (resume context)
            if (conversationHistory?.some(m => m.content.includes('show-widget'))) return true;
            // Check explicit widget/image-agent mode
            if (imageAgentMode) return true;
            return false;
          })();

          if (needsWidgetSpecs) {
            const { createWidgetMcpServer } = await import('@/lib/widget-guidelines');
            const widgetServer = createWidgetMcpServer();
            queryOptions.mcpServers = {
              ...(queryOptions.mcpServers || {}),
              'codepilot-widget': widgetServer,
            };
          }
        }

        // Media MCP: import + generation tools (keyword-gated).
        // Registered when the conversation involves media/image generation tasks
        // in CODE mode. Design Agent mode uses the old image-gen-request flow
        // and does NOT need these MCP tools.
        const needsMediaMcp = (() => {
          if (imageAgentMode) return false; // Design Agent uses its own flow
          const mediaKeywords = /生成图片|画一|图像|图片|素材|保存.*素材|import.*library|save.*library|codepilot_import_media|codepilot_generate_image/i;
          if (mediaKeywords.test(prompt)) return true;
          if (conversationHistory?.some(m =>
            mediaKeywords.test(m.content)
          )) return true;
          return false;
        })();

        if (needsMediaMcp) {
          const { createMediaImportMcpServer, MEDIA_MCP_SYSTEM_PROMPT } = await import('@/lib/media-import-mcp');
          const { createImageGenMcpServer } = await import('@/lib/image-gen-mcp');
          queryOptions.mcpServers = {
            ...(queryOptions.mcpServers || {}),
            'codepilot-media': createMediaImportMcpServer(sessionId, resolvedWorkingDirectory.path),
            'codepilot-image-gen': createImageGenMcpServer(sessionId, resolvedWorkingDirectory.path),
          };
          // Inject media capability hint into system prompt
          if (queryOptions.systemPrompt && typeof queryOptions.systemPrompt === 'object' && 'append' in queryOptions.systemPrompt) {
            queryOptions.systemPrompt.append = (queryOptions.systemPrompt.append || '') + '\n\n' + MEDIA_MCP_SYSTEM_PROMPT;
          }
        }

        // CLI tools MCP: tool management capabilities (keyword-gated).
        // Wide regex to cover natural phrasing like "帮我装 jq", "install uv",
        // "brew install", "pip install", "npm install -g", etc.
        const needsCliToolsMcp = (() => {
          const cliKeywords = /CLI\s*工具|cli.tool|安装.*工具|卸载.*工具|添加.*工具|更新.*工具|升级.*工具|入库.*工具|工具.*入库|加入.*工具库|添加到.*库|工具库|tool\s*library|codepilot_cli_tools|帮我装|帮我安装|帮我更新|帮我升级|\binstall\s+[@\w./-]+|\buninstall\s+[@\w./-]+|\bupdate\s+[@\w./-]+|\bupgrade\s+[@\w./-]+|brew\s+install|brew\s+upgrade|pip\s+install|pipx\s+install|npm\s+install\s+-g|npm\s+update\s+-g|cargo\s+install|apt\s+install|apt-get\s+install/i;
          if (cliKeywords.test(prompt)) return true;
          if (conversationHistory?.some(m => cliKeywords.test(m.content))) return true;
          return false;
        })();

        if (needsCliToolsMcp) {
          const { createCliToolsMcpServer, CLI_TOOLS_MCP_SYSTEM_PROMPT } = await import('@/lib/cli-tools-mcp');
          queryOptions.mcpServers = {
            ...(queryOptions.mcpServers || {}),
            'codepilot-cli-tools': createCliToolsMcpServer(),
          };
          if (queryOptions.systemPrompt && typeof queryOptions.systemPrompt === 'object' && 'append' in queryOptions.systemPrompt) {
            queryOptions.systemPrompt.append = (queryOptions.systemPrompt.append || '') + '\n\n' + CLI_TOOLS_MCP_SYSTEM_PROMPT;
          }
        }

        // Pass through SDK-specific options from ClaudeStreamOptions
        if (thinking) {
          queryOptions.thinking = thinking;
        }
        // Always set effort explicitly to prevent user-level ~/.claude/settings.json
        // from injecting 'high' effort via settingSources inheritance.
        // UI-selected effort takes priority; otherwise default to 'medium'.
        queryOptions.effort = effort || 'medium';
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
        if (context1m) {
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
            try { updateSdkSessionId(sessionId, ''); } catch { /* best effort */ }
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

        // Permission handler: auto-approve if enabled, or sends SSE event and waits for user response
        queryOptions.canUseTool = async (toolName, input, opts) => {
          // Auto-approve CodePilot's own in-process MCP tools — they are internal
          // and the user has already opted in by enabling the relevant mode.
          // Auto-approve CodePilot's own in-process MCP tools — they are internal
          // and the user has already opted in by enabling the relevant mode.
          // Note: SDK prefixes MCP tool names with mcp__<server>__, so we check
          // both bare and prefixed names.
          const autoApprovedTools = [
            'codepilot_generate_image',
            'codepilot_import_media',
            'codepilot_load_widget_guidelines',
            'codepilot_cli_tools_list',
            'codepilot_cli_tools_add',
            'codepilot_cli_tools_remove',
            'codepilot_cli_tools_check_updates',
          ];
          if (autoApprovedTools.some(t => toolName === t || toolName.endsWith(`__${t}`))) {
            return { behavior: 'allow' as const, updatedInput: input };
          }

          const permissionRequestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          // If auto-approval is enabled, approve immediately without user interaction
          if (shouldAutoApprove) {
            console.log(`[claude-client] Auto-approved ${toolName} (auto-approval enabled)`);
            return {
              behavior: 'allow',
              updatedInput: input,
              ...(opts.suggestions ? { updatedPermissions: opts.suggestions } : {}),
            };
          }

          const permEvent: PermissionRequestEvent = {
            permissionRequestId,
            toolName,
            toolInput: input,
            suggestions: opts.suggestions as PermissionRequestEvent['suggestions'],
            decisionReason: opts.decisionReason,
            blockedPath: opts.blockedPath,
            toolUseId: opts.toolUseID,
            description: undefined,
          };

          // Persist permission request to DB for audit/recovery
          const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
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
          // Store original input so registry can inject updatedInput on allow
          const result = await registerPendingPermission(permissionRequestId, input, opts.signal);

          // Restore runtime status after permission resolved
          onRuntimeStatusChange?.('running');

          return result;
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

            // In imageAgentMode, skip file path references so Claude doesn't
            // try to use built-in tools to analyze images from disk. It will
            // see the images via vision (base64 content blocks) and follow the
            // IMAGE_AGENT_SYSTEM_PROMPT to output image-gen-request blocks.
            // In normal mode, append disk paths — only for the images actually included.
            const textWithImageRefs = imageAgentMode
              ? textPrompt
              : (() => {
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
          } catch (resumeError) {
            const errMsg = resumeError instanceof Error ? resumeError.message : String(resumeError);
            console.warn('[claude-client] Resume failed, retrying without resume:', errMsg);
            // Clear stale sdk_session_id so future messages don't retry this broken resume
            if (sessionId) {
              try { updateSdkSessionId(sessionId, ''); } catch { /* best effort */ }
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
          }
        }

        registerConversation(sessionId, conversation);

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
                            .filter((c: { type: string }) => c.type === 'text')
                            .map((c: { text?: string }) => c.text)
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
                    controller.enqueue(formatSSE({
                      type: 'tool_result',
                      data: JSON.stringify(ssePayload),
                    }));
                    if (block.is_error) {
                      console.warn(`[claude-client] Tool ${block.tool_use_id} failed: ${resultContent}`);
                    }

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
              tokenUsage = extractTokenUsage(resultMsg);
              controller.enqueue(formatSSE({
                type: 'result',
                data: JSON.stringify({
                  subtype: resultMsg.subtype,
                  is_error: resultMsg.is_error,
                  num_turns: resultMsg.num_turns,
                  duration_ms: resultMsg.duration_ms,
                  usage: tokenUsage,
                  session_id: resultMsg.session_id,
                }),
              }));
              // Notify on conversation-level errors (e.g. rate limit, auth failure)
              if (resultMsg.is_error) {
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
              break;
            }

            default: {
              if ((message as { type: string }).type === 'keep_alive') {
                controller.enqueue(formatSSE({ type: 'keep_alive', data: '' }));
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
        });

        // ── Reactive compact: auto-compress and retry on CONTEXT_TOO_LONG ──
        if (classified.category === 'CONTEXT_TOO_LONG' && !ptlRetryAttempted && conversationHistory && conversationHistory.length > 4) {
          ptlRetryAttempted = true;
          try {
            console.log('[claude-client] CONTEXT_TOO_LONG detected — attempting auto-compress + retry');
            controller.enqueue(formatSSE({ type: 'status', data: JSON.stringify({ notification: true, message: 'context_compressing_retry' }) }));

            const { compressConversation } = await import('./context-compressor');
            const { updateSessionSummary: updateSummary } = await import('@/lib/db');
            const compResult = await compressConversation({
              sessionId,
              messages: conversationHistory,
              existingSummary: options.sessionSummary,
              providerId: options.providerId || options.sessionProviderId,
              sessionModel: model,
            });
            updateSummary(sessionId, compResult.summary);
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
              try { updateSdkSessionId(sessionId, ''); } catch { /* best effort */ }
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
                case 'assistant': {
                  const aMsg = msg as SDKAssistantMessage;
                  for (const block of aMsg.message.content) {
                    if (block.type === 'tool_use') {
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
                  const se = msg as { type: 'stream_event'; event: { type: string; delta?: { text?: string; thinking?: string }; index?: number } };
                  if (se.event.type === 'content_block_delta') {
                    if (se.event.delta?.text) {
                      controller.enqueue(formatSSE({ type: 'text', data: se.event.delta.text }));
                    }
                    if (se.event.delta?.thinking) {
                      controller.enqueue(formatSSE({ type: 'thinking', data: se.event.delta.thinking }));
                    }
                  }
                  break;
                }
                case 'result': {
                  const rMsg = msg as SDKResultMessage;
                  if ('result' in rMsg) {
                    const usage = extractTokenUsage(rMsg as SDKResultSuccess);
                    if (usage) {
                      controller.enqueue(formatSSE({ type: 'result', data: JSON.stringify(usage) }));
                    }
                  }
                  // Emit compression notification so frontend updates hasSummary
                  controller.enqueue(formatSSE({ type: 'status', data: JSON.stringify({ notification: true, message: 'context_compressed' }) }));
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
        // Falls back gracefully for older frontends that only read raw text
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
            // Include formatted text for backward compatibility
            _formattedMessage: errorMessage,
          }),
        }));
        controller.enqueue(formatSSE({ type: 'done', data: '' }));

        // Always clear sdk_session_id on crash so the next message starts fresh.
        // Even for fresh sessions — the SDK may emit a session_id via status
        // event before crashing, which gets persisted by consumeStream/SSE
        // handlers. Leaving it would cause repeated resume failures.
        if (sessionId) {
          try {
            updateSdkSessionId(sessionId, '');
            console.warn('[claude-client] Cleared stale sdk_session_id for session', sessionId);
          } catch {
            // best effort
          }
        }

        controller.close();
      } finally {
        unregisterConversation(sessionId);
      }
    },

    cancel() {
      abortController?.abort();
    },
  });
}
