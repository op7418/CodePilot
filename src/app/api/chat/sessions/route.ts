import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import { getAllSessions, createSession } from '@/lib/db';
import type { CreateSessionRequest, SessionsResponse, SessionResponse } from '@/types';

export async function GET() {
  try {
    const sessions = getAllSessions();
    const response: SessionsResponse = { sessions };
    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[GET /api/chat/sessions] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: CreateSessionRequest = await request.json();

    // Validate working_directory is provided
    if (!body.working_directory) {
      return Response.json(
        { error: 'Working directory is required', code: 'MISSING_DIRECTORY' },
        { status: 400 },
      );
    }

    // Validate directory actually exists on disk
    try {
      await fs.access(body.working_directory);
    } catch {
      return Response.json(
        { error: 'Directory does not exist', code: 'INVALID_DIRECTORY' },
        { status: 400 },
      );
    }

    const session = createSession(
      body.title,
      body.model,
      body.system_prompt,
      body.working_directory,
      body.mode,
      body.provider_id,
    );
    const response: SessionResponse = { session };
    return Response.json(response, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[POST /api/chat/sessions] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
