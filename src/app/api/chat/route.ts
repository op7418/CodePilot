import { NextRequest } from 'next/server';
import { streamClaude } from '@/lib/claude-client';
import { addMessage, getMessages, getSession, updateSessionTitle, updateSdkSessionId, updateSessionModel, updateSessionProvider, updateSessionProviderId, getSetting, acquireSessionLock, renewSessionLock, releaseSessionLock, setSessionRuntimeStatus, syncSdkTasks } from '@/lib/db';
import { resolveProvider as resolveProviderUnified } from '@/lib/provider-resolver';
import { notifySessionStart, notifySessionComplete, notifySessionError } from '@/lib/telegram-bot';
import { extractCompletion } from '@/lib/onboarding-completion';
import type { SendMessageRequest, SSEEvent, TokenUsage, MessageContentBlock, FileAttachment, ClaudeStreamOptions } from '@/types';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { MCPServerConfig } from '@/types';
import { getClaudeUserConfigPath, getClaudeSettingsPath } from '@/lib/cli-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Read MCP server configs from ~/.claude.json, ~/.claude/settings.json, and project .mcp.json */
function loadMcpServers(): Record<string, MCPServerConfig> | undefined {
  try {
    const readJson = (p: string): Record<string, unknown> => {
      if (!fs.existsSync(p)) return {};
      try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return {}; }
    };
    const userConfig = readJson(getClaudeUserConfigPath());
    const settings = readJson(getClaudeSettingsPath());
    // Also read project-level .mcp.json
    const projectMcp = readJson(path.join(process.cwd(), '.mcp.json'));
    const merged = {
      ...((userConfig.mcpServers || {}) as Record<string, MCPServerConfig>),
      ...((settings.mcpServers || {}) as Record<string, MCPServerConfig>),
      ...((projectMcp.mcpServers || {}) as Record<string, MCPServerConfig>),
    };
    // Resolve ${...} placeholders in env values against DB settings
    for (const server of Object.values(merged)) {
      if (server.env) {
        for (const [key, value] of Object.entries(server.env)) {
          if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
            const settingKey = value.slice(2, -1);
            const resolved = getSetting(settingKey);
            server.env[key] = resolved || '';
          }
        }
      }
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  } catch {
    return undefined;
  }
}

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

    // Telegram notification: session started (fire-and-forget)
    const telegramNotifyOpts = {
      sessionId: session_id,
      sessionTitle: session.title !== 'New Chat' ? session.title : content.slice(0, 50),
      workingDirectory: session.working_directory,
    };
    notifySessionStart(telegramNotifyOpts).catch(() => {});

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
    const effectiveModel = model || session.model || getSetting('default_model') || undefined;

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

    // Determine permission mode from chat mode: code → acceptEdits, plan → plan, ask → default (no tools)
    const effectiveMode = mode || session.mode || 'code';
    let permissionMode: string;
    let systemPromptOverride: string | undefined;
    switch (effectiveMode) {
      case 'plan':
        permissionMode = 'plan';
        break;
      case 'ask':
        permissionMode = 'default';
        systemPromptOverride = (session.system_prompt || '') +
          '\n\nYou are in Ask mode. Answer questions and provide information only. Do not use any tools, do not read or write files, do not execute commands. Only respond with text.';
        break;
      default: // 'code'
        permissionMode = 'acceptEdits';
        break;
    }

    const abortController = new AbortController();

    // Handle client disconnect
    request.signal.addEventListener('abort', () => {
      abortController.abort();
    });

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
            data: (meta?.filePath && !f.type.startsWith('image/')) ? '' : f.data, // Keep base64 for images (needed for vision); clear for non-images (read from disk)
            filePath: meta?.filePath,
          };
        })
      : undefined;

    // Load assistant workspace prompt if configured
    let workspacePrompt = '';
    let assistantProjectInstructions = '';
    try {
      const workspacePath = getSetting('assistant_workspace_path');
      if (workspacePath) {
        const { loadWorkspaceFiles, assembleWorkspacePrompt, loadState, needsDailyCheckIn } = await import('@/lib/assistant-workspace');

        // Only inject workspace files for assistant project sessions
        const sessionWd = session.working_directory || '';
        const isAssistantProject = sessionWd === workspacePath;

        if (isAssistantProject) {
          // Incremental reindex BEFORE search so current turn sees latest content
          try {
            const { indexWorkspace } = await import('@/lib/workspace-indexer');
            indexWorkspace(workspacePath);
          } catch {
            // indexer not available, skip
          }

          const files = loadWorkspaceFiles(workspacePath);

          // Retrieval: search workspace index for relevant context
          let retrievalResults: import('@/types').SearchResult[] | undefined;
          try {
            const { searchWorkspace, updateHotset } = await import('@/lib/workspace-retrieval');
            if (content.length > 10) {
              retrievalResults = searchWorkspace(workspacePath, content, { limit: 5 });
              if (retrievalResults.length > 0) {
                updateHotset(workspacePath, retrievalResults.map(r => r.path));
              }
            }
          } catch {
            // retrieval module not available, skip
          }

          workspacePrompt = assembleWorkspacePrompt(files, retrievalResults);

          const state = loadState(workspacePath);

          if (!state.onboardingComplete) {
            // First-time onboarding: instruct AI to ask onboarding questions
            assistantProjectInstructions = `<assistant-project-task type="onboarding">
You are now in the assistant workspace onboarding session. Your task is to interview the user to build their profile.

Ask the following 13 questions ONE AT A TIME. Wait for the user's answer before asking the next question. Be conversational and friendly.

1. How should I address you?
2. What name should I use for myself?
3. Do you prefer "concise and direct" or "detailed explanations"?
4. Do you prefer "minimal interruptions" or "proactive suggestions"?
5. What are your three hard boundaries?
6. What are your three most important current goals?
7. Do you prefer output as "lists", "reports", or "conversation summaries"?
8. What information may be written to long-term memory?
9. What information must never be written to long-term memory?
10. What three things should I do first when entering a project?
11. How do you organize your materials? (by project / time / topic / mixed)
12. Where should new information go by default?
13. How should completed tasks be archived?

After the user answers the LAST question (Q13), you MUST immediately output the completion block below. Do NOT wait for the user to say anything else. Do NOT ask for confirmation. Just output the block right after your response to Q13.

CRITICAL FORMATTING RULES for the completion block:
- Each value must be a single line (replace any newlines with spaces)
- Escape all double quotes inside values with backslash: \\"
- Do NOT use single quotes for JSON keys or values
- Do NOT add trailing commas
- The JSON must be on a SINGLE line

\`\`\`onboarding-complete
{"q1":"answer1","q2":"answer2","q3":"answer3","q4":"answer4","q5":"answer5","q6":"answer6","q7":"answer7","q8":"answer8","q9":"answer9","q10":"answer10","q11":"answer11","q12":"answer12","q13":"answer13"}
\`\`\`

After outputting the completion block, tell the user that the setup is complete and the system is now initializing their workspace. Keep this message brief and friendly.

Do NOT try to write files yourself. The system will automatically generate soul.md, user.md, claude.md, memory.md, config.json, and taxonomy.json from your collected answers.

Start by greeting the user and asking the first question.
</assistant-project-task>`;
          } else if (needsDailyCheckIn(state)) {
            // Daily check-in: instruct AI to ask 3 quick questions
            assistantProjectInstructions = `<assistant-project-task type="daily-checkin">
You are now in the assistant workspace daily check-in session. Ask the user these 3 questions ONE AT A TIME:

1. What did you work on or accomplish today?
2. Any changes to your current priorities or goals?
3. Anything you'd like me to remember going forward?

After collecting all 3 answers, output a summary in exactly this format:

\`\`\`checkin-complete
{"q1":"answer1","q2":"answer2","q3":"answer3"}
\`\`\`

Do NOT try to write files yourself. The system will automatically write a daily memory entry and update user.md from your collected answers.

Start by greeting the user and asking the first question.
</assistant-project-task>`;
          }

        }
      }
    } catch (e) {
      console.warn('[chat API] Failed to load assistant workspace:', e);
    }

    // Append per-request system prompt (e.g. skill injection for image generation)
    let finalSystemPrompt = systemPromptOverride || session.system_prompt || undefined;
    if (systemPromptAppend) {
      finalSystemPrompt = (finalSystemPrompt || '') + '\n\n' + systemPromptAppend;
    }

    // Workspace prompt goes first (base personality), session prompt after (task override)
    if (workspacePrompt) {
      finalSystemPrompt = workspacePrompt + '\n\n' + (finalSystemPrompt || '');
    }

    // Assistant project instructions go after workspace prompt
    if (assistantProjectInstructions) {
      finalSystemPrompt = (finalSystemPrompt || '') + '\n\n' + assistantProjectInstructions;
    }

    // Inject available CLI tools context (best-effort, non-blocking)
    try {
      const { buildCliToolsContext } = await import('@/lib/cli-tools-context');
      const cliToolsCtx = await buildCliToolsContext();
      if (cliToolsCtx) {
        finalSystemPrompt = (finalSystemPrompt || '') + '\n\n' + cliToolsCtx;
      }
    } catch {
      // CLI tools context injection failed — don't block chat
    }

    // Inject widget (generative UI) system prompt — gated by user setting (default: enabled)
    const generativeUISetting = getSetting('generative_ui_enabled');
    const generativeUIEnabled = generativeUISetting !== 'false';
    if (generativeUIEnabled) {
      try {
        const { WIDGET_SYSTEM_PROMPT } = await import('@/lib/widget-guidelines');
        finalSystemPrompt = (finalSystemPrompt || '') + '\n\n' + WIDGET_SYSTEM_PROMPT;
      } catch {
        // Widget prompt injection failed — don't block chat
      }
    }

    // Load recent conversation history from DB as fallback context.
    // This is used when SDK session resume is unavailable or fails,
    // so the model still has conversation context.
    const { messages: recentMsgs } = getMessages(session_id, { limit: 50 });
    // Exclude the user message we just saved (last in the list) — it's already the prompt
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    // Load MCP servers from Claude config files so the SDK knows about them
    // even when settingSources skips 'user' (custom provider scenario).
    const mcpServers = loadMcpServers();

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
      imageAgentMode: !!systemPromptAppend,
      toolTimeoutSeconds: toolTimeout || 300,
      provider: resolvedProvider,
      providerId: effectiveProviderId || undefined,
      sessionProviderId: session.provider_id || undefined,
      mcpServers,
      conversationHistory: historyMsgs,
      bypassPermissions: session.permission_profile === 'full_access',
      thinking: thinking as ClaudeStreamOptions['thinking'],
      effort: effort as ClaudeStreamOptions['effort'],
      context1m: context_1m,
      generativeUI: generativeUIEnabled,
      enableFileCheckpointing: enableFileCheckpointing ?? (effectiveMode === 'code'),
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
    collectStreamResponse(streamForCollect, session_id, telegramNotifyOpts, () => {
      clearInterval(lockRenewalInterval);
      releaseSessionLock(session_id, lockId);
      setSessionRuntimeStatus(session_id, 'idle');
    });

    return new Response(streamForClient, {
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
) {
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
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
            } else if (event.type === 'text') {
              currentText += event.data;
            } else if (event.type === 'tool_use') {
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
                const newBlock = {
                  type: 'tool_result' as const,
                  tool_use_id: resultData.tool_use_id,
                  content: resultData.content,
                  is_error: resultData.is_error || false,
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

    if (contentBlocks.length > 0) {
      // If the message is text-only (no tool calls), store as plain text
      // for backward compatibility with existing message rendering.
      // If it contains tool calls, store as structured JSON.
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );

      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();

      if (content) {
        addMessage(
          sessionId,
          'assistant',
          content,
          tokenUsage ? JSON.stringify(tokenUsage) : null,
        );
      }
    }
  } catch (e) {
    hasError = true;
    errorMessage = e instanceof Error ? e.message : 'Stream reading error';
    // Stream reading error - best effort save
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
      const completion = extractCompletion(fullText);
      if (completion) {
        const workspacePath = getSetting('assistant_workspace_path');
        const session = getSession(sessionId);
        if (workspacePath && session && session.working_directory === workspacePath) {
          await processCompletionServerSide(completion, workspacePath, sessionId);
        }
      }
    } catch (e) {
      console.error('[chat API] Server-side completion detection failed:', e);
    }

    // Telegram notifications: completion or error (fire-and-forget)
    if (hasError) {
      notifySessionError(errorMessage, telegramOpts).catch(() => {});
    } else {
      // Extract text summary for the completion notification
      const textSummary = contentBlocks
        .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      notifySessionComplete(textSummary || undefined, telegramOpts).catch(() => {});
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
