import { NextRequest } from 'next/server';
import { streamClaude } from '@/lib/claude-client';
import { addMessage, getSession, updateSessionTitle, updateSdkSessionId, getSetting } from '@/lib/db';
import type { SendMessageRequest, SSEEvent, TokenUsage, MessageContentBlock, FileAttachment } from '@/types';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body: SendMessageRequest & { files?: FileAttachment[]; toolTimeout?: number } = await request.json();
    const { session_id, content, model, mode, files, toolTimeout } = body;

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

    // Save user message — persist file metadata so attachments survive page reload
    let savedContent = content;
    let fileMeta: Array<{ id: string; name: string; type: string; size: number; filePath: string }> | undefined;
    if (files && files.length > 0) {
      const workDir = session.working_directory || process.cwd();
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
      savedContent = `<!--files:${JSON.stringify(fileMeta)}-->${content}`;
    }
    addMessage(session_id, 'user', savedContent);

    // Auto-generate title from first message if still default
    if (session.title === 'New Chat') {
      const title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
      updateSessionTitle(session_id, title);
    }

    // Determine model: request override > session model > default setting
    const effectiveModel = model || session.model || getSetting('default_model') || undefined;

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
            data: f.data,
            filePath: meta?.filePath,
          };
        })
      : undefined;

    // Stream Claude response, using SDK session ID for resume if available
    const stream = streamClaude({
      prompt: content,
      sessionId: session_id,
      sdkSessionId: session.sdk_session_id || undefined,
      model: effectiveModel,
      systemPrompt: systemPromptOverride || session.system_prompt || undefined,
      workingDirectory: session.working_directory || undefined,
      abortController,
      permissionMode,
      files: fileAttachments,
      toolTimeoutSeconds: toolTimeout || 120,
    });

    // Tee the stream: one for client, one for collecting the response
    const [streamForClient, streamForCollect] = stream.tee();

    // Save assistant message in background
    collectStreamResponse(streamForCollect, session_id);

    return new Response(streamForClient, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function collectStreamResponse(stream: ReadableStream<string>, sessionId: string) {
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  let tokenUsage: TokenUsage | null = null;

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
                contentBlocks.push({
                  type: 'tool_result',
                  tool_use_id: resultData.tool_use_id,
                  content: resultData.content,
                  is_error: resultData.is_error || false,
                });
              } catch {
                // skip malformed tool_result data
              }
            } else if (event.type === 'status') {
              // Capture SDK session_id from init event and persist it
              try {
                const statusData = JSON.parse(event.data);
                if (statusData.session_id) {
                  updateSdkSessionId(sessionId, statusData.session_id);
                }
              } catch {
                // skip malformed status data
              }
            } else if (event.type === 'result') {
              try {
                const resultData = JSON.parse(event.data);
                if (resultData.usage) {
                  tokenUsage = resultData.usage;
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
  } catch {
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
  }
}
