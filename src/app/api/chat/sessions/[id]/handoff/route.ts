import { NextRequest } from 'next/server';
import {
  createSessionHandoff,
  getMessages,
  getSessionHandoffPreview,
} from '@/lib/db';
import { isRuntimeId } from '@/lib/runtime/runtime-id';
import { validateRuntimeRoute } from '@/lib/runtime/route-validation';
import { buildRuntimeHandoffPayload } from '@/lib/runtime/handoff-payload';

function failure(status: number, code: string, extra: Record<string, unknown> = {}) {
  return Response.json({ error: code, code, ...extra }, { status });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const preview = getSessionHandoffPreview(id);
  if (!preview) return failure(404, 'SOURCE_SESSION_NOT_FOUND');
  if (preview.sourceSession.runtime_binding_state !== 'bound'
    || !isRuntimeId(preview.sourceSession.runtime_pin)) {
    return failure(409, 'SOURCE_RUNTIME_UNBOUND');
  }
  return Response.json({
    source_session_id: id,
    source_runtime_id: preview.sourceSession.runtime_pin,
    source_route_revision: preview.sourceSession.route_revision ?? 0,
    source_boundary_rowid: preview.sourceBoundaryRowid,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return failure(400, 'INVALID_HANDOFF_REQUEST');
  }
  const runtimeId = body.runtime_id;
  const providerId = typeof body.provider_instance_id === 'string'
    ? body.provider_instance_id.trim()
    : '';
  const modelId = typeof body.model_id === 'string' ? body.model_id.trim() : '';
  const expectedRouteRevision = body.expected_source_route_revision;
  const expectedBoundaryRowid = body.expected_source_boundary_rowid;
  if (!isRuntimeId(runtimeId) || !providerId || !modelId
    || !Number.isSafeInteger(expectedRouteRevision) || (expectedRouteRevision as number) < 0
    || !Number.isSafeInteger(expectedBoundaryRowid) || (expectedBoundaryRowid as number) < 0) {
    return failure(400, 'INVALID_HANDOFF_REQUEST');
  }

  const preview = getSessionHandoffPreview(id);
  if (!preview) return failure(404, 'SOURCE_SESSION_NOT_FOUND');
  if (preview.sourceSession.runtime_binding_state !== 'bound'
    || !isRuntimeId(preview.sourceSession.runtime_pin)) {
    return failure(409, 'SOURCE_RUNTIME_UNBOUND');
  }
  if (preview.sourceSession.runtime_pin === runtimeId) {
    return failure(409, 'HANDOFF_RUNTIME_MUST_CHANGE');
  }
  const targetRoute = { runtimeId, providerId, modelId };
  const validation = await validateRuntimeRoute(targetRoute);
  if (!validation.ok) return failure(409, validation.code);

  const { messages } = getMessages(id, { limit: 200, excludeHeartbeatAck: true });
  const payload = buildRuntimeHandoffPayload({
    sourceSession: preview.sourceSession,
    sourceRuntimeId: preview.sourceSession.runtime_pin,
    sourceBoundaryRowid: expectedBoundaryRowid as number,
    targetRuntimeId: runtimeId,
    targetProviderId: providerId,
    targetModelId: modelId,
    messages,
    userNote: typeof body.user_note === 'string' ? body.user_note : undefined,
  });
  const result = createSessionHandoff({
    sourceSessionId: id,
    expectedSourceRouteRevision: expectedRouteRevision as number,
    expectedSourceBoundaryRowid: expectedBoundaryRowid as number,
    targetRoute,
    payloadVersion: 1,
    payloadJson: JSON.stringify(payload),
    payloadSource: 'recent_transcript',
    idempotencyKey: typeof body.idempotency_key === 'string' ? body.idempotency_key : undefined,
  });
  if (!result.ok) {
    const codes = {
      source_not_found: 'SOURCE_SESSION_NOT_FOUND',
      source_unbound: 'SOURCE_RUNTIME_UNBOUND',
      source_busy: 'SOURCE_SESSION_BUSY',
      source_route_advanced: 'SOURCE_ROUTE_ADVANCED',
      source_transcript_advanced: 'SOURCE_TRANSCRIPT_ADVANCED',
    } as const;
    return failure(result.reason === 'source_not_found' ? 404 : 409, codes[result.reason]);
  }
  return Response.json({
    target_session_id: result.targetSession.id,
    target_session: result.targetSession,
    handoff: result.handoff,
    idempotent: result.idempotent,
  }, { status: result.idempotent ? 200 : 201 });
}
