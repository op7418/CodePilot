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
  getDefaultProviderId,
  isLockOwner,
} from '../db';
import { createSessionLockSettler } from '../session-lock-settle';
import {
  normalizePermissionProfile,
  resolveClaudeWireOptions,
  resolveProfileAutoReviewSupport,
} from '../permission/profile';
import { isAutoReviewSupported } from '../permission/sdk-capability';
import { evaluateRenewal } from '../session-lock-renewal';
import { resolveProvider as resolveProviderUnified } from '../provider-resolver';
import { getActiveChatRuntime } from '../chat-runtime';
import { loadCodePilotMcpServers, loadAllMcpServers } from '../mcp-loader';
import { assembleContext } from '../context-assembler';
import { predictNativeRuntime } from '../runtime';
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

  // Lock renewal interval. Session ownership (DP3): if renewSessionLock returns
  // false the lockId no longer owns the row (a newer web/bridge send took over,
  // or the lock was already released) — stop renewing a lock we don't hold.
  // Bridge turns are NOT autoTrigger, so there is no renewal cap (autoTrigger:
  // false + max: Infinity ⇒ evaluateRenewal only ever returns 'continue' or
  // 'stop-renew-false'); the shared decision keeps the semantics consistent
  // with the /api/chat route.
  const renewalInterval = setInterval(() => {
    let renewed: boolean;
    try {
      renewed = renewSessionLock(sessionId, lockId, 600);
    } catch {
      // Transient DB error — keep the interval alive and retry next tick.
      return;
    }
    const decision = evaluateRenewal({ autoTrigger: false, renewalCount: 0, renewed, max: Infinity });
    if (decision === 'stop-renew-false') {
      console.warn(`[conversation-engine] lockId 已不 own（被接管/已释放），停止续租 session ${sessionId}`);
      clearInterval(renewalInterval);
    }
  }, 60_000);

  // Session ownership — lockId-scoped settler shared with the finally below.
  // Idempotent; only writes runtime_status when releaseSessionLock confirms we
  // still own the lock (lockId-scoped release vs session-scoped status), so a
  // superseded bridge turn cannot clobber the new owner's 'running' with 'idle'.
  const settleLock = createSessionLockSettler({
    clearRenewal: () => clearInterval(renewalInterval),
    releaseLock: () => releaseSessionLock(sessionId, lockId),
    setStatus: (status) => { try { setSessionRuntimeStatus(sessionId, status); } catch { /* best effort */ } },
  });

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

    // Resolve provider via unified resolver.
    // Priority chain:
    // 1. Binding's provider_id (per-binding override)
    // 2. Session's provider_id (if the DB column exists)
    // 3. Global default provider (getDefaultProviderId)
    // 4. 'env' mode fallback
    const effectiveProviderId = binding.providerId || session?.provider_id || getDefaultProviderId() || undefined;

    // Same runtime gate as the main /api/chat route — bridge sessions go
    // through the same SDK / ai-sdk paths, so the default-model fallback
    // must respect the active runtime's compat constraints.
    const activeRuntime = getActiveChatRuntime();
    const resolved = resolveProviderUnified({
      providerId: effectiveProviderId,
      model: binding.model || undefined,
      sessionModel: session?.model || undefined,
      runtime: activeRuntime,
    });
    const resolvedProvider = resolved.provider;

    // Use upstream model from unified resolver (same chain as chat route)
    const effectiveModel = resolved.upstreamModel || resolved.model || binding.model || session?.model || getSetting('default_model') || undefined;

    // Guard: protocol/model mismatch — e.g. google protocol with model 'sonnet'
    // would silently send a wrong request. Fail fast with a clear error.
    if (resolvedProvider && resolved.protocol) {
      const modelLower = (effectiveModel || '').toLowerCase();
      const isAnthropicModel = modelLower.includes('claude') || ['sonnet', 'opus', 'haiku'].includes(modelLower);
      const isNonAnthropicProtocol = !['anthropic', 'openai-compatible', 'openrouter'].includes(resolved.protocol);
      if (isAnthropicModel && isNonAnthropicProtocol) {
        const errMsg = `Provider "${resolvedProvider.name}" uses ${resolved.protocol} protocol but model "${effectiveModel}" is an Anthropic model. Please configure the correct provider for this bridge channel.`;
        console.error(`[conversation-engine] ${errMsg}`);
        throw new Error(errMsg);
      }
    }

    // Permission mode from binding mode
    // Profile decides the floor (plan > bypass > auto reviewer > acceptEdits)
    // through the same resolver the main chat route uses — bridge sessions
    // must not grow their own interpretation of the three profiles.
    const wire = resolveClaudeWireOptions({
      profile: normalizePermissionProfile(session?.permission_profile),
      effectiveMode: binding.mode === 'plan' ? 'plan' : 'code',
      autoReviewSupported: resolveProfileAutoReviewSupport({
        runtime: activeRuntime,
        claudeSdkSupported: isAutoReviewSupported(),
      }),
    });

    // The binding's 'ask' mode is a separate axis: it asks for MORE
    // confirmation than the profile's floor. It can tighten acceptEdits into
    // 'default', but it never loosens a bypass and never overrides the
    // reviewer — those are the profile's call.
    const permissionMode: string =
      binding.mode === 'ask' && wire.permissionMode === 'acceptEdits' ? 'default' : wire.permissionMode;
    const bypassPermissions = wire.bypassPermissions;

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

    // Load MCP servers using shared runtime prediction (same logic as chat route).
    // Was lazy `require('../runtime')`; converted to static import — Turbopack's
    // CJS↔ESM interop returns `{ default: ... }` shape that broke destructuring.
    const mcpServers = predictNativeRuntime(effectiveProviderId)
      ? loadAllMcpServers()
      : loadCodePilotMcpServers();

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
      callScene: 'bridge',
      sessionId,
      // Session ownership — plumb the ownership token so this bridge turn's Query
      // registers/unregisters and clearSdkSessionIfOwner run under A's owner-gate
      // (options.lockId). A superseded bridge turn then can't clear a new owner's
      // SDK session on cleanup.
      lockId,
      sdkSessionId: effectiveSdkSessionId,
      model: effectiveModel,
      systemPrompt: assembled.systemPrompt,
      workingDirectory: effectiveCwd,
      abortController,
      permissionMode,
      provider: resolvedProvider,
      providerId: effectiveProviderId,
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
        // I1 owner gate: a superseded bridge turn (its session lock taken over
        // by a newer web/bridge turn) must not write session-level runtime_status
        // — it would clobber the new owner's 'running'.
        try {
          if (isLockOwner(sessionId, lockId)) {
            setSessionRuntimeStatus(sessionId, status);
          } else {
            console.warn(`[conversation-engine] stale owner (lockId superseded), skipping runtime_status write for session ${sessionId}`);
          }
        } catch { /* best effort */ }
      },
    });

    // Consume the stream server-side (replicate collectStreamResponse pattern).
    // Permission requests are forwarded immediately via the callback during streaming
    // because the stream blocks until permission is resolved — we can't wait until after.
    return await consumeStream(stream, sessionId, lockId, onPermissionRequest, onPartialText, onToolEvent);
  } finally {
    // Session ownership — lockId-scoped settle: clears the renewal interval,
    // releases only THIS lockId's row, and writes runtime_status='idle' ONLY when
    // the release confirms we still owned the lock. A superseded bridge turn thus
    // no longer overwrites the new owner's 'running' with 'idle'.
    settleLock('idle');
  }
}

