/**
 * Conversation Engine — processes inbound IM messages through Claude.
 *
 * Takes a ChannelBinding + inbound message, calls streamClaude(),
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ChannelBinding } from './types';
import type { SSEEvent, TokenUsage, MessageContentBlock, FileAttachment } from '@/types';
import { streamClaude } from '../claude-client';
import {
  addMessage,
  getMessages,
  acquireSessionLock,
  renewSessionLock,
  releaseSessionLock,
  setSessionRuntimeStatus,
  updateSdkSessionId,
  updateSessionModel,
  syncSdkTasks,
  getSession,
  getSetting,
} from '../db';
import { resolveProvider as resolveProviderUnified } from '../provider-resolver';
import { loadCodePilotMcpServers } from '../mcp-loader';
import { assembleContext } from '../context-assembler';
import crypto from 'crypto';

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
}

/**
 * Callback invoked immediately when a permission_request SSE event arrives.
 * This breaks the deadlock: the stream blocks until the permission is resolved,
 * so we must forward the request to the IM *during* stream consumption,
 * not after it returns.
 */
export type OnPermissionRequest = (perm: PermissionRequestInfo) => Promise<void>;

/**
 * Callback invoked on each `text` SSE event with the full accumulated text so far.
 * Must return synchronously — the bridge-manager handles throttling and fire-and-forget.
 */
export type OnPartialText = (fullText: string) => void;

/**
 * Callback invoked on tool_use / tool_result SSE events.
 * Used by card streaming to show tool progress indicators.
 */
export type OnToolEvent = (event: { type: 'tool_use'; id: string; name: string } | { type: 'tool_result'; tool_use_id: string; is_error: boolean }) => void;

export interface ConversationResult {
  responseText: string;
  tokenUsage: TokenUsage | null;
  hasError: boolean;
  errorMessage: string;
  /** Permission request events that were forwarded during streaming */
  permissionRequests: PermissionRequestInfo[];
  /** SDK session ID captured from status/result events, for session resume */
  sdkSessionId: string | null;
}

/**
 * Resolve and validate working directory from multiple candidates.
 * Returns the first existing directory, or HOME as last resort.
 */
function resolveWorkingDirectory(...candidates: (string | undefined | null)[]): string {
  for (const dir of candidates) {
    if (dir && fs.existsSync(dir)) return dir;
  }
  return os.homedir();
}

/**
 * Process an inbound message: send to Claude, consume the response stream,
 * save to DB, and return the result.
 */
