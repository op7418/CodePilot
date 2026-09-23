import { getAssistantMemoryWorkspace } from '@/lib/memory-binding';
import { NextRequest } from 'next/server';
import { deleteSession, getHandoffForTargetSession, getLatestSessionCompactionEvent, getSession, updateSessionWorkingDirectory, updateSessionTitle, updateSessionMode, updateSessionAccessLevel, clearSessionMessages, updateSdkSessionId, updateSessionPermissionProfile } from '@/lib/db';
import { sanitizeManualTitle } from '@/lib/conversation-title';
import { autoApprovePendingForSession } from '@/lib/bridge/permission-broker';
import { isPermissionProfile, normalizePermissionProfile, PERMISSION_PROFILES } from '@/lib/permission/profile';
import path from 'node:path';
import { isExistingDirectory } from '@/lib/working-directory';
import { parseRuntimeHandoffPayload } from '@/lib/runtime/handoff-payload';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }
    const handoff = getHandoffForTargetSession(id);
    const compaction = getLatestSessionCompactionEvent(id);
    const handoffPayload = handoff ? parseRuntimeHandoffPayload(handoff.payload_json) : undefined;
    return Response.json({
      session,
      assistantMemoryEnabled: !!getAssistantMemoryWorkspace(session),
      ...(handoff && handoffPayload ? {
        handoff: {
          sourceSessionId: handoff.source_session_id,
          sourceTitle: handoffPayload.source.title,
          sourceRuntimeId: handoff.source_runtime_id,
          targetRuntimeId: handoff.target_runtime_id,
          sourceBoundaryRowid: handoff.source_boundary_rowid,
          payloadSource: handoff.payload_source,
          truncated: handoffPayload.truncated,
        },
      } : {}),
      ...(compaction ? {
        compaction: {
          trigger: compaction.trigger,
          sourceBoundaryRowid: compaction.source_boundary_rowid,
          messagesCompressed: compaction.messages_compressed,
          estimatedTokensSaved: compaction.estimated_tokens_saved,
          recreatedUnderlyingSession: compaction.recreated_underlying_session === 1,
          auxiliaryProviderId: compaction.auxiliary_provider_id,
          auxiliaryModelId: compaction.auxiliary_model_id,
          createdAt: compaction.created_at,
        },
      } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get session';
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    const body = await request.json();

    // Validate the consolidated access-level pair before performing ANY write.
    // The composer sends mode + permission_profile in one PATCH; accepting the
    // mode and only then rejecting a bad profile would leave a partially
    // applied permission transition.
    if (body.mode !== undefined && !['code', 'plan', 'ask'].includes(body.mode)) {
      return Response.json(
        { error: 'mode must be one of: code, plan, ask' },
        { status: 400 },
      );
    }
    if (body.permission_profile !== undefined && !isPermissionProfile(body.permission_profile)) {
      return Response.json(
        { error: `permission_profile must be one of: ${PERMISSION_PROFILES.join(', ')}` },
        { status: 400 },
      );
    }
    const hasConsolidatedAccessPair = body.mode !== undefined
      && body.permission_profile !== undefined;

    // Runtime/Provider/Model is one identity. Keeping this legacy PATCH path
    // would bypass route_revision CAS and could leave a half-written route.
    // Callers must use /route with all three fields and an expected revision.
    if (body.runtime_pin !== undefined || body.provider_id !== undefined || body.model !== undefined) {
      return Response.json(
        {
          error: 'Runtime, provider, and model must be changed through the atomic route endpoint.',
          code: 'ATOMIC_ROUTE_REQUIRED',
          route_revision: session.route_revision ?? 0,
        },
        { status: 409 },
      );
    }

    if (body.working_directory) {
      const workingDirectory = typeof body.working_directory === 'string'
        ? body.working_directory.trim()
        : '';
      if (!path.isAbsolute(workingDirectory) || !isExistingDirectory(workingDirectory)) {
        return Response.json(
          { error: 'Working directory must be an existing absolute directory', code: 'INVALID_DIRECTORY' },
          { status: 400 },
        );
      }
      updateSessionWorkingDirectory(id, path.normalize(workingDirectory));
    }
    // Rename. `if (body.title)` used to be the whole validation, so a title of
    // "   " or a lone NUL byte was stored verbatim and rendered as a blank sidebar
    // row the user couldn't tell apart from a bug. Validate + canonicalize
    // through the shared pure function, and reject rather than silently
    // storing junk. `undefined` still means "not renaming in this PATCH".
    if (body.title !== undefined) {
      const result = sanitizeManualTitle(body.title);
      if (!result.ok) {
        return Response.json({ error: result.error }, { status: 400 });
      }
      // origin 'manual' with no expectOrigin: the user is explicitly naming
      // this chat, which outranks every automatic writer from now on.
      updateSessionTitle(id, result.title, 'manual');

      // Keep an existing Codex thread label aligned with CodePilot's canonical
      // title. Fire-and-forget so an unavailable/old app-server can never make
      // the local rename spinner wait for its 30s RPC timeout.
      if (session.codex_thread_id) {
        import('@/lib/codex/thread-name')
          .then(({ syncCodexThreadName }) => syncCodexThreadName(id, result.title))
          .catch(() => { /* local manual rename already succeeded */ });
      }
    }
    if (body.mode) {
      if (hasConsolidatedAccessPair) {
        updateSessionAccessLevel(id, body.mode, body.permission_profile);
      } else {
        updateSessionMode(id, body.mode);
      }
    }
    if (body.sdk_session_id !== undefined) {
      updateSdkSessionId(id, body.sdk_session_id);
    }
    if (body.permission_profile !== undefined) {
      // A profile change only governs requests made AFTER it lands — an
      // in-flight prompt keeps the semantics it was raised under. The one
      // exception is the deliberate full_access elevation below: the user
      // asked for "stop asking me", and the request they're staring at is
      // the one they meant. Switching to/from auto_review resolves nothing —
      // the pending prompt stays a human decision.
      const previousProfile = normalizePermissionProfile(session.permission_profile);
      if (!hasConsolidatedAccessPair) {
        updateSessionPermissionProfile(id, body.permission_profile);
      }
      if (previousProfile !== 'full_access' && body.permission_profile === 'full_access') {
        try {
          autoApprovePendingForSession(id);
        } catch (err) {
          console.warn('[session-api] Failed to auto-approve pending permissions:', err);
        }
      }
    }
    if (body.clear_messages) {
      clearSessionMessages(id);
    }

    const updated = getSession(id);
    return Response.json({ session: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update session';
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    deleteSession(id);
    return Response.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete session';
    return Response.json({ error: message }, { status: 500 });
  }
}
