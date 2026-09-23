import { NextRequest } from 'next/server';
import {
  getSession,
  updateSessionRouteCas,
  type SessionRouteIdentity,
} from '@/lib/db';
import { isRuntimeId } from '@/lib/runtime/runtime-id';
import { getThreadExecutionBinding } from '@/lib/runtime/thread-execution-binding';
import {
  routeChangeMode,
  runtimeRefToClearForRouteChange,
  type RouteChangeMode,
} from '@/lib/runtime/continuation-policy';
import { validateRuntimeRoute } from '@/lib/runtime/route-validation';

function error(status: number, code: string, extra: Record<string, unknown> = {}) {
  return Response.json({ error: code, code, ...extra }, { status });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return error(404, 'SESSION_NOT_FOUND');

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return error(400, 'INVALID_ROUTE_REQUEST');
  }
  const runtimeId = body.runtime_id;
  const providerId = typeof body.provider_instance_id === 'string'
    ? body.provider_instance_id.trim()
    : '';
  const modelId = typeof body.model_id === 'string' ? body.model_id.trim() : '';
  const expectedRouteRevision = body.expected_route_revision;
  const recovery = body.recovery === true;
  const bindForExecution = body.bind_for_execution === true;
  if (!isRuntimeId(runtimeId) || !providerId || !modelId
    || !Number.isSafeInteger(expectedRouteRevision) || (expectedRouteRevision as number) < 0
    || (body.bind_for_execution !== undefined && typeof body.bind_for_execution !== 'boolean')) {
    return error(400, 'INVALID_ROUTE_REQUEST');
  }

  const binding = getThreadExecutionBinding(session);
  if (binding.routeRevision !== expectedRouteRevision) {
    return error(409, 'ROUTE_REVISION_CONFLICT', {
      route_revision: binding.routeRevision,
      session,
    });
  }
  if (binding.state === 'legacy_unbound' && !recovery) {
    return error(409, 'RUNTIME_RECOVERY_REQUIRED', { route_revision: binding.routeRevision });
  }
  if (binding.state === 'bound' && binding.runtimeId !== runtimeId) {
    return error(409, 'RUNTIME_OWNERSHIP_CONFLICT', {
      currentRuntimeId: binding.runtimeId,
      requestedRuntimeId: runtimeId,
      canHandoff: true,
      route_revision: binding.routeRevision,
    });
  }

  const target: SessionRouteIdentity = { runtimeId, providerId, modelId };
  const validation = await validateRuntimeRoute(target);
  if (!validation.ok) return error(409, validation.code);

  let continuationMode: RouteChangeMode = 'in_session';
  if (binding.runtimeId) {
    continuationMode = routeChangeMode({
      runtimeId: binding.runtimeId,
      providerId: session.provider_id || '',
      modelId: session.model || '',
    }, target);
  }
  if (binding.state === 'bound' && continuationMode === 'new_session') {
    return error(409, 'ROUTE_REQUIRES_HANDOFF', {
      currentRuntimeId: binding.runtimeId,
      requestedRuntimeId: runtimeId,
      canHandoff: true,
      route_revision: binding.routeRevision,
    });
  }
  if (continuationMode === 'unsupported') {
    return error(409, 'ROUTE_CHANGE_UNSUPPORTED', { route_revision: binding.routeRevision });
  }

  const result = updateSessionRouteCas({
    sessionId: id,
    expectedRouteRevision: expectedRouteRevision as number,
    route: target,
    ...(binding.state === 'legacy_unbound' && recovery
      ? { binding: { state: 'bound' as const, source: 'user_recovery' as const } }
      : binding.state === 'unbound' && bindForExecution
        ? { binding: { state: 'bound' as const, source: 'first_execution' as const } }
      : {}),
    clearRuntimeRefFor: runtimeRefToClearForRouteChange(runtimeId, continuationMode),
  });
  if (!result.ok) {
    return result.reason === 'not_found'
      ? error(404, 'SESSION_NOT_FOUND')
      : error(409, 'ROUTE_REVISION_CONFLICT', {
          route_revision: result.session?.route_revision ?? expectedRouteRevision,
          session: result.session,
        });
  }
  return Response.json({
    session: result.session,
    route_revision: result.session.route_revision ?? 0,
    continuation_mode: continuationMode,
  });
}