export async function processMessage(
  binding: ChannelBinding,
  text: string,
  onPermissionRequest?: OnPermissionRequest,
  abortSignal?: AbortSignal,
  files?: FileAttachment[],
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
): Promise<ConversationResult> {
  const sessionId = binding.codepilotSessionId;

  // Acquire session lock
  const lockId = crypto.randomBytes(8).toString('hex');
  const lockAcquired = acquireSessionLock(sessionId, lockId, `bridge-${binding.channelType}`, 600);
  if (!lockAcquired) {
    return {
      responseText: '',
      tokenUsage: null,
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      permissionRequests: [],
      sdkSessionId: null,
    };
  }

  setSessionRuntimeStatus(sessionId, 'running');

  // Lock renewal interval
  const renewalInterval = setInterval(() => {
    try { renewSessionLock(sessionId, lockId, 600); } catch { /* best effort */ }
  }, 60_000);

  try {
    // Resolve session early — needed for workingDirectory and provider resolution
    const session = getSession(sessionId);

    // Save user message — persist file attachments to disk using the same
    // <!--files:JSON--> format as the desktop chat route, so the UI can render them.
    // Also attach filePath to the file objects so streamClaude() can reuse
    // on-disk copies (matching the desktop route behavior, preventing duplicate writes).
    let savedContent = text;
    if (files && files.length > 0) {
      const workDir = binding.workingDirectory || session?.working_directory || '';
      if (workDir) {
        try {
          const uploadDir = path.join(workDir, '.codepilot-uploads');
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }
          const fileMeta = files.map((f) => {
            const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
            const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
            const buffer = Buffer.from(f.data, 'base64');
            fs.writeFileSync(filePath, buffer);
            // Attach filePath to the original file object so streamClaude()
            // can reference the on-disk copy via getUploadedFilePaths()
            f.filePath = filePath;
            return { id: f.id, name: f.name, type: f.type, size: buffer.length, filePath };
          });
          savedContent = `<!--files:${JSON.stringify(fileMeta)}-->${text}`;
        } catch (err) {
          console.warn('[conversation-engine] Failed to persist file attachments:', err instanceof Error ? err.message : err);
          savedContent = `[${files.length} image(s) attached] ${text}`;
        }
      } else {
        savedContent = `[${files.length} image(s) attached] ${text}`;
      }
    }
    addMessage(sessionId, 'user', savedContent);

    // Resolve provider via unified resolver (same logic as desktop chat route)
    const resolved = resolveProviderUnified({
      sessionProviderId: session?.provider_id || undefined,
      model: binding.model || undefined,
      sessionModel: session?.model || undefined,
    });
    const resolvedProvider = resolved.provider;

    // Use upstream model from unified resolver (same chain as chat route)
    const effectiveModel = resolved.upstreamModel || resolved.model || binding.model || session?.model || getSetting('default_model') || undefined;

    // Permission mode from binding mode
    let permissionMode: string;
    switch (binding.mode) {
      case 'plan': permissionMode = 'plan'; break;
      case 'ask': permissionMode = 'default'; break;
      default: permissionMode = 'acceptEdits'; break;
    }

    // Bypass permissions entirely when session has full_access profile
    const bypassPermissions = session?.permission_profile === 'full_access';

    // Load conversation history for context
    const { messages: recentMsgs } = getMessages(sessionId, { limit: 50, excludeHeartbeatAck: true });
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    // Load only MCP servers needing CodePilot-specific processing (${...} env placeholders).
    // All other MCP servers are auto-loaded by the SDK via settingSources.
    const mcpServers = loadCodePilotMcpServers();

    // Unified context assembly — adds CLI tools context (and workspace prompt if applicable)
    const assembled = await assembleContext({
      session: session!,
      entryPoint: 'bridge',
      userPrompt: text,
      conversationHistory: historyMsgs,
    });

    // Resolve a valid working directory from multiple candidates
    const effectiveCwd = resolveWorkingDirectory(
      binding.workingDirectory,
      session?.working_directory,
      getSetting('bridge_default_work_dir'),
    );

    // If the effective cwd differs from what the binding/session had, the
    // original directory is gone — clear sdkSessionId to prevent stale resume.
    const originalCwd = binding.workingDirectory || session?.working_directory;
    const cwdChanged = originalCwd && effectiveCwd !== originalCwd;
    const effectiveSdkSessionId = cwdChanged ? undefined : (binding.sdkSessionId || undefined);

    if (cwdChanged) {
      console.log(`[conversation-engine] CWD changed from "${originalCwd}" to "${effectiveCwd}", clearing sdkSessionId`);
    }

    const stream = streamClaude({
      prompt: text,
      sessionId,
      sdkSessionId: effectiveSdkSessionId,
      model: effectiveModel,
      systemPrompt: assembled.systemPrompt,
      workingDirectory: effectiveCwd,
      abortController,
      permissionMode,
      provider: resolvedProvider,
      sessionProviderId: session?.provider_id || undefined,
      mcpServers,
      conversationHistory: historyMsgs,
      files,
      bypassPermissions,
      // Bridge-specific SDK options
      thinking: { type: 'disabled' as const },
      effort: 'medium' as const,
      generativeUI: false,
      enableFileCheckpointing: false,
      context1m: false,
      onRuntimeStatusChange: (status: string) => {
        try { setSessionRuntimeStatus(sessionId, status); } catch { /* best effort */ }
      },
    });

    // Consume the stream server-side (replicate collectStreamResponse pattern).
    // Permission requests are forwarded immediately via the callback during streaming
    // because the stream blocks until permission is resolved — we can't wait until after.
    return await consumeStream(stream, sessionId, onPermissionRequest, onPartialText, onToolEvent);
  } finally {
    clearInterval(renewalInterval);
    releaseSessionLock(sessionId, lockId);
    setSessionRuntimeStatus(sessionId, 'idle');
  }
}

/**
 * Consume an SSE stream and extract response data.
 * Mirrors the collectStreamResponse() logic from chat/route.ts.
 */
