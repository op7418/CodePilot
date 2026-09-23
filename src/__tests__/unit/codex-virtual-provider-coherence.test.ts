/**
 * Phase 5 review round 4 — codex_account virtual provider + atomic
 * runtime_pin coherence on session PATCH.
 *
 * Codex CDP smoke (2026-05-13) caught two real wiring bugs:
 *
 *   P1.1 — Sending under (provider_id=codex_account, model=gpt-5.5)
 *          returned 409 "provider deleted" because
 *          `resolveProviderForSession` treated codex_account as a
 *          regular DB-row id and didn't find it (it's virtual,
 *          produced by buildCodexProviderModelGroup).
 *
 *   P1.2 — Picking a codex_account model in the picker persisted
 *          provider_id=codex_account but left runtime_pin
 *          =codepilot_runtime. The composer's PATCH whitelist
 *          rejected runtime_pin='codex_runtime' (hardcoded two-id
 *          allowlist) so even when the UI tried to switch the
 *          runtime, the server returned 400.
 *
 * Fixes pinned here:
 *   - provider-resolver.ts treats 'codex_account' as a virtual provider
 *     in BOTH resolveProvider (main entry) and resolveProviderForSession
 *     (session-validated wrapper).
 *   - The PATCH route's runtime_pin validation now goes through
 *     `isRuntimeId` (covers RUNTIME_IDS) and 400s with the up-to-date
 *     set listed.
 *   - The PATCH route enforces atomic coherence: provider_id=codex_account
 *     automatically forces runtime_pin to codex_runtime when the client
 *     didn't include one. Response carries `coherence.forcedRuntimePin`
 *     so the UI can show a toast.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProvider } from '@/lib/provider-resolver';

const repoRoot = path.resolve(__dirname, '../..');

describe('resolveProvider — codex_account virtual provider (P1.1 fix)', () => {
  it('codex_account is recognized as a virtual provider — no DB lookup, no 409', () => {
    const resolved = resolveProvider({ providerId: 'codex_account', model: 'gpt-5.5' });
    // Virtual: no `invalidReason`, `hasCredentials: true` (account-managed),
    // `_codexAccount: true` marker so downstream code can branch.
    assert.equal(resolved.invalidReason, undefined);
    assert.equal((resolved as { _codexAccount?: boolean })._codexAccount, true);
    assert.equal(resolved.hasCredentials, true);
    assert.equal(resolved.model, 'gpt-5.5');
    assert.equal(resolved.upstreamModel, 'gpt-5.5');
  });

  it('codex_account never falls through to env / default fallback', () => {
    // If the route accidentally fell through, `provider` would be the
    // default DB provider (or undefined for env) — not what we want.
    // The marker is the load-bearing pin.
    const resolved = resolveProvider({ providerId: 'codex_account' });
    assert.equal((resolved as { _codexAccount?: boolean })._codexAccount, true);
  });
});

describe('Provider-resolver virtual-provider exception list — source-level pin', () => {
  const resolverSrc = fs.readFileSync(
    path.join(repoRoot, 'lib/provider-resolver.ts'),
    'utf8',
  );

  it('resolveProviderForSession exempts codex_account from the DB-missing check', () => {
    // The same exception list that handles env / openai-oauth must
    // include codex_account so the session-validated path doesn't 409
    // when Codex Account models are persisted on a chat session.
    assert.match(
      resolverSrc,
      /effectiveProviderId\s*!==\s*'codex_account'/,
    );
  });

  it('resolveProvider has an early branch for codex_account', () => {
    // Mirror the buildOpenAIOAuthResolution path so codex_account
    // never reaches getProvider() with a virtual id.
    assert.match(
      resolverSrc,
      /effectiveProviderId\s*===\s*'codex_account'[\s\S]{0,500}buildCodexAccountResolution/,
    );
  });
});

describe('Session route mutation — one atomic Runtime+Provider+Model identity', () => {
  const legacyPatchSrc = fs.readFileSync(
    path.join(repoRoot, 'app/api/chat/sessions/[id]/route.ts'),
    'utf8',
  );
  const atomicRouteSrc = fs.readFileSync(
    path.join(repoRoot, 'app/api/chat/sessions/[id]/route/route.ts'),
    'utf8',
  );
  const validationSrc = fs.readFileSync(
    path.join(repoRoot, 'lib/runtime/route-validation.ts'),
    'utf8',
  );

  it('legacy PATCH refuses every split route field before writes', () => {
    assert.match(legacyPatchSrc, /body\.runtime_pin[\s\S]*body\.provider_id[\s\S]*body\.model/);
    assert.match(legacyPatchSrc, /ATOMIC_ROUTE_REQUIRED/);
  });

  it('atomic endpoint validates RuntimeId and requires route_revision CAS', () => {
    assert.match(atomicRouteSrc, /isRuntimeId\(runtimeId\)/);
    assert.match(atomicRouteSrc, /expected_route_revision/);
    assert.match(atomicRouteSrc, /ROUTE_REVISION_CONFLICT/);
    assert.match(atomicRouteSrc, /updateSessionRouteCas/);
  });

  it('codex_account is accepted only with codex_runtime instead of server-side self-switching', () => {
    assert.match(validationSrc, /route\.providerId === 'codex_account'/);
    assert.match(validationSrc, /route\.runtimeId !== 'codex_runtime'/);
    assert.match(validationSrc, /RUNTIME_ROUTE_INCOMPATIBLE/);
    assert.doesNotMatch(atomicRouteSrc, /updateSessionRuntime/);
  });
});
