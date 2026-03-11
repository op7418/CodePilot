import { query } from "@anthropic-ai/claude-agent-sdk";
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
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeStreamOptions,
  SSEEvent,
  TokenUsage,
  MCPServerConfig,
  PermissionRequestEvent,
  FileAttachment,
} from "@/types";
import { isImageFile } from "@/types";
import { registerPendingPermission } from "./permission-registry";
import {
  registerConversation,
  unregisterConversation,
} from "./conversation-registry";
import { captureCapabilities } from "./agent-sdk-capabilities";
import { getSetting, updateSdkSessionId, createPermissionRequest } from "./db";
import { resolveForClaudeCode, toClaudeCodeEnv } from "./provider-resolver";
import { findClaudeBinary, findGitBash, getExpandedPath } from "./platform";
import { notifyPermissionRequest, notifyGeneric } from "./telegram-bot";
import os from "os";
import fs from "fs";
import path from "path";

/**
 * Sanitize a string for use as an environment variable value.
 * Removes null bytes and control characters that cause spawn EINVAL.
 */
function sanitizeEnvValue(value: string): string {
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
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
    if (typeof value === "string") {
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
    const content = fs.readFileSync(cmdPath, "utf-8");
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
 * Convert our MCPServerConfig to the SDK's McpServerConfig format.
 * Supports stdio, sse, and http transport types.
 */
function toSdkMcpConfig(
  servers: Record<string, MCPServerConfig>,
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    const transport = config.type || "stdio";

    switch (transport) {
      case "sse": {
        if (!config.url) {
          console.warn(`[mcp] SSE server "${name}" is missing url, skipping`);
          continue;
        }
        const sseConfig: McpSSEServerConfig = {
          type: "sse",
          url: config.url,
        };
        if (config.headers && Object.keys(config.headers).length > 0) {
          sseConfig.headers = config.headers;
        }
        result[name] = sseConfig;
        break;
      }

      case "http": {
        if (!config.url) {
          console.warn(`[mcp] HTTP server "${name}" is missing url, skipping`);
          continue;
        }
        const httpConfig: McpHttpServerConfig = {
          type: "http",
          url: config.url,
        };
        if (config.headers && Object.keys(config.headers).length > 0) {
          httpConfig.headers = config.headers;
        }
        result[name] = httpConfig;
        break;
      }

      case "stdio":
      default: {
        if (!config.command) {
          console.warn(
            `[mcp] stdio server "${name}" is missing command, skipping`,
          );
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
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("");
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
    cost_usd: "total_cost_usd" in msg ? msg.total_cost_usd : undefined,
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
function getUploadedFilePaths(
  files: FileAttachment[],
  workDir: string,
): string[] {
  const paths: string[] = [];
  let uploadDir: string | undefined;
  for (const file of files) {
    if (file.filePath) {
      paths.push(file.filePath);
    } else {
      // Fallback: write file to disk (should not happen in normal flow)
      if (!uploadDir) {
        uploadDir = path.join(workDir, ".codepilot-uploads");
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
      }
      const safeName = path
        .basename(file.name)
        .replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
      const buffer = Buffer.from(file.data, "base64");
      fs.writeFileSync(filePath, buffer);
      paths.push(filePath);
    }
  }
  return paths;
}

/**
 * Build a context-enriched prompt by prepending conversation history.
 * Used when SDK session resume is unavailable or fails.
 */
function buildPromptWithHistory(
  prompt: string,
  history?: Array<{ role: "user" | "assistant"; content: string }>,
): string {
  if (!history || history.length === 0) return prompt;

  const lines: string[] = [
    "<conversation_history>",
    "(This is a summary of earlier conversation turns for context. Tool calls shown here were already executed — do not repeat them or output their markers as text.)",
  ];
  for (const msg of history) {
    // For assistant messages with tool blocks (JSON arrays), extract only the text portions.
    // Tool-use and tool-result blocks are omitted to avoid Claude parroting them as plain text.
    let content = msg.content;
    if (msg.role === "assistant" && content.startsWith("[")) {
      try {
        const blocks = JSON.parse(content);
        const parts: string[] = [];
        for (const b of blocks) {
          if (b.type === "text" && b.text) parts.push(b.text);
          // Skip tool_use and tool_result — they were already executed
        }
        content =
          parts.length > 0 ? parts.join("\n") : "(assistant used tools)";
      } catch {
        // Not JSON, use as-is
      }
    }
    lines.push(`${msg.role === "user" ? "Human" : "Assistant"}: ${content}`);
  }
  lines.push("</conversation_history>");
  lines.push("");
  lines.push(prompt);
  return lines.join("\n");
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

  const sdkEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  if (!sdkEnv.HOME) sdkEnv.HOME = os.homedir();
  if (!sdkEnv.USERPROFILE) sdkEnv.USERPROFILE = os.homedir();
  sdkEnv.PATH = getExpandedPath();
  delete sdkEnv.CLAUDECODE;

  if (process.platform === "win32" && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    const gitBashPath = findGitBash();
    if (gitBashPath) sdkEnv.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath;
  }

  const resolvedEnv = toClaudeCodeEnv(sdkEnv, resolved);
  Object.assign(sdkEnv, resolvedEnv);

  const abortController = new AbortController();
  if (params.abortSignal) {
    params.abortSignal.addEventListener("abort", () => abortController.abort());
  }

  // Auto-timeout after 60s to prevent indefinite hangs
  const timeoutId = setTimeout(() => abortController.abort(), 60_000);

  const queryOptions: Options = {
    cwd: os.homedir(),
    abortController,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    env: sanitizeEnv(sdkEnv),
    settingSources: resolved.settingSources as Options["settingSources"],
    systemPrompt: params.system,
    maxTurns: 1,
  };

  if (params.model) {
    queryOptions.model = params.model;
  }

  const claudePath = findClaudePath();
  if (claudePath) {
    const ext = path.extname(claudePath).toLowerCase();
    if (ext === ".cmd" || ext === ".bat") {
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
  let resultText = "";
  try {
    for await (const msg of conversation) {
      if (msg.type === "result" && "result" in msg) {
        resultText = (msg as SDKResultSuccess).result || "";
      }
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (abortController.signal.aborted && !params.abortSignal?.aborted) {
      throw new Error("SDK query timed out after 60s");
    }
    throw err;
  }

  clearTimeout(timeoutId);

  if (!resultText) {
    throw new Error("SDK query returned no result");
  }

  return resultText;
}

export function streamClaude(
  options: ClaudeStreamOptions,
): ReadableStream<string> {
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
  } = options;

  return new ReadableStream<string>({
    async start(controller) {
      // Resolve provider via the unified resolver. The caller may pass an explicit
      // provider (from resolveProvider().provider), or undefined when 'env' mode is
      // intended. We do NOT fall back to getActiveProvider() here — that's handled
      // inside resolveForClaudeCode() only when no resolution was attempted at all.
      const resolved = resolveForClaudeCode(options.provider, {
        providerId: options.providerId,
        sessionProviderId: options.sessionProviderId,
      });

      try {
        // Build env for the Claude Code subprocess.
        // Start with process.env (includes user shell env from Electron's loadUserShellEnv).
        // Then overlay any API config the user set in CodePilot settings (optional).
        const sdkEnv: Record<string, string> = {
          ...(process.env as Record<string, string>),
        };

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
        if (
          process.platform === "win32" &&
          !process.env.CLAUDE_CODE_GIT_BASH_PATH
        ) {
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
        if (
          !resolved.hasCredentials &&
          !sdkEnv.ANTHROPIC_API_KEY &&
          !sdkEnv.ANTHROPIC_AUTH_TOKEN
        ) {
          console.warn(
            "[claude-client] No API key found: no active provider, no legacy settings, and no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN in environment",
          );
        }

        // Check if dangerously_skip_permissions is enabled globally or per-session
        const globalSkip =
          getSetting("dangerously_skip_permissions") === "true";
        const skipPermissions = globalSkip || !!sessionBypassPermissions;

        // Validate working directory — if it doesn't exist, spawn throws ENOENT
        // with the binary path in the error message (Node.js quirk), misleading users.
        const safeCwd =
          workingDirectory && fs.existsSync(workingDirectory)
            ? workingDirectory
            : os.homedir();
        if (workingDirectory && !fs.existsSync(workingDirectory)) {
          console.warn(
            `[claude-client] Working directory does not exist: ${workingDirectory}, falling back to home dir`,
          );
        }

        const queryOptions: Options = {
          cwd: safeCwd,
          abortController,
          includePartialMessages: true,
          permissionMode: skipPermissions
            ? "bypassPermissions"
            : (permissionMode as Options["permissionMode"]) || "acceptEdits",
          env: sanitizeEnv(sdkEnv),
          // Load settings so the SDK behaves like the CLI (tool permissions,
          // CLAUDE.md, etc.). When an active provider is configured in
          // CodePilot, skip 'user' settings because ~/.claude/settings.json
          // may contain env overrides (ANTHROPIC_BASE_URL, ANTHROPIC_MODEL,
          // etc.) that would conflict with the provider's configuration.
          settingSources: resolved.settingSources as Options["settingSources"],
        };

        if (skipPermissions) {
          queryOptions.allowDangerouslySkipPermissions = true;
        }

        // Find claude binary for packaged app where PATH is limited.
        // On Windows, npm installs Claude CLI as a .cmd wrapper which cannot
        // be spawned directly without shell:true. Parse the wrapper to
        // extract the real .js script path and pass that to the SDK instead.
        const claudePath = findClaudePath();
        if (claudePath) {
          const ext = path.extname(claudePath).toLowerCase();
          if (ext === ".cmd" || ext === ".bat") {
            const scriptPath = resolveScriptFromCmd(claudePath);
            if (scriptPath) {
              queryOptions.pathToClaudeCodeExecutable = scriptPath;
            } else {
              console.warn(
                "[claude-client] Could not resolve .js path from .cmd wrapper, falling back to SDK resolution:",
                claudePath,
              );
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
            type: "preset",
            preset: "claude_code",
            append: systemPrompt,
          };
        }

        // MCP servers: only pass explicitly provided config (e.g. from CodePilot UI).
        // User-level MCP config from ~/.claude.json and ~/.claude/settings.json
        // is now automatically loaded by the SDK via settingSources: ['user', 'project', 'local'].
        if (mcpServers && Object.keys(mcpServers).length > 0) {
          queryOptions.mcpServers = toSdkMcpConfig(mcpServers);
        }

        // Pass through SDK-specific options from ClaudeStreamOptions
        if (thinking) {
          queryOptions.thinking = thinking;
        }
        if (effort) {
          queryOptions.effort = effort;
        }
        if (outputFormat) {
          queryOptions.outputFormat = outputFormat;
        }
        if (agents) {
          queryOptions.agents = agents as Options["agents"];
        }
        if (agent) {
          queryOptions.agent = agent;
        }
        if (enableFileCheckpointing) {
          queryOptions.enableFileCheckpointing = true;
        }

        // Resume session if we have an SDK session ID from a previous conversation turn.
        // Pre-check: verify working_directory exists before attempting resume.
        // Resume depends on session context (cwd/project scope), so if the
        // original working_directory no longer exists, resume will fail.
        let shouldResume = !!sdkSessionId;
        if (
          shouldResume &&
          workingDirectory &&
          !fs.existsSync(workingDirectory)
        ) {
          console.warn(
            `[claude-client] Working directory "${workingDirectory}" does not exist, skipping resume`,
          );
          shouldResume = false;
          if (sessionId) {
            try {
              updateSdkSessionId(sessionId, "");
            } catch {
              /* best effort */
            }
          }
          controller.enqueue(
            formatSSE({
              type: "status",
              data: JSON.stringify({
                notification: true,
                title: "Session fallback",
                message:
                  "Original working directory no longer exists. Starting fresh conversation.",
              }),
            }),
          );
        }
        if (shouldResume) {
          queryOptions.resume = sdkSessionId;
        }

        // Permission handler: sends SSE event and waits for user response
        queryOptions.canUseTool = async (toolName, input, opts) => {
          const permissionRequestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          const permEvent: PermissionRequestEvent = {
            permissionRequestId,
            toolName,
            toolInput: input,
            suggestions:
              opts.suggestions as PermissionRequestEvent["suggestions"],
            decisionReason: opts.decisionReason,
            blockedPath: opts.blockedPath,
            toolUseId: opts.toolUseID,
            description: undefined,
          };

          // Persist permission request to DB for audit/recovery
          const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
            .toISOString()
            .replace("T", " ")
            .split(".")[0];
          try {
            createPermissionRequest({
              id: permissionRequestId,
              sessionId,
              sdkSessionId: sdkSessionId || "",
              toolName,
              toolInput: JSON.stringify(input),
              decisionReason: opts.decisionReason || "",
              expiresAt,
            });
          } catch (e) {
            console.warn(
              "[claude-client] Failed to persist permission request to DB:",
              e,
            );
          }

          // Send permission_request SSE event to the client
          controller.enqueue(
            formatSSE({
              type: "permission_request",
              data: JSON.stringify(permEvent),
            }),
          );

          // Notify via Telegram (fire-and-forget)
          notifyPermissionRequest(
            toolName,
            input as Record<string, unknown>,
            telegramOpts,
          ).catch(() => {});

          // Notify runtime status change
          onRuntimeStatusChange?.("waiting_permission");

          // Wait for user response (resolved by POST /api/chat/permission)
          // Store original input so registry can inject updatedInput on allow
          const result = await registerPendingPermission(
            permissionRequestId,
            input,
            opts.signal,
          );

          // Restore runtime status after permission resolved
          onRuntimeStatusChange?.("running");

          return result;
        };

        // Telegram notification context for hooks
        const telegramOpts = {
          sessionId,
          sessionTitle: undefined as string | undefined,
          workingDirectory,
        };

        // No queryOptions.hooks — all hook types (Notification, PostToolUse) use
        // the SDK's hook_callback control_request transport, which fails with
        // "CLI output was not valid JSON" when the CLI mixes control frames with
        // normal stdout. Notifications are derived from stream messages instead
        // (task_notification, result). TodoWrite sync uses tool_use → tool_result.

        // Capture real-time stderr output from Claude Code process
        queryOptions.stderr = (data: string) => {
          // Diagnostic: log raw stderr data length to server console
          console.log(
            `[stderr] received ${data.length} bytes, first 200 chars:`,
            data.slice(0, 200).replace(/[\x00-\x1F\x7F]/g, "?"),
          );
          // Strip ANSI escape codes, OSC sequences, and control characters
          // but preserve tabs (\x09) and carriage returns (\x0D)
          const cleaned = data
            .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "") // CSI sequences (colors, cursor)
            .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "") // OSC sequences
            .replace(/\x1B\([A-Z]/g, "") // Character set selection
            .replace(/\x1B[=>]/g, "") // Keypad mode
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "") // Control chars (keep \t \n \r)
            .replace(/\r\n/g, "\n") // Normalize CRLF
            .replace(/\r/g, "\n") // Convert remaining CR to LF
            .replace(/\n{3,}/g, "\n\n") // Collapse multiple blank lines
            .trim();
          if (cleaned) {
            controller.enqueue(
              formatSSE({
                type: "tool_output",
                data: cleaned,
              }),
            );
          }
        };

        // Build the prompt with file attachments and optional conversation history.
        // When resuming, the SDK has full context so we send the raw prompt.
        // When NOT resuming (fresh or fallback), prepend DB history for context.
        function buildFinalPrompt(
          useHistory: boolean,
        ): string | AsyncIterable<SDKUserMessage> {
          const basePrompt = useHistory
            ? buildPromptWithHistory(prompt, conversationHistory)
            : prompt;

          if (!files || files.length === 0) return basePrompt;

          const imageFiles = files.filter((f) => isImageFile(f.type));
          const nonImageFiles = files.filter((f) => !isImageFile(f.type));

          let textPrompt = basePrompt;
          if (nonImageFiles.length > 0) {
            const workDir = workingDirectory || os.homedir();
            const savedPaths = getUploadedFilePaths(nonImageFiles, workDir);
            const fileReferences = savedPaths
              .map(
                (p, i) =>
                  `[User attached file: ${p} (${nonImageFiles[i].name})]`,
              )
              .join("\n");
            textPrompt = `${fileReferences}\n\nPlease read the attached file(s) above using your Read tool, then respond to the user's message:\n\n${basePrompt}`;
          }

          if (imageFiles.length > 0) {
            // In imageAgentMode, skip file path references so Claude doesn't
            // try to use built-in tools to analyze images from disk. It will
            // see the images via vision (base64 content blocks) and follow the
            // IMAGE_AGENT_SYSTEM_PROMPT to output image-gen-request blocks.
            // In normal mode, append disk paths so skills can reference them.
            const textWithImageRefs = imageAgentMode
              ? textPrompt
              : (() => {
                  const workDir = workingDirectory || os.homedir();
                  const imagePaths = getUploadedFilePaths(imageFiles, workDir);
                  const imageReferences = imagePaths
                    .map(
                      (p, i) =>
                        `[User attached image: ${p} (${imageFiles[i].name})]`,
                    )
                    .join("\n");
                  return `${imageReferences}\n\n${textPrompt}`;
                })();

            const contentBlocks: Array<
              | {
                  type: "image";
                  source: { type: "base64"; media_type: string; data: string };
                }
              | { type: "text"; text: string }
            > = [];

            for (const img of imageFiles) {
              contentBlocks.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: img.type || "image/png",
                  data: img.data,
                },
              });
            }

            contentBlocks.push({ type: "text", text: textWithImageRefs });

            const userMessage: SDKUserMessage = {
              type: "user",
              message: {
                role: "user",
                content: contentBlocks,
              },
              parent_tool_use_id: null,
              session_id: sdkSessionId || "",
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
            const errMsg =
              resumeError instanceof Error
                ? resumeError.message
                : String(resumeError);
            console.warn(
              "[claude-client] Resume failed, retrying without resume:",
              errMsg,
            );
            // Clear stale sdk_session_id so future messages don't retry this broken resume
            if (sessionId) {
              try {
                updateSdkSessionId(sessionId, "");
              } catch {
                /* best effort */
              }
            }
            // Notify frontend about the fallback
            controller.enqueue(
              formatSSE({
                type: "status",
                data: JSON.stringify({
                  notification: true,
                  title: "Session fallback",
                  message:
                    "Previous session could not be resumed. Starting fresh conversation.",
                }),
              }),
            );
            // Remove resume and try again as a fresh conversation with history context
            delete queryOptions.resume;
            conversation = query({
              prompt: buildFinalPrompt(true),
              options: queryOptions,
            });
          }
        }

        registerConversation(sessionId, conversation);

        // Fire-and-forget: capture SDK capabilities for UI consumption
        // Scope to provider so different providers don't pollute each other's cache
        const capProviderId = resolved.provider?.api_key
          ? resolved.provider.id || "custom"
          : "env";
        captureCapabilities(sessionId, conversation, capProviderId).catch(
          (err) => {
            console.warn("[claude-client] Capability capture failed:", err);
          },
        );

        let lastAssistantText = "";
        let tokenUsage: TokenUsage | null = null;
        // Track pending TodoWrite tool_use_ids so we can sync after successful execution
        const pendingTodoWrites = new Map<
          string,
          Array<{ content: string; status: string; activeForm?: string }>
        >();

        for await (const message of conversation) {
          if (abortController?.signal.aborted) {
            break;
          }

          switch (message.type) {
            case "assistant": {
              const assistantMsg = message as SDKAssistantMessage;
              // Text deltas are handled by stream_event for real-time streaming.
              // Only track lastAssistantText here and process tool_use blocks.
              const text = extractTextFromMessage(assistantMsg);
              if (text) {
                lastAssistantText = text;
              }

              // Check for tool use blocks
              for (const block of assistantMsg.message.content) {
                if (block.type === "tool_use") {
                  controller.enqueue(
                    formatSSE({
                      type: "tool_use",
                      data: JSON.stringify({
                        id: block.id,
                        name: block.name,
                        input: block.input,
                      }),
                    }),
                  );

                  // Track TodoWrite calls — sync deferred until tool_result confirms success
                  if (block.name === "TodoWrite") {
                    try {
                      const toolInput = block.input as {
                        todos?: Array<{
                          content: string;
                          status: string;
                          activeForm?: string;
                        }>;
                      };
                      if (toolInput?.todos && Array.isArray(toolInput.todos)) {
                        pendingTodoWrites.set(block.id, toolInput.todos);
                      }
                    } catch (e) {
                      console.warn(
                        "[claude-client] Failed to parse TodoWrite input:",
                        e,
                      );
                    }
                  }
                }
              }
              break;
            }

            case "user": {
              // Tool execution results come back as user messages with tool_result blocks
              const userMsg = message as SDKUserMessage;
              const content = userMsg.message.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "tool_result") {
                    const resultContent =
                      typeof block.content === "string"
                        ? block.content
                        : Array.isArray(block.content)
                          ? block.content
                              .filter(
                                (c: { type: string }) => c.type === "text",
                              )
                              .map((c: { text: string }) => c.text)
                              .join("\n")
                          : String(block.content ?? "");
                    controller.enqueue(
                      formatSSE({
                        type: "tool_result",
                        data: JSON.stringify({
                          tool_use_id: block.tool_use_id,
                          content: resultContent,
                          is_error: block.is_error || false,
                        }),
                      }),
                    );

                    // Deferred TodoWrite sync: only emit task_update after successful execution
                    if (
                      !block.is_error &&
                      pendingTodoWrites.has(block.tool_use_id)
                    ) {
                      const todos = pendingTodoWrites.get(block.tool_use_id)!;
                      pendingTodoWrites.delete(block.tool_use_id);
                      controller.enqueue(
                        formatSSE({
                          type: "task_update",
                          data: JSON.stringify({
                            session_id: sessionId,
                            todos: todos.map((t, i) => ({
                              id: String(i),
                              content: t.content,
                              status: t.status,
                              activeForm: t.activeForm || "",
                            })),
                          }),
                        }),
                      );
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
                controller.enqueue(
                  formatSSE({
                    type: "rewind_point",
                    data: JSON.stringify({ userMessageId: userMsg.uuid }),
                  }),
                );
              }
              break;
            }

            case "stream_event": {
              const streamEvent = message as SDKPartialAssistantMessage;
              const evt = streamEvent.event;
              if (evt.type === "content_block_delta" && "delta" in evt) {
                const delta = evt.delta;
                if ("text" in delta && delta.text) {
                  controller.enqueue(
                    formatSSE({ type: "text", data: delta.text }),
                  );
                }
              }
              break;
            }

            case "system": {
              const sysMsg = message as SDKSystemMessage;
              if ("subtype" in sysMsg) {
                if (sysMsg.subtype === "init") {
                  const initMsg = sysMsg as SDKSystemMessage & {
                    slash_commands?: unknown;
                    skills?: unknown;
                  };
                  controller.enqueue(
                    formatSSE({
                      type: "status",
                      data: JSON.stringify({
                        session_id: sysMsg.session_id,
                        model: sysMsg.model,
                        requested_model: model,
                        tools: sysMsg.tools,
                        slash_commands: initMsg.slash_commands,
                        skills: initMsg.skills,
                      }),
                    }),
                  );
                } else if (sysMsg.subtype === "status") {
                  // SDK sends status messages when permission mode changes (e.g. ExitPlanMode)
                  const statusMsg = sysMsg as SDKSystemMessage & {
                    permissionMode?: string;
                  };
                  if (statusMsg.permissionMode) {
                    controller.enqueue(
                      formatSSE({
                        type: "mode_changed",
                        data: statusMsg.permissionMode,
                      }),
                    );
                  }
                } else if (sysMsg.subtype === "task_notification") {
                  // Agent task completed/failed/stopped — surface as notification
                  const taskMsg = sysMsg as SDKSystemMessage & {
                    status: string;
                    summary: string;
                    task_id: string;
                  };
                  const title =
                    taskMsg.status === "completed"
                      ? "Task completed"
                      : `Task ${taskMsg.status}`;
                  controller.enqueue(
                    formatSSE({
                      type: "status",
                      data: JSON.stringify({
                        notification: true,
                        title,
                        message: taskMsg.summary || "",
                      }),
                    }),
                  );
                  notifyGeneric(
                    title,
                    taskMsg.summary || "",
                    telegramOpts,
                  ).catch(() => {});
                }
              }
              break;
            }

            case "tool_progress": {
              const progressMsg = message as SDKToolProgressMessage;
              controller.enqueue(
                formatSSE({
                  type: "tool_output",
                  data: JSON.stringify({
                    _progress: true,
                    tool_use_id: progressMsg.tool_use_id,
                    tool_name: progressMsg.tool_name,
                    elapsed_time_seconds: progressMsg.elapsed_time_seconds,
                  }),
                }),
              );
              // Auto-timeout: abort if tool runs longer than configured threshold
              if (
                toolTimeoutSeconds > 0 &&
                progressMsg.elapsed_time_seconds >= toolTimeoutSeconds
              ) {
                controller.enqueue(
                  formatSSE({
                    type: "tool_timeout",
                    data: JSON.stringify({
                      tool_name: progressMsg.tool_name,
                      elapsed_seconds: Math.round(
                        progressMsg.elapsed_time_seconds,
                      ),
                    }),
                  }),
                );
                abortController?.abort();
              }
              break;
            }

            case "result": {
              const resultMsg = message as SDKResultMessage;
              tokenUsage = extractTokenUsage(resultMsg);
              controller.enqueue(
                formatSSE({
                  type: "result",
                  data: JSON.stringify({
                    subtype: resultMsg.subtype,
                    is_error: resultMsg.is_error,
                    num_turns: resultMsg.num_turns,
                    duration_ms: resultMsg.duration_ms,
                    usage: tokenUsage,
                    session_id: resultMsg.session_id,
                  }),
                }),
              );
              // Notify on conversation-level errors (e.g. rate limit, auth failure)
              if (resultMsg.is_error) {
                const errTitle = "Conversation error";
                const errMsg =
                  resultMsg.subtype || "The conversation ended with an error";
                controller.enqueue(
                  formatSSE({
                    type: "status",
                    data: JSON.stringify({
                      notification: true,
                      title: errTitle,
                      message: errMsg,
                    }),
                  }),
                );
                notifyGeneric(errTitle, errMsg, telegramOpts).catch(() => {});
              }
              break;
            }

            default: {
              if ((message as { type: string }).type === "keep_alive") {
                controller.enqueue(formatSSE({ type: "keep_alive", data: "" }));
              }
              break;
            }
          }
        }

        controller.enqueue(formatSSE({ type: "done", data: "" }));
        controller.close();
      } catch (error) {
        const rawMessage =
          error instanceof Error ? error.message : "Unknown error";
        // Log full error details for debugging (visible in terminal / dev tools)
        console.error("[claude-client] Stream error:", {
          message: rawMessage,
          stack: error instanceof Error ? error.stack : undefined,
          cause:
            error instanceof Error
              ? (error as { cause?: unknown }).cause
              : undefined,
          stderr:
            error instanceof Error
              ? (error as { stderr?: string }).stderr
              : undefined,
          code:
            error instanceof Error
              ? (error as NodeJS.ErrnoException).code
              : undefined,
        });

        // Try to extract stderr or cause for more useful error messages
        const stderr =
          error instanceof Error
            ? (error as { stderr?: string }).stderr
            : undefined;
        const cause =
          error instanceof Error
            ? (error as { cause?: unknown }).cause
            : undefined;
        const extraDetail =
          stderr ||
          (cause instanceof Error ? cause.message : cause ? String(cause) : "");

        let errorMessage = rawMessage;

        // Provide more specific error messages based on error type
        if (error instanceof Error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            code === "ENOENT" ||
            rawMessage.includes("ENOENT") ||
            rawMessage.includes("spawn")
          ) {
            errorMessage = `Claude Code CLI not found, or the session working directory no longer exists. Please ensure Claude Code is installed and available in your PATH.\n\nOriginal error: ${rawMessage}`;
          } else if (
            rawMessage.includes("exited with code 1") ||
            rawMessage.includes("exit code 1")
          ) {
            const providerHint = resolved.provider?.name
              ? ` (Provider: ${resolved.provider?.name})`
              : "";
            const detailHint = extraDetail ? `\n\nDetails: ${extraDetail}` : "";
            const hasImages = files && files.some((f) => isImageFile(f.type));
            const imageHint = hasImages
              ? "\n• Provider may not support image/vision input"
              : "";
            errorMessage = `Claude Code process exited with an error${providerHint}. This is often caused by:\n• Invalid or missing API Key\n• Incorrect Base URL configuration\n• Network connectivity issues${imageHint}${detailHint}\n\nOriginal error: ${rawMessage}`;
          } else if (rawMessage.includes("exited with code")) {
            const providerHint = resolved.provider?.name
              ? ` (Provider: ${resolved.provider?.name})`
              : "";
            errorMessage = `Claude Code process crashed unexpectedly${providerHint}.\n\nOriginal error: ${rawMessage}`;
          } else if (
            code === "ECONNREFUSED" ||
            rawMessage.includes("ECONNREFUSED") ||
            rawMessage.includes("fetch failed")
          ) {
            const baseUrl = resolved.provider?.base_url || "default";
            errorMessage = `Cannot connect to API endpoint (${baseUrl}). Please check your network connection and Base URL configuration.\n\nOriginal error: ${rawMessage}`;
          } else if (
            rawMessage.includes("401") ||
            rawMessage.includes("Unauthorized") ||
            rawMessage.includes("authentication")
          ) {
            const providerHint = resolved.provider?.name
              ? ` for provider "${resolved.provider?.name}"`
              : "";
            errorMessage = `Authentication failed${providerHint}. Please verify your API Key is correct and has not expired.\n\nOriginal error: ${rawMessage}`;
          } else if (
            rawMessage.includes("403") ||
            rawMessage.includes("Forbidden")
          ) {
            errorMessage = `Access denied. Your API Key may not have permission for this operation.\n\nOriginal error: ${rawMessage}`;
          } else if (
            rawMessage.includes("429") ||
            rawMessage.includes("rate limit") ||
            rawMessage.includes("Rate limit")
          ) {
            errorMessage = `Rate limit exceeded. Please wait a moment before retrying.\n\nOriginal error: ${rawMessage}`;
          }
        }

        controller.enqueue(formatSSE({ type: "error", data: errorMessage }));
        controller.enqueue(formatSSE({ type: "done", data: "" }));

        // Always clear sdk_session_id on crash so the next message starts fresh.
        // Even for fresh sessions — the SDK may emit a session_id via status
        // event before crashing, which gets persisted by consumeStream/SSE
        // handlers. Leaving it would cause repeated resume failures.
        if (sessionId) {
          try {
            updateSdkSessionId(sessionId, "");
            console.warn(
              "[claude-client] Cleared stale sdk_session_id for session",
              sessionId,
            );
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
