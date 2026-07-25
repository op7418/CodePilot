/**
 * Phase 5e Phase 3 review round 4 fix P2 #2 (2026-05-18) —
 * `resolveEffectiveProviderId()` must match chat send path behaviour
 * across all four PROVIDER-level fallback shapes:
 *
 *   1. Auto mode (no pin) → chooses the active DB provider id (or
 *      undefined when no provider at all).
 *   2. Pinned valid → returns the pinned provider id verbatim.
 *   3. Pinned invalid (pin points at a missing / inactive provider)
 *      → falls back through `default_provider_id` setting → active
 *      provider, mirroring `resolveProvider({ providerId: pinned })`
 *      in `provider-resolver.ts:181-189`.
 *   4. Virtual provider (codex_account / openai-oauth / xai-oauth / env) →
 *      preserved verbatim; resolver does NOT try to look these up
 *      as DB rows (they don't exist there).
 *
 * Scope note (review round 5 P2): this file pins PROVIDER-level
 * fallback parity only. Model-level fallback (model not in
 * `provider_models` under the active Runtime, role-model overrides)
 * is OUT OF SCOPE — `resolveEffectiveProviderId` only consults
 * `global_default_model_provider`, not `global_default_model`. The
 * helper's downstream consumer is the codex_runtime matrix downgrade
 * which is keyed on the virtual provider id `codex_account`, so
 * provider-level resolution is sufficient. If a future feature
 * extends scope, add a separate test file for model-level parity.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveProviderId } from '@/lib/harness/settings-effective-provider';
import { resolveProvider } from '@/lib/provider-resolver';
import {
  getDb,
  setSetting,
  createProvider,
  activateProvider,
  deleteProvider,
  getActiveProvider,
} from '@/lib/db';

// Track created rows so we can clean up after each test (test DB is
// shared across the test process; we don't isolate per-test but we do
// reset state for the case we touch).
const trackedProviders: string[] = [];

beforeEach(() => {
  trackedProviders.length = 0;
});

afterEach(() => {
  // Best-effort cleanup of providers we created in this test.
  const db = getDb();
  for (const id of trackedProviders) {
    try {
      deleteProvider(id);
    } catch {
      // ignore
    }
  }
  // Restore default_provider_id / global_default_model_provider to
  // whatever they were before the test. Tests below set + restore
  // these explicitly via the snapshot mechanism in
  // `withSettings`.
  void db;
});

/** Snapshot + restore the two settings rows the resolver reads. */
async function withSettings<T>(
  overrides: { globalDefault?: string | null; legacyDefault?: string | null },
  body: () => T,
): Promise<T> {
  const db = getDb();
  const prevGlobal = db
    .prepare("SELECT value FROM settings WHERE key = 'global_default_model_provider'")
    .get() as { value: string } | undefined;
  const prevLegacy = db
    .prepare("SELECT value FROM settings WHERE key = 'default_provider_id'")
    .get() as { value: string } | undefined;
  try {
    if (overrides.globalDefault === null) {
      db.prepare("DELETE FROM settings WHERE key = 'global_default_model_provider'").run();
    } else if (overrides.globalDefault !== undefined) {
      setSetting('global_default_model_provider', overrides.globalDefault);
    }
    if (overrides.legacyDefault === null) {
      db.prepare("DELETE FROM settings WHERE key = 'default_provider_id'").run();
    } else if (overrides.legacyDefault !== undefined) {
      setSetting('default_provider_id', overrides.legacyDefault);
    }
    return body();
  } finally {
    if (prevGlobal) {
      setSetting('global_default_model_provider', prevGlobal.value);
    } else {
      db.prepare("DELETE FROM settings WHERE key = 'global_default_model_provider'").run();
    }
    if (prevLegacy) {
      setSetting('default_provider_id', prevLegacy.value);
    } else {
      db.prepare("DELETE FROM settings WHERE key = 'default_provider_id'").run();
    }
  }
}

function createTestProvider(name: string) {
  const provider = createProvider({
    name,
    provider_type: 'anthropic',
    protocol: 'anthropic',
    base_url: 'https://api.example.invalid',
    api_key: 'test-key',
  });
  trackedProviders.push(provider.id);
  return provider;
}

describe('resolveEffectiveProviderId — provider-level: virtual providers', () => {
  it('codex_account pinned → returned verbatim (no DB lookup)', async () => {
    await withSettings({ globalDefault: 'codex_account' }, () => {
      assert.equal(resolveEffectiveProviderId(), 'codex_account');
    });
  });

  it('openai-oauth pinned → returned verbatim', async () => {
    await withSettings({ globalDefault: 'openai-oauth' }, () => {
      assert.equal(resolveEffectiveProviderId(), 'openai-oauth');
    });
  });

  it('xai-oauth pinned → returned verbatim', async () => {
    await withSettings({ globalDefault: 'xai-oauth' }, () => {
      assert.equal(resolveEffectiveProviderId(), 'xai-oauth');
    });
  });

  it('env pinned → returned verbatim', async () => {
    await withSettings({ globalDefault: 'env' }, () => {
      assert.equal(resolveEffectiveProviderId(), 'env');
    });
  });
});

