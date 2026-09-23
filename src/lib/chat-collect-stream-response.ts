import { createStreamTurnOutcome, NON_SUCCESSFUL_TERMINAL_FINISH_REASONS } from './stream-turn-outcome';
import { enqueueCommittedMemoryTurn, getMemoryTurnUserMessageId } from './memory-lifecycle';
import { getAssistantMemoryWorkspace } from './memory-binding';
// Server-side SSE collection + assistant persistence for POST /api/chat.
//
// Extracted out of `route.ts` (Session ownership rework): Next App Router only
// allows a route module to export HTTP methods / segment config, so a named
// `collectStreamResponse` export from `route.ts` breaks `.next/types` route
// typecheck. This library module is imported by BOTH `route.ts` (production
// call site) and `collect-owner-gate.test.ts` (real-driven owner-gate test),
// keeping the route module's export surface clean.
import type { ChatRuntime } from '@/lib/chat-runtime-shared';
import { isSessionStateResultError } from '@/lib/error-classifier';
import {
  addMessage,
  getSession,
  updateSdkSessionId,
  syncSdkTasks,
  isLockOwner,
  updateMessageStreamCheckpoint,
  updateMessageStreamStatus,
} from '@/lib/db';
import { notifySessionComplete, notifySessionError } from '@/lib/telegram-bot';
import {
  notifyInteractiveChatApproval,
  notifyInteractiveChatCompleted,
} from '@/lib/interactive-chat-notifications';
import { extractCompletion } from '@/lib/onboarding-completion';
import { saveMediaToLibrary } from '@/lib/media-saver';
import type { SSEEvent, TokenUsage, MessageContentBlock, MediaBlock, ExternalSource } from '@/types';
import { isRuntimeId } from '@/lib/runtime/runtime-id';
import { attachNormalizedTurnUsage } from '@/lib/runtime/turn-usage';
import { attachNativeStep, parseNativeStepHistory } from './native-step-history';

const ASSISTANT_CHECKPOINT_INTERVAL_MS = 120;

/**
 * Serialize assistant blocks with the same shape used by historical rendering.
 * Checkpoints and terminal persistence must share this helper so refreshing
 * cannot change a tool/sub-agent block into a different transcript shape.
 */
