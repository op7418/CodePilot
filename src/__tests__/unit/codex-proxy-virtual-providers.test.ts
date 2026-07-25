/**
 * Phase 5b P0 follow-up — virtual-provider resolution in the Codex proxy.
 *
 * Background: `/api/providers/models?runtime=codex_runtime` surfaces
 * BOTH DB-backed providers AND virtual providers (`openai-oauth`,
 * `xai-oauth`, `codex_account`). The Codex chat picker reads that list directly,
 * so anything it shows MUST be resolvable by the proxy route. The
 * pre-fix bug: `handleProxyRequest` only looked up by `getProvider`
 * (DB-only), so a user picking openai-oauth under Codex Runtime hit
 * `provider_not_found` on the first send — UI false-positive.
 *
 * These tests pin two contracts:
 *
 *   1. `handleProxyRequest` resolves openai-oauth WITHOUT returning
 *      provider_not_found. (Downstream failures — missing OAuth
 *      token, upstream call — surface as different error codes; the
 *      key invariant is "the lookup branch doesn't lose the virtual
 *      id".)
 *
 *   2. The set of provider_ids the API route can return under
 *      `runtime=codex_runtime` is a subset of the set the proxy can
 *      resolve. Adding a new virtual provider to the API route
 *      without registering it here would trip this test.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleProxyRequest,
  getProxyResolvableProviderIds,
  registerAdapter,
  type ResponsesAdapter,
} from '@/lib/codex/proxy/adapter';
import { getAllProviders } from '@/lib/db';
import { createUnifiedAdapter } from '@/lib/codex/proxy/unified-adapter';
import { makeErrorResult } from '@/lib/codex/proxy/errors';

const validBody = {
  model: 'gpt-5.4',
  input: [{ type: 'message' as const, role: 'user' as const, content: [{ type: 'input_text' as const, text: 'hi' }] }],
  stream: true,
};

// ─────────────────────────────────────────────────────────────────────
// Virtual-provider resolution — no provider_not_found
// ─────────────────────────────────────────────────────────────────────

// Stub the openai_compatible adapter so the test never reaches createModel
// / network / OAuth token storage. The stub records what arguments it was
// called with so we can assert the proxy successfully resolved the virtual
// id and dispatched, instead of dying at the DB lookup.
let stubObserved:
  | { providerId: string; modelHint: string | undefined; resolvedHasCredentials: boolean }
  | undefined;
let originalUnifiedAdapter: ResponsesAdapter;

describe('handleProxyRequest — virtual providers resolve without provider_not_found', () => {
  before(() => {
    originalUnifiedAdapter = createUnifiedAdapter('openai_compatible');
    registerAdapter('openai_compatible', async (input, resolved) => {
      stubObserved = {
        providerId: input.targetProviderId,
        modelHint: input.body.model,
        resolvedHasCredentials: resolved.hasCredentials,
      };
      // Return a sentinel error so the call short-circuits cleanly
      // without touching the network or createModel.
      return makeErrorResult('internal_error', '[test-stub] adapter reached');
    });
  });

  after(() => {
    // Restore the real adapter so downstream tests aren't affected.
    registerAdapter('openai_compatible', originalUnifiedAdapter);
    stubObserved = undefined;
  });

  it('openai-oauth: reaches the openai_compatible adapter with the virtual id intact (NOT provider_not_found)', async () => {
    stubObserved = undefined;
    const result = await handleProxyRequest({
      targetProviderId: 'openai-oauth',
      sessionId: '',
      workspacePath: '',
      body: validBody,
      signal: new AbortController().signal,
    });
    // The stub records the adapter call. If we never reached it the
    // lookup must have failed earlier (provider_not_found, credentials_missing).
    const observed = stubObserved as
      | { providerId: string; modelHint: string | undefined; resolvedHasCredentials: boolean }
      | undefined;
    if (!observed) {
      throw new Error(
        'openai-oauth must reach the openai_compatible adapter — failing earlier (provider_not_found / credentials_missing) means the virtual-provider branch in handleProxyRequest is broken',
      );
    }
    assert.equal(
      observed.providerId,
      'openai-oauth',
      'the adapter must see the ORIGINAL virtual id, not a derived/dropped one — that lost id is what broke createModel in the pre-fix version',
    );
    assert.equal(
      observed.resolvedHasCredentials,
      true,
      'buildOpenAIOAuthResolution always sets hasCredentials=true (OAuth checked at call time); credentials_missing here would be a regression',
    );
    // The stub returns a sentinel internal_error — surface so we know
    // it's the stub, not a real failure. Critical invariant: NOT provider_not_found.
    assert.equal(result.kind, 'error');
    if (result.kind !== 'error') return;
    assert.notEqual(result.error.code, 'provider_not_found');
    assert.match(result.error.message, /test-stub/);
  });

  it('xai-oauth: reaches the openai_compatible proxy adapter with the virtual id intact', async () => {
    stubObserved = undefined;
    const result = await handleProxyRequest({
      targetProviderId: 'xai-oauth',
      sessionId: '',
      workspacePath: '',
      body: { ...validBody, model: 'grok-4.5' },
      signal: new AbortController().signal,
    });
    const observed = stubObserved as
      | { providerId: string; modelHint: string | undefined; resolvedHasCredentials: boolean }
      | undefined;
    assert.ok(observed, 'xai-oauth must resolve and reach the proxy adapter');
    assert.equal(observed.providerId, 'xai-oauth');
    assert.equal(observed.modelHint, 'grok-4.5');
    assert.equal(observed.resolvedHasCredentials, true);
    assert.equal(result.kind, 'error');
    if (result.kind === 'error') {
      assert.notEqual(result.error.code, 'provider_not_found');
      assert.match(result.error.message, /test-stub/);
    }
  });

  it('codex_account: surfaces routing-bug error (NOT provider_not_found)', async () => {
    // Codex Account routes through Codex's own thread/turn flow with
    // no codepilot_proxy injection. Reaching the proxy with this id
    // means CodexRuntime called thread/start with the proxy injection
    // active — a wiring bug we want to flag clearly instead of
    // pretending the provider doesn't exist.
    const result = await handleProxyRequest({
      targetProviderId: 'codex_account',
      sessionId: '',
      workspacePath: '',
      body: validBody,
      signal: new AbortController().signal,
    });
    assert.equal(result.kind, 'error');
    if (result.kind !== 'error') return;
    assert.equal(
      result.error.code,
      'internal_error',
      'codex_account hitting the proxy is a routing bug; surface as internal_error so the message points at the codex-runtime wiring, not at the user',
    );
    assert.notEqual(result.error.code, 'provider_not_found');
    assert.match(
      result.error.message,
      /codex_account|Codex Account|routes through Codex/,
    );
  });

  it('a real-looking but unregistered virtual id: provider_not_found is still the right answer', async () => {
    const result = await handleProxyRequest({
      targetProviderId: 'made-up-virtual-id-12345',
      sessionId: '',
      workspacePath: '',
      body: validBody,
      signal: new AbortController().signal,
    });
    assert.equal(result.kind, 'error');
    if (result.kind !== 'error') return;
    assert.equal(result.error.code, 'provider_not_found');
    // Hint about the virtual-provider escape hatch should be in the
    // message so future devs know which file to edit when adding a
    // new virtual provider to the API route.
    assert.match(result.error.message, /VIRTUAL_PROVIDERS|virtual provider/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// API contract — every codex_runtime row is proxy-resolvable
// ─────────────────────────────────────────────────────────────────────

describe('API contract — every provider surfaced under runtime=codex_runtime must be proxy-resolvable', () => {
  it('GET /api/providers/models?runtime=codex_runtime: every returned provider_id is in the proxy resolver set', async () => {
    const { GET } = await import('@/app/api/providers/models/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://test.local/api/providers/models?runtime=codex_runtime');
    const res = await GET(req);
    const data = (await res.json()) as {
      groups: Array<{ provider_id: string }>;
    };

    // The proxy resolver set: every DB provider id + every virtual id.
    const dbIds = getAllProviders().map(p => p.id);
    const resolvable = getProxyResolvableProviderIds(dbIds);

    // Add `codex_account` defensively — it surfaces under codex_runtime
    // but routes around the proxy. The contract only requires it be
    // RESOLVABLE (i.e. the proxy gives a clear error), not that it
    // succeeds. The virtual-provider routing-bug test above confirms
    // the failure surface is clean.
    for (const g of data.groups) {
      assert.ok(
        resolvable.has(g.provider_id),
        `Provider "${g.provider_id}" surfaces under runtime=codex_runtime in the API response, but the Codex proxy has no resolution path for it. Register it in VIRTUAL_PROVIDERS (src/lib/codex/proxy/adapter.ts) or remove it from the runtime=codex_runtime API response. Without one of these the UI shows a row that can't actually send.`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Static guarantee — virtual provider registry mirrors the API route
// ─────────────────────────────────────────────────────────────────────

describe('Virtual-provider registry mirrors /api/providers/models', () => {
  it('every virtual provider id the API route surfaces is registered in VIRTUAL_PROVIDERS', () => {
    // Source-level grep is good enough here — the API route hand-codes
    // virtual ids as string literals in `provider_id: 'openai-oauth'`
    // / `provider_id: 'codex_account'`. We can't usefully invoke the
    // route to enumerate them (Codex app-server may not be available)
    // so we read the route file and assert each literal is registered.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const routeSrc = fs.readFileSync(
      path.resolve(__dirname, '../../app/api/providers/models/route.ts'),
      'utf8',
    );
    const literalIds = new Set<string>();
    for (const match of routeSrc.matchAll(/provider_id:\s*['"]([^'"]+)['"]/g)) {
      const id = match[1];
      if (id === 'env') continue; // env is the Claude Code default — explicit non-proxy path
      literalIds.add(id);
    }
    const resolvable = getProxyResolvableProviderIds([]);
    for (const id of literalIds) {
      assert.ok(
        resolvable.has(id),
        `Virtual provider id "${id}" is hard-coded in the API route but missing from VIRTUAL_PROVIDERS in src/lib/codex/proxy/adapter.ts. Add the entry or remove the literal — they must stay in lockstep.`,
      );
    }
  });
});