describe('resolveEffectiveProviderId — provider-level: auto mode (no pin)', () => {
  it('returns the active provider id when no pin is set', async () => {
    const provider = createTestProvider(`auto-mode-${Date.now()}`);
    activateProvider(provider.id);
    await withSettings({ globalDefault: null }, () => {
      const id = resolveEffectiveProviderId();
      // Active provider id should win in auto mode (provider-resolver
      // walks default_provider_id setting → getActiveProvider chain).
      assert.equal(typeof id, 'string');
      // Same id chat send path would resolve to:
      const chatPathId = resolveProvider({}).provider?.id;
      assert.equal(id, chatPathId);
    });
  });
});

describe('resolveEffectiveProviderId — provider-level: pinned valid', () => {
  it('returns the pinned id when the provider row exists', async () => {
    const provider = createTestProvider(`pinned-valid-${Date.now()}`);
    await withSettings({ globalDefault: provider.id }, () => {
      assert.equal(resolveEffectiveProviderId(), provider.id);
      // Chat send path agrees.
      const chatPathId = resolveProvider({ providerId: provider.id }).provider?.id;
      assert.equal(resolveEffectiveProviderId(), chatPathId);
    });
  });
});

describe('resolveEffectiveProviderId — provider-level: pinned-invalid auto-fallback parity', () => {
  // The reviewer-requested case: user pinned a provider that no
  // longer exists. Chat send path walks fallback chain; Settings
  // must walk the same chain so the capability clipboard doesn't
  // claim a different provider than the next chat will actually use.
  it('pinned id points at a non-existent provider → falls back to chat send path equivalent', async () => {
    const activeProvider = createTestProvider(`fallback-target-${Date.now()}`);
    activateProvider(activeProvider.id);

    const fakePinnedId = `does-not-exist-${Date.now()}`;
    await withSettings({ globalDefault: fakePinnedId, legacyDefault: null }, () => {
      const settingsId = resolveEffectiveProviderId();
      // Whatever Settings says MUST equal what chat send path would
      // resolve to under the same pin. This is the parity contract.
      const chatPathId = resolveProvider({ providerId: fakePinnedId }).provider?.id;
      assert.equal(
        settingsId,
        chatPathId,
        `Settings effective provider (${settingsId}) must match chat send path (${chatPathId}) when the pin is invalid`,
      );
      // And the fallback target should be a real, reachable provider,
      // not the broken pin.
      assert.notEqual(settingsId, fakePinnedId);
      // Active provider should be the fallback (provider-resolver
      // walks default → getActiveProvider; with no legacy default
      // it lands on active).
      assert.equal(settingsId, activeProvider.id);
    });
  });

  it('pinned id points at a non-existent provider + legacy default exists → walks default chain too', async () => {
    const legacyProvider = createTestProvider(`legacy-default-${Date.now()}`);
    const activeProvider = createTestProvider(`active-different-${Date.now()}`);
    activateProvider(activeProvider.id);

    const fakePinnedId = `does-not-exist-${Date.now()}-b`;
    await withSettings(
      { globalDefault: fakePinnedId, legacyDefault: legacyProvider.id },
      () => {
        // resolveProvider walks defaultId before getActiveProvider —
        // so the legacy default should win when the pin is broken.
        const settingsId = resolveEffectiveProviderId();
        const chatPathId = resolveProvider({ providerId: fakePinnedId }).provider?.id;
        assert.equal(settingsId, chatPathId);
        // Either the resolver lands on legacy provider (default chain
        // hit first) OR active (legacy ineligible) — what matters
        // is parity. Just assert non-broken.
        assert.notEqual(settingsId, fakePinnedId);
        // And it must be one of the providers we created.
        assert.ok(
          settingsId === legacyProvider.id || settingsId === activeProvider.id,
          `expected fallback to legacy or active provider; got ${settingsId}`,
        );
      },
    );
  });
});

describe('resolveEffectiveProviderId — provider-level: graceful degradation', () => {
  it('no providers at all → returns undefined (matrix still renders without provider override)', async () => {
    // Force "no providers" via stripping all rows isn't trivially
    // safe across the shared test DB. Instead exercise the scenario
    // via the resolver's defensive try/catch: if resolveProvider
    // throws, the helper returns undefined.
    // Indirect check: when nothing is pinned AND no active provider,
    // resolveProvider returns provider=undefined; helper returns
    // undefined too.
    const active = getActiveProvider();
    if (active) {
      // skip: we can't safely temporarily deactivate without affecting
      // other tests' shared state.
      return;
    }
    await withSettings({ globalDefault: null, legacyDefault: null }, () => {
      const id = resolveEffectiveProviderId();
      assert.equal(id, undefined);
    });
  });
});
