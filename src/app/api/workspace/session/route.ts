import { bindAssistantMemory } from '@/lib/memory-binding';
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getSetting, getDb } from '@/lib/db';
import { getLatestSessionByWorkingDirectory, createSession } from '@/lib/db';
import { resolveAutomaticSessionRoute } from '@/lib/runtime/automatic-session-route';

export async function POST(request: NextRequest) {
  try {
    const workspacePath = getSetting('assistant_workspace_path');
    if (!workspacePath) {
      return NextResponse.json({ error: 'No workspace path configured' }, { status: 400 });
    }

    // Validate that the workspace directory actually exists and is accessible
    try {
      const stat = fs.statSync(workspacePath);
      if (!stat.isDirectory()) {
        return NextResponse.json({ error: 'Workspace path is not a directory', code: 'not_a_directory' }, { status: 400 });
      }
      fs.accessSync(workspacePath, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      return NextResponse.json({ error: 'Workspace path does not exist or is not accessible', code: 'path_invalid' }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const { mode } = body as { mode?: 'onboarding' | 'checkin' };

    // For onboarding: always create new session
    // For checkin: reuse latest session if exists
    const session = getDb().transaction(() => {
      let session;
      if (mode === 'checkin') {
        session = getLatestSessionByWorkingDirectory(workspacePath, { includeSources: ['user'] });
      }

      if (!session) {
        const model = typeof body.model === 'string' ? body.model : '';
        const provider_id = typeof body.provider_id === 'string' ? body.provider_id : '';
        const route = resolveAutomaticSessionRoute('user_checkin', {
          modelId: model || undefined,
          providerId: provider_id || undefined,
        });
        session = createSession(
          undefined,
          route.modelId,
          undefined,
          workspacePath,
          'code',
          route.providerId,
          undefined,
          undefined,
          undefined,
          {
            runtimeId: route.runtimeId,
            state: 'bound',
            source: 'assistant_session_create',
          },
        );
      }

      bindAssistantMemory(session.id);
      return session;
    })();
    return NextResponse.json({ session, isNew: !session.sdk_session_id });
  } catch (e) {
    if (e instanceof Error && e.message === 'MEMORY_BINDING_SCOPE_MISMATCH') {
      return NextResponse.json({ error: 'Assistant workspace changed; retry opening the assistant.', code: 'assistant_scope_changed' }, { status: 409 });
    }
    console.error('[workspace/session] POST failed:', e);
    return NextResponse.json({ error: 'Failed to create/find session' }, { status: 500 });
  }
}
