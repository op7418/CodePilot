import { NextRequest, NextResponse } from 'next/server';
import { getTasksBySession } from '@/lib/db';
import type { TasksResponse, ErrorResponse } from '@/types';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const sessionId = searchParams.get('session_id');

  if (!sessionId) {
    return NextResponse.json<ErrorResponse>(
      { error: 'Missing session_id parameter' },
      { status: 400 }
    );
  }

  try {
    const tasks = getTasksBySession(sessionId);
    return NextResponse.json<TasksResponse>({ tasks });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to get tasks' },
      { status: 500 }
    );
  }
}
