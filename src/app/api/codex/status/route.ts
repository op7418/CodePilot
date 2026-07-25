/**
 * GET /api/codex/status — read current status with automatic candidate-change
 * detection. POST forces a safe rescan for same-path in-place CLI upgrades.
 *
 * Phase 5 Phase 1 (2026-05-13) — Settings status card source.
 *
 * Returns the Codex app-server availability without spawning the
 * process. Two states matter to the UI:
 *
 *   - `not_installed` — Codex binary missing; UI shows install hint
 *   - `installed_idle` — binary exists; app-server has not been
 *     initialized in this process yet
 *   - `ready`         — app-server already up; show version + home
 *
 * Intermediate states (`spawn_failed`, `too_old`, `unknown`) ride
 * through as-is — the Settings status card renders the message verbatim.
 */

import { NextResponse } from 'next/server';
import {
  getCodexAvailability,
  refreshCodexAvailability,
} from '@/lib/codex/app-server-manager';

export async function GET() {
  try {
    const availability = await getCodexAvailability();
    return NextResponse.json({ availability });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { availability: { kind: 'spawn_failed', reason } },
      { status: 200 },
    );
  }
}

export async function POST() {
  try {
    const availability = await refreshCodexAvailability();
    return NextResponse.json({ availability });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { availability: { kind: 'spawn_failed', reason } },
      { status: 200 },
    );
  }
}
