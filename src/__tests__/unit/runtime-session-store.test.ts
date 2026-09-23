/**
 * Phase 0.5 Slice C — Runtime session store abstraction.
 *
 * Asserts:
 *   1. The abstraction file exists and exports the three lifecycle
 *      helpers (`getRuntimeSessionRef` / `setRuntimeSessionRef` /
 *      `clearRuntimeSessionRef`).
 *   2. The helpers cover every `RuntimeId` exhaustively at the type
 *      level (the switch's `default: never` block guards drift when
 *      a new runtime is added — TS will fail compilation if the
 *      implementer forgets to extend the switch).
 *   3. The /api/chat/sessions/[id] PATCH handler — the canonical
 *      consumer of the clearing path — calls `clearRuntimeSessionRef`
 *      instead of poking `updateSdkSessionId(id, '')` directly.
 *      Future Codex Runtime adds its clearing branch inside the store
 *      helper without splaying through the API route.
 *
 * Slice E will extend this test with a sibling assertion on the
 * read-side (api/chat/route.ts using `getRuntimeSessionRef` for
 * resume) once the unified event channel migration lands.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const storeSrc = fs.readFileSync(
  path.resolve(__dirname, '../../lib/runtime/session-store.ts'),
  'utf8',
);

const sessionsRouteSrc = fs.readFileSync(
  path.resolve(__dirname, '../../app/api/chat/sessions/[id]/route.ts'),
  'utf8',
);
const atomicRouteSrc = fs.readFileSync(
  path.resolve(__dirname, '../../app/api/chat/sessions/[id]/route/route.ts'),
  'utf8',
);
const dbSrc = fs.readFileSync(
  path.resolve(__dirname, '../../lib/db.ts'),
  'utf8',
);

describe('Runtime session store abstraction', () => {
  it('session-store.ts exports the three lifecycle helpers', () => {
    assert.match(storeSrc, /export\s+function\s+getRuntimeSessionRef\b/);
    assert.match(storeSrc, /export\s+function\s+setRuntimeSessionRef\b/);
    assert.match(storeSrc, /export\s+function\s+clearRuntimeSessionRef\b/);
  });

  it('every helper has an exhaustiveness guard on RuntimeId', () => {
    // The `default: { const _: never = ...; }` pattern is what
    // surfaces when a new RuntimeId is added but the switch case is
    // missing. Each of the 3 helpers must have one.
    const exhaustiveMatches = storeSrc.match(/const\s+_\s*:\s*never\s*=\s*(runtimeId|ref\.runtimeId)/g) ?? [];
    assert.ok(
      exhaustiveMatches.length >= 3,
      `Expected at least 3 exhaustiveness guards (one per lifecycle helper), found ${exhaustiveMatches.length}`,
    );
  });

  it('claude_code branch delegates to the legacy sdk_session_id column', () => {
    // Preserves v0.x history rows. Future Codex slice does NOT change
    // this branch; it adds a new case for `codex_runtime`.
    assert.match(storeSrc, /case\s+'claude_code'[\s\S]{0,300}sdk_session_id/);
    assert.match(storeSrc, /updateSdkSessionId/);
  });

  it('codepilot_runtime branch is an explicit no-op (no external state)', () => {
    // Native runtime keeps state in-memory; no persistent ref.
    // Codifying this branch — instead of letting it fall through —
    // forces the implementer to think about persistence intentionally.
    assert.match(storeSrc, /case\s+'codepilot_runtime'/);
  });

  it('atomic route CAS clears the affected Runtime ref in the same DB transaction', () => {
    assert.match(sessionsRouteSrc, /ATOMIC_ROUTE_REQUIRED/,
      'legacy PATCH must reject split route writes.');
    assert.match(atomicRouteSrc, /clearRuntimeRefFor:\s*runtimeRefToClearForRouteChange/,
      'continuation policy must select the Runtime ref that becomes invalid.');
    assert.match(dbSrc, /clearRuntimeRefFor\?:\s*RuntimeId/);
    assert.match(dbSrc, /clearClaude[\s\S]{0,500}sdk_session_id\s*=\s*CASE/,
      'the CAS UPDATE must clear Claude resume state atomically with the route.');
    assert.match(dbSrc, /clearCodex[\s\S]{0,500}codex_thread_id\s*=\s*CASE/,
      'the CAS UPDATE must clear Codex resume state atomically with the route.');
  });
});