function serializeAssistantBlocks(blocks: readonly MessageContentBlock[]): string | null {
  const cleanedBlocks = blocks;
  const hasStructuredBlocks = cleanedBlocks.some(
    (block) =>
      Boolean(block.nativeStep) || block.type === 'tool_use'
      || block.type === 'tool_result'
      || block.type === 'thinking'
  );
  const content = hasStructuredBlocks
    ? JSON.stringify(cleanedBlocks)
    : cleanedBlocks
        .filter((block): block is Extract<MessageContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();
  return content || null;
}

function buildAssistantSnapshot(
  contentBlocks: readonly MessageContentBlock[],
  currentText: string,
  thinkingText: string,
): { blocks: MessageContentBlock[]; content: string | null } {
  const blocks = [...contentBlocks];
  if (currentText.trim()) {
    blocks.push({ type: 'text', text: currentText });
  }
  if (thinkingText.trim()) {
    blocks.unshift({ type: 'thinking', thinking: thinkingText.trim() });
  }
  return { blocks, content: serializeAssistantBlocks(blocks) };
}

/**
 * Consume the runtime SSE stream server-side and persist the assistant turn.
 *
 * Session ownership (I1/DP1 ownership gate): `lockId` is this turn's
 * session-lock owner token (minted at route.ts :85). EVERY session-level write
 * below — sdk_session_id / SDK tasks / the assistant `addMessage` — is
 * gated on `isLockOwner(sessionId, lockId)`. A superseded turn (its lock taken
 * over by a newer send after Stop→watchdog release) reaches here LATE and must
 * NOT write: its writes would clobber the new owner's state and (DP1) splice its
 * stale assistant output into the new owner's message timeline (the 1.9 ordering
 * bug). The happy path is safe because `addMessage` runs inside the try, BEFORE
 * `onComplete`→settleLock releases the lock (route.ts finally), so the true
 * owner is still the lock holder when it persists.
 *
 * Lives in a library module (not route.ts) so it can be imported by both the
 * route and the owner-gate behavioral test (collect-owner-gate.test.ts), which
 * drives it with a real SSE stream + real DB lock state.
 */
export async function collectStreamResponse(
  stream: ReadableStream<string>,
  sessionId: string,
  lockId: string,
  telegramOpts: { sessionId?: string; sessionTitle?: string; workingDirectory?: string },
  onComplete?: () => void,
  opts?: {
    suppressNotifications?: boolean;
    /** Terminal DB writes have settled; post-save model calls are still background work. */
    onPersistenceSettled?: (saved: boolean) => void;
    /** Phase 2 semantic title generation. Present only when this turn is the
     *  session's FIRST real user turn (the route sets it from the fallback-title
     *  CAS return value). Fired below only on a clean, persisted completion. */
    titleGeneration?: {
      userText: string;
      runtime: ChatRuntime;
      providerId: string;
      model?: string;
    };
  },
) {
  const memoryUserMessageId = getMemoryTurnUserMessageId(sessionId);
  const reader = stream.getReader();
  const memoryOutcome = createStreamTurnOutcome();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  let thinkingText = '';
  /** Tracks whether non-thinking content arrived since last thinking delta (for phase separation) */
  let thinkingPhaseEnded = false;
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  let sawSuccessfulResult = false;
  let sawNonSuccessfulTerminalResult = false;
  let lastSavedAssistantMsgId: string | null = null;
  let checkpointMessageId: string | null = null;
  let lastCheckpointAt = 0;
  // Dedup layer: skip duplicate tool_result events by tool_use_id
  const seenToolResultIds = new Set<string>();
  const notifiedPermissionRequestIds = new Set<string>();

  const persistCheckpoint = (force = false): void => {
    const now = Date.now();
    if (!force && checkpointMessageId && now - lastCheckpointAt < ASSISTANT_CHECKPOINT_INTERVAL_MS) {
      return;
    }

    const { content } = buildAssistantSnapshot(contentBlocks, currentText, thinkingText);
    if (!content) return;

    // A checkpoint may only be created/advanced while this turn owns the
    // session. If ownership was superseded after an earlier checkpoint, settle
    // that old row without copying any newer stale output into the timeline.
    if (!isLockOwner(sessionId, lockId)) {
      if (checkpointMessageId) {
        updateMessageStreamStatus(checkpointMessageId, 'interrupted');
      }
      return;
    }

    const usage = tokenUsage ? JSON.stringify(tokenUsage) : null;
    if (checkpointMessageId) {
      updateMessageStreamCheckpoint(checkpointMessageId, content, 'streaming', usage);
    } else {
      const saved = addMessage(sessionId, 'assistant', content, usage, {
        stream_status: 'streaming',
      });
      checkpointMessageId = saved.id;
    }
    lastCheckpointAt = now;
  };

  const persistTerminal = (
    content: string,
    status: 'completed' | 'error',
  ): void => {
    if (!isLockOwner(sessionId, lockId)) {
      if (checkpointMessageId) {
        updateMessageStreamStatus(checkpointMessageId, 'interrupted');
      }
      console.warn(
        `[chat/route] stale owner (lockId superseded) — DP1: dropping terminal assistant content for session ${sessionId}`,
      );
      return;
    }

    const usage = tokenUsage ? JSON.stringify(tokenUsage) : null;
    if (checkpointMessageId) {
      updateMessageStreamCheckpoint(checkpointMessageId, content, status, usage);
      lastSavedAssistantMsgId = checkpointMessageId;
    } else {
      const saved = addMessage(sessionId, 'assistant', content, usage, {
        stream_status: status,
      });
      checkpointMessageId = saved.id;
      lastSavedAssistantMsgId = saved.id;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event: SSEEvent = JSON.parse(line.slice(6));
            memoryOutcome.observe(event);
            if (event.type === 'permission_request') {
              // Permission prompts are not transcript content, but they are a
              // first-class native notification. The server-side collector is
              // the single cross-Runtime source, so navigation/reload cannot
              // make the reminder disappear or duplicate it.
              if (!opts?.suppressNotifications && isLockOwner(sessionId, lockId)) {
                try {
                  const permission = JSON.parse(event.data) as {
                    permissionRequestId?: unknown;
                    toolName?: unknown;
                  };
                  const permissionRequestId = typeof permission.permissionRequestId === 'string'
                    ? permission.permissionRequestId
                    : '';
                  if (permissionRequestId && !notifiedPermissionRequestIds.has(permissionRequestId)) {
                    await notifyInteractiveChatApproval({
                      sessionId,
                      sessionTitle: telegramOpts.sessionTitle,
                      toolName: typeof permission.toolName === 'string' ? permission.toolName : undefined,
                    });
                    notifiedPermissionRequestIds.add(permissionRequestId);
                  }
                } catch (error) {
                  console.warn(
                    `[chat/route] failed to queue approval notification for session ${sessionId}:`,
                    error instanceof Error ? error.message : String(error),
                  );
                }
              }
            } else if (event.type === 'tool_output') {
              // Streaming tool output is not saved as message content.
            } else if (event.type === 'thinking') {
              // Accumulate thinking content with phase separation (--- between phases)
              if (thinkingPhaseEnded) {
                if (thinkingText) thinkingText += '\n\n---\n\n';
                thinkingPhaseEnded = false;
              }
              thinkingText += event.data;
              persistCheckpoint();
            } else if (event.type === 'text') {
              currentText += event.data;
              if (thinkingText) thinkingPhaseEnded = true;
              persistCheckpoint();
            } else if (event.type === 'native_step') {
              const step = await parseNativeStepHistory(JSON.parse(event.data));
              if (step) {
                if (thinkingText) contentBlocks.push({ type: 'thinking', thinking: thinkingText });
                if (currentText) contentBlocks.push({ type: 'text', text: currentText });
                thinkingText = ''; currentText = ''; thinkingPhaseEnded = false;
                attachNativeStep(contentBlocks, step);
                persistCheckpoint(true);
              }
            } else if (event.type === 'tool_use') {
              if (thinkingText) thinkingPhaseEnded = true;
              // Flush any accumulated text before the tool use block
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
                persistCheckpoint(true);
              } catch {
                // skip malformed tool_use data
              }
            } else if (event.type === 'tool_result') {
              try {
                const resultData = JSON.parse(event.data);

                // Save media blocks to library, replace base64 with local paths
                let savedMedia: MediaBlock[] | undefined;
                if (Array.isArray(resultData.media) && resultData.media.length > 0) {
                  savedMedia = [];
                  for (const block of resultData.media as MediaBlock[]) {
                    if (block.data) {
                      try {
                        const saved = saveMediaToLibrary(block, {
                          sessionId,
                          parentAssetIds: block.sourceMetadata?.parentAssetIds,
                        });
                        savedMedia.push({
                          type: block.type,
                          mimeType: block.mimeType,
                          localPath: saved.localPath,
                          mediaId: saved.mediaId,
                        });
                      } catch (saveErr) {
                        console.warn('[chat/route] Failed to save media block:', saveErr);
                        savedMedia.push(block); // Keep original if save fails
                      }
                    } else {
                      savedMedia.push(block);
                    }
                  }
                }

                const newBlock: MessageContentBlock = {
                  type: 'tool_result' as const,
                  tool_use_id: resultData.tool_use_id,
                  content: resultData.content,
                  is_error: resultData.is_error || false,
                  ...(savedMedia && savedMedia.length > 0 ? { media: savedMedia } : {}),
                  ...(Array.isArray(resultData.sources) && resultData.sources.length > 0
                    ? { sources: resultData.sources as ExternalSource[] }
                    : {}),
                };
                // Last-wins: if same tool_use_id already exists, replace it
                // (user handler's result may be more complete than PostToolUse's)
                if (seenToolResultIds.has(resultData.tool_use_id)) {
                  const idx = contentBlocks.findIndex(
                    (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id
                  );
                  if (idx >= 0) {
                    contentBlocks[idx] = newBlock;
                  }
                } else {
                  seenToolResultIds.add(resultData.tool_use_id);
                  contentBlocks.push(newBlock);
                }
                persistCheckpoint(true);
              } catch {
                // skip malformed tool_result data
              }
            } else if (event.type === 'status') {
              // Persist the continuation reference, never the reported model:
              // status.model is an upstream observation, not the committed
              // picker route. Overwriting it breaks alias-based second turns.
              // I1/DP1 owner gate: a superseded turn must not write session-level
              // state — skip the write (diagnostic-log only) if we no longer own
              // the lock.
              try {
                const statusData = JSON.parse(event.data);
                if (statusData.session_id) {
                  if (!isLockOwner(sessionId, lockId)) {
                    console.warn(`[chat/route] stale owner (lockId superseded), skipping status session_id write for session ${sessionId}`);
                  } else {
                    if (statusData.session_id) {
                      updateSdkSessionId(sessionId, statusData.session_id);
                    }
                  }
                }
              } catch {
                // skip malformed status data
              }
            } else if (event.type === 'task_update') {
              // Sync SDK TodoWrite tasks to local DB. I1/DP1 owner gate: a
              // superseded turn must not overwrite the new owner's task list.
              try {
                const taskData = JSON.parse(event.data);
                if (taskData.session_id && taskData.todos) {
                  if (!isLockOwner(sessionId, lockId)) {
                    console.warn(`[chat/route] stale owner (lockId superseded), skipping syncSdkTasks for session ${sessionId}`);
                  } else {
                    syncSdkTasks(taskData.session_id, taskData.todos);
                  }
                }
              } catch {
                // skip malformed task_update data
              }
            } else if (event.type === 'error') {
              hasError = true;
              errorMessage = event.data || 'Unknown error';
            } else if (event.type === 'result') {
              try {
                const resultData = JSON.parse(event.data);
                const finishReason = typeof resultData.finish_reason === 'string'
                  ? resultData.finish_reason
                  : null;
                if (
                  finishReason
                  && NON_SUCCESSFUL_TERMINAL_FINISH_REASONS.has(finishReason)
                ) {
                  // Codex emits a second usage-only result after the terminal
                  // interrupted/inProgress result. Keep this sticky so that
                  // follow-up accounting cannot turn a stopped turn back into
                  // a successful completion.
                  sawNonSuccessfulTerminalResult = true;
                }
                if (resultData.usage) {
                  const rawUsage = resultData.usage as TokenUsage;
                  const routeSession = getSession(sessionId);
                  tokenUsage = routeSession && isRuntimeId(routeSession.runtime_pin)
                    ? attachNormalizedTurnUsage(rawUsage, {
                        runtimeId: routeSession.runtime_pin,
                        providerInstanceId: routeSession.provider_id || undefined,
                        modelId: routeSession.model || undefined,
                      })
                    : rawUsage;
                  persistCheckpoint(true);
                }
                if (resultData.is_error) {
                  hasError = true;
                  // #629 — surface the result error so the empty-assistant guard
                  // below persists a visible **Error:** bubble; otherwise a failed
                  // is_error result turn looks like "no answer" after refresh.
                  if (!errorMessage) {
                    errorMessage =
                      (Array.isArray(resultData.errors) && resultData.errors.length
                        ? resultData.errors.join('\n')
                        : resultData.subtype) || 'The conversation ended with an error';
                  }
                } else if (!sawNonSuccessfulTerminalResult) {
                  sawSuccessfulResult = true;
                }
                // Also capture session_id from result if we missed it from init.
                // #629 — EXCEPT a stale-resume is_error result: resultData.session_id
                // is the BAD id; persisting it would overwrite claude-client's clear
                // and make the next turn retry the broken resume. Clear it instead so
                // the next message starts fresh (DB-history rebuild).
                // I1/DP1 owner gate: a superseded turn must not write (or clear) the
                // new owner's sdk_session_id.
                if (!isLockOwner(sessionId, lockId)) {
                  console.warn(`[chat/route] stale owner (lockId superseded), skipping result sdk_session_id write for session ${sessionId}`);
                } else if (resultData.is_error && isSessionStateResultError(resultData.errors)) {
                  updateSdkSessionId(sessionId, '');
                } else if (resultData.session_id) {
                  updateSdkSessionId(sessionId, resultData.session_id);
                }
                // Memory flush tracking: log high turn counts for assistant sessions.
                // The progressive update instructions already tell the model to
                // proactively write important info to daily memory files.
                if (resultData.num_turns >= 25) {
                  console.log(`[chat API] High turn count (${resultData.num_turns}) for session ${sessionId}`);
                }
              } catch {
                // skip malformed result data
              }
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    }

    // Flush any remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    // Prepend thinking block if accumulated during stream
    if (thinkingText.trim()) {
      contentBlocks.unshift({ type: 'thinking', thinking: thinkingText.trim() });
    }

    // Phase 5c slice 5 (2026-05-16, post-smoke) — when the only
    // thing the stream produced was an error event (no text, no
    // thinking, no tool call), persist a fallback assistant message
    // capturing the error. Pre-fix the proxy preflight 400 path
    // (e.g. Codex `namespace` tool tripping unsupported_tool_kind)
    // fired `event.type === 'error'` → set `hasError` + `errorMessage`,
    // then `done` closed the stream with `contentBlocks` still
    // empty. Nothing landed in DB and refresh showed only the user
    // bubble — looked like "the assistant ignored me".
    //
    // Same `**Error:** <message>` format `stream-session-manager.ts`
    // uses on the client side so the post-refresh transcript matches
    // what the live SSE showed.
    if (hasError && contentBlocks.length === 0 && errorMessage) {
      contentBlocks.push({ type: 'text', text: `**Error:** ${errorMessage}` });
    }

    if (contentBlocks.length > 0) {
      const content = serializeAssistantBlocks(contentBlocks);

      if (content) {
        persistTerminal(content, hasError ? 'error' : 'completed');
      }
    }
  } catch (e) {
    hasError = true;
    errorMessage = e instanceof Error ? e.message : 'Stream reading error';
    // Stream reading error - best effort save (same structured-block handling as happy path)
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    if (thinkingText.trim()) {
      contentBlocks.unshift({ type: 'thinking', thinking: thinkingText.trim() });
    }
    // Same error-visibility fallback as the happy path above —
    // applies when the SSE consumption loop itself throws (network
    // drop / parse failure) rather than receiving an error event.
    // Without this, transient stream errors also disappeared from
    // the transcript on refresh.
    if (contentBlocks.length === 0 && errorMessage) {
      contentBlocks.push({ type: 'text', text: `**Error:** ${errorMessage}` });
    }
    if (contentBlocks.length > 0) {
      const content = serializeAssistantBlocks(contentBlocks);
      if (content) {
        persistTerminal(content, 'error');
      }
    }
  } finally {
    // A durable success event shared by Desktop and Bridge, independent of Runtime.
    if (lastSavedAssistantMsgId !== null) {
      try {
        enqueueCommittedMemoryTurn({
          sessionId, assistantMessageId: lastSavedAssistantMsgId, userMessageId: memoryUserMessageId ?? null,
          successful: memoryOutcome.successful && !hasError,
          ownerValid: isLockOwner(sessionId, lockId),
          systemTurn: !!opts?.suppressNotifications, entryPoint: 'desktop', blocks: contentBlocks,
        });
      } catch { console.warn('[memory] MEMORY_JOB_ENQUEUE_FAILED'); }
    }

    // Publish before any asynchronous completion effects. A later notification
    // or cleanup failure must not turn a confirmed DB write into a save warning.
    opts?.onPersistenceSettled?.(lastSavedAssistantMsgId !== null || contentBlocks.length === 0);
    // ── Server-side completion detection (reliable path) ──
    // After persisting the assistant message, check for onboarding/checkin
    // fences and process them directly on the server. This ensures completion
    // is captured even if the frontend misses it (page refresh, parse failure, etc.).
    try {
      const fullText = contentBlocks
        .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');

      // 1. Check for onboarding-complete fence
      const completion = extractCompletion(fullText);
      if (completion) {
        const session = getSession(sessionId);
        const workspacePath = session && getAssistantMemoryWorkspace(session);
        if (workspacePath) {
          await processCompletionServerSide(completion, workspacePath, sessionId);
        }
      }

    } catch (e) {
      console.error('[chat API] Server-side completion detection failed:', e);
    }

    // ── Phase 2: semantic title generation (background, fire-and-forget) ──
    // Preconditions, all required:
    //   - the route marked this as the session's first real user turn,
    //   - the turn ended cleanly (`hasError` covers thrown errors AND inline
    //     `error` SSE events; interrupted/inProgress terminal results are
    //     tracked separately because they are not provider errors),
    //   - the assistant row actually persisted (a turn dropped by the DP1 owner
    //     gate is a superseded turn — it must not name the new owner's chat).
    // Not awaited: `collectStreamResponse` is itself detached from the streaming
    // Response, and nothing downstream of here may wait on a provider call.
    // `generateSessionTitle` never throws; `.catch` is belt-and-braces.
    if (
      opts?.titleGeneration
      && !hasError
      && !sawNonSuccessfulTerminalResult
      && lastSavedAssistantMsgId !== null
    ) {
      const gen = opts.titleGeneration;

      import('@/lib/title-generation')
        .then(({ generateSessionTitle }) =>
          generateSessionTitle({
            sessionId,
            userText: gen.userText,
            runtime: gen.runtime,
            providerId: gen.providerId,
            model: gen.model,
          }),
        )
        .catch(() => { /* silent by contract — the fallback title stands */ });

      // Codex app-server does not generate titles, but it does expose
      // `thread/name/set`. Once the first successful turn has persisted, the
      // runtime thread id is available, so mirror the LOCAL canonical title in
      // the background. Read it at completion time so a manual rename that won
      // during the turn is mirrored instead of being overwritten by the
      // original fallback snapshot.
      if (gen.runtime === 'codex_runtime') {
        const canonicalTitle = getSession(sessionId)?.title?.trim();
        if (canonicalTitle) {
          import('@/lib/codex/thread-name')
            .then(({ syncCodexThreadName }) => syncCodexThreadName(sessionId, canonicalTitle))
            .catch(() => { /* best effort — the local title remains canonical */ });
        }
      }
    }

    // Native task-completion notification. Require a successful terminal
    // result, a persisted assistant row, and current lock ownership so a
    // stopped/empty/superseded turn can never announce false completion.
    if (
      !opts?.suppressNotifications
      && !hasError
      && !sawNonSuccessfulTerminalResult
      && sawSuccessfulResult
      && lastSavedAssistantMsgId !== null
      && isLockOwner(sessionId, lockId)
    ) {
      try {
        await notifyInteractiveChatCompleted({
          sessionId,
          sessionTitle: telegramOpts.sessionTitle,
        });
      } catch (error) {
        console.warn(
          `[chat/route] failed to queue completion notification for session ${sessionId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // Telegram notifications: completion or error (fire-and-forget)
    // Suppressed for auto-trigger turns (onboarding/heartbeat) — invisible system flows
    if (!opts?.suppressNotifications) {
      if (hasError) {
        notifySessionError(errorMessage, telegramOpts).catch(() => {});
      } else if (!sawNonSuccessfulTerminalResult) {
        const textSummary = contentBlocks
          .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        notifySessionComplete(textSummary || undefined, telegramOpts).catch(() => {});
      }
    }
    onComplete?.();
  }
}

/**
 * Process a detected onboarding/checkin completion on the server side.
 * Calls the shared processor functions directly — no HTTP round-trip needed.
 *
 * Both processors are internally idempotent:
 * - processOnboarding checks state.onboardingComplete
 * - processCheckin checks state.lastCheckInDate === today
 */
async function processCompletionServerSide(
  completion: import('@/lib/onboarding-completion').ExtractedCompletion,
  _workspacePath: string,
  sessionId: string,
): Promise<void> {
  try {
    if (completion.type === 'onboarding') {
      const { processOnboarding } = await import('@/lib/onboarding-processor');
      console.log('[chat API] Server-side onboarding completion detected');
      await processOnboarding(completion.answers, sessionId);
      console.log('[chat API] Server-side onboarding completion succeeded');
    } else if (completion.type === 'checkin') {
      const { processCheckin } = await import('@/lib/checkin-processor');
      console.log('[chat API] Server-side checkin completion detected');
      await processCheckin(completion.answers, sessionId);
      console.log('[chat API] Server-side checkin completion succeeded');
    }

    // Clear hookTriggeredSessionId directly (no HTTP needed).
    // CAS: only clear if we are still the owner — prevents wiping another
    // tab's legitimate lock when completions arrive out of order.
    try {
      const { loadState, saveState } = await import('@/lib/assistant-workspace');
      const { getSetting: getSettingDirect } = await import('@/lib/db');
      const wsPath = getSettingDirect('assistant_workspace_path');
      if (wsPath) {
        const state = loadState(wsPath);
        if (state.hookTriggeredSessionId === sessionId || !state.hookTriggeredSessionId) {
          state.hookTriggeredSessionId = undefined;
          state.hookTriggeredAt = undefined;
          saveState(wsPath, state);
        }
      }
    } catch {
      // Best effort
    }
  } catch (e) {
    console.error(`[chat API] Server-side ${completion.type} processing failed:`, e);
  }
}
