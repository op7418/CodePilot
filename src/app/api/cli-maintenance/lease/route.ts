import { randomUUID } from 'node:crypto';
import * as bridgeManager from '@/lib/bridge/bridge-manager';
import { hasActiveSessionWork, listScheduledTasks } from '@/lib/db';
import {
  acquireCliMaintenanceLease,
  heartbeatCliMaintenanceLease,
  releaseCliMaintenanceLease,
} from '@/lib/cli-maintenance-lease';
import { isCliProvider, type CliProvider } from '@/lib/cli-maintenance-contract';
import { quiesceCodexForCliMaintenance } from '@/lib/codex/app-server-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LEASE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

type LeaseAction = 'acquire' | 'heartbeat' | 'release';

function validAction(value: unknown): value is LeaseAction {
  return value === 'acquire' || value === 'heartbeat' || value === 'release';
}

function hasActiveWork(): boolean {
  return hasActiveSessionWork()
    || bridgeManager.getStatus().running
    || listScheduledTasks().some((task) => task.last_status === 'running');
}

function fail(errorCode: string, status = 409): Response {
  return Response.json({ ok: false, errorCode }, { status });
}

export async function POST(request: Request) {
  let body: { action?: unknown; provider?: unknown; leaseId?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail('invalid_request', 400);
  }
  if (!validAction(body.action) || !isCliProvider(body.provider)) {
    return fail('invalid_request', 400);
  }
  const provider: CliProvider = body.provider;
  const leaseId = typeof body.leaseId === 'string' && LEASE_ID_PATTERN.test(body.leaseId)
    ? body.leaseId
    : body.action === 'acquire'
      ? randomUUID()
      : null;
  if (!leaseId) return fail('invalid_request', 400);

  if (body.action === 'heartbeat') {
    return heartbeatCliMaintenanceLease(provider, leaseId)
      ? Response.json({ ok: true })
      : fail('lease_not_found', 404);
  }
  if (body.action === 'release') {
    // Idempotent release: a stale/expired lease is already safe.
    releaseCliMaintenanceLease(provider, leaseId);
    return Response.json({ ok: true });
  }

  if (!acquireCliMaintenanceLease(provider, leaseId)) {
    return fail('maintenance_in_progress');
  }

  try {
    // The gate is visible before this second activity check, closing the long
    // update-window race without hot-killing a process that already started.
    if (hasActiveWork()) {
      releaseCliMaintenanceLease(provider, leaseId);
      return fail('active_work');
    }
    if (provider === 'codex') {
      const quiesce = await quiesceCodexForCliMaintenance();
      if (quiesce !== 'idle') {
        releaseCliMaintenanceLease(provider, leaseId);
        return fail(quiesce === 'active' ? 'active_work' : 'activity_unavailable');
      }
    }
    return Response.json({ ok: true, leaseId });
  } catch {
    releaseCliMaintenanceLease(provider, leaseId);
    return fail('activity_unavailable');
  }
}
