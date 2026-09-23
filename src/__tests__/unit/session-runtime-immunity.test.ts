/**
 * Phase 2 Step 1 — runtime/provider/model drift contract tests.
 *
 * What the user is afraid of:
 *   "我的旧会话，会不会因为我改了 Settings 里的全局默认就被偷偷换了引擎、
 *    服务商或模型？"
 *
 * Phase 2 promises that once a session has its own provider/model selection
 * (and eventually its own runtime), changing the global default WILL NOT
 * change what that session sends next.
 *
 * Step 1 doesn't yet implement session-level execution state. What it DOES
 * do is lock in the parts of the contract the resolver already gets right
 * (so a future refactor can't regress them) and stake out the gaps that
 * Step 2 must fill.
 *
 * Each block declares whether it's a:
 *   - GREEN  : current code already enforces this; we're guardrailing it.
 *              These pass today and must keep passing forever.
 *   - YELLOW : current code mostly enforces it but the resolver still has
 *              a gap (e.g. no invalid-session signal, no schema column for
 *              session-level runtime). Marked `{ todo: true }` and writes
 *              the **target-state** assertion — node:test runs the test
 *              and reports its failure as `# todo`, NOT `# skipped`, so
 *              the audit is visible without breaking CI. Step 2 lands the
 *              fix → assertion passes → Step 2's collation PR drops the
 *              `{ todo: true }` wrapper.
 *   - RED    : current code does NOT enforce this — a known hazardous
 *              pattern still ships. Same `{ todo: true }` + target-state
 *              shape: the test runs, fails-as-todo until Step 2 deletes
 *              the hazard, then flips to passing. Promote out of todo as
 *              part of Step 2 closeout.
 *
 * Cross-references:
 *   - `docs/exec-plans/active/refactor-closeout.md` Phase 2 Step 1
 *   - `src/__tests__/unit/provider-resolver.test.ts` (existing global-
 *     default tests — the immunity story below extends those).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  resolveProvider,
  resolveProviderForSession,
} from '../../lib/provider-resolver';
import { resolveRuntimeForSession, getActiveChatRuntime } from '../../lib/chat-runtime';
import {
  getSetting,
  setSetting,
  createProvider,
  updateProvider,
  deleteProvider,
  activateProvider,
  getActiveProvider,
  getDb,
  getProviderSecretErrorCode,
} from '../../lib/db';

// ────────────────────────────────────────────────────────────────
// GREEN — resolver already gives session state priority over global
// default. We pin these so a refactor can't quietly invert the order.
// ────────────────────────────────────────────────────────────────

describe('GREEN — existing-session immunity to global model drift', () => {
  // Two-line save/restore around each test so other tests in the suite
  // don't see leaked global_default_* values.
  let savedModel: string | null | undefined;
  let savedProvider: string | null | undefined;
  let savedDefaultModel: string | null | undefined;
  const setup = () => {
    savedModel = getSetting('global_default_model');
    savedProvider = getSetting('global_default_model_provider');
    savedDefaultModel = getSetting('default_model');
  };
  const teardown = () => {
    setSetting('global_default_model', savedModel || '');
    setSetting('global_default_model_provider', savedProvider || '');
    setSetting('default_model', savedDefaultModel || '');
  };

  it('global_default_model change does not move a session that already pinned its own model', () => {
    setup();
    try {
      // Initial state: user set global default to opus.
      setSetting('global_default_model', 'opus');
      setSetting('global_default_model_provider', 'env');

      // Session was created earlier with sonnet pinned to it.
      const before = resolveProvider({ providerId: 'env', sessionModel: 'sonnet' });
      assert.equal(before.model, 'sonnet', 'session should resolve to its own pinned model');

      // User flips the global default to haiku in Settings.
      setSetting('global_default_model', 'haiku');

      // Same session — same call shape — must still resolve to sonnet.
      // This is the headline immunity story.
      const after = resolveProvider({ providerId: 'env', sessionModel: 'sonnet' });
      assert.equal(after.model, 'sonnet',
        'session pinned model must NOT be replaced by the new global default');
      assert.equal(after.model, before.model,
        'before/after must agree — global mutation cannot leak into resolver output');
    } finally {
      teardown();
    }
  });

  it('legacy `default_model` setting change does not move a session with its own model', () => {
    setup();
    try {
      // The legacy single-key default (pre-2C contract) still feeds the
      // resolver as a low-priority fallback. Sessions with their own
      // sessionModel must still beat it.
      setSetting('default_model', 'haiku');
      const before = resolveProvider({ providerId: 'env', sessionModel: 'sonnet' });
      assert.equal(before.model, 'sonnet');

      setSetting('default_model', 'opus');
      const after = resolveProvider({ providerId: 'env', sessionModel: 'sonnet' });
      assert.equal(after.model, 'sonnet',
        'legacy default_model is a fallback, never an override of sessionModel');
    } finally {
      teardown();
    }
  });

  it('explicit per-message model beats both session and global', () => {
    setup();
    try {
      setSetting('global_default_model', 'opus');
      setSetting('global_default_model_provider', 'env');

      // User clicks the chat composer model picker and sends with haiku
      // for this one message. Session model is sonnet; global is opus.
      // Per-message wins.
      const r = resolveProvider({ providerId: 'env', sessionModel: 'sonnet', model: 'haiku' });
      assert.equal(r.model, 'haiku',
        'opts.model is highest priority — user picked it deliberately');
    } finally {
      teardown();
    }
  });
});

describe('GREEN — existing-session immunity to cross-provider global pinning', () => {
  let savedModel: string | null | undefined;
  let savedProvider: string | null | undefined;
  const setup = () => {
    savedModel = getSetting('global_default_model');
    savedProvider = getSetting('global_default_model_provider');
  };
  const teardown = () => {
    setSetting('global_default_model', savedModel || '');
    setSetting('global_default_model_provider', savedProvider || '');
  };

  it('global pin pointing at provider X does not affect a session pinned to provider Y', () => {
    setup();
    // Create a real DB provider so the resolver has something to resolve
    // against — the global pin will be aimed elsewhere.
    const sessionProvider = createProvider({
      name: '__test_session_immunity_session__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'test-key',
      role_models_json: JSON.stringify({ default: 'sonnet' }),
    });
    const otherProvider = createProvider({
      name: '__test_session_immunity_other__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'test-key',
    });
    try {
      // User pinned the OTHER provider globally (e.g. they made it the
      // new-chat default in Settings → Models).
      setSetting('global_default_model', 'cross-provider-model');
      setSetting('global_default_model_provider', otherProvider.id);

      // Session is on `sessionProvider` with its own session model.
      const r = resolveProvider({
        providerId: sessionProvider.id,
        sessionModel: 'sonnet',
      });
      // The cross-provider global default must not leak into this session.
      assert.notEqual(r.model, 'cross-provider-model',
        'cross-provider global pin must not leak into a different session');
      assert.equal(r.model, 'sonnet', 'session should keep its own model');
    } finally {
      deleteProvider(sessionProvider.id);
      deleteProvider(otherProvider.id);
      teardown();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// YELLOW — invalid-default surfacing. Phase 2C already covers the
// new-chat case via `resolveNewChatDefault`. The piece Phase 2 has
// to add: existing sessions whose stored provider was deleted must
// not silently re-point — they must surface as invalid.
// ────────────────────────────────────────────────────────────────

describe('YELLOW — provider deletion + existing session: must not silently fall back', () => {
  let savedModel: string | null | undefined;
  let savedProvider: string | null | undefined;
  const setup = () => {
    savedModel = getSetting('global_default_model');
    savedProvider = getSetting('global_default_model_provider');
  };
  const teardown = () => {
    setSetting('global_default_model', savedModel || '');
    setSetting('global_default_model_provider', savedProvider || '');
  };

  it('resolveProviderForSession surfaces invalidReason="provider-missing" when the session points at a deleted provider', () => {
    setup();
    try {
      const ghostId = '__deleted_provider_ghost_id__';
      // Phase 2 Step 2: the session-aware wrapper detects that the
      // stored provider id no longer exists in the DB and surfaces
      // `invalidReason: 'provider-missing'` instead of silently
      // routing through env. Routes can now block the send and the
      // UI can show "this session's provider is gone — pick a new one"
      // instead of executing under a substitute the user never asked
      // for. (`resolveProvider` directly is unchanged — legacy paths
      // that want silent env fallback keep their behavior; only
      // session-scoped consumers see the new signal.)
      const r = resolveProviderForSession({
        provider_id: ghostId,
        model: 'sonnet',
      });
      assert.equal(r.invalidReason, 'provider-missing',
        'session-aware wrapper must flag the deleted provider, not silent-substitute');
      // Sanity: the wrapper still returns a usable ResolvedProvider
      // shape so destructuring callers don't crash before they read
      // the new field. Provider should be the env-fallback shape (or
      // undefined), not the requested ghost id.
      assert.notEqual(r.provider?.id, ghostId);
    } finally {
      teardown();
    }
  });

  it('resolveProviderForSession does NOT flag invalid when session points at a real provider', () => {
    setup();
    const previousActive = getActiveProvider();
    const provider = createProvider({
      name: '__test_session_provider__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'test-key',
    });
    // The legacy resolver treats sessionProviderId as non-explicit and
    // skips inactive providers (a stale-deactivated-provider fallback).
    // Real session-pinned providers are always active in production —
    // activate ours so the resolver follows the live-provider path the
    // wrapper is being tested against.
    activateProvider(provider.id);
    try {
      const r = resolveProviderForSession({
        provider_id: provider.id,
        model: 'sonnet',
      });
      assert.equal(r.invalidReason, undefined,
        'healthy session must not carry an invalid signal');
      assert.equal(r.provider?.id, provider.id);
      assert.equal(r.model, 'sonnet');
    } finally {
      deleteProvider(provider.id);
      if (previousActive) activateProvider(previousActive.id);
      teardown();
    }
  });

  it('fails closed when the selected provider secret cannot be decrypted', () => {
    setup();
    const previousActive = getActiveProvider();
    const id = `__unreadable_provider_secret_${Date.now()}__`;
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO api_providers
        (id, name, provider_type, preset_key, protocol, base_url, api_key,
         api_key_ciphertext, api_key_storage, is_active, sort_order, extra_env,
         headers_json, env_overrides_json, role_models_json, options_json, notes,
         created_at, updated_at)
      VALUES (?, 'Unreadable GLM', 'anthropic', 'glm-cn', 'anthropic',
              'https://open.bigmodel.cn/api/anthropic', '',
              'cpsec:v1:not-a-valid-envelope', 'safe_storage:macos_keychain',
              1, 0, '{}', '{}', '{}', '{}', '{}', '', ?, ?)
    `).run(id, now, now);

    try {
      const resolved = resolveProviderForSession({
        provider_id: id,
        model: 'sonnet',
        requestProviderId: id,
        requestModel: 'sonnet',
      });
      assert.equal(resolved.provider?.id, id);
      assert.equal(resolved.hasCredentials, false);
      assert.equal(
        resolved.invalidReason,
        'credentials-unreadable',
        'an inaccessible selected secret must stop before any ambient Claude OAuth/env fallback',
      );

      // Legacy sessions can carry provider_id='' before lazy seeding. Their
      // final destination comes from the global default/active provider and
      // must hit the same pre-persistence credential gate.
      setSetting('global_default_model_provider', id);
      const fallbackResolved = resolveProviderForSession({
        provider_id: '',
        model: 'sonnet',
      });
      assert.equal(fallbackResolved.provider?.id, id);
      assert.equal(
        fallbackResolved.invalidReason,
        'credentials-unreadable',
        'an unreadable default/active provider must be rejected before the chat route records the message',
      );
    } finally {
      deleteProvider(id);
      if (previousActive) activateProvider(previousActive.id);
      teardown();
    }
  });

  it('classifies an empty selected provider as credentials-missing', () => {
    setup();
    const previousActive = getActiveProvider();
    const provider = createProvider({
      name: '__missing_provider_secret__',
      provider_type: 'anthropic',
      base_url: 'https://open.bigmodel.cn/api/anthropic',
      api_key: '',
    });
    activateProvider(provider.id);
    try {
      const resolved = resolveProviderForSession({
        provider_id: provider.id,
        model: 'sonnet',
        requestProviderId: provider.id,
        requestModel: 'sonnet',
      });
      assert.equal(resolved.provider?.id, provider.id);
      assert.equal(resolved.hasCredentials, false);
      assert.equal(resolved.invalidReason, 'credentials-missing');
    } finally {
      deleteProvider(provider.id);
      if (previousActive) activateProvider(previousActive.id);
      teardown();
    }
  });

  it('clears a stale decrypt error after the user explicitly clears the key', () => {
    setup();
    const previousActive = getActiveProvider();
    const id = `__cleared_provider_secret_${Date.now()}__`;
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO api_providers
        (id, name, provider_type, preset_key, protocol, base_url, api_key,
         api_key_ciphertext, api_key_storage, is_active, sort_order, extra_env,
         headers_json, env_overrides_json, role_models_json, options_json, notes,
         created_at, updated_at)
      VALUES (?, 'Cleared GLM', 'anthropic', 'glm-cn', 'anthropic',
              'https://open.bigmodel.cn/api/anthropic', '',
              'cpsec:v1:not-a-valid-envelope', 'safe_storage:macos_keychain',
              1, 0, '{}', '{}', '{}', '{}', '{}', '', ?, ?)
    `).run(id, now, now);

    try {
      const before = resolveProviderForSession({ provider_id: id, model: 'sonnet' });
      assert.equal(before.invalidReason, 'credentials-unreadable');
      assert.ok(getProviderSecretErrorCode(id));

      updateProvider(id, { api_key: '' });

      assert.equal(getProviderSecretErrorCode(id), null);
      const after = resolveProviderForSession({ provider_id: id, model: 'sonnet' });
      assert.equal(after.invalidReason, 'credentials-missing');
    } finally {
      deleteProvider(id);
      if (previousActive) activateProvider(previousActive.id);
      teardown();
    }
  });

  it('resolveProviderForSession does NOT bypass invalid check when request body simply echoes the deleted session provider (Step 2 review)', () => {
    setup();
    try {
      // Realistic Step 3 wire: ChatView sends `provider_id` on every
      // request, value = session.provider_id, even when the user did
      // not explicitly switch providers. If that "echo" were treated
      // as an explicit override, a deleted session provider would
      // slip past `provider-missing` detection and route through env
      // — exactly the silent fallback Phase 2 wants to eliminate.
      // The wrapper must validate the *effective* destination (which
      // is the same id either way) and still flag invalid here.
      const ghostId = '__deleted_provider_ghost_id__';
      const r = resolveProviderForSession({
        provider_id: ghostId,
        model: 'sonnet',
        requestProviderId: ghostId,    // body echoes the same dead id
        requestModel: 'sonnet',
      });
      assert.equal(r.invalidReason, 'provider-missing',
        'request body echo of session.provider_id must NOT bypass the deleted-provider check');
    } finally {
      teardown();
    }
  });

  it('resolveProviderForSession flags invalid when an EXPLICIT override points at a deleted provider too', () => {
    setup();
    const previousActive = getActiveProvider();
    const provider = createProvider({
      name: '__test_session_alive__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'test-key',
    });
    activateProvider(provider.id);
    try {
      // Session is healthy, but the user-supplied override points at a
      // ghost id (UI bug, race with delete, hand-crafted API call).
      // The wrapper validates the *effective* destination, so the
      // override's deleted state is the one that should fire — fail
      // closed instead of routing through env.
      const r = resolveProviderForSession({
        provider_id: provider.id,                            // session healthy
        model: 'sonnet',
        requestProviderId: '__deleted_provider_ghost_id__',  // override dead
      });
      assert.equal(r.invalidReason, 'provider-missing',
        'an explicit override pointing at a deleted provider must also flag invalid');
    } finally {
      deleteProvider(provider.id);
      if (previousActive) activateProvider(previousActive.id);
      teardown();
    }
  });

  it('resolveProviderForSession trusts an explicit per-message providerId override (request body)', () => {
    setup();
    const previousActive = getActiveProvider();
    const provider = createProvider({
      name: '__test_session_override__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'test-key',
    });
    activateProvider(provider.id);
    try {
      // Session was committed to a deleted provider, BUT the user
      // just picked a real one in the composer. Per-message intent
      // wins; no invalid flag should fire.
      const r = resolveProviderForSession({
        provider_id: '__deleted_provider_ghost_id__',
        model: 'sonnet',
        requestProviderId: provider.id,
      });
      assert.equal(r.invalidReason, undefined,
        'request-side override must not trigger the session-level invalid flag');
      assert.equal(r.provider?.id, provider.id);
    } finally {
      deleteProvider(provider.id);
      if (previousActive) activateProvider(previousActive.id);
      teardown();
    }
  });

  it('chat_sessions schema: runtime_pin column exists (Phase 2 Step 2)', () => {
    // Phase 2 Step 2: chat_sessions carries a session-level runtime
    // pin column so a session can survive global-default changes
    // without re-resolving via the global `agent_runtime` setting.
    const dbSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lib', 'db.ts'),
      'utf8',
    );
    // Sanity: Phase 1's provider_id / model migrations must still be
    // here. These are regression guards.
    assert.match(dbSrc, /chat_sessions ADD COLUMN provider_id/,
      'Phase 1 provider_id migration should still be present');
    assert.match(dbSrc, /chat_sessions[\s\S]*?\bmodel\s+TEXT/,
      'chat_sessions should still carry the per-session model column');
    // Step 2 contract: runtime_pin migration shipped.
    assert.match(dbSrc, /chat_sessions ADD COLUMN runtime_pin/,
      'Phase 2 Step 2: chat_sessions must carry a runtime_pin column');
  });
});

// ────────────────────────────────────────────────────────────────
// GREEN — Phase 2 Step 2 wrapper contract for runtime resolution.
//
// `resolveRuntimeForSession({ runtime_pin })` is the read side of the
// new column. Once Step 3+ migrates streamClaude / chat-route /
// useProviderModels off `getActiveChatRuntime()` (no args) and onto
// this wrapper, sessions with a pinned runtime are immune to global
// `agent_runtime` flips — which is the headline user-facing promise
// of Phase 2.
// ────────────────────────────────────────────────────────────────

describe('GREEN — resolveRuntimeForSession honours session.runtime_pin', () => {
  // Save / restore the global agent_runtime setting so the cross-test
  // mutations below don't leak.
  let savedAgentRuntime: string | null | undefined;
  const setup = () => { savedAgentRuntime = getSetting('agent_runtime'); };
  const teardown = () => { setSetting('agent_runtime', savedAgentRuntime || ''); };

  it('empty pin → falls through to global getActiveChatRuntime()', () => {
    setup();
    try {
      // Empty pin means "no per-session commitment, follow global".
      // Whatever the global resolver returns, the wrapper agrees.
      const fromWrapper = resolveRuntimeForSession({ runtime_pin: '' });
      const fromGlobal = getActiveChatRuntime();
      assert.equal(fromWrapper, fromGlobal,
        'session with no pin must agree with the global resolver');
    } finally {
      teardown();
    }
  });

  it('pin="claude_code" wins over the global setting (immunity headline)', () => {
    setup();
    try {
      // Session is pinned to Claude Code. Even if the user just
      // flipped the global setting to native, the wrapper must
      // return the session's commitment.
      setSetting('agent_runtime', 'native');
      const r = resolveRuntimeForSession({ runtime_pin: 'claude_code' });
      assert.equal(r, 'claude_code',
        'session pin wins over global agent_runtime — this is the whole point of Step 2');
    } finally {
      teardown();
    }
  });

  it('pin="codepilot_runtime" wins over the global setting', () => {
    setup();
    try {
      setSetting('agent_runtime', 'claude-code-sdk');
      const r = resolveRuntimeForSession({ runtime_pin: 'codepilot_runtime' });
      assert.equal(r, 'codepilot_runtime');
    } finally {
      teardown();
    }
  });

  it('unknown pin value (legacy / corrupt row) → falls through to global', () => {
    setup();
    try {
      // Defensive: if some legacy row has e.g. `runtime_pin = 'auto'`
      // or `'sdk'`, the wrapper must NOT return that opaque value.
      // Fall through to the global resolver instead.
      const r = resolveRuntimeForSession({ runtime_pin: 'auto' as string });
      const expected = getActiveChatRuntime();
      assert.equal(r, expected);
    } finally {
      teardown();
    }
  });

  it('undefined runtime_pin (e.g. session record before column shipped) → falls through to global', () => {
    // Defensive against `getSession()` returning a row whose
    // runtime_pin field is somehow undefined (legacy migration race,
    // partial mock object). The wrapper must not throw.
    setup();
    try {
      const r = resolveRuntimeForSession({});
      const expected = getActiveChatRuntime();
      assert.equal(r, expected);
    } finally {
      teardown();
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // Phase 5e round 8 (2026-05-18) — session pin priority over
  // cli_enabled=false. This was the user-reported P0:
  //   "global default is Codex or CodePilot (sets cli_enabled=false),
  //    but I pick Claude Code for one session via the composer; UI
  //    shows ClaudeCode but backend silently runs Native."
  // Regression pins live here AND in runtime-selection.test.ts (the
  // algorithm-level mirror). This block covers the chat-runtime wrapper
  // contract: resolveRuntimeForSession honors the pin verbatim no
  // matter what the global cli_enabled / agent_runtime look like.
  // ─────────────────────────────────────────────────────────────────

  it('pin=claude_code + cli_enabled=false (global default Codex/CodePilot) → claude_code (NOT codepilot_runtime)', () => {
    setup();
    const savedCli = getSetting('cli_enabled');
    try {
      setSetting('agent_runtime', 'codex_runtime');
      setSetting('cli_enabled', 'false');
      const r = resolveRuntimeForSession({ runtime_pin: 'claude_code' });
      assert.equal(
        r,
        'claude_code',
        'session pin must beat the global cli_enabled=false short-circuit — otherwise UI lies about which engine ran',
      );
    } finally {
      setSetting('cli_enabled', savedCli || '');
      teardown();
    }
  });

  it('pin=claude_code + global agent_runtime=native + cli_enabled=false → claude_code (compound immunity)', () => {
    // Same as above but also pins agent_runtime away from claude-code-sdk.
    // The session pin is the singular source of truth.
    setup();
    const savedCli = getSetting('cli_enabled');
    try {
      setSetting('agent_runtime', 'native');
      setSetting('cli_enabled', 'false');
      const r = resolveRuntimeForSession({ runtime_pin: 'claude_code' });
      assert.equal(r, 'claude_code');
    } finally {
      setSetting('cli_enabled', savedCli || '');
      teardown();
    }
  });

  it('pin=codepilot_runtime + cli_enabled=true + global=claude-code-sdk → codepilot_runtime (pin always wins)', () => {
    // Mirror image of the above — session pinned to Native, global
    // default is SDK. The pin still wins.
    setup();
    const savedCli = getSetting('cli_enabled');
    try {
      setSetting('agent_runtime', 'claude-code-sdk');
      setSetting('cli_enabled', 'true');
      const r = resolveRuntimeForSession({ runtime_pin: 'codepilot_runtime' });
      assert.equal(r, 'codepilot_runtime');
    } finally {
      setSetting('cli_enabled', savedCli || '');
      teardown();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// RED — known drift points the audit identified.
//
// Each case is marked `{ todo: true }` and asserts the **target
// state** (the hazardous pattern is gone). On Step 1 these fail-as-todo
// (the runner reports them as `# todo N`, NOT `# fail`); the suite
// stays green so legitimate regressions still show up. On Step 2,
// when the actual code is fixed, these flip to passing-but-still-
// marked-todo, signaling the Step 2 PR to drop the `{ todo: true }`
// wrapper and promote them to real assertions.
//
// Patterns are pinned to the **specific hazardous site** rather than
// any reference to the symbol — e.g. the ChatView case looks for the
// `providerWasFilteredOut → fetch PATCH` combo, not just the variable
// name (which can legitimately remain for a future invalid banner).
// Reviewer feedback (2026-05-06): "ok > 0" passing tests give a false
// "1537 green" sense of safety; flip to target-state + todo so the
// audit shows up as visibly pending.
//
// (Audit also flagged `lib/runtime/registry.ts:resolveRuntime` reading
// `agent_runtime`, but that's the chain root — Step 2's plan keeps it
// global-only and adds a session-aware caller wrapper higher up. So
// it's documented in the report but NOT a separate todo here.)
// ────────────────────────────────────────────────────────────────

describe('RED — known global-runtime hazard sites Phase 2 Step 2 must replace', () => {
  const repoRoot = path.join(__dirname, '..', '..');

  // Search the **whole file as a single string** — needed for cross-
  // line patterns like the providerWasFilteredOut → PATCH effect.
  // Returns whether the hazard pattern is present, plus a sample line
  // for the failure message so Step 2's PR diff is easy to spot.
  const findHazard = (
    file: string,
    needle: RegExp,
  ): { present: boolean; sample: string } => {
    const src = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    const m = src.match(needle);
    if (!m) return { present: false, sample: '' };
    const before = src.slice(0, m.index ?? 0);
    const lineNo = before.split('\n').length;
    return { present: true, sample: `${file}:${lineNo}  ${m[0].slice(0, 120)}` };
  };

  it('claude-client.streamClaude must NOT pass raw global agent_runtime to resolveRuntime (drift point #1)', () => {
    // Phase 2 Step 3a (2026-05-07): streamClaude now translates
    // `options.sessionRuntimePin` to the agent_runtime override and
    // only consults `getSetting('agent_runtime')` when the session
    // has no pin. The hazard pattern (raw `getSetting('agent_runtime')`
    // wrapped directly in `resolveRuntime(...)`) is gone.
    const h = findHazard(
      'lib/claude-client.ts',
      /resolveRuntime\(\s*getSetting\(['"]agent_runtime['"]\)/,
    );
    assert.equal(h.present, false,
      `streamClaude no longer reads agent_runtime directly. Found at ${h.sample}`);
  });

  it('chat route must NOT call getActiveChatRuntime() with no session arg (drift point #2)', () => {
    // Phase 2 Step 3a: chat route calls `resolveRuntimeForSession(session)`
    // instead. The bare-no-arg call form is gone.
    const h = findHazard(
      'app/api/chat/route.ts',
      /getActiveChatRuntime\(\s*\)/,
    );
    assert.equal(h.present, false,
      `chat route routes runtime through the session, not the global. Found at ${h.sample}`);
  });

  it('useProviderModels must NOT default runtime to "auto" (drift point #4)', () => {
    // Phase 2 Step 3b: signature is now `runtime: ChatRuntimeParam | null`
    // (required, no default). Every caller must pass the session's
    // pin explicitly via `chatRuntimeParamForSession(...)`, so a
    // global `agent_runtime` flip can't silently re-filter every
    // open chat.
    const h = findHazard(
      'hooks/useProviderModels.ts',
      /runtime\s*:\s*ChatRuntimeParam[^=\n]*=\s*['"]auto['"]/,
    );
    assert.equal(h.present, false,
      `useProviderModels no longer defaults to "auto". Found at ${h.sample}`);
  });

  it('chat route effectiveModel chain must NOT fall back to global default_model after session.model (drift point #5)', () => {
    // Phase 2 Step 3a: the `session.model || getSetting('default_model')`
    // fallback was removed. session.model is now lazy-seeded after
    // first send (chat route writes whatever the resolver picks back
    // to the session row), so subsequent sends never reach the global
    // fallback. The CLI-disabled escape-hatch read of `default_model`
    // for env-only models still exists in the file but doesn't match
    // this hazard pattern (different shape, different intent).
    const h = findHazard(
      'app/api/chat/route.ts',
      /session\.model\s*\|\|\s*getSetting\(\s*['"]default_model['"]\s*\)/,
    );
    assert.equal(h.present, false,
      `chat route uses session.model unconditionally (lazy-seeded), no global fallback. Found at ${h.sample}`);
  });

  it('ChatView must NOT silent-PATCH session provider on runtime filter mismatch (drift point #6)', () => {
    // Phase 2 Step 3b: the silent-PATCH effect was replaced with an
    // inline notice. ChatView still *reads* `providerWasFilteredOut`
    // to compute `sessionProviderRuntimeIncompatible` (and render
    // the notice), but the variable + a `/api/chat/sessions/${sessionId}`
    // + `method: 'PATCH'` combo is no longer present. The picker
    // already filters to runtime-compatible providers, so the user
    // can pick one in the composer; persistence goes through the
    // existing `onProviderModelChange` path on user action only.
    const h = findHazard(
      'components/chat/ChatView.tsx',
      /providerWasFilteredOut[\s\S]{0,800}\/api\/chat\/sessions\/\$\{sessionId\}[\s\S]{0,400}method:\s*['"]PATCH['"]/,
    );
    assert.equal(h.present, false,
      `providerWasFilteredOut no longer triggers a silent PATCH; user must opt in. Found at ${h.sample}`);
  });

  it('stream-session-manager dispatches typed event on 409 INVALID_SESSION_PROVIDER (Step 4b)', () => {
    // Phase 2 Step 4b: when the chat route returns 409 with
    // `code: 'INVALID_SESSION_PROVIDER'` (Step 3a contract — the
    // session's saved provider got deleted between page load and
    // send), the frontend stream manager must surface a typed event
    // ChatView listens for and renders an inline banner. Without
    // this, users only see a generic "Failed to send message" toast
    // that doesn't explain what to do.
    //
    // Keep it lightweight — assert the event-dispatch wire exists
    // alongside the existing NEEDS_PROVIDER_SETUP branch. Rendering
    // the banner is exercised in ChatView's static-source test below.
    const src = fs.readFileSync(
      path.join(repoRoot, 'lib/stream-session-manager.ts'),
      'utf8',
    );
    assert.match(
      src,
      /err\?\.code\s*===\s*['"]INVALID_SESSION_PROVIDER['"][\s\S]{0,400}new CustomEvent\(\s*['"]chat-invalid-session-provider['"]/,
      'stream-session-manager must dispatch chat-invalid-session-provider on 409 INVALID_SESSION_PROVIDER',
    );
  });

  it('ChatView listens for chat-invalid-session-provider event and clears on provider switch (Step 4b)', () => {
    // Three pieces must coexist for the banner to actually work:
    //   1. addEventListener('chat-invalid-session-provider', …)
    //   2. some state setter for the banner (we use
    //      `setInvalidSessionProvider`)
    //   3. an effect that clears the banner when currentProviderId
    //      changes (so picking a new provider hides it without an
    //      explicit dismiss button)
    const src = fs.readFileSync(
      path.join(repoRoot, 'components/chat/ChatView.tsx'),
      'utf8',
    );
    assert.match(
      src,
      /addEventListener\(\s*['"]chat-invalid-session-provider['"]/,
      'ChatView must listen for chat-invalid-session-provider window event',
    );
    assert.match(
      src,
      /setInvalidSessionProvider\(\s*null\s*\)/,
      'ChatView must clear the banner state — likely when the user picks a new provider',
    );
  });

  it('credential failures expose a localized provider-settings recovery path', () => {
    const route = fs.readFileSync(path.join(repoRoot, 'app/api/chat/route.ts'), 'utf8');
    const chatView = fs.readFileSync(path.join(repoRoot, 'components/chat/ChatView.tsx'), 'utf8');
    const newChat = fs.readFileSync(path.join(repoRoot, 'app/chat/page.tsx'), 'utf8');
    const en = fs.readFileSync(path.join(repoRoot, 'i18n/en.ts'), 'utf8');
    const zh = fs.readFileSync(path.join(repoRoot, 'i18n/zh.ts'), 'utf8');

    assert.match(route, /credentials-unreadable[\s\S]{0,300}credentials-missing/);
    assert.match(route, /sessionProviderId:\s*provider_id\s*\|\|\s*session\.provider_id/);
    for (const source of [chatView, newChat]) {
      assert.match(source, /chat\.providerCredentialsUnavailable\.message/);
      assert.match(source, /chat\.providerCredentialsUnreadable\.message/);
      assert.match(source, /\/settings\/providers/);
    }
    assert.match(newChat, /providerRecovery[\s\S]{0,160}error\.providerCredentialUnavailable/);
    assert.match(route, /credentials-unreadable[\s\S]{0,400}delete the old provider[\s\S]{0,200}same API key/);
    assert.match(en, /chat\.providerCredentialsUnavailable\.action/);
    assert.match(zh, /chat\.providerCredentialsUnavailable\.action/);
    assert.match(en, /providerCredentialsUnreadable[\s\S]{0,400}API key itself may still be valid[\s\S]{0,300}delete the old provider[\s\S]{0,200}same API key/);
    assert.match(zh, /providerCredentialsUnreadable[\s\S]{0,300}API Key 本身可能仍然有效[\s\S]{0,300}删除原来的服务商[\s\S]{0,200}同一个 API Key 重新添加/);
    assert.match(en, /providerCredentialsUnreadable[\s\S]{0,700}custom model settings/);
    assert.match(zh, /providerCredentialsUnreadable[\s\S]{0,700}自定义模型设置/);
  });

  it('stream-session-manager takes a silent error path for INVALID_SESSION_PROVIDER (Step 4b round 2)', () => {
    // Step 4b round 1 dispatched the typed window event but still
    // `throw new Error(...)` afterwards, which the catch block at the
    // bottom of the stream function turned into an `**Error:** ...`
    // assistant bubble in the transcript — on top of the red banner
    // ChatView already shows. Round 2 fix: tag the thrown Error with
    // `code` so the catch can branch on it, and skip the
    // `finalMessageContent` write when the code is INVALID_SESSION_PROVIDER.
    //
    // Two source-level invariants lock this in:
    //   1. !response.ok branch tags `code` onto the Error before throwing
    //   2. catch block reads `(error as ...).code` and uses it to gate
    //      `finalMessageContent` (so the snapshot stays empty for this code)
    const src = fs.readFileSync(
      path.join(repoRoot, 'lib/stream-session-manager.ts'),
      'utf8',
    );
    // (1) thrown Error carries `code`. We don't pin the exact cast
    // syntax — only that something assigns the backend `err.code`
    // (with or without optional chain) onto the Error before it's
    // thrown.
    assert.match(
      src,
      /\.code\s*=\s*err\??\.code/,
      'stream-session-manager must propagate the backend `code` field onto the thrown Error so the catch can branch on it',
    );
    // (2) catch block branches on the code and skips finalMessageContent.
    // Look for an inline ternary on `finalMessageContent` whose
    // condition references the code (we use `silentError` as the var,
    // but the regex stays loose enough to allow a rename).
    assert.match(
      src,
      /finalMessageContent:\s*\w+\s*\?\s*null\s*:\s*\w+\(/,
      'catch block must conditionally skip finalMessageContent for the silent-error code, not unconditionally write `**Error:** ...`',
    );
    // And the gate condition must reference INVALID_SESSION_PROVIDER —
    // future codes that should also be silent get added to the same
    // condition; future codes that shouldn't, don't.
    assert.match(
      src,
      /=== ['"]INVALID_SESSION_PROVIDER['"]/,
      'silent-error branch must gate on INVALID_SESSION_PROVIDER specifically (not a generic "any error code" fallback)',
    );
  });

  it('ChatView removes ONLY the current optimistic user message on chat-invalid-session-provider (Step 4b round 3)', () => {
    // The chat route's early gate for invalid session provider runs
    // BEFORE `addMessage`, so the user turn never lands in the DB. But
    // `sendMessage` in ChatView appends an optimistic `temp-${Date.now()}`
    // bubble to local state right before calling `doStartStream` — if
    // the 409 fires, the optimistic bubble has nothing to be reconciled
    // against and just sits in the transcript as a phantom turn.
    //
    // Round 2 cleared this with a broad `id.startsWith('temp-')` filter,
    // but earlier successful turns also keep their temp-* ids until the
    // page reloads (the temp → DB id swap doesn't happen mid-session),
    // so the broad filter would wipe history alongside the failed turn.
    //
    // Round 3 fix: track the just-pushed id in a ref
    // (`pendingOptimisticUserIdRef`) and remove **only** that one id on
    // 409. Three invariants must coexist:
    //   1. The ref is declared
    //   2. sendMessage / dequeue assign the freshly-created
    //      `userMessage.id` to the ref before calling doStartStream
    //   3. The 409 handler reads the ref and filters by exact id (not
    //      a prefix)
    const src = fs.readFileSync(
      path.join(repoRoot, 'components/chat/ChatView.tsx'),
      'utf8',
    );
    assert.match(
      src,
      /pendingOptimisticUserIdRef\s*=\s*useRef</,
      'ChatView must declare pendingOptimisticUserIdRef so the 409 handler can target a single id, not broad-filter all temp-* messages',
    );
    assert.match(
      src,
      /pendingOptimisticUserIdRef\.current\s*=\s*userMessage\.id/,
      'sendMessage / dequeue must record the freshly-created optimistic message id into the ref before starting the stream',
    );
    // The 409 handler reads the ref and runs a filter that compares
    // by exact id — match a setMessages-style filter referencing
    // `pendingOptimisticUserIdRef.current` (or a local `pendingId`
    // variable derived from it) and `m.id !==`.
    assert.match(
      src,
      /pendingOptimisticUserIdRef\.current[\s\S]{0,400}m\.id\s*!==/,
      'chat-invalid-session-provider handler must remove ONLY the message whose id matches the ref — not broad-filter every temp-* user message',
    );
  });

  it('chat route binds the Runtime owner before first manual execution and fails closed for background turns', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'app/api/chat/route.ts'),
      'utf8',
    );
    assert.match(
      src,
      /decideExecutionBinding\([\s\S]{0,300}autoTrigger\s*\?\s*'auto'\s*:\s*'manual'[\s\S]{0,500}!bindingDecision\.ok/,
      'chat route must run the owner decision and reject a disallowed automatic execution.',
    );
    assert.match(
      src,
      /bindSessionForExecution\([\s\S]{0,500}expectedRouteRevision/,
      'first manual execution must bind through the route-revision CAS before provider execution.',
    );
    assert.doesNotMatch(
      src,
      /updateSessionRuntime\(/,
      'execution must not use the legacy split runtime_pin write.',
    );
  });

  it('ChatView must HARD-block send when sessionProviderRuntimeIncompatible (Step 3b review)', () => {
    // Step 3b round 1 left a hole: the inline notice was rendered but
    // the send pipe wasn't gated, so a user who clicked send instead
    // of using the picker would have the runtime-filtered fallback
    // sent as `provider_id` / `model` and the chat route's lazy-seed
    // would persist them — the silent rewrite the inline notice was
    // supposed to prevent, just at a different layer.
    //
    // The fix requires TWO things: (a) `doStartStream` early-returns
    // when the flag is true, (b) MessageInput's `disabled` prop
    // includes the flag so the send button is visibly blocked. This
    // test checks both are present in the source — if either gets
    // removed in a future refactor, the gate has a hole.
    const src = fs.readFileSync(
      path.join(repoRoot, 'components/chat/ChatView.tsx'),
      'utf8',
    );
    // (a) early-return guard inside doStartStream / startStream.
    // Multi-line regex: any `if (sessionProviderRuntimeIncompatible)`
    // followed shortly by `return`.
    assert.match(
      src,
      /if\s*\(\s*sessionProviderRuntimeIncompatible\s*\)\s*\{[\s\S]{0,200}return\b/,
      'doStartStream must hard-block when the saved provider is runtime-incompatible — sending the fallback would re-introduce the silent rewrite at the wire layer',
    );
    // (b) MessageInput disabled prop includes the flag.
    assert.match(
      src,
      /disabled\s*=\s*\{[\s\S]{0,200}sessionProviderRuntimeIncompatible[\s\S]{0,200}\}/,
      'MessageInput disabled prop must include sessionProviderRuntimeIncompatible so the send button is visibly blocked',
    );
    // (c) Every useCallback / useEffect that reads
    // `sessionProviderRuntimeIncompatible` for control flow MUST list
    // it as a dependency — otherwise the closure can hold a stale
    // value across runtime/provider state changes and either fail to
    // block (when the flag flipped to true after capture) or fail to
    // recover (when it flipped to false). Round-4 review caught
    // doStartStream missing this.
    //
    // Counting the flag inside dep arrays is the cheapest robust
    // approximation: dep arrays are flat identifier lists with no
    // nested brackets, so `\[[^\[\]]*flag[^\[\]]*\]` reliably matches
    // each one without false-positives from JSX or array literals in
    // bodies. We expect at least 3 occurrences (doStartStream +
    // sendMessage + dequeue effect). If the count drops, some hook's
    // dep got pruned and the closure goes stale.
    const flagDepListings = src.match(/\[[^\[\]]*sessionProviderRuntimeIncompatible[^\[\]]*\]/g) ?? [];
    assert.ok(
      flagDepListings.length >= 3,
      `expected sessionProviderRuntimeIncompatible to appear in at least 3 hook dep arrays (doStartStream + sendMessage + dequeue) — found ${flagDepListings.length}. A pruned dep makes the closure capture a stale value.`,
    );
  });

  it('every optimistic-bubble push site is preceded by the runtime-incompatible guard (Step 4b round 4)', () => {
    // Round 3 narrowed the ghost-message removal to a single tracked
    // id, but the underlying problem is still avoidable up-front: any
    // path that pushes an optimistic `temp-*` user message and then
    // hands off to `doStartStream` must FIRST check
    // `sessionProviderRuntimeIncompatible`. If it doesn't, doStartStream's
    // own Guard 4 catches the send but the bubble is already in the
    // transcript — same ghost shape.
    //
    // Two paths can push optimistic bubbles: `sendMessage` (the user's
    // direct send / autoTrigger / widget bridge) and the message-queue
    // dequeue effect (queued sends after streaming finishes). Both
    // assign the freshly-created `userMessage.id` to
    // `pendingOptimisticUserIdRef.current` — that line is therefore a
    // reliable anchor for "an optimistic bubble is about to be pushed".
    //
    // Lock both paths: for *every* `pendingOptimisticUserIdRef.current = userMessage.id`
    // assignment in the file, the preceding ~4000 chars (one logical
    // function/effect body — sendMessage's is ~50 lines, dequeue's ~25)
    // must contain an `if (sessionProviderRuntimeIncompatible) … return`
    // early-out. Future refactors that add another optimistic push path
    // inherit the same contract automatically.
    const src = fs.readFileSync(
      path.join(repoRoot, 'components/chat/ChatView.tsx'),
      'utf8',
    );
    const pushSites = [...src.matchAll(/pendingOptimisticUserIdRef\.current\s*=\s*userMessage\.id/g)];
    assert.ok(
      pushSites.length >= 2,
      `expected at least 2 optimistic-id push sites (sendMessage + dequeue) — found ${pushSites.length}. If the count dropped, the round-3 round-4 contract may have regressed.`,
    );
    for (const m of pushSites) {
      const before = src.slice(Math.max(0, (m.index ?? 0) - 4000), m.index ?? 0);
      assert.match(
        before,
        /if\s*\(\s*sessionProviderRuntimeIncompatible\s*\)\s*\{[\s\S]{0,200}return\b/,
        `optimistic-id push at character ${m.index} is missing a preceding sessionProviderRuntimeIncompatible early-return — would let a queued / autoTrigger / widget send leave a ghost bubble`,
      );
    }
  });

  it('route identity changes use the atomic CAS endpoint; legacy PATCH rejects split writes', () => {
    const legacySrc = fs.readFileSync(
      path.join(repoRoot, 'app/api/chat/sessions/[id]/route.ts'),
      'utf8',
    );
    assert.match(
      legacySrc,
      /body\.runtime_pin[\s\S]{0,500}ATOMIC_ROUTE_REQUIRED/,
      'legacy session PATCH must reject runtime/provider/model writes before applying anything.',
    );
    const atomicSrc = fs.readFileSync(
      path.join(repoRoot, 'app/api/chat/sessions/[id]/route/route.ts'),
      'utf8',
    );
    assert.match(atomicSrc, /expected_route_revision/,
      'atomic route endpoint must require the caller\'s expected route revision.');
    assert.match(atomicSrc, /updateSessionRouteCas\(/,
      'atomic route endpoint must apply the three-part route through one CAS mutation.');
    assert.match(atomicSrc, /RUNTIME_OWNERSHIP_CONFLICT/,
      'a bound cross-Runtime mutation must be rejected and redirected to handoff.');
  });

  it('new-chat default-resolver is runtime-reactive, not pinned to mount-time auto (Step 4c round 1)', () => {
    // Round-1 review caught: the validation effects in `app/chat/page.tsx`
    // hardcoded `?runtime=auto` and ran with empty deps `[]`, so flipping
    // the RuntimeSelector updated only the picker hook; `invalidDefault`
    // / `noCompatibleProvider` / `checkpointReasons` stayed frozen at
    // mount-time runtime, leaving the red RunCheckpoint up and the input
    // disabled even after the model picker had already corrected itself.
    //
    // The fix is two invariants that must coexist forever:
    //   (a) NO `runtime=auto` literal in the file — the URL must
    //       interpolate the session runtime param so the right runtime
    //       feeds back into the resolver.
    //   (b) Every effect that consumes that URL must list
    //       `sessionRuntimeParam` in its dep array, otherwise the
    //       runtime swap never re-fires the validator.
    const src = fs.readFileSync(
      path.join(repoRoot, 'app/chat/page.tsx'),
      'utf8',
    );
    assert.ok(
      !/runtime=auto/.test(src),
      'app/chat/page.tsx must not hardcode `runtime=auto` — use `${sessionRuntimeParam}` so RuntimeSelector flips re-fire the default resolver',
    );
    // Also assert the runtime-aware URL exists — protects against future
    // refactors that delete the call entirely (which would mask the
    // hardcode-removal as "passing").
    assert.match(
      src,
      /\/api\/providers\/models\?runtime=\$\{sessionRuntimeParam\}/,
      'default-resolver fetch must template the session runtime param into the URL',
    );
    // Find every useEffect block whose body references the templated URL,
    // and require `sessionRuntimeParam` in its dep array. The body span
    // we look back over is generous (~6000 chars) to cover both effects'
    // full Promise.all chains.
    const fetchSites = [...src.matchAll(/\/api\/providers\/models\?runtime=\$\{sessionRuntimeParam\}/g)];
    assert.ok(fetchSites.length >= 2, `expected at least 2 runtime-aware fetch sites in chat/page.tsx (initial-load + provider-changed listener) — found ${fetchSites.length}`);
    for (const m of fetchSites) {
      const after = src.slice(m.index ?? 0, (m.index ?? 0) + 6000);
      assert.match(
        after,
        /\}\s*,\s*\[[^\[\]]*sessionRuntimeParam[^\[\]]*\]/,
        `useEffect using sessionRuntimeParam URL at ${m.index} must list sessionRuntimeParam in its deps — empty deps freeze the resolver at mount-time runtime`,
      );
    }
  });

  it('explicit runtimePin keeps the resolver effect runtime-aware on /chat (Step 4c round 2)', () => {
    // Round-2 originally caught: switching RuntimeSelector to a runtime
    // where the picker auto-resolves a valid pair STILL kept the red
    // RunCheckpoint up + composer disabled, because the page OR'd
    // `overview.defaultInvalid` (a global stat about the global pin)
    // into the checkpoint and unconditionally fed `mode: 'pinned'` to
    // the resolver under explicit override.
    //
    // 2026-05-09 second cut: the second prong (`overview.defaultInvalid`
    // OR-in) and `runtimeFallback` suppression were both retired by
    // dropping `useOverviewData()` from chat entries entirely — the
    // `chat-static-graph.test.ts` contract now forbids reaching it.
    // The bug they guarded against can't recur because the global
    // signals are no longer in the chat first-paint graph.
    //
    // What still matters is the resolver effect's mode override: every
    // place that feeds `mode:` into `resolveNewChatDefault` must branch
    // on `runtimePin` so pinned semantics only apply under follow-default.
    const stripComments = (s: string) =>
      s.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

    const rawPage = fs.readFileSync(
      path.join(repoRoot, 'app/chat/page.tsx'),
      'utf8',
    );
    const pageCode = stripComments(rawPage);
    const modeAssignments = [...pageCode.matchAll(/effectiveMode[\s\S]{0,200}runtimePin/g)];
    assert.ok(
      modeAssignments.length >= 2,
      `expected ≥2 effectiveMode derivations branching on runtimePin (initial-load + provider-changed) — found ${modeAssignments.length}`,
    );

    // chat/page.tsx must NOT touch overview.defaultInvalid in runtime
    // code. Earlier rounds carried a "(!overrideGlobalPinnedGate &&
    // overview.defaultInvalid)" guard; the new contract is "overview
    // doesn't reach this file at all". JSDoc that explains the history
    // is stripped before checking — only runtime references count.
    assert.doesNotMatch(
      pageCode,
      /overview\.defaultInvalid/,
      'chat/page.tsx must not read overview.defaultInvalid — RunCheckpoint here is session-scoped, global pinned-invalid lives in /settings',
    );
    assert.doesNotMatch(
      pageCode,
      /\bruntimeFallback\b/,
      'chat/page.tsx must not compute runtimeFallback — runtime-fallback notice is global health, not session blocking',
    );

    // Same guard for the existing-session path.
    const rawView = fs.readFileSync(
      path.join(repoRoot, 'components/chat/ChatView.tsx'),
      'utf8',
    );
    const viewCode = stripComments(rawView);
    assert.doesNotMatch(
      viewCode,
      /overview\.defaultInvalid/,
      'ChatView must not read overview.defaultInvalid — global pinned-invalid is not relevant to a saved session',
    );
    assert.doesNotMatch(
      viewCode,
      /\bruntimeFallback\b/,
      'ChatView must not compute runtimeFallback — runtime-fallback notice is global health, not session blocking',
    );
  });

  it('RunCockpit honors session runtime override and is wired by both call sites (Step 4c round 4)', () => {
    // Round 4 — RunCockpit was reading global `useOverviewData()` and
    // showing red "Claude Code · 固定不可用" even when round 2/3 had
    // already cleared the upper RunCheckpoint. Same surface,
    // contradictory signals. The fix threads `sessionRuntimePin` in as
    // a prop and gates global signals (defaultInvalid + runtimeFallback)
    // behind a `sessionRuntimeOverride` derived from it.
    //
    // 2026-05-09 split: RunCockpit.tsx is now the trigger-only shell;
    // the heavy data layer (severity, runtime override gating) lives
    // in RunCockpitPopoverContent.tsx. The shell still declares the
    // `sessionRuntimePin` prop (and forwards it), but the derivation
    // moved to the popover content file.
    //
    // Three invariants:
    //   (a) The shell declares `sessionRuntimePin` AND forwards it
    //       to the popover content (otherwise the prop is dead weight).
    //   (b) The popover content derives `sessionRuntimeOverride` from
    //       the prop and short-circuits the runtimeFallback signal
    //       under override.
    //   (c) Both render sites (ChatView + chat/page) pass
    //       `sessionRuntimePin={runtimePin}` to the shell — otherwise
    //       the chain is declared but never populated and the bug
    //       regresses.
    const shellSrc = fs.readFileSync(
      path.join(repoRoot, 'components/chat/RunCockpit.tsx'),
      'utf8',
    );
    const popoverSrc = fs.readFileSync(
      path.join(repoRoot, 'components/chat/RunCockpitPopoverContent.tsx'),
      'utf8',
    );
    // (a) shell side — prop declared and forwarded into the lazy popover
    assert.match(
      shellSrc,
      /sessionRuntimePin\?:\s*string/,
      'RunCockpit shell must declare sessionRuntimePin prop',
    );
    assert.match(
      shellSrc,
      /<RunCockpitPopoverContent[\s\S]{0,400}sessionRuntimePin=\{sessionRuntimePin\}/,
      'RunCockpit shell must forward sessionRuntimePin to RunCockpitPopoverContent — without forwarding, the popover falls back to global signals and the override breaks',
    );
    // (b) popover content side — override flag + runtimeFallback gate
    assert.match(
      popoverSrc,
      /sessionRuntimeOverride\s*=\s*!!sessionRuntimePin/,
      'RunCockpitPopoverContent must derive sessionRuntimeOverride from sessionRuntimePin',
    );
    assert.match(
      popoverSrc,
      /runtimeFallback\s*=\s*\n?\s*!sessionRuntimeOverride/,
      'runtimeFallback derivation must short-circuit under sessionRuntimeOverride — global SDK→native fallback notice does not apply when the user has explicitly pinned runtime',
    );
    // (c) — both call sites must pass the prop.
    const callSites = [
      'components/chat/ChatView.tsx',
      'app/chat/page.tsx',
    ];
    for (const rel of callSites) {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      assert.match(
        src,
        /<RunCockpit[\s\S]{0,800}sessionRuntimePin=\{runtimePin\}/,
        `${rel} must pass sessionRuntimePin={runtimePin} to RunCockpit — declaring the prop without populating it from both call sites would silently regress the fix`,
      );
    }
  });

  it('ChatView locks the Runtime lane after execution starts without a redundant status banner', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'components/chat/ChatView.tsx'),
      'utf8',
    );
    const messageInputSrc = fs.readFileSync(
      path.join(repoRoot, 'components/chat/MessageInput.tsx'),
      'utf8',
    );
    const pickerSrc = fs.readFileSync(
      path.join(repoRoot, 'components/chat/ModelSelectorDropdown.tsx'),
      'utf8',
    );
    assert.doesNotMatch(
      src,
      /import\s*\{\s*RuntimeSelector\s*\}\s*from\s*['"]\.\/RuntimeSelector['"]/,
      'ChatView must not render a second standalone Runtime selector beside the integrated picker',
    );
    assert.match(
      src,
      /<MessageInput[\s\S]{0,900}runtime=\{sessionRuntimeParam\}[\s\S]{0,120}onRuntimeChange=\{handleRuntimePinChange\}/,
      'ChatView must wire the model picker Runtime lane to handleRuntimePinChange',
    );
    assert.match(
      src,
      /runtimeChangeDisabled=\{runtimeSelectionLocked\}/,
      'ChatView must make the Runtime lane read-only after the owner is established.',
    );
    assert.match(
      src,
      /runtimeSelectionLocked\s*=\s*runtimeBindingState\s*===\s*'bound'[\s\S]{0,160}hasAcceptedExecutionMessage/,
      'the UI lock must also cover the accepted-first-message window before a server-prop reload.',
    );
    assert.doesNotMatch(
      src,
      /chat\.runtime\.ownerFixed/,
      'the disabled Runtime lane is sufficient feedback; ChatView must not add a persistent ownership banner.',
    );
    assert.match(
      messageInputSrc,
      /runtimeChangeDisabled=\{isStreaming \|\| runtimeChangeDisabled\}/,
      'MessageInput must preserve the streaming lock and the owner lock.',
    );
    assert.match(
      pickerSrc,
      /disabled=\{runtimeChangeDisabled\}[\s\S]{0,180}composer\.runtimeLocked/,
      'the Runtime buttons must be visibly disabled with an explanation.',
    );
    assert.match(
      src,
      /commitRoute\s*=\s*useCallback[\s\S]{0,900}expected_route_revision/,
      'same-Runtime route changes must include expected_route_revision.',
    );
    assert.doesNotMatch(
      src,
      /continueInNewRuntimeChat|router\.push\(`\/chat\/\$\{result\.target_session_id\}`\)/,
      'the ordinary picker must never create a handoff and surprise-navigate to another chat.',
    );
    assert.match(
      src,
      /handleRuntimePinChange\s*=\s*useCallback[\s\S]{0,180}if \(runtimeSelectionLocked\) return;/,
      'the callback must fail closed even if a stale UI event attempts a Runtime change.',
    );
  });
});
