import { NextRequest } from 'next/server';
import { streamClaude } from '@/lib/claude-client';
import { streamOpenRouter } from '@/lib/openrouter-client';
import { addMessage, getSession, updateSessionTitle, updateSdkSessionId, getSetting } from '@/lib/db';
import type { SendMessageRequest, SSEEvent, TokenUsage, ApiProvider } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body: SendMessageRequest = await request.json();
    const { session_id, content, model, mode } = body;

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

    // Save user message
    addMessage(session_id, 'user', content);

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

    // Determine which provider to use
    const provider: ApiProvider = (getSetting('api_provider') as ApiProvider) || 'claude_code';

    let stream: ReadableStream<string>;

    if (provider === 'openrouter') {
      // Use OpenRouter (OpenAI-compatible API)
      stream = streamOpenRouter({
        prompt: content,
        sessionId: session_id,
        model: effectiveModel,
        systemPrompt: systemPromptOverride || session.system_prompt || undefined,
        abortController,
      });
    } else {
      // Use Claude Code Agent SDK (default)
      stream = streamClaude({
        prompt: content,
        sessionId: session_id,
        sdkSessionId: session.sdk_session_id || undefined,
        model: effectiveModel,
        systemPrompt: systemPromptOverride || session.system_prompt || undefined,
        workingDirectory: session.working_directory || undefined,
        abortController,
        permissionMode,
      });
    }

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
  let fullText = '';
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
              fullText += event.data;
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

    if (fullText.trim()) {
      addMessage(
        sessionId,
        'assistant',
        fullText.trim(),
        tokenUsage ? JSON.stringify(tokenUsage) : null,
      );
    }
  } catch {
    // Stream reading error - best effort save
    if (fullText.trim()) {
      addMessage(sessionId, 'assistant', fullText.trim());
    }
  }
}
