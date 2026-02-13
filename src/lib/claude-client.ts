import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  SDKSystemMessage,
  SDKToolProgressMessage,
  Options,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  McpServerConfig,
  NotificationHookInput,
  PostToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeStreamOptions, SSEEvent, TokenUsage, MCPServerConfig, PermissionRequestEvent, FileAttachment } from '@/types';
import { isImageFile } from '@/types';
import { registerPendingPermission } from './permission-registry';
import { getSetting, getActiveProvider } from './db';
import { findClaudeBinary, findGitBash, getExpandedPath } from './platform';
import os from 'os';
import fs from 'fs';
import path from 'path';

let cachedClaudePath: string | null | undefined;

function findClaudePath(): string | undefined {
  if (cachedClaudePath !== undefined) return cachedClaudePath || undefined;
  const found = findClaudeBinary();
  cachedClaudePath = found ?? null;
  return found;
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

export function streamClaude(options: ClaudeStreamOptions): ReadableStream<string> {
  const {
    prompt,
    sdkSessionId,
    model,
    systemPrompt,
    workingDirectory,
    mcpServers,
    abortController,
    permissionMode,
    files,
    toolTimeoutSeconds = 0,
  } = options;

  return new ReadableStream<string>({
    async start(controller) {
      try {
        // Build env for the Claude Code subprocess.
        // Start with process.env (includes user shell env from Electron's loadUserShellEnv).
        // Then overlay any API config the user set in CodePilot settings (optional).
        const sdkEnv: Record<string, string> = { ...process.env as Record<string, string> };

        // Ensure HOME/USERPROFILE are set so Claude Code can find ~/.claude/commands/
        if (!sdkEnv.HOME) sdkEnv.HOME = os.homedir();
        if (!sdkEnv.USERPROFILE) sdkEnv.USERPROFILE = os.homedir();
        // Ensure SDK subprocess has expanded PATH (consistent with Electron mode)
        sdkEnv.PATH = getExpandedPath();

        // On Windows, auto-detect Git Bash if not already configured
        if (process.platform === 'win32' && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
          const gitBashPath = findGitBash();
          if (gitBashPath) {
            sdkEnv.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath;
          }
        }

        // Try to get config from active provider first
        const activeProvider = getActiveProvider();

        if (activeProvider && activeProvider.api_key) {
          // Clear all existing ANTHROPIC_* variables to prevent conflicts
          for (const key of Object.keys(sdkEnv)) {
            if (key.startsWith('ANTHROPIC_')) {
              delete sdkEnv[key];
            }
          }

          // Inject provider config — set both token variants so extra_env can clear the unwanted one
          sdkEnv.ANTHROPIC_AUTH_TOKEN = activeProvider.api_key;
          sdkEnv.ANTHROPIC_API_KEY = activeProvider.api_key;
          if (activeProvider.base_url) {
            sdkEnv.ANTHROPIC_BASE_URL = activeProvider.base_url;
          }

          // Inject extra environment variables
          // Empty string values mean "delete this variable" (e.g. clear ANTHROPIC_API_KEY for AUTH_TOKEN-only providers)
          try {
            const extraEnv = JSON.parse(activeProvider.extra_env || '{}');
            for (const [key, value] of Object.entries(extraEnv)) {
              if (typeof value === 'string') {
                if (value === '') {
                  delete sdkEnv[key];
                } else {
                  sdkEnv[key] = value;
                }
              }
            }
          } catch {
            // ignore malformed extra_env
          }
        } else {
          // No active provider — check legacy DB settings first, then fall back to
          // environment variables already present in process.env (copied into sdkEnv above).
          // This allows users who set ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL
          // in their shell environment to use them without configuring a provider in the UI.
          const appToken = getSetting('anthropic_auth_token');
          const appBaseUrl = getSetting('anthropic_base_url');
          if (appToken) {
            sdkEnv.ANTHROPIC_AUTH_TOKEN = appToken;
          }
          if (appBaseUrl) {
            sdkEnv.ANTHROPIC_BASE_URL = appBaseUrl;
          }
          // If neither legacy settings nor env vars provide a key, log a warning
          if (!appToken && !sdkEnv.ANTHROPIC_API_KEY && !sdkEnv.ANTHROPIC_AUTH_TOKEN) {
            console.warn('[claude-client] No API key found: no active provider, no legacy settings, and no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN in environment');
          }
        }

        // Check if dangerously_skip_permissions is enabled in app settings
        const skipPermissions = getSetting('dangerously_skip_permissions') === 'true';

        const queryOptions: Options = {
          cwd: workingDirectory || process.cwd(),
          abortController,
          includePartialMessages: true,
          permissionMode: skipPermissions
            ? 'bypassPermissions'
            : ((permissionMode as Options['permissionMode']) || 'acceptEdits'),
          env: sdkEnv,
        };

        if (skipPermissions) {
          queryOptions.allowDangerouslySkipPermissions = true;
        }

        // Find claude binary for packaged app where PATH is limited
        const claudePath = findClaudePath();
        if (claudePath) {
          queryOptions.pathToClaudeCodeExecutable = claudePath;
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

        // Load MCP servers: use passed-in config, or auto-read from config files
        let effectiveMcpServers = mcpServers;
        if (!effectiveMcpServers || Object.keys(effectiveMcpServers).length === 0) {
          try {
            const userConfigPath = path.join(os.homedir(), '.claude.json');
            const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
            let merged: Record<string, MCPServerConfig> = {};
            if (fs.existsSync(userConfigPath)) {
              const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));
              if (userConfig.mcpServers) merged = { ...merged, ...userConfig.mcpServers };
            }
            if (fs.existsSync(settingsPath)) {
              const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
              if (settings.mcpServers) merged = { ...merged, ...settings.mcpServers };
            }
            if (Object.keys(merged).length > 0) effectiveMcpServers = merged;
          } catch {
            // ignore config read errors
          }
        }
        if (effectiveMcpServers && Object.keys(effectiveMcpServers).length > 0) {
          queryOptions.mcpServers = toSdkMcpConfig(effectiveMcpServers);
        }

        // Resume session if we have an SDK session ID from a previous conversation turn
        if (sdkSessionId) {
          queryOptions.resume = sdkSessionId;
        }

        // Permission handler: sends SSE event and waits for user response
        queryOptions.canUseTool = async (toolName, input, opts) => {
          const permissionRequestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

          // Send permission_request SSE event to the client
          controller.enqueue(formatSSE({
            type: 'permission_request',
            data: JSON.stringify(permEvent),
          }));

          // Wait for user response (resolved by POST /api/chat/permission)
          // Store original input so registry can inject updatedInput on allow
          return registerPendingPermission(permissionRequestId, input, opts.signal);
        };

        // Hooks: capture notifications and tool completion events
        queryOptions.hooks = {
          Notification: [{
            hooks: [async (input) => {
              const notif = input as NotificationHookInput;
              controller.enqueue(formatSSE({
                type: 'status',
                data: JSON.stringify({
                  notification: true,
                  title: notif.title,
                  message: notif.message,
                }),
              }));
              return {};
            }],
          }],
          PostToolUse: [{
            hooks: [async (input) => {
              const toolEvent = input as PostToolUseHookInput;
              controller.enqueue(formatSSE({
                type: 'tool_result',
                data: JSON.stringify({
                  tool_use_id: toolEvent.tool_use_id,
                  content: typeof toolEvent.tool_response === 'string'
                    ? toolEvent.tool_response
                    : JSON.stringify(toolEvent.tool_response),
                  is_error: false,
                }),
              }));
              return {};
            }],
          }],
        };

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

        // Build the prompt with file attachments.
        // Images → sent as multimodal base64 content blocks (vision).
        // Non-image files → saved to disk and referenced via Read tool.
        let finalPrompt: string | AsyncIterable<SDKUserMessage> = prompt;

        if (files && files.length > 0) {
          const imageFiles = files.filter(f => isImageFile(f.type));
          const nonImageFiles = files.filter(f => !isImageFile(f.type));

          // Save non-image files to disk for Read tool access
          let textPrompt = prompt;
          if (nonImageFiles.length > 0) {
            const workDir = workingDirectory || process.cwd();
            const savedPaths = getUploadedFilePaths(nonImageFiles, workDir);
            const fileReferences = savedPaths
              .map((p, i) => `[User attached file: ${p} (${nonImageFiles[i].name})]`)
              .join('\n');
            textPrompt = `${fileReferences}\n\nPlease read the attached file(s) above using your Read tool, then respond to the user's message:\n\n${prompt}`;
          }

          // If there are images, build a multimodal SDKUserMessage
          if (imageFiles.length > 0) {
            const contentBlocks: Array<
              | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
              | { type: 'text'; text: string }
            > = [];

            for (const img of imageFiles) {
              contentBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: img.type || 'image/png',
                  data: img.data,
                },
              });
            }

            contentBlocks.push({ type: 'text', text: textPrompt });

            const userMessage: SDKUserMessage = {
              type: 'user',
              message: {
                role: 'user',
                content: contentBlocks,
              },
              parent_tool_use_id: null,
              session_id: sdkSessionId || '',
            };

            // Create a single-message async iterable
            finalPrompt = (async function* () {
              yield userMessage;
            })();
          } else {
            finalPrompt = textPrompt;
          }
        }

        const conversation = query({
          prompt: finalPrompt,
          options: queryOptions,
        });

        let lastAssistantText = '';
        let tokenUsage: TokenUsage | null = null;

        for await (const message of conversation) {
          if (abortController?.signal.aborted) {
            break;
          }

          switch (message.type) {
            case 'assistant': {
              const assistantMsg = message as SDKAssistantMessage;
              // Text deltas are handled by stream_event for real-time streaming.
              // Only track lastAssistantText here and process tool_use blocks.
              const text = extractTextFromMessage(assistantMsg);
              if (text) {
                lastAssistantText = text;
              }

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
                    const resultContent = typeof block.content === 'string'
                      ? block.content
                      : Array.isArray(block.content)
                        ? block.content
                            .filter((c: { type: string }) => c.type === 'text')
                            .map((c: { text: string }) => c.text)
                            .join('\n')
                        : String(block.content ?? '');
                    controller.enqueue(formatSSE({
                      type: 'tool_result',
                      data: JSON.stringify({
                        tool_use_id: block.tool_use_id,
                        content: resultContent,
                        is_error: block.is_error || false,
                      }),
                    }));
                  }
                }
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
              }
              break;
            }

            case 'system': {
              const sysMsg = message as SDKSystemMessage;
              if ('subtype' in sysMsg) {
                if (sysMsg.subtype === 'init') {
                  controller.enqueue(formatSSE({
                    type: 'status',
                    data: JSON.stringify({
                      session_id: sysMsg.session_id,
                      model: sysMsg.model,
                      tools: sysMsg.tools,
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
              break;
            }
          }
        }

        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        controller.enqueue(formatSSE({ type: 'error', data: errorMessage }));
        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      }
    },

    cancel() {
      abortController?.abort();
    },
  });
}
