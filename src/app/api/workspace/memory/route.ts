import { NextResponse } from 'next/server';
import { getSetting } from '@/lib/db';
import {
  correctMemoryRecord, MemoryRecordError, readMemoryRecords,
  revokeMemoryRecord, saveMemoryRecordCandidate,
} from '@/lib/memory-records';
import { getMemoryJobStatus, resumeMemoryJobs } from '@/lib/memory-lifecycle';

function enhancementStatus(workspace: string) {
  try { return getMemoryJobStatus(workspace); } catch { return { error: 'unavailable' }; }
}

function requestAllowed(request: Request, mutation: boolean): boolean {
  try {
    const url = new URL(request.url);
    const target = new URL(`${url.protocol}//${request.headers.get('host') || url.host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) return false;
    const origin = request.headers.get('origin');
    if ((mutation && !origin) || (origin && new URL(origin).origin !== target.origin)) return false;
    const site = request.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return false;
    return !mutation || request.headers.get('content-type')?.split(';')[0].trim() === 'application/json';
  } catch { return false; }
}

function failure(error: unknown) {
  const code = error instanceof MemoryRecordError ? error.code : 'unavailable';
  const status = code === 'capacity' ? 507 : code === 'corrupt' ? 422 : code === 'conflict' || code === 'busy' ? 409 : code === 'invalid' || code === 'secret' ? 400 : code === 'not_found' ? 404 : 500;
  return NextResponse.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request) {
  if (!requestAllowed(request, false)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const workspace = getSetting('assistant_workspace_path');
  if (!workspace) return NextResponse.json({ error: 'unconfigured' }, { status: 400 });
  try {
    return NextResponse.json({ ...readMemoryRecords(workspace), enhancement: enhancementStatus(workspace) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  if (!requestAllowed(request, true)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const text = await request.text();
    if (text.length > 20000) throw new MemoryRecordError('invalid', 'Request is too large.');
    const body = JSON.parse(text);
    if (!body || Array.isArray(body) || typeof body !== 'object'
      || Object.keys(body).some(key => !['action', 'id', 'content', 'expectedRevision', 'idempotencyKey'].includes(key))
      || typeof body.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedRevision)) {
      throw new MemoryRecordError('invalid', 'Invalid request.');
    }
    // The client cannot select a filesystem root or fabricate conversation provenance.
    // Revision includes the real workspace identity, rejecting stale UI after a root switch.
    const workspace = getSetting('assistant_workspace_path');
    if (!workspace) return NextResponse.json({ error: 'unconfigured' }, { status: 400 });
    if (body.action === 'retry') {
      if (readMemoryRecords(workspace).revision !== body.expectedRevision) throw new MemoryRecordError('conflict', 'Workspace or memory changed.');
      void resumeMemoryJobs(workspace).catch(() => { /* persisted job status is shown on refresh */ });
      return NextResponse.json({ ...readMemoryRecords(workspace), enhancement: enhancementStatus(workspace), retryRequested: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
    }
    if (body.action === 'remember') {
      return NextResponse.json(saveMemoryRecordCandidate(workspace, {
        content: body.content, source: { kind: 'manual', capturedAt: new Date().toISOString() }, idempotencyKey: body.idempotencyKey,
      }, body.expectedRevision));
    }
    if (typeof body.id !== 'string') throw new MemoryRecordError('invalid', 'Memory ID is required.');
    if (body.action === 'correct') return NextResponse.json(correctMemoryRecord(workspace, body.id, body.content, body.expectedRevision));
    if (body.action === 'forget') return NextResponse.json(revokeMemoryRecord(workspace, body.id, body.expectedRevision));
    throw new MemoryRecordError('invalid', 'Unknown action.');
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: 'invalid' }, { status: 400 });
    return failure(error);
  }
}
