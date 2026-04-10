import { NextRequest } from 'next/server';
import { streamClaude } from '@/lib/claude-client';
import { addMessage, getMessages, getSession, getSessionSummary, updateSessionTitle, updateSdkSessionId, updateSessionModel, updateSessionProvider, updateSessionProviderId, getSetting, acquireSessionLock, renewSessionLock, releaseSessionLock, setSessionRuntimeStatus, syncSdkTasks } from '@/lib/db';
import { resolveProvider as resolveProviderUnified } from '@/lib/provider-resolver';
import { notifySessionStart, notifySessionComplete, notifySessionError } from '@/lib/telegram-bot';
import { extractCompletion } from '@/lib/onboarding-completion';
import { loadCodePilotMcpServers, loadAllMcpServers } from '@/lib/mcp-loader';
import { assembleContext } from '@/lib/context-assembler';
import type { SendMessageRequest, SSEEvent, TokenUsage, MessageContentBlock, FileAttachment, ClaudeStreamOptions, MediaBlock } from '@/types';
import { saveMediaToLibrary } from '@/lib/media-saver';
import { ensureSchedulerRunning } from '@/lib/task-scheduler';

// Start the task scheduler on first API call
ensureSchedulerRunning();
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let activeSessionId: string | undefined;
  let activeLockId: string | undefined;

  try {
    const body: SendMessageRequest & { files?: FileAttachment[]; toolTimeout?: number; provider_id?: string; systemPromptAppend?: string; autoTrigger?: boolean; thinking?: unknown; effort?: string; enableFileCheckpointing?: boolean; displayOverride?: string; context_1m?: boolean } = await request.json();
    const { session_id, content, model, mode, files, toolTimeout, provider_id, systemPromptAppend, autoTrigger, thinking, effort, enableFileCheckpointing, displayOverride, context_1m } = body;

    console.log('[chat API] content length:', content.length, 'first 200 chars:', content.slice(0, 200));
    console.log('[chat API] systemPromptAppend:', systemPromptAppend ? `${systemPromptAppend.length} chars` : 'none');

    if (!session_id || !content) {
      return new Response(JSON.stringify({ error: 'session_id and content are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const session = getSession(session_id);
    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Acquire exclusive lock for this session to prevent concurrent requests
    const lockId = crypto.randomBytes(8).toString('hex');
    const lockAcquired = acquireSessionLock(session_id, lockId, `chat-${process.pid}`, 600);
    if (!lockAcquired) {
      return new Response(
        JSON.stringify({ error: 'Session is busy processing another request', code: 'SESSION_BUSY' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    }
    activeSessionId = session_id;
    activeLockId = lockId;
    setSessionRuntimeStatus(session_id, 'running');

    // ── /compact command handler ────────────────────────────────────
    if (content.trim() === '/compact') {
      try {
        const { compressConversation, resetCompressionState } = await import('@/lib/context-compressor');
        const { getMessages: getDbMessages, getSessionSummary: getDbSummary, updateSessionSummary: updateDbSummary, addMessage: addDbMessage } = await import('@/lib/db');

        resetCompressionState(session_id);
        const { messages: allMsgs } = getDbMessages(session_id, { limit: 200, excludeHeartbeatAck: true });
        const existingSummary = getDbSummary(session_id).summary;

        if (allMsgs.length < 4) {
          const msg = '对话还很短，暂不需要压缩。';
          addDbMessage(session_id, 'assistant', JSON.stringify([{ type: 'text', text: msg }]));
          releaseSessionLock(session_id, lockId);
          setSessionRuntimeStatus(session_id, 'idle');
          const sseData = `data: ${JSON.stringify({ type: 'text', data: msg })}\n\ndata: ${JSON.stringify({ type: 'done' })}\n\n`;
          return new Response(sseData, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
        }

        const msgData = allMsgs.map(m => ({ role: m.role, content: m.content }));
        const result = await compressConversation({
          sessionId: session_id,
          messages: msgData,
          existingSummary: existingSummary || undefined,
          providerId: provider_id || session.provider_id || undefined,
          sessionModel: model || session.model || undefined,
        });

        updateDbSummary(session_id, result.summary);
        const msg = `上下文已压缩。压缩了 ${result.messagesCompressed} 条消息，预计节省 ~${Math.round(result.estimatedTokensSaved / 1000)}K tokens。`;
        addDbMessage(session_id, 'assistant', JSON.stringify([{ type: 'text', text: msg }]));
        releaseSessionLock(session_id, lockId);
        setSessionRuntimeStatus(session_id, 'idle');
        const sseData = `data: ${JSON.stringify({ type: 'text', data: msg })}\n\ndata: ${JSON.stringify({ type: 'done' })}\n\n`;
        return new Response(sseData, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
      } catch (compactErr) {
        console.error('[chat API] /compact failed:', compactErr);
        releaseSessionLock(session_id, lockId);
        setSessionRuntimeStatus(session_id, 'idle');
        return new Response(JSON.stringify({ error: 'Compression failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Telegram notification: session started (fire-and-forget)
    // Skip for auto-trigger turns (onboarding/heartbeat) — these are invisible system triggers
    const telegramNotifyOpts = {
      sessionId: session_id,
      sessionTitle: session.title !== 'New Chat' ? session.title : content.slice(0, 50),
      workingDirectory: session.working_directory,
    };
    if (!autoTrigger) {
      notifySessionStart(telegramNotifyOpts).catch(() => {});
    }

    // Save user message — persist file metadata so attachments survive page reload
    // Skip saving for autoTrigger messages (invisible system triggers for assistant hooks)
    // Use displayOverride for DB storage if provided (e.g. /skillName instead of expanded prompt)
    let savedContent = displayOverride || content;
    let fileMeta: Array<{ id: string; name: string; type: string; size: number; filePath: string }> | undefined;
    if (!autoTrigger) {
      if (files && files.length > 0) {
        const workDir = session.working_directory;
        const uploadDir = path.join(workDir, '.codepilot-uploads');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
        fileMeta = files.map((f) => {
          const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
          const buffer = Buffer.from(f.data, 'base64');
          fs.writeFileSync(filePath, buffer);
          return { id: f.id, name: f.name, type: f.type, size: buffer.length, filePath };
        });
        savedContent = `<!--files:${JSON.stringify(fileMeta)}-->${displayOverride || content}`;
      }
      addMessage(session_id, 'user', savedContent);

      // Auto-generate title from first message if still default
      if (session.title === 'New Chat') {
        const title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
        updateSessionTitle(session_id, title);
      }
    }

    // Determine model: request override > session model > default setting
    let effectiveModel = model || session.model || getSetting('default_model') || undefined;

    // When Claude Code is disabled, sessions with env-provider models (sonnet/opus/haiku)
    // can't use them anymore. Fall back to default model from first available provider.
    const cliDisabled = getSetting('cli_enabled') === 'false';
    const ENV_MODELS = new Set(['sonnet', 'opus', 'haiku']);
    const effectiveProviderId_pre = provider_id || session.provider_id || '';
    if (cliDisabled && effectiveModel && ENV_MODELS.has(effectiveModel) && (!effectiveProviderId_pre || effectiveProviderId_pre === 'env')) {
      effectiveModel = getSetting('default_model') || undefined;
      // If default model is also env-only, clear it
      if (effectiveModel && ENV_MODELS.has(effectiveModel)) {
        effectiveModel = undefined;
      }
    }

    // Persist model and provider to session so usage stats can group by model+provider.
    // This runs on every message but the DB writes are cheap (single UPDATE by PK).
    if (effectiveModel && effectiveModel !== session.model) {
      updateSessionModel(session_id, effectiveModel);
    }

    // Resolve provider via unified resolver (same logic for chat, bridge, onboarding, etc.)
    const effectiveProviderId = provider_id || session.provider_id || '';
    const resolved = resolveProviderUnified({
      providerId: effectiveProviderId || undefined,
      sessionProviderId: session.provider_id || undefined,
      model: model || undefined,
      sessionModel: session.model || undefined,
    });
    const resolvedProvider = resolved.provider;

    const providerName = resolvedProvider?.name || '';
    if (providerName !== (session.provider_name || '')) {
      updateSessionProvider(session_id, providerName);
    }
    const persistProviderId = effectiveProviderId || provider_id || '';
    if (persistProviderId !== (session.provider_id || '')) {
      updateSessionProviderId(session_id, persistProviderId);
    }

    // Resolve permission mode from request body (sent by frontend on each message)
    // or fall back to session's persisted mode from DB.
    // Request body mode takes priority to avoid race condition: user switches mode
    // then immediately sends — the PATCH may not have landed in DB yet.
    const effectiveMode = mode || session.mode || 'code';
    const permissionMode = effectiveMode === 'plan' ? 'plan' : 'acceptEdits';

    // Plan mode takes precedence over full_access: if the user explicitly chose
    // Plan, they expect no tool execution regardless of permission profile.
    const bypassPermissions = session.permission_profile === 'full_access' && effectiveMode !== 'plan';
    const systemPromptOverride: string | undefined = undefined;

    const abortController = new AbortController();

    // Convert file attachments to the format expected by streamClaude.
    // Include filePath from the already-saved files so claude-client can
    // reference the on-disk copies instead of writing them again.
    const fileAttachments: FileAttachment[] | undefined = files && files.length > 0
      ? files.map((f, i) => {
          const meta = fileMeta?.find((m: { id: string }) => m.id === f.id);
          return {
            id: f.id || `file-${Date.now()}-${i}`,
            name: f.name,
            type: f.type,
            size: f.size,
            data: meta?.filePath ? '' : f.data, // Clear base64 once written to disk — claude-client reads from filePath on demand
            filePath: meta?.filePath,
          };
        })
      : undefined;

    // Load conversation history from DB as fallback context.
    // Fetch up to 200 messages (DB query is cheap); actual truncation is done
    // by buildFallbackContext using a token budget, not a fixed message count.
    const { messages: recentMsgs } = getMessages(session_id, { limit: 200, excludeHeartbeatAck: true });
    // Exclude the user message we just saved (last in the list) — it's already the prompt
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    // Load session summary for compression-aware fallback
    const sessionSummaryData = getSessionSummary(session_id);

    // Detect actual image agent mode by checking for the specific design agent prompt,
    // not just any systemPromptAppend (which could come from CLI badges or skills).
    const isImageAgentMode = !!systemPromptAppend && systemPromptAppend.includes('image-gen-request');

    // Unified context assembly — extracts workspace, CLI tools, widget prompt
    const assembled = await assembleContext({
      session,
      entryPoint: 'desktop',
      userPrompt: content,
      systemPromptAppend,
      conversationHistory: historyMsgs,
      imageAgentMode: isImageAgentMode,
      autoTrigger: !!autoTrigger,
    });
    const finalSystemPrompt = assembled.systemPrompt;
    const generativeUIEnabled = assembled.generativeUIEnabled;
    const assistantProjectInstructions = assembled.assistantProjectInstructions;
    const isAssistantProject = assembled.isAssistantProject;

    // Load MCP servers for the predicted runtime:
    // - SDK Runtime: only needs servers with ${...} env placeholders (SDK loads the rest via settingSources)
    // - Native Runtime: needs ALL servers (it manages MCP connections independently)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { predictNativeRuntime } = require('@/lib/runtime') as typeof import('@/lib/runtime');
    const mcpServers = predictNativeRuntime(effectiveProviderId)
      ? loadAllMcpServers()
      : loadCodePilotMcpServers();

    // ── Context compression check ───────────────────────────────────
    // Estimate next-turn context size and compress if over threshold.
    let activeSessionSummary = sessionSummaryData.summary || undefined;
    let fallbackTokenBudget: number | undefined;
    let compressionOccurred = false;

    try {
      const { estimateContextTokens } = await import('@/lib/context-estimator');
      const { getContextWindow } = await import('@/lib/model-context');
      const { needsCompression, compressConversation } = await import('@/lib/context-compressor');
      const { updateSessionSummary } = await import('@/lib/db');

      const modelForWindow = resolved.upstreamModel || resolved.model || effectiveModel || 'sonnet';
      const contextWindow = getContextWindow(modelForWindow, { context1m: context_1m }) || 200000;

      // Estimate using normalized content (matches what buildFallbackContext actually sends).
      // Raw transcript overestimates tool-heavy conversations because normalize + microcompact
      // strip metadata and truncate old tool results significantly.
      const { normalizeMessageContent, microCompactMessage } = await import('@/lib/message-normalizer');
      const { roughTokenEstimate } = await import('@/lib/context-estimator');
      const normalizedHistory = historyMsgs.map((m, i) => ({
        role: m.role,
        content: microCompactMessage(m.role, normalizeMessageContent(m.role, m.content), historyMsgs.length - 1 - i),
      }));

      const estimate = estimateContextTokens({
        systemPrompt: finalSystemPrompt,
        history: normalizedHistory,
        currentUserMessage: content,
        sessionSummary: activeSessionSummary,
      });

      // Budget for history = 70% of window minus system prompt, summary, and current user message.
      // buildFallbackContext adds summary + prompt on top of the history, so we must account for them.
      fallbackTokenBudget = Math.floor(
        contextWindow * 0.7 - estimate.breakdown.system - estimate.breakdown.summary - estimate.breakdown.userMessage
      );

      if (needsCompression(estimate.total, contextWindow, session_id)) {
        console.log(`[chat API] Context at ${((estimate.total / contextWindow) * 100).toFixed(1)}% — triggering compression`);

        // Determine which messages to compress using normalized sizes (consistent with estimate)
        const recentBudget = Math.floor(contextWindow * 0.5);
        const messagesToKeep: typeof historyMsgs = [];
        let keptTokens = 0;
        for (let i = normalizedHistory.length - 1; i >= 0; i--) {
          const msgTokens = roughTokenEstimate(normalizedHistory[i].content) + 10;
          if (keptTokens + msgTokens > recentBudget) break;
          messagesToKeep.unshift(historyMsgs[i]); // Keep raw msg for compression input
          keptTokens += msgTokens;
        }
        const messagesToCompress = historyMsgs.slice(0, historyMsgs.length - messagesToKeep.length);

        if (messagesToCompress.length > 0) {
          try {
            const result = await compressConversation({
              sessionId: session_id,
              messages: messagesToCompress,
              existingSummary: activeSessionSummary,
              providerId: effectiveProviderId || undefined,
              sessionModel: effectiveModel || undefined,
            });
            activeSessionSummary = result.summary;
            updateSessionSummary(session_id, result.summary);
            // Recalculate budget with new (larger) summary
            const newSummaryTokens = roughTokenEstimate(result.summary);
            const userMsgTokens = roughTokenEstimate(content);
            fallbackTokenBudget = Math.floor(
              contextWindow * 0.7 - estimate.breakdown.system - newSummaryTokens - userMsgTokens
            );
            // Flag so we can notify frontend via a leading SSE event
            compressionOccurred = true;
            console.log(`[chat API] Compressed ${result.messagesCompressed} messages, saved ~${result.estimatedTokensSaved} tokens`);
          } catch (compErr) {
            console.warn('[chat API] Compression failed, proceeding without:', compErr);
          }
        }
      }
    } catch (estimateErr) {
      console.warn('[chat API] Context estimation failed, proceeding without compression:', estimateErr);
    }

    // Stream Claude response, using SDK session ID for resume if available
    console.log('[chat API] streamClaude params:', {
      promptLength: content.length,
      promptFirst200: content.slice(0, 200),
      sdkSessionId: session.sdk_session_id || 'none',
      systemPromptLength: finalSystemPrompt?.length || 0,
      systemPromptFirst200: finalSystemPrompt?.slice(0, 200) || 'none',
    });
    const stream = streamClaude({
      prompt: content,
      sessionId: session_id,
      sdkSessionId: session.sdk_session_id || undefined,
      model: resolved.upstreamModel || resolved.model || effectiveModel,
      systemPrompt: finalSystemPrompt,
      workingDirectory: session.sdk_cwd || session.working_directory || undefined,
      abortController,
      permissionMode,
      files: fileAttachments,
      imageAgentMode: isImageAgentMode,
      toolTimeoutSeconds: toolTimeout || 300,
      provider: resolvedProvider,
      providerId: effectiveProviderId || undefined,
      sessionProviderId: session.provider_id || undefined,
      mcpServers,
      conversationHistory: historyMsgs,
      sessionSummary: activeSessionSummary,
      fallbackTokenBudget,
      bypassPermissions,
      thinking: thinking as ClaudeStreamOptions['thinking'],
      effort: effort as ClaudeStreamOptions['effort'],
      context1m: context_1m,
      generativeUI: generativeUIEnabled,
      enableFileCheckpointing: enableFileCheckpointing ?? true,
      autoTrigger: !!autoTrigger,
      onRuntimeStatusChange: (status: string) => {
        try { setSessionRuntimeStatus(session_id, status); } catch { /* best effort */ }
      },
    });

    // Tee the stream: one for client, one for collecting the response
    const [streamForClient, streamForCollect] = stream.tee();

    // Periodically renew the session lock so long-running tasks don't expire
    const lockRenewalInterval = setInterval(() => {
      try { renewSessionLock(session_id, lockId, 600); } catch { /* best effort */ }
    }, 60_000);

    // Save assistant message in background, with cleanup callback to release lock
    const isHeartbeatTurn = !!autoTrigger && content.includes('心跳检查');
    collectStreamResponse(streamForCollect, session_id, telegramNotifyOpts, () => {
      clearInterval(lockRenewalInterval);
      releaseSessionLock(session_id, lockId);
      setSessionRuntimeStatus(session_id, 'idle');
    }, { isHeartbeatTurn, suppressNotifications: !!autoTrigger });

    // If auto-compression happened, prepend a notification event to the stream
    const responseStream = compressionOccurred
      ? new ReadableStream<string>({
          async start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'status', data: JSON.stringify({ notification: true, message: 'context_compressed' }) })}\n\n`);
            const reader = streamForClient.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
            } finally {
              controller.close();
            }
          },
        })
      : streamForClient;

    return new Response(responseStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    // Release lock and reset status on error (only if lock was acquired)
    if (activeSessionId && activeLockId) {
      try {
        releaseSessionLock(activeSessionId, activeLockId);
        setSessionRuntimeStatus(activeSessionId, 'idle', error instanceof Error ? error.message : 'Unknown error');
      } catch { /* best effort */ }
    }

    const message = error instanceof Error ? error.message : 'Internal server error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function collectStreamResponse(
  stream: ReadableStream<string>,
  sessionId: string,
  telegramOpts: { sessionId?: string; sessionTitle?: string; workingDirectory?: string },
  onComplete?: () => void,
  opts?: { isHeartbeatTurn?: boolean; suppressNotifications?: boolean },
) {
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  let thinkingText = '';
  /** Tracks whether non-thinking content arrived since last thinking delta (for phase separation) */
  let thinkingPhaseEnded = false;
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  let lastSavedAssistantMsgId: string | null = null;
  // Dedup layer: skip duplicate tool_result events by tool_use_id
  const seenToolResultIds = new Set<string>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event: SSEEvent = JSON.parse(line.slice(6));
            if (event.type === 'permission_request' || event.type === 'tool_output') {
              // Skip permission_request and tool_output events - not saved as message content
            } else if (event.type === 'thinking') {
              // Accumulate thinking content with phase separation (--- between phases)
              if (thinkingPhaseEnded) {
                if (thinkingText) thinkingText += '\n\n---\n\n';
                thinkingPhaseEnded = false;
              }
              thinkingText += event.data;
            } else if (event.type === 'text') {
              currentText += event.data;
              if (thinkingText) thinkingPhaseEnded = true;
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
                        const saved = saveMediaToLibrary(block, { sessionId });
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
              } catch {
                // skip malformed tool_result data
              }
            } else if (event.type === 'status') {
              // Capture SDK session_id and model from init event and persist them
              try {
                const statusData = JSON.parse(event.data);
                if (statusData.session_id) {
                  updateSdkSessionId(sessionId, statusData.session_id);
                }
                if (statusData.model) {
                  updateSessionModel(sessionId, statusData.model);
                }
              } catch {
                // skip malformed status data
              }
            } else if (event.type === 'task_update') {
              // Sync SDK TodoWrite tasks to local DB
              try {
                const taskData = JSON.parse(event.data);
                if (taskData.session_id && taskData.todos) {
                  syncSdkTasks(taskData.session_id, taskData.todos);
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
                if (resultData.usage) {
                  tokenUsage = resultData.usage;
                }
                if (resultData.is_error) {
                  hasError = true;
                }
                // Also capture session_id from result if we missed it from init
                if (resultData.session_id) {
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

    if (contentBlocks.length > 0) {
      // If the message is text-only (no tool calls), store as plain text
      // for backward compatibility with existing message rendering.
      // Strip soft-heartbeat marker from text blocks before persisting (both paths)
      const heartbeatMarkerRe = /\s*<!--\s*heartbeat-done\s*-->\s*/g;
      const cleanedBlocks = contentBlocks.map(b =>
        b.type === 'text' && 'text' in b ? { ...b, text: (b.text as string).replace(heartbeatMarkerRe, '') } : b
      );

      // If it contains tool calls or thinking blocks, store as structured JSON.
      const hasStructuredBlocks = cleanedBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'thinking'
      );

      const content = hasStructuredBlocks
        ? JSON.stringify(cleanedBlocks)
        : cleanedBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();

      if (content) {
        const savedMsg = addMessage(
          sessionId,
          'assistant',
          content,
          tokenUsage ? JSON.stringify(tokenUsage) : null,
        );
        lastSavedAssistantMsgId = savedMsg.id;
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
    if (contentBlocks.length > 0) {
      const hbRe = /\s*<!--\s*heartbeat-done\s*-->\s*/g;
      const errCleanedBlocks = contentBlocks.map(b =>
        b.type === 'text' && 'text' in b ? { ...b, text: (b.text as string).replace(hbRe, '') } : b
      );
      const hasStructuredBlocks = errCleanedBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'thinking'
      );
      const content = hasStructuredBlocks
        ? JSON.stringify(errCleanedBlocks)
        : errCleanedBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
      if (content) {
        addMessage(sessionId, 'assistant', content);
      }
    }
  } finally {
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
        const workspacePath = getSetting('assistant_workspace_path');
        const session = getSession(sessionId);
        if (workspacePath && session && session.working_directory === workspacePath) {
          await processCompletionServerSide(completion, workspacePath, sessionId);
        }
      }

      // 2a. Soft heartbeat: for normal turns in assistant projects, mark heartbeat done
      // only if the AI's response actually mentions heartbeat-related content.
      if (!opts?.isHeartbeatTurn && !hasError && fullText.trim().length > 0) {
        try {
          const workspacePath = getSetting('assistant_workspace_path');
          const session = getSession(sessionId);
          if (workspacePath && session && session.working_directory === workspacePath) {
            const { loadState, saveState, shouldRunHeartbeat } = await import('@/lib/assistant-workspace');
            const { getLocalDateString } = await import('@/lib/utils');
            const st = loadState(workspacePath);
            if (shouldRunHeartbeat(st)) {
              // Only mark done if the AI included the heartbeat-done marker.
              // The soft hint instructs the AI to append <!-- heartbeat-done --> when it checks in.
              const didCheck = fullText.includes('<!-- heartbeat-done -->');
              if (didCheck) {
                st.lastHeartbeatDate = getLocalDateString();
                saveState(workspacePath, st);
              }
            }
          }
        } catch { /* best effort */ }
      }

      // 2b. Heartbeat state update — ONLY for actual heartbeat turns, and ONLY on success
      if (opts?.isHeartbeatTurn && !hasError && fullText.trim().length > 0) {
        try {
          const workspacePath = getSetting('assistant_workspace_path');
          const session = getSession(sessionId);
          if (workspacePath && session && session.working_directory === workspacePath) {
            const { stripHeartbeatToken } = await import('@/lib/heartbeat');
            const { loadState, saveState } = await import('@/lib/assistant-workspace');
            const { getLocalDateString } = await import('@/lib/utils');
            const stripped = stripHeartbeatToken(fullText);

            const st = loadState(workspacePath);
            st.lastHeartbeatDate = getLocalDateString();

            if (stripped.shouldSkip && lastSavedAssistantMsgId) {
              // Pure HEARTBEAT_OK — mark ONLY the assistant reply as ack
              // (auto-trigger messages are not persisted, so we only have the reply)
              try {
                const { updateMessageHeartbeatAck } = await import('@/lib/db');
                updateMessageHeartbeatAck(lastSavedAssistantMsgId, true);
              } catch { /* best effort */ }
            } else if (!stripped.shouldSkip) {
              // Has real content — record for dedup
              st.lastHeartbeatText = stripped.text;
              st.lastHeartbeatSentAt = Date.now();
            }

            // Clear hookTriggeredSessionId
            if (st.hookTriggeredSessionId === sessionId || !st.hookTriggeredSessionId) {
              st.hookTriggeredSessionId = undefined;
              st.hookTriggeredAt = undefined;
            }
            saveState(workspacePath, st);
          }
        } catch {
          // best effort heartbeat state update
        }
      }
    } catch (e) {
      console.error('[chat API] Server-side completion detection failed:', e);
    }

    // Memory extraction: auto-extract durable memories every N turns (assistant projects only)
    if (!opts?.isHeartbeatTurn && !opts?.suppressNotifications) {
      try {
        const workspacePath = getSetting('assistant_workspace_path');
        const session = getSession(sessionId);
        if (workspacePath && session && session.working_directory === workspacePath) {
          const { shouldExtractMemory, hasMemoryWritesInResponse, extractMemories } = await import('@/lib/memory-extractor');

          const fullTextForMemory = contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('');

          // For memory-write detection, serialize ALL blocks (including tool_use/tool_result)
          // so that hasMemoryWritesInResponse can see memory file paths in tool calls.
          const fullResponseForWriteCheck = JSON.stringify(contentBlocks);

          // Load buddy rarity for extraction interval
          let buddyRarity: string | undefined;
          try {
            const { loadState } = await import('@/lib/assistant-workspace');
            const st = loadState(workspacePath);
            buddyRarity = st.buddy?.rarity;
          } catch { /* ignore */ }

          // Only extract if: interval met + AI didn't already write memory this turn
          if (shouldExtractMemory(buddyRarity, sessionId) && !hasMemoryWritesInResponse(fullResponseForWriteCheck)) {
            const { getMessages: getMsgs } = await import('@/lib/db');
            const { messages: recent } = getMsgs(sessionId, { limit: 6, excludeHeartbeatAck: true });
            const recentForExtraction = recent.map(m => ({ role: m.role, content: m.content }));

            // Fire-and-forget: don't block the response
            extractMemories(recentForExtraction, workspacePath).catch(() => {});
          }
        }
      } catch { /* best effort */ }
    }

    // Telegram notifications: completion or error (fire-and-forget)
    // Suppressed for auto-trigger turns (onboarding/heartbeat) — invisible system flows
    if (!opts?.suppressNotifications) {
      if (hasError) {
        notifySessionError(errorMessage, telegramOpts).catch(() => {});
      } else {
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