/**
 * Consume an SSE stream and extract response data.
 * Mirrors the collectStreamResponse() logic from chat/route.ts.
 *
 * Session ownership (I1/DP1 owner gate): `lockId` is this bridge turn's ownership
 * token. Every session-level write below — sdk_session_id / model / SDK tasks /
 * the assistant `addMessage` — is gated on `isLockOwner(sessionId, lockId)`. A
 * superseded bridge turn (its lock taken over by a newer web/bridge send) reaches
 * consume LATE carrying its OLD lockId and must write NOTHING to shared session
 * state. Exported (it is a lib function, no Next route export contract) so the
 * gate is driveable by a real DB unit test.
 */
export async function consumeStream(
  stream: ReadableStream<string>,
  sessionId: string,
  lockId: string,
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
          case 'thinking': {
            // Accumulate thinking deltas into a thinking content block
            const delta = event.data;
            const lastBlock = contentBlocks[contentBlocks.length - 1];
            if (lastBlock && lastBlock.type === 'thinking' && 'thinking' in lastBlock) {
              (lastBlock as { type: 'thinking'; thinking: string }).thinking += delta;
            } else {
              contentBlocks.push({ type: 'thinking', thinking: delta });
            }
            break;
          }

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
              // capturedSdkSessionId is in-memory (returned to this binding for
              // its own resume) — harmless. Only the shared session-level DB
              // writes are owner-gated (I1/DP1): a superseded turn must not
              // overwrite the new owner's sdk_session_id / model.
              if (statusData.session_id) {
                capturedSdkSessionId = statusData.session_id;
              }
              if (statusData.session_id || statusData.model) {
                if (!isLockOwner(sessionId, lockId)) {
                  console.warn(`[conversation-engine] stale owner (lockId superseded), skipping status session_id/model write for session ${sessionId}`);
                } else {
                  if (statusData.session_id) {
                    updateSdkSessionId(sessionId, statusData.session_id);
                  }
                  if (statusData.model) {
                    updateSessionModel(sessionId, statusData.model);
                  }
                }
              }
              // Skill-nudge: agent loop emits this at end-of-run when the
              // workflow is complex enough to warrant saving as a Skill.
              // Append as a separated text block so IM users see the
              // suggestion at the bottom of the assistant reply.
              if (
                statusData.subtype === 'skill_nudge' &&
                typeof statusData.message === 'string' &&
                statusData.message.trim() !== ''
              ) {
                // Flush any pending assistant text first so the nudge
                // appears AFTER the assistant's own final words.
                if (currentText.trim()) {
                  contentBlocks.push({ type: 'text', text: currentText });
                  currentText = '';
                }
                contentBlocks.push({
                  type: 'text',
                  text: `\n\n---\nSkill suggestion: ${statusData.message}`,
                });
              }
            } catch { /* skip */ }
            break;
          }

          case 'task_update': {
            try {
              const taskData = JSON.parse(event.data);
              if (taskData.session_id && taskData.todos) {
                // I1/DP1 owner gate: a superseded turn must not overwrite the
                // new owner's task list.
                if (!isLockOwner(sessionId, lockId)) {
                  console.warn(`[conversation-engine] stale owner (lockId superseded), skipping syncSdkTasks for session ${sessionId}`);
                } else {
                  syncSdkTasks(taskData.session_id, taskData.todos);
                }
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
                // I1/DP1 owner gate: a superseded turn must not write the new
                // owner's sdk_session_id.
                if (!isLockOwner(sessionId, lockId)) {
                  console.warn(`[conversation-engine] stale owner (lockId superseded), skipping result sdk_session_id write for session ${sessionId}`);
                } else {
                  updateSdkSessionId(sessionId, resultData.session_id);
                }
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
      const hasStructuredBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'thinking'
      );
      const content = hasStructuredBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();

      if (content) {
        // DP1 owner gate: a superseded bridge turn must not insert its (old)
        // assistant answer into the new owner's timeline. The response is still
        // returned to this binding for IM delivery; only the DB persist is dropped.
        if (!isLockOwner(sessionId, lockId)) {
          console.warn(`[conversation-engine] stale owner (lockId superseded) — DP1: dropping assistant message persist for session ${sessionId} (${content.length} chars not written)`);
        } else {
          addMessage(sessionId, 'assistant', content, tokenUsage ? JSON.stringify(tokenUsage) : null);
        }
      }
    }

    // Extract response for IM delivery — include text blocks, and if none exist
    // but thinking blocks are present, include a summary so thinking-only turns
    // are not silently dropped.
    const textParts = contentBlocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text);
    if (textParts.length === 0) {
      const thinkingBlocks = contentBlocks.filter((b) => b.type === 'thinking' && 'thinking' in b);
      if (thinkingBlocks.length > 0) {
        textParts.push('_(reasoning completed, no text output)_');
      }
    }
    const responseText = textParts.join('').trim();

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
      const hasStructuredBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'thinking'
      );
      const content = hasStructuredBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();
      if (content) {
        // DP1 owner gate (error path): same invariant as the happy path — a
        // superseded bridge turn must not insert its partial answer into the new
        // owner's timeline.
        if (!isLockOwner(sessionId, lockId)) {
          console.warn(`[conversation-engine] stale owner (lockId superseded) — DP1: dropping error-path assistant message persist for session ${sessionId}`);
        } else {
          addMessage(sessionId, 'assistant', content);
        }
      }
    }

    const isAbort = e instanceof DOMException && e.name === 'AbortError'
      || e instanceof Error && e.name === 'AbortError';

    // Build error responseText — include indicator if thinking blocks were present
    const errorTextParts = contentBlocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text);
    if (errorTextParts.length === 0 && contentBlocks.some((b) => b.type === 'thinking')) {
      errorTextParts.push('_(reasoning completed, no text output)_');
    }

    return {
      responseText: errorTextParts.join('').trim(),
      tokenUsage,
      hasError: true,
      errorMessage: isAbort ? 'Task stopped by user' : (e instanceof Error ? e.message : 'Stream consumption error'),
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  }
}
