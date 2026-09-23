import { NextRequest } from 'next/server';
import { parseClaudeSession } from '@/lib/claude-session-parser';
import { createSession, addMessage, updateSdkSessionId, getAllSessions } from '@/lib/db';
import { deriveConversationTitle } from '@/lib/conversation-title';
import { serverErrorResponse } from '@/lib/api-error';
import { resolveAutomaticSessionRoute } from '@/lib/runtime/automatic-session-route';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId) {
      return Response.json(
        { error: 'sessionId is required' },
        { status: 400 },
      );
    }

    // Check for duplicate import: reject if a session with this sdk_session_id already exists
    const existingSessions = getAllSessions();
    const alreadyImported = existingSessions.find(s => s.sdk_session_id === sessionId);
    if (alreadyImported) {
      return Response.json(
        {
          error: 'This session has already been imported',
          existingSessionId: alreadyImported.id,
        },
        { status: 409 },
      );
    }

    const parsed = parseClaudeSession(sessionId);
    if (!parsed) {
      return Response.json(
        { error: `Session "${sessionId}" not found or could not be parsed` },
        { status: 404 },
      );
    }

    const { info, messages } = parsed;

    if (messages.length === 0) {
      return Response.json(
        { error: 'Session has no messages to import' },
        { status: 400 },
      );
    }

    // Title from the first user message, via the same pure function as every
    // other entry point. A foreign transcript's message may be empty or
    // metadata-only once cleaned, so fall back to the project name.
    const firstUserMsg = messages.find(m => m.role === 'user');
    const title = deriveConversationTitle(firstUserMsg?.content) || `Imported: ${info.projectName}`;

    // Create a new CodePilot session. origin 'import': this title describes a
    // conversation that happened elsewhere, so semantic re-generation must
    // never touch it.
    const route = resolveAutomaticSessionRoute('interactive_chat', { runtimeId: 'claude_code' });
    const session = createSession(
      title,
      route.modelId,
      undefined, // system prompt
      info.cwd || info.projectPath,
      'code',
      route.providerId,
      undefined, // permission profile
      undefined, // source
      'import',
      {
        runtimeId: 'claude_code',
        state: 'bound',
        source: 'legacy_runtime_ref',
      },
    );

    // Store the original Claude Code SDK session ID so the conversation can be resumed
    updateSdkSessionId(session.id, sessionId);

    // Import all messages
    for (const msg of messages) {
      // For assistant messages with tool blocks, store as structured JSON
      // For text-only messages, store as plain text (consistent with CodePilot's convention)
      const content = msg.hasToolBlocks
        ? JSON.stringify(msg.contentBlocks)
        : msg.content;

      if (content.trim()) {
        addMessage(session.id, msg.role, content);
      }
    }

    return Response.json({
      session: {
        id: session.id,
        title,
        messageCount: messages.length,
        projectPath: info.projectPath,
        sdkSessionId: sessionId,
      },
    }, { status: 201 });
  } catch (error) {
    return serverErrorResponse('POST /api/claude-sessions/import', error);
  }
}
