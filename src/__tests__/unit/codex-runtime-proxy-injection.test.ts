/**
 * Phase 5b — Codex Runtime ↔ provider proxy wiring regression tests.
 *
 * The unified translator at `/api/codex/proxy/v1/responses` only
 * works if `thread/start` is called with the matching
 * `model_providers.codepilot_proxy` config + `modelProvider:
 * 'codepilot_proxy'` + `x-codepilot-target-provider` header. The
 * earlier Phase 5b commit shipped the helper but didn't actually wire
 * it into `CodexRuntime.stream()`, which meant the UI showed Codex
 * Runtime as available for CodePilot providers while the actual
 * thread/start params didn't carry the injection — a silent failure
 * mode (the user sees the model in the picker, sends, and the run
 * fails because Codex tries to call the upstream API directly).
 *
 * These tests pin the contract at two layers:
 *
 *   1. `buildCodexThreadStartParams` (pure helper) — exercises every
 *      provider-resolution branch (env / empty → throw, codex_account
 *      → no injection, real provider → full injection).
 *
 *   2. `CodexRuntime.stream` — observes the failure surface for the
 *      env case. We can't spawn the real app-server in CI (CODEX_DISABLED=1),
 *      but the env / empty checks fire BEFORE the subprocess boot, so
 *      they're testable end-to-end through the runtime entry point.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildCodexThreadParams,
  buildCodexThreadStartParams,
  buildCodexProviderProxyInjection,
  CODEX_PROXY_PROVIDER_KEY,
} from '@/lib/codex/provider-proxy';
import { codexRuntime } from '@/lib/codex/runtime';

// ─────────────────────────────────────────────────────────────────────
// buildCodexThreadStartParams — provider-resolution branches
// ─────────────────────────────────────────────────────────────────────

describe('buildCodexThreadStartParams — provider routing', () => {
  it('throws for empty providerId (caller must reject before this layer)', () => {
    assert.throws(
      () =>
        buildCodexThreadStartParams({
          providerId: '',
          workingDirectory: '/tmp',
          proxyBaseUrl: 'http://127.0.0.1:3000',
        }),
      /env.*empty providerId|must reject/,
    );
  });

  it('throws for env providerId (Claude Code default explicitly excluded)', () => {
    assert.throws(
      () =>
        buildCodexThreadStartParams({
          providerId: 'env',
          workingDirectory: '/tmp',
          proxyBaseUrl: 'http://127.0.0.1:3000',
        }),
      /env/,
    );
  });

  it('returns just {cwd} for codex_account (Codex uses its own credentials, no proxy injection)', () => {
    const params = buildCodexThreadStartParams({
      providerId: 'codex_account',
      workingDirectory: '/tmp/work',
      proxyBaseUrl: 'http://127.0.0.1:3000',
    });
    assert.deepEqual(params, { cwd: '/tmp/work' });
    assert.equal(
      (params as Record<string, unknown>).modelProvider,
      undefined,
      'codex_account must NOT carry modelProvider — Codex would otherwise try to resolve codepilot_proxy without the matching config',
    );
    assert.equal((params as Record<string, unknown>).config, undefined);
  });

  it('injects codepilot_proxy + target header for a real CodePilot provider', () => {
    const params = buildCodexThreadStartParams({
      providerId: 'glm-test',
      workingDirectory: '/tmp/work',
      proxyBaseUrl: 'http://127.0.0.1:3000',
    });
    assert.equal(params.cwd, '/tmp/work');
    assert.equal(
      params.modelProvider,
      CODEX_PROXY_PROVIDER_KEY,
      'modelProvider must point Codex at the codepilot_proxy entry it sees in config.model_providers',
    );
    const cfg = params.config?.model_providers?.[CODEX_PROXY_PROVIDER_KEY];
    assert.ok(cfg, 'config.model_providers.codepilot_proxy must be present');
    assert.equal(cfg!.wire_api, 'responses');
    assert.equal(
      cfg!.base_url,
      'http://127.0.0.1:3000/api/codex/proxy/v1',
      'base_url must point at the local proxy route — Codex appends /responses for streaming',
    );
    assert.equal(
      cfg!.http_headers['x-codepilot-target-provider'],
      'glm-test',
      'target provider header must echo the requested CodePilot provider id so the proxy route knows which DB row to forward',
    );
  });

  it('omits cwd when workingDirectory is not provided', () => {
    const params = buildCodexThreadStartParams({
      providerId: 'codex_account',
      proxyBaseUrl: 'http://127.0.0.1:3000',
    });
    assert.equal((params as { cwd?: string }).cwd, undefined);
  });

  it('strips trailing slashes off the proxy base url so the path concat stays clean', () => {
    const params = buildCodexThreadStartParams({
      providerId: 'glm-test',
      proxyBaseUrl: 'http://127.0.0.1:3000/',
    });
    const cfg = params.config?.model_providers?.[CODEX_PROXY_PROVIDER_KEY];
    assert.equal(
      cfg!.base_url,
      'http://127.0.0.1:3000/api/codex/proxy/v1',
      'trailing slash must be normalised away — Codex appends /responses and a double slash would silently 404',
    );
  });

  it('forwards `model` alongside modelProvider + config (Phase 5b smoke fix 2026-05-15)', () => {
    // Codex's thread_start_params_from_config / thread_resume_params_from_config
    // (codex-rs/tui/.../app_server_session.rs) pass model + modelProvider + config
    // together. Without `model`, Codex's resolver can't pick the model id under
    // codepilot_proxy (we don't set default_model on the proxy entry by design),
    // so the turn fails with a generic "Codex error" before our proxy is ever
    // called. Pinning the field-presence here so a future refactor doesn't drop it.
    const params = buildCodexThreadStartParams({
      providerId: 'glm-test',
      workingDirectory: '/tmp/work',
      proxyBaseUrl: 'http://127.0.0.1:3000',
      model: 'glm-4.5-air',
    });
    assert.equal(params.model, 'glm-4.5-air', 'thread/start + thread/resume must carry the selected model');
    assert.equal(params.modelProvider, 'codepilot_proxy');
    assert.equal(params.cwd, '/tmp/work');
  });

  it('omits `model` when caller didn\'t supply one (back-compat with sessions that haven\'t persisted a model yet)', () => {
    const params = buildCodexThreadStartParams({
      providerId: 'glm-test',
      proxyBaseUrl: 'http://127.0.0.1:3000',
    });
    assert.equal(params.model, undefined);
  });

  it('forwards `model` for codex_account (Codex uses it to pick the upstream model id)', () => {
    const params = buildCodexThreadStartParams({
      providerId: 'codex_account',
      workingDirectory: '/tmp',
      proxyBaseUrl: 'http://127.0.0.1:3000',
      model: 'gpt-5.5',
    });
    assert.equal(params.model, 'gpt-5.5');
    // codex_account is the virtual provider — no proxy injection
    assert.equal(params.modelProvider, undefined);
    assert.equal(params.config, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildCodexProviderProxyInjection — the lower-level helper
// ─────────────────────────────────────────────────────────────────────

describe('buildCodexProviderProxyInjection — proxy config shape', () => {
  it('packs the modelProvider key + config.model_providers entry exactly as Codex expects', () => {
    const injection = buildCodexProviderProxyInjection('p1', 'http://127.0.0.1:3000');
    assert.equal(injection.modelProvider, 'codepilot_proxy');
    const entry = injection.config.model_providers.codepilot_proxy;
    assert.equal(entry.name, 'CodePilot via Codex');
    assert.equal(entry.wire_api, 'responses');
    assert.equal(entry.base_url, 'http://127.0.0.1:3000/api/codex/proxy/v1');
    assert.equal(entry.http_headers['x-codepilot-target-provider'], 'p1');
  });
});

// ─────────────────────────────────────────────────────────────────────
// CodexRuntime.stream — env / empty provider rejection
// ─────────────────────────────────────────────────────────────────────

async function collectStream(stream: ReadableStream<string>): Promise<string[]> {
  const chunks: string[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return chunks;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

describe('CodexRuntime.stream — provider gate (Phase 5b)', () => {
  it('rejects with run_failed when providerId is "env"', async () => {
    const stream = codexRuntime.stream({
      callScene: 'interactive_chat',
      prompt: 'hi',
      sessionId: 'test-session-env',
      providerId: 'env',
    });
    const chunks = await collectStream(stream);
    const joined = chunks.join('');
    assert.match(
      joined,
      /env|Claude Code default|not supported/,
      'env rejection must surface a specific reason (mentions env / Claude Code) so the user understands WHY the send failed, not a generic "Codex Runtime error"',
    );
    // The runtime emits a run_failed canonical event when it bails out
    // pre-stream. The exact SSE wrapper is `data: {"type":"run_failed",
    // "data":"..."}\n\n` per canonicalToSseLine.
    // CodexRuntime emits the pre-stream rejection as a canonical
    // `error` SSE event followed by `done`. The existing chat
    // consumer treats this as a terminal failure.
    assert.match(joined, /"type":"error"/);
    assert.match(joined, /"type":"done"/);
  });

  it('rejects with run_failed when no providerId / sessionProviderId is given', async () => {
    const stream = codexRuntime.stream({
      callScene: 'interactive_chat',
      prompt: 'hi',
      sessionId: 'test-session-empty',
    });
    const chunks = await collectStream(stream);
    const joined = chunks.join('');
    // CodexRuntime emits the pre-stream rejection as a canonical
    // `error` SSE event followed by `done`. The existing chat
    // consumer treats this as a terminal failure.
    assert.match(joined, /"type":"error"/);
    assert.match(joined, /"type":"done"/);
    assert.match(joined, /provider|env|Claude Code/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildCodexThreadParams — same shape serves start AND resume (P1 follow-up)
// ─────────────────────────────────────────────────────────────────────

describe('buildCodexThreadParams — shared shape for thread/start + thread/resume', () => {
  it('returns the same payload regardless of start vs resume usage (one helper, two call sites)', () => {
    // Two callers (thread/start in fresh path, thread/resume in
    // matching-binding path) call this with identical inputs and MUST
    // receive identical payloads. The previous P1 bug was that resume
    // omitted the params entirely; we pin that the helper is the
    // single source so a future "optimise resume" diff can't drop
    // them again without touching this test.
    const opts = {
      providerId: 'glm-test',
      workingDirectory: '/tmp/work',
      proxyBaseUrl: 'http://127.0.0.1:3000',
    };
    const a = buildCodexThreadParams(opts);
    const b = buildCodexThreadParams(opts);
    assert.deepEqual(a, b);
    // Spreadability: both call sites spread the same object into the
    // request payload. Snapshot the keys so a future refactor that
    // adds a non-spreadable field (function, Symbol, etc.) trips.
    const keys = Object.keys(a).sort();
    assert.deepEqual(keys, ['config', 'cwd', 'modelProvider']);
  });

  it('legacy buildCodexThreadStartParams alias is wired to the same helper', () => {
    // The rename is non-breaking — the alias keeps the original name
    // valid for callers / tests that haven't migrated. Asserting
    // function identity catches an accidental forked implementation.
    assert.equal(
      buildCodexThreadStartParams,
      buildCodexThreadParams,
      'buildCodexThreadStartParams must be a true alias of buildCodexThreadParams so the start and resume paths share one source of truth',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// thread/resume payload guardrail — CodexRuntime calls thread/resume
// with the same proxy params it passes to thread/start. Pre-fix, the
// resume branch passed only `{ threadId }`. Source-grep the runtime
// because the runtime function spawns the app-server we can't mock
// without dragging the whole subprocess machinery into a unit test;
// the AST-level pin still catches the regression at zero runtime cost.
// ─────────────────────────────────────────────────────────────────────

describe('CodexRuntime — thread/resume payload mirrors thread/start (Phase 5b P1)', () => {
  const runtimeSrc = fs.readFileSync(
    path.resolve(
      __dirname,
      '../../lib/codex/runtime.ts',
    ),
    'utf8',
  );

  it('runtime calls thread/resume with threadId + spread of buildCodexThreadParams result', () => {
    // Find the thread/resume client.request call and confirm it
    // spreads the shared threadParams object. Allow whitespace +
    // optional trailing comma; reject the pre-fix `{ threadId: ... }`
    // bare form.
    const match = runtimeSrc.match(
      /client\.request(?:<[^>]+>)?\(\s*['"]thread\/resume['"][\s\S]{0,400}?\)/,
    );
    assert.ok(match, 'expected a client.request("thread/resume", ...) call in runtime.ts');
    const payload = match![0];
    assert.match(
      payload,
      /\.\.\.threadParams/,
      'thread/resume must spread the same `threadParams` object the runtime uses for thread/start — otherwise the second turn loses the codepilot_proxy injection. Found:\n' + payload,
    );
    assert.match(
      payload,
      /threadId\s*:\s*existingRef\.token/,
      'thread/resume must reference the persisted thread id from the session ref',
    );
  });

  it('runtime calls thread/start with the same threadParams (no divergence)', () => {
    // Same source of truth: both thread/start invocations (fresh path
    // + resume-failed fallback) must use `threadParams`.
    const matches = [
      ...runtimeSrc.matchAll(
        /client\.request<[^>]+>\(\s*\n?\s*['"]thread\/start['"][\s\S]{0,200}?\)/g,
      ),
    ];
    assert.ok(
      matches.length >= 2,
      `expected at least 2 client.request<...>("thread/start", ...) call sites in runtime.ts (fresh + resume-failed fallback); got ${matches.length}`,
    );
    for (const m of matches) {
      assert.match(
        m[0],
        /threadParams\s*,?\s*\)/,
        'thread/start call must pass `threadParams` directly so all three paths (start fresh, resume, resume-failed) share one params object. Found:\n' + m[0],
      );
    }
  });
});