async function consumeStream(
  stream: ReadableStream<string>,
  sessionId: string,
  onPermissionRequest?: OnPermissionRequest,
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
): Promise<ConversationResult> {
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  /** Monotonically accumulated text for streaming preview — never resets on tool_use. */
  let previewText = '';
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  const seenToolResultIds = new Set<string>();
  const permissionRequests: PermissionRequestInfo[] = [];
  let capturedSdkSessionId: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        let event: SSEEvent;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        switch (event.type) {
          case 'text':
            currentText += event.data;
            if (onPartialText) {
              previewText += event.data;
              try { onPartialText(previewText); } catch { /* non-critical */ }
            }
            break;

          case 'tool_use': {
            if (currentText.trim()) {
              contentBlocks.push({ type: 'text', text: currentText });
              currentText = '';
            }
            try {
              const toolData = JSON.parse(event.data);
              contentBlocks.push({
                type: 'tool_use',
                id: toolData.id,
                name: toolData.name,
                input: toolData.input,
              });
              if (onToolEvent) {
                try { onToolEvent({ type: 'tool_use', id: toolData.id, name: toolData.name }); } catch { /* non-critical */ }
              }
            } catch { /* skip */ }
            break;
          }

          case 'tool_result': {
            try {
              const resultData = JSON.parse(event.data);
              const newBlock = {
                type: 'tool_result' as const,
                tool_use_id: resultData.tool_use_id,
                content: resultData.content,
                is_error: resultData.is_error || false,
              };
              if (seenToolResultIds.has(resultData.tool_use_id)) {
                const idx = contentBlocks.findIndex(
                  (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id
                );
                if (idx >= 0) contentBlocks[idx] = newBlock;
              } else {
                seenToolResultIds.add(resultData.tool_use_id);
                contentBlocks.push(newBlock);
              }
              if (onToolEvent) {
                try { onToolEvent({ type: 'tool_result', tool_use_id: resultData.tool_use_id, is_error: resultData.is_error || false }); } catch { /* non-critical */ }
              }
            } catch { /* skip */ }
            break;
          }

          case 'permission_request': {
            try {
              const permData = JSON.parse(event.data);
              const perm: PermissionRequestInfo = {
                permissionRequestId: permData.permissionRequestId,
                toolName: permData.toolName,
                toolInput: permData.toolInput,
                suggestions: permData.suggestions,
              };
              permissionRequests.push(perm);
              // Forward immediately — the stream blocks until the permission is
              // resolved, so we must send the IM prompt *now*, not after the stream ends.
              if (onPermissionRequest) {
                onPermissionRequest(perm).catch((err) => {
                  console.error('[conversation-engine] Failed to forward permission request:', err);
                });
              }
            } catch { /* skip */ }
            break;
          }

          case 'status': {
            try {
              const statusData = JSON.parse(event.data);
              if (statusData.session_id) {
                capturedSdkSessionId = statusData.session_id;
                updateSdkSessionId(sessionId, statusData.session_id);
              }
              if (statusData.model) {
                updateSessionModel(sessionId, statusData.model);
              }
            } catch { /* skip */ }
            break;
          }

          case 'task_update': {
            try {
              const taskData = JSON.parse(event.data);
              if (taskData.session_id && taskData.todos) {
                syncSdkTasks(taskData.session_id, taskData.todos);
              }
            } catch { /* skip */ }
            break;
          }

          case 'error': {
            hasError = true;
            // Parse structured error JSON to extract a user-friendly message
            try {
              const errObj = JSON.parse(event.data);
              errorMessage = errObj.userMessage || errObj._formattedMessage || errObj.message || event.data;
            } catch {
              errorMessage = event.data || 'Unknown error';
            }
            break;
          }

          case 'result': {
            try {
              const resultData = JSON.parse(event.data);
              if (resultData.usage) tokenUsage = resultData.usage;
              if (resultData.is_error) hasError = true;
              if (resultData.session_id) {
                capturedSdkSessionId = resultData.session_id;
                updateSdkSessionId(sessionId, resultData.session_id);
              }
            } catch { /* skip */ }
            break;
          }

          // tool_output, tool_timeout, mode_changed, done — ignored for bridge
        }
      }
    }

    // Flush remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    // Save assistant message
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();

      if (content) {
        addMessage(sessionId, 'assistant', content, tokenUsage ? JSON.stringify(tokenUsage) : null);
      }
    }

    // Extract text-only response for IM delivery
    const responseText = contentBlocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    return {
      responseText,
      tokenUsage,
      hasError,
      errorMessage,
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  } catch (e) {
    // Best-effort save on stream error
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();
      if (content) {
        addMessage(sessionId, 'assistant', content);
      }
    }

    const isAbort = e instanceof DOMException && e.name === 'AbortError'
      || e instanceof Error && e.name === 'AbortError';

    return {
      responseText: '',
      tokenUsage,
      hasError: true,
      errorMessage: isAbort ? 'Task stopped by user' : (e instanceof Error ? e.message : 'Stream consumption error'),
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  }
}
