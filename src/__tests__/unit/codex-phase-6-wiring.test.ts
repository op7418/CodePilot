/**
 * Phase 5 Phase 6 (2026-05-14) — source-level pin for Settings收口.
 *
 * IA correction (2026-05-14, same day): Codex shouldn't be a
 * top-level Settings tab — it spans two domains (engine + provider).
 * The standalone /settings/codex page is now a transitional redirect;
 * its content lives in Runtime (app-server status) + Providers
 * (account / quota) + Models (Codex Account models).
 *
 * Pins kept here cover the surfaces that survived the correction:
 *
 *   1. /settings/codex → redirect to /settings/runtime
 *   2. nav-config does NOT register a top-level "codex" section
 *   3. Chat model picker shows codex_runtime-specific disclosure +
 *      empty-state copy (per user spec 2026-05-14: filter, not
 *      gray-out; "切回 Claude Code / CodePilot Runtime" wording).
 *   4. Electron `before-quit` hook calls /api/codex/dispose before
 *      `killServer()` (avoids orphan Codex grandchild).
 *   5. /api/codex/rate-limits route exists and wraps
 *      `account/rateLimits/read`.
 *
 * No live codex binary in CI — these are source-level greps. Same
 * pattern as round 3 / 4 / 5 pins.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');

// ─────────────────────────────────────────────────────────────────────
// IA correction — top-level Codex tab removed; URL redirected
// ─────────────────────────────────────────────────────────────────────

describe('Settings IA — no top-level Codex tab (IA correction)', () => {
  const navSrc = fs.readFileSync(
    path.join(repoRoot, 'components/settings/nav-config.ts'),
    'utf8',
  );

  it('SettingsSection union does NOT include "codex"', () => {
    // Codex is split across runtime / providers / models — not its own
    // section. A regression here would put the misaligned tab back.
    assert.doesNotMatch(navSrc, /\|\s*['"]codex['"]/);
  });

  it('SETTINGS_NAV_ITEMS does NOT contain a codex entry', () => {
    assert.doesNotMatch(navSrc, /id:\s*['"]codex['"]/);
  });

  it('/settings/codex remains routable as a redirect to /settings/runtime', () => {
    // Deep links from the brief window the standalone page shipped
    // should still resolve — just to the correct location.
    const pageSrc = fs.readFileSync(
      path.join(repoRoot, 'app/settings/codex/page.tsx'),
      'utf8',
    );
    assert.match(pageSrc, /import\s*\{\s*redirect\s*\}\s*from\s*['"]next\/navigation['"]/);
    assert.match(pageSrc, /redirect\(['"]\/settings\/runtime/);
  });

  it('CodexPanel component is removed (content moved to runtime / providers / models)', () => {
    const panelPath = path.join(repoRoot, 'components/settings/CodexPanel.tsx');
    assert.equal(
      fs.existsSync(panelPath),
      false,
      'CodexPanel.tsx must not exist — its content lives in RuntimePanel + ProviderManager + ModelsSection',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Codex capability card aligns to the Codex Account profile (2026-05-28)
// ─────────────────────────────────────────────────────────────────────

describe('Settings Runtime page — Codex card uses the Codex Account profile', () => {
  const pageSrc = fs.readFileSync(
    path.join(repoRoot, 'app/settings/runtime/page.tsx'),
    'utf8',
  );

  it('derives the codex_runtime matrix from "codex_account", not the effective default provider', () => {
    // User decision (2026-05-28): the Codex capability card must reflect
    // Codex Account's honest profile (Memory/Widget/Tasks callable with
    // notes; image/media/dashboard/cli NOT callable). Deriving from the
    // effective default provider made the card render the provider-proxy
    // profile when the default wasn't Codex Account, overstating image /
    // media as callable even though they aren't under Codex Account.
    assert.match(
      pageSrc,
      /capabilityMatrixForRuntimeProvider\(\s*["']codex_runtime["']\s*,\s*["']codex_account["']\s*,?\s*\)/,
      'page must derive Codex cells from the codex_account profile',
    );
    assert.doesNotMatch(
      pageSrc,
      /resolveEffectiveProviderId/,
      'Codex card must not key off the effective default provider (that profile overstates image/media)',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Rate limits API — wraps `account/rateLimits/read`
// ─────────────────────────────────────────────────────────────────────

describe('/api/codex/rate-limits route (IA correction)', () => {
  it('GET route exists and imports readCodexRateLimits', () => {
    const routeSrc = fs.readFileSync(
      path.join(repoRoot, 'app/api/codex/rate-limits/route.ts'),
      'utf8',
    );
    assert.match(
      routeSrc,
      /import\s*\{\s*readCodexRateLimits\s*\}\s*from\s*['"]@\/lib\/codex\/account['"]/,
    );
    assert.match(routeSrc, /export\s+async\s+function\s+GET/);
    assert.match(routeSrc, /readCodexRateLimits\(\)/);
  });

  it('readCodexRateLimits calls account/rateLimits/read with narrowed shape', () => {
    const accountSrc = fs.readFileSync(
      path.join(repoRoot, 'lib/codex/account.ts'),
      'utf8',
    );
    assert.match(accountSrc, /export\s+async\s+function\s+readCodexRateLimits/);
    assert.match(accountSrc, /['"]account\/rateLimits\/read['"]/);
    // Must surface primary + secondary windows (the user-spec quotas
    // for 5h and 7d buckets) — not just the deprecated flat shape.
    assert.match(accountSrc, /primary:\s*toWindow/);
    assert.match(accountSrc, /secondary:\s*toWindow/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// RuntimePanel三引擎化 — Codex Runtime as a peer engine
// ─────────────────────────────────────────────────────────────────────

describe('RuntimePanel — three-engine picker (IA correction)', () => {
  const panelSrc = fs.readFileSync(
    path.join(repoRoot, 'components/settings/RuntimePanel.tsx'),
    'utf8',
  );

  it('AgentRuntime is imported from effective.ts (not duplicated locally)', () => {
    // Local 2-value duplicate caused drift; single source of truth via
    // effective.ts. Both effective.AgentRuntime and legacy.ConcreteRuntime
    // now include 'codex_runtime'.
    assert.match(
      panelSrc,
      /import\s*\{[\s\S]{0,300}type\s+AgentRuntime[\s\S]{0,100}\}\s*from\s*["']@\/lib\/runtime\/effective["']/,
    );
    assert.doesNotMatch(panelSrc, /type\s+AgentRuntime\s*=\s*["']claude-code-sdk["']\s*\|\s*["']native["']\s*;/);
  });

  it('picker grid expands to 3 columns', () => {
    assert.match(panelSrc, /grid\s+grid-cols-1\s+md:grid-cols-3\s+gap-4/);
  });

  it('Codex Runtime EnginePickerCard is rendered', () => {
    assert.match(
      panelSrc,
      /engine="codex_runtime"[\s\S]{0,2000}handleRuntimeChange\("codex_runtime"\)/,
    );
  });

  it('handleRuntimeChange flips cli_enabled only when claude-code-sdk selected', () => {
    // Codex Runtime AND CodePilot Runtime both run without the CLI,
    // so cli_enabled=true only when value === 'claude-code-sdk'.
    assert.match(
      panelSrc,
      /const\s+cliEnabledValue\s*=\s*value\s*===\s*["']claude-code-sdk["']\s*\?\s*["']true["']\s*:\s*["']false["']/,
    );
  });

  it('Codex Runtime detail card renders below the picker', () => {
    // The detail card pulls reason/impact/recovery from codexRuntimeStatus
    // and surfaces the app-server status row + Codex home + jump links.
    // Phase 6 UI收口 P1 (2026-05-14): short detail-card heading "Codex"
    // (the page title + section header carry the "Runtime / 引擎"
    // framing; repeating it on every card was redundant noise).
    assert.match(panelSrc, /<RuntimeCard\s+name="Codex"/);
    assert.match(panelSrc, /codexRuntimeStatus/);
    // Jump links to where account + models live — these are load-bearing
    // for the IA: the Codex card MUST NOT duplicate Provider / Models
    // content, just point to it.
    assert.match(panelSrc, /href="\/settings\/providers"/);
    assert.match(panelSrc, /href="\/settings\/models"/);
  });

  it('refresh explicitly rescans the CLI and surfaces the selected binary path', () => {
    assert.match(
      panelSrc,
      /fetch\(["']\/api\/codex\/status["']\s*,\s*\{[\s\S]{0,160}method:\s*["']POST["']/,
      'the refresh button must POST so same-path upgrades clear resolver/version/failure caches',
    );
    assert.match(panelSrc, /["']binary["']\s+in\s+codexAvailability/);
    assert.match(panelSrc, /CLI 来源/);
    assert.match(panelSrc, /CLI source/);
  });
});

describe('/api/codex/status — safe refresh contract', () => {
  const routeSrc = fs.readFileSync(
    path.join(repoRoot, 'app/api/codex/status/route.ts'),
    'utf8',
  );
  const managerSrc = fs.readFileSync(
    path.join(repoRoot, 'lib/codex/app-server-manager.ts'),
    'utf8',
  );

  it('keeps GET read-only and exposes POST through refreshCodexAvailability', () => {
    assert.match(routeSrc, /export\s+async\s+function\s+GET\s*\(/);
    assert.match(routeSrc, /export\s+async\s+function\s+POST\s*\(/);
    assert.match(routeSrc, /POST\(\)[\s\S]{0,180}refreshCodexAvailability\(\)/);
  });

  it('does not dispose or switch a healthy/pending app-server during refresh', () => {
    const refreshBlock = managerSrc.match(
      /export\s+async\s+function\s+refreshCodexAvailability[\s\S]+?\n}\n\n\/\*\*/,
    );
    assert.ok(refreshBlock, 'refreshCodexAvailability block must exist');
    assert.match(refreshBlock![0], /if\s*\(cached\)\s*return\s+getCodexAvailability\(\)/);
    assert.doesNotMatch(refreshBlock![0], /disposeCodexAppServer|\.dispose\(|\.kill\(/);
  });
});

describe('runtime/effective — three-engine union (IA correction)', () => {
  it('AgentRuntime accepts codex_runtime', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'lib/runtime/effective.ts'), 'utf8');
    assert.match(src, /AgentRuntime\s*=\s*["']claude-code-sdk["']\s*\|\s*["']native["']\s*\|\s*["']codex_runtime["']/);
  });

  it('runtimeDisplayLabel returns short "Codex" label for codex_runtime', () => {
    // Phase 6 UI收口 P1 fix-up (2026-05-14): label dropped the redundant
    // "Runtime" suffix so the engine picker / composer button / detail
    // card heading / runtime explainer banner all read consistently.
    const src = fs.readFileSync(path.join(repoRoot, 'lib/runtime/effective.ts'), 'utf8');
    assert.match(src, /runtime\s*===\s*["']codex_runtime["'][\s\S]{0,80}return\s+["']Codex["']/);
    assert.doesNotMatch(src, /return\s+["']Codex Runtime["']/);
  });

  it('computeEffectiveRuntime returns codex_runtime without fallback', () => {
    // Codex doesn't fall back. Send-time guardrail (claude-client.ts
    // Round 5) handles the unavailable case with a clear error.
    const src = fs.readFileSync(path.join(repoRoot, 'lib/runtime/effective.ts'), 'utf8');
    assert.match(
      src,
      /storedAgentRuntime\s*===\s*["']codex_runtime["'][\s\S]{0,80}return\s+["']codex_runtime["']/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Providers — Codex Account virtual provider card
// ─────────────────────────────────────────────────────────────────────

describe('ProviderManager — Codex Account virtual card (IA correction)', () => {
  const mgrSrc = fs.readFileSync(
    path.join(repoRoot, 'components/settings/ProviderManager.tsx'),
    'utf8',
  );

  it('imports Codex types + CodexQuotaWidget', () => {
    assert.match(mgrSrc, /CodexAccountState[\s\S]{0,80}from\s*["']@\/lib\/codex\/types["']/);
    assert.match(mgrSrc, /CodexLoginStart[\s\S]{0,80}from\s*["']@\/lib\/codex\/account["']/);
    assert.match(mgrSrc, /import\s*\{\s*CodexQuotaWidget\s*\}\s*from\s*["']\.\/CodexQuotaWidget["']/);
  });

  it('Codex Account card renders alongside OAuth virtual providers when logged in', () => {
    // The OAuth section header must trigger when OpenAI, xAI, OR Codex is
    // connected — regressing this means a virtual-provider user would
    // see no card at all.
    assert.match(
      mgrSrc,
      /openaiAuth\?\.authenticated\s*\|\|\s*xaiAuth\?\.authenticated\s*\|\|\s*codexAccount\?\.kind\s*===\s*['"]logged_in['"]/,
    );
    assert.match(mgrSrc, /codexAccount\?\.kind\s*===\s*['"]logged_in['"][\s\S]{0,500}<ProviderCard/);
  });

  it('Codex card uses "登录方式" instead of "类型" for account.type', () => {
    // Phase 6 IA correction copy fix: type=chatgpt/apiKey/amazonBedrock
    // is the LOGIN METHOD, not the plan. "类型" reads as plan to users.
    // Pin the rename so a future build can't silently revert it.
    assert.match(mgrSrc, /label:\s*isZh\s*\?\s*['"]登录方式['"]/);
    assert.match(mgrSrc, /['"]Login method['"]/);
    // The Codex card MUST NOT render `account.type` under a "类型" /
    // "Type" label — that was the confusing original.
    const codexCardBlock = mgrSrc.match(/codexAccount\?\.kind\s*===\s*['"]logged_in['"][\s\S]+?<\/ProviderCard>/);
    if (codexCardBlock) {
      assert.doesNotMatch(codexCardBlock[0], /label:\s*isZh\s*\?\s*['"]类型['"]/);
      assert.doesNotMatch(codexCardBlock[0], /['"]Type['"]\s*,\s*value:\s*codexAccount\.account\.type/);
    } else {
      assert.fail('Could not locate the Codex Account ProviderCard block');
    }
  });

  it('CodexQuotaWidget is rendered inside the Codex Account card', () => {
    assert.match(mgrSrc, /<CodexQuotaWidget\s+snapshot=\{codexRateLimits\}/);
  });

  it('Codex login dialog does NOT auto window.open (feedback_no_silent_auto_irreversible)', () => {
    // Login flow renders authUrl as an explicit <a target="_blank">
    // link inside a Dialog, never window.open().
    const codexLoginDialog = mgrSrc.match(/Codex Account login dialog[\s\S]+?<\/Dialog>/);
    assert.ok(codexLoginDialog, 'Codex login dialog must exist');
    assert.doesNotMatch(codexLoginDialog![0], /window\.open\(/);
    assert.match(codexLoginDialog![0], /target=["']_blank["']/);
  });

  it('keeps Add Service open and renders an inline error when Codex login startup fails', () => {
    // First-time users have no connected OAuth section, so codexError must be
    // rendered inside the still-open Add Service dialog. Closing before the
    // POST resolved made the original failure look like a no-op.
    assert.match(
      mgrSrc,
      /handleCodexLogin\(\)\.then\(\(started\)[\s\S]{0,100}if\s*\(started\)\s*setAddServiceOpen\(false\)/,
    );
    const addDialog = mgrSrc.match(/Add Service dialog[\s\S]+?Codex Account login dialog/);
    assert.ok(addDialog, 'Add Service dialog block must exist');
    assert.match(addDialog![0], /codexError\s*&&[\s\S]{0,160}role=["']alert["']/);
    assert.match(addDialog![0], /aria-busy=\{entry\.loading/);
  });
});

describe('CodexQuotaWidget — primary + secondary windows (IA correction)', () => {
  const src = fs.readFileSync(
    path.join(repoRoot, 'components/settings/CodexQuotaWidget.tsx'),
    'utf8',
  );

  it('renders both primary and secondary RateLimitWindow blocks', () => {
    assert.match(src, /snapshot\.primary[\s\S]{0,300}WindowRow/);
    assert.match(src, /snapshot\.secondary[\s\S]{0,300}WindowRow/);
  });

  it('shows usedPercent (per upstream schema), not absolute remaining tokens', () => {
    // Upstream only reports usedPercent + resetsAt — there is no
    // absolute token count. UI copy must reflect that or it implies
    // data the API doesn't actually return.
    assert.match(src, /已用\s*\$\{pct\.toFixed\(0\)\}%/);
    assert.match(src, /\$\{pct\.toFixed\(0\)\}%\s*used/);
    assert.doesNotMatch(src, /剩余\s*\d+\s*tokens?/);
    assert.doesNotMatch(src, /remaining\s*\d+\s*tokens?/i);
  });

  it('surfaces credits.balance when present (and "Unlimited" when unlimited)', () => {
    assert.match(src, /snapshot\.credits/);
    assert.match(src, /unlimited/);
    assert.match(src, /balance/);
  });

  it('warns when rateLimitReachedType is non-null', () => {
    // Split: the gate variable, the warning copy, and the rendered
    // type label live in separate code regions. Pin them
    // independently rather than via one wide regex.
    assert.match(src, /isRateLimited\s*=\s*!!snapshot\.rateLimitReachedType/);
    assert.match(src, /已触达配额上限/);
    assert.match(src, /Rate limit reached/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Models — Codex Account read-only block
// ─────────────────────────────────────────────────────────────────────

describe('Models page — Codex Account read-only block (IA correction)', () => {
  it('ModelsSection imports + renders CodexAccountModelsBlock', () => {
    const sectionSrc = fs.readFileSync(
      path.join(repoRoot, 'components/settings/ModelsSection.tsx'),
      'utf8',
    );
    assert.match(
      sectionSrc,
      /import\s*\{\s*CodexAccountModelsBlock\s*\}\s*from\s*["']\.\/CodexAccountModelsBlock["']/,
    );
    assert.match(sectionSrc, /<CodexAccountModelsBlock\s+isZh=\{isZh\}/);
  });

  it('block self-hides when not loaded / no models', () => {
    const blockSrc = fs.readFileSync(
      path.join(repoRoot, 'components/settings/CodexAccountModelsBlock.tsx'),
      'utf8',
    );
    assert.match(blockSrc, /if\s*\(\s*!loaded\s*\)\s*return\s+null/);
    assert.match(blockSrc, /if\s*\(\s*!group\s*\|\|\s*!group\.models\?\.length\s*\)\s*return\s+null/);
  });

  it('block carries the "仅 Codex" badge + "Codex only" en mirror', () => {
    // Phase 6 UI收口 P1 fix-up sweep (2026-05-14): badge follows the
    // short product name. "Codex Runtime" / "仅 Codex Runtime" was the
    // pre-sweep wording that leaked the "Runtime" suffix into a
    // qualifier badge.
    const blockSrc = fs.readFileSync(
      path.join(repoRoot, 'components/settings/CodexAccountModelsBlock.tsx'),
      'utf8',
    );
    assert.match(blockSrc, /仅 Codex/);
    assert.match(blockSrc, /Codex only/);
    // Regression guard against re-bolting the suffix.
    assert.doesNotMatch(blockSrc, /仅 Codex Runtime/);
    assert.doesNotMatch(blockSrc, /Codex Runtime only/);
  });

  it('block is read-only (no enable/disable Switch, no edit display name)', () => {
    // Phase 6 IA correction principle: Codex Account models come from
    // upstream Codex, not from CodePilot's DB — nothing to toggle.
    // Regressing to a writable list would be confusing (the toggle
    // would do nothing) AND require new persistence schema.
    const blockSrc = fs.readFileSync(
      path.join(repoRoot, 'components/settings/CodexAccountModelsBlock.tsx'),
      'utf8',
    );
    assert.doesNotMatch(blockSrc, /<Switch\b/);
    assert.doesNotMatch(blockSrc, /onCheckedChange/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Chat composer RuntimeSelector — codex_runtime stickiness (IA round 3)
//
// Pre-round-3 the chat composer hard-coded a binary ternary
// `=== 'claude-code-sdk' ? 'claude_code' : 'codepilot_runtime'` at two
// callsites and `useGlobalAgentRuntime` only typed two values. With
// `agent_runtime='codex_runtime'` stored, the RuntimeSelector trigger
// rendered "Claude Code" while Models / Settings already agreed Codex
// was the default. Round 3 expanded the hook + extracted the registry-id
// → ChatRuntime mapping into `agentRuntimeToChatRuntime()` and pins the
// new wiring here so the binary ternary can't slip back in.
// ─────────────────────────────────────────────────────────────────────

describe('Chat composer RuntimeSelector — codex_runtime support (IA round 3)', () => {
  it('useGlobalAgentRuntime preserves codex_runtime (not coerced to claude-code-sdk)', () => {
    const hookSrc = fs.readFileSync(
      path.join(repoRoot, 'hooks/useGlobalAgentRuntime.ts'),
      'utf8',
    );
    // The state type now lists all three registry ids.
    assert.match(
      hookSrc,
      /agentRuntime:\s*["']claude-code-sdk["']\s*\|\s*["']native["']\s*\|\s*["']codex_runtime["']/,
    );
    // The coercion branch handles codex_runtime as a first-class value,
    // not silently mapped to claude-code-sdk.
    assert.match(
      hookSrc,
      /stored\s*===\s*["']codex_runtime["']\s*\?\s*["']codex_runtime["']/,
    );
    // Regression guard: the old binary coercion is gone.
    assert.doesNotMatch(
      hookSrc,
      /stored\s*===\s*["']native["']\s*\?\s*["']native["']\s*:\s*["']claude-code-sdk["']/,
    );
  });

  it('agentRuntimeToChatRuntime helper exists and maps three engines correctly', () => {
    const sharedSrc = fs.readFileSync(
      path.join(repoRoot, 'lib/chat-runtime-shared.ts'),
      'utf8',
    );
    assert.match(sharedSrc, /export\s+function\s+agentRuntimeToChatRuntime/);
    assert.match(sharedSrc, /stored\s*===\s*['"]native['"][\s\S]{0,80}codepilot_runtime/);
    assert.match(sharedSrc, /stored\s*===\s*['"]codex_runtime['"][\s\S]{0,80}codex_runtime/);
    // Default branch for 'claude-code-sdk' / 'auto' / null
    assert.match(sharedSrc, /return\s+['"]claude_code['"]/);
  });

  it('both chat composer callsites use the helper (not inline binary ternary)', () => {
    for (const relativePath of ['app/chat/page.tsx', 'components/chat/ChatView.tsx']) {
      const src = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      // The new wiring: helper invocation
      assert.match(
        src,
        /effectiveRuntime=\{agentRuntimeToChatRuntime\(globalRuntime\.agentRuntime\)\}/,
        `${relativePath} must call agentRuntimeToChatRuntime`,
      );
      // The old wiring: inline binary ternary that dropped codex_runtime
      assert.doesNotMatch(
        src,
        /agentRuntime\s*===\s*['"]claude-code-sdk['"]\s*\?\s*['"]claude_code['"]\s*:\s*['"]codepilot_runtime['"]/,
        `${relativePath} must not reintroduce the binary ternary`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Model picker — full-catalog + per-row disabled (Phase 6 UI收口 P2)
//
// Replaces the earlier Slice B suite which pinned the server-side
// filter behavior + header disclosure copy. P2 inverted those:
//   - Picker always renders the FULL catalog
//   - Incompatible rows are disabled with hover tooltip explaining why
//   - Header disclosure banners removed (per-row tooltips replace them)
//   - Empty state collapses to the rare "zero providers configured"
//     case; the codex-specific empty state is gone (Codex rows just
//     appear disabled when not logged in / app-server unavailable
//     because the server omits the group entirely)
// ─────────────────────────────────────────────────────────────────────

describe('Model picker — per-row compat gating (Phase 6 UI收口 P2)', () => {
  const pickerSrc = fs.readFileSync(
    path.join(repoRoot, 'components/chat/ModelSelectorDropdown.tsx'),
    'utf8',
  );

  it('row disabled-state checks opt.supportedRuntimes against runtimeApplied', () => {
    // The load-bearing assertion: each model row computes its own
    // disabled state from the per-row annotation. Regression would
    // either hide rows again (server filter) or stop reading the
    // annotation (incompatible rows become silently clickable).
    assert.match(
      pickerSrc,
      /opt\.supportedRuntimes[\s\S]{0,80}\.includes\(runtimeApplied\)/,
    );
  });

  it('row tooltip reads from opt.unsupportedReasonByRuntime for the active runtime', () => {
    assert.match(
      pickerSrc,
      /opt\.unsupportedReasonByRuntime\?\.\[runtimeApplied!\]/,
    );
    // Generic zh + en fallbacks for rows whose upstream contract
    // doesn't supply a per-runtime reason.
    assert.match(pickerSrc, /当前 Agent 引擎不支持此模型/);
    assert.match(pickerSrc, /Current Agent engine does not support this model/);
  });

  it('recent-models section honours the same disabled-state gating', () => {
    // Without this gate, a "recently used GLM" entry would stay
    // clickable under Codex even though the active engine can't
    // serve GLM models. Same supportedRuntimes / tooltip wiring as
    // the main groups below.
    assert.match(
      pickerSrc,
      /option\.supportedRuntimes[\s\S]{0,80}\.includes\(runtimeApplied\)/,
    );
  });

  it('header disclosure banners are GONE (per-row tooltips replace them)', () => {
    // Pre-P2 the picker carried a "only showing models for X" /
    // "Codex currently supports only Codex Account models..." top
    // banner. Both are obsolete now that every row is visible with
    // its own tooltip — keeping them would be visual noise.
    assert.doesNotMatch(
      pickerSrc,
      /仅显示当前 Agent 引擎可用的模型/,
    );
    assert.doesNotMatch(
      pickerSrc,
      /Models available under the current Agent engine/,
    );
    assert.doesNotMatch(
      pickerSrc,
      /Codex 当前仅支持 Codex Account 模型/,
    );
  });

  it('empty state collapses to the generic "no providers configured" copy', () => {
    // Phase 6 UI收口 P2: with the full catalog always returned, an
    // empty groups array means "user has zero providers configured
    // at all" — rare, and the only meaningful recovery is the
    // Providers page. No more codex-specific empty-state branch.
    assert.match(pickerSrc, /providerGroups\.length\s*===\s*0/);
    assert.match(pickerSrc, /尚未配置任何服务商/);
    assert.match(pickerSrc, /No providers configured yet/);
    // Regression guard: the codex-specific empty branch must not
    // creep back in. The picker's compat gating now operates per
    // row, not per empty-state branch.
    assert.doesNotMatch(
      pickerSrc,
      /providerGroups\.length\s*===\s*0[\s\S]{0,300}runtimeApplied\s*===\s*['"]codex_runtime['"]/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase 6 P0 (2026-05-15) — chat composer runtime gate, auto-correct
// semantics, codex proxy-pending reason.
//
// The earlier P2 work delivered "show all + disabled" rendering but
// left two holes that a user smoke session caught:
//
//   (a) chat/page + ChatView passed `'auto'` into useProviderModels
//       when the session had no pin. The hook treated `'auto'` as
//       "no per-row gating" so the picker rendered every model as
//       enabled even when the global Codex Runtime would block them.
//   (b) MessageInput's auto-correct fallback called the SAME
//       `onProviderModelChange` callback the manual picker click
//       used. The parent handler dismissed the pinned-default
//       warning + wrote localStorage + (in ChatView) PATCHed the
//       session, silently confirming a fallback the user never
//       acknowledged.
//   (c) `getModelCompat` had no `codex_runtime` entries in
//       `unsupportedReasonByRuntime` for non-codex providers, so
//       disabled rows under Codex showed only the generic fallback
//       tooltip instead of the "Codex provider proxy 尚未覆盖"
//       parity wording the user spec called for.
// ─────────────────────────────────────────────────────────────────────

describe('effectiveChatRuntime — resolves "auto" to a concrete RuntimeId (Phase 6 P0)', () => {
  it('returns the session pin verbatim when it\'s a known RuntimeId', () => {
    const sharedSrc = fs.readFileSync(
      path.join(repoRoot, 'lib/chat-runtime-shared.ts'),
      'utf8',
    );
    assert.match(sharedSrc, /export\s+function\s+effectiveChatRuntime/);
    assert.match(sharedSrc, /isRuntimeId\(runtimePin\)\s*\)\s*return\s+runtimePin/);
  });

  it('falls back to agentRuntimeToChatRuntime(globalAgentRuntime) when no pin', () => {
    const sharedSrc = fs.readFileSync(
      path.join(repoRoot, 'lib/chat-runtime-shared.ts'),
      'utf8',
    );
    assert.match(
      sharedSrc,
      /return\s+agentRuntimeToChatRuntime\(globalAgentRuntime\)/,
    );
  });
});

describe('Chat composer — passes concrete RuntimeId to useProviderModels (Phase 6 P0)', () => {
  it('chat/page.tsx uses effectiveChatRuntime, not chatRuntimeParamForSession', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'app/chat/page.tsx'), 'utf8');
    assert.match(src, /effectiveChatRuntime\(\s*runtimePin\s*,\s*globalRuntime\.agentRuntime\s*\)/);
    // Regression guard: the old `chatRuntimeParamForSession(runtimePin)`
    // produces `'auto'` which then bypasses the picker's per-row
    // compat gate. Must not creep back into the new-chat page.
    assert.doesNotMatch(src, /chatRuntimeParamForSession\(runtimePin\)/);
  });

  it('ChatView.tsx uses effectiveChatRuntime, not chatRuntimeParamForSession', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'components/chat/ChatView.tsx'), 'utf8');
    assert.match(src, /effectiveChatRuntime\(\s*runtimePin\s*,\s*globalRuntime\.agentRuntime\s*\)/);
    assert.doesNotMatch(src, /chatRuntimeParamForSession\(runtimePin\)/);
  });
});

describe('invalid-default branch — auto-fallback writes through to parent state (Phase 6 P0 round 3)', () => {
  const pageSrc = fs.readFileSync(
    path.join(repoRoot, 'app/chat/page.tsx'),
    'utf8',
  );

  it('both resolver branches call resolveNewChatDefault again with mode="auto" on invalid-default', () => {
    // The load-bearing assertion. Pre-round-3 the invalid-default
    // branch cleared currentProviderId/Model — banner said
    // "auto-switched" but parent state stayed empty, MessageInput's
    // useProviderModels resolved a different visible fallback, and
    // the send gate then tripped on the empty parent state. Round 3
    // re-runs the resolver in 'auto' mode and writes the result
    // through to parent state so banner / display / send all agree.
    //
    // Two resolver call sites (initial-load + checkProvider), both
    // must do this — pinned by two anchored matches.
    const invalidDefaultBranches = pageSrc.match(
      /resolved\.status\s*===\s*['"]invalid-default['"][\s\S]+?(?=\n\s*\}\s*else\s*\{|\n\s*\}\s*else\s+if)/g,
    );
    assert.ok(
      invalidDefaultBranches && invalidDefaultBranches.length === 2,
      'expected exactly two invalid-default branches (initial-load + checkProvider resolvers)',
    );
    for (const branch of invalidDefaultBranches!) {
      assert.match(
        branch,
        /const\s+autoFallback\s*=\s*resolveNewChatDefault\(/,
        'each invalid-default branch must re-resolve via resolveNewChatDefault to land on a sendable fallback pair',
      );
      assert.match(
        branch,
        /mode:\s*['"]auto['"]/,
        'auto-fallback call must explicitly use mode="auto" so it walks the savedPair → apiDefault → first chain regardless of the pinned mode that originally failed',
      );
      assert.match(
        branch,
        /autoFallback\.status\s*===\s*['"]auto-resolved['"][\s\S]{0,300}setCurrentProviderId/,
        'the fallback result must be written through to parent state so MessageInput / send gate / banner all see the same pair',
      );
      // The pinned-invalid warning still fires — banner copy says
      // "auto-switched", so the warning state must stick.
      assert.match(branch, /setInvalidDefault\(\s*\{/);
    }
  });

  it('regression guard: invalid-default no longer empties parent state without writing a fallback', () => {
    // Pre-round-3 both branches had the shape:
    //   setCurrentModel('');
    //   setCurrentProviderId('');
    //   setInvalidDefault({...});
    // and that was IT. Now there's always a follow-up auto-resolve
    // before / after. A regression would re-introduce the bare
    // empty-set pattern. Check by searching the whole file for the
    // dangerous shape — three consecutive setters with no
    // intervening fallback assignment.
    const dangerous = pageSrc.match(
      /setCurrentModel\(['"]['"]?\)\s*;\s*setCurrentProviderId\(['"]['"]?\)\s*;\s*setNoCompatibleProvider\(false\)\s*;\s*setInvalidDefault\(\s*\{[^}]*reason:[^}]*\}\s*\)\s*;\s*\}/,
    );
    assert.ok(
      !dangerous,
      'invalid-default branch must not leave parent state empty (currentModel + currentProviderId set to "") without a follow-up auto-resolve writing a working pair — that splits parent state from MessageInput visual state',
    );
  });
});

describe('Empty-state — hasSendableProviderForCurrentRuntime bypasses /api/setup for Codex (Phase 6 P0 round 2)', () => {
  const pageSrc = fs.readFileSync(
    path.join(repoRoot, 'app/chat/page.tsx'),
    'utf8',
  );

  it('hasSendableProviderForCurrentRuntime is derived from canSendWithCurrentProvider + modelReady', () => {
    // The empty-state gate must NOT flash for a Codex-Account-only
    // user during the initial resolver window. `modelReady=false`
    // means "still loading" — keep the empty state hidden until
    // the resolver lands. Once modelReady=true, the gate collapses
    // to canSendWithCurrentProvider, which honours the codex_account
    // / openai-oauth virtual-provider bypass.
    assert.match(
      pageSrc,
      /hasSendableProviderForCurrentRuntime\s*=\s*useMemo/,
    );
    assert.match(
      pageSrc,
      /if\s*\(\s*!modelReady\s*\)\s*return\s+true/,
    );
    assert.match(
      pageSrc,
      /return\s+canSendWithCurrentProvider/,
    );
  });

  it('empty-state overlay gates on hasSendableProvider*, NOT the raw hasProvider', () => {
    // Pre-round-2 the overlay condition was
    // `(!workingDir.trim() || !hasProvider)` — that flashed the
    // legacy "configure a provider" card on Codex-Account-only
    // users even when the resolver had landed cleanly on
    // (codex_account, gpt-5.5). Round 2 routes through the new
    // derived flag so virtual providers no longer trip the
    // overlay.
    assert.match(
      pageSrc,
      /!workingDir\.trim\(\)\s*\|\|\s*!hasSendableProviderForCurrentRuntime/,
    );
    // Regression guard: the bare `|| !hasProvider` form must not
    // creep back in.
    assert.doesNotMatch(
      pageSrc,
      /!workingDir\.trim\(\)\s*\|\|\s*!hasProvider/,
    );
  });

  it('ChatEmptyState receives hasSendableProvider*, not raw hasProvider', () => {
    // The child's onboarding branches must see the same truth as
    // the parent's overlay gate. Passing raw hasProvider would let
    // the child render "configure a provider" copy even when the
    // parent gate said "show the empty state" for an unrelated
    // reason (no workingDir).
    assert.match(
      pageSrc,
      /hasProvider=\{hasSendableProviderForCurrentRuntime\}/,
    );
  });
});

describe('Send gate — canSendWithCurrentProvider bypasses /api/setup for Codex Account (Phase 6 P0 follow-up)', () => {
  const pageSrc = fs.readFileSync(
    path.join(repoRoot, 'app/chat/page.tsx'),
    'utf8',
  );

  it('canSendWithCurrentProvider memo exists with the codex_account bypass', () => {
    // The load-bearing assertion: Codex Account is a virtual provider
    // outside /api/setup's "provider === 'completed'" world, so
    // hasProvider is false for Codex-Account-only users. Without this
    // bypass, the user sees a green send button (composer enabled by
    // useProviderModels' resolved pair) → click → "no provider
    // configured" legacy error. The runtime/model pair is the source
    // of truth at send time; the bypass keeps the gate honest.
    assert.match(
      pageSrc,
      /canSendWithCurrentProvider\s*=\s*useMemo/,
    );
    assert.match(
      pageSrc,
      /currentProviderId\s*===\s*['"]codex_account['"][\s\S]{0,50}return\s+true/,
    );
  });

  it('openai-oauth gets the same bypass (other known virtual provider)', () => {
    // Same shape as codex_account — openai-oauth is also virtual
    // (managed by /api/openai-oauth/status, not /api/setup). The
    // bypass set must include both so the OAuth-only flow doesn't
    // regress.
    assert.match(
      pageSrc,
      /currentProviderId\s*===\s*['"]openai-oauth['"][\s\S]{0,50}return\s+true/,
    );
  });

  it('sendFirstMessage uses canSendWithCurrentProvider, not the raw hasProvider gate', () => {
    // Regression guard against re-introducing the bare `!hasProvider`
    // check that blocked Codex Account sends. The empty-state path
    // (line 1076 in page.tsx today) still reads hasProvider — that's
    // intentional, it's about onboarding visibility, not about "is
    // this specific send valid".
    const sendBlock = pageSrc.match(
      /const\s+sendFirstMessage\s*=[\s\S]+?\}\s*,\s*\[[^\]]+\]/,
    );
    assert.ok(sendBlock, 'sendFirstMessage useCallback must exist in page.tsx');
    assert.match(sendBlock![0], /canSendWithCurrentProvider/);
    // The old guard was `if (!hasProvider) { setErrorBanner(...); return; }`
    assert.doesNotMatch(sendBlock![0], /if\s*\(\s*!hasProvider\s*\)/);
  });
});

describe('MessageInput auto-correct — manual-only side effects (Phase 6 P0)', () => {
  it('MessageInput auto-correct passes `{ isAuto: true }` to onProviderModelChange', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'components/chat/MessageInput.tsx'),
      'utf8',
    );
    // The load-bearing assertion: the auto-correct effect must mark
    // its callback as auto so the parent can skip the manual-pick
    // side effects (warning clear, localStorage write).
    //
    // s07 reviewer fix (run i31): the effect now routes through the
    // `emitProviderModelChange` wrapper, which enriches opts with the new
    // model's supportedEffortLevels (so both effort-reset consumers validate
    // against the same picker feed) and forwards `...opts` — including
    // `isAuto` — to `onProviderModelChange`. Assert both hops preserve isAuto.
    assert.match(
      src,
      /emitProviderModelChange\([\s\S]{0,120}\{\s*isAuto:\s*true\s*\}\s*\)/,
      'the auto-correct effect must mark its switch as auto',
    );
    assert.match(
      src,
      /onProviderModelChange\?\.\([\s\S]{0,200}\.\.\.opts[\s\S]{0,200}\)/,
      'the enriching wrapper must forward ...opts (carrying isAuto) to the parent',
    );
  });

  it('ChatView handleProviderModelChange early-returns on opts.isAuto (no session PATCH)', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'components/chat/ChatView.tsx'),
      'utf8',
    );
    // PATCHing the session on a silent fallback would persist a
    // model the user never picked — the next page load would surface
    // the auto-corrected pair as their "real" selection. Must not.
    //
    // s07 (2026-07-18) moved the effort-effect block ABOVE this guard so the
    // helper's isAuto branch stays live, but the invariant is unchanged: the
    // isAuto early-return must still fire BEFORE the session PATCH. Assert that
    // ordering directly (stronger than a fixed-distance grep).
    assert.match(
      src,
      /opts\?\.isAuto\)\s*return;[\s\S]{0,400}fetch\(`\/api\/chat\/sessions\//,
      'isAuto must early-return before the session PATCH so a silent fallback is not persisted',
    );
  });
});

describe('Picker — codex_runtime supportedRuntimes flows end-to-end (Phase 5b)', () => {
  // Pre-5b the picker disabled non-Codex rows under Codex Runtime
  // with a proxy-pending reason. After the unified provider-proxy
  // translator landed, every known compat tier reaches Codex Runtime
  // so the picker re-enables those rows. The pin here exercises the
  // full chain — invoke the API route, walk every returned row, and
  // assert non-`unknown` tiers carry `codex_runtime` in supportedRuntimes.
  it('GET /api/providers/models response shape: known-tier rows include codex_runtime in supportedRuntimes', async () => {
    const { GET } = await import('@/app/api/providers/models/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://test.local/api/providers/models');
    const res = await GET(req);
    const data = (await res.json()) as {
      groups: Array<{
        provider_id: string;
        compat?: string;
        models: Array<{
          value: string;
          supportedRuntimes?: string[];
          unsupportedReasonByRuntime?: Record<string, string>;
        }>;
      }>;
    };
    assert.ok(Array.isArray(data.groups), 'response must include groups[]');

    // Every row must carry supportedRuntimes — picker gate reads this
    // per row. Missing annotation falls back to "universally supported".
    for (const g of data.groups) {
      for (const m of g.models) {
        assert.ok(
          Array.isArray(m.supportedRuntimes),
          `${g.provider_id}/${m.value} must carry supportedRuntimes — picker gate reads this per row`,
        );
      }
    }

    // Known tiers (everything except `unknown` and media-only) MUST
    // list codex_runtime in supportedRuntimes now that Phase 5b's
    // unified translator handles all three adapter families. The
    // built-in `env` provider (Claude Code default) is the ONE
    // explicit exception — Phase 5b deliberately excludes env from
    // Codex Runtime parity, so env rows must NOT carry codex_runtime
    // even though their tier (claude_code_ready) is otherwise ready.
    const phase5bReadyTiers = new Set([
      'claude_code_ready',
      'claude_code_verified',
      'claude_code_experimental',
      'openrouter_anthropic_skin',
      'codepilot_only',
    ]);
    let checkedNonEnv = false;
    let checkedEnv = false;
    for (const g of data.groups) {
      if (!g.compat || !phase5bReadyTiers.has(g.compat)) continue;
      const isEnv = g.provider_id === 'env';
      for (const m of g.models) {
        if (isEnv) {
          checkedEnv = true;
          assert.ok(
            !m.supportedRuntimes?.includes('codex_runtime'),
            `${g.provider_id} / ${m.value}: env (Claude Code default) MUST be excluded from codex_runtime — selecting it under Codex Runtime would fail to send`,
          );
          assert.match(
            m.unsupportedReasonByRuntime?.codex_runtime ?? '',
            /env|默认|Claude Code/,
            `${g.provider_id} / ${m.value}: env exclusion must surface a clear reason for the picker tooltip`,
          );
        } else {
          checkedNonEnv = true;
          assert.ok(
            m.supportedRuntimes?.includes('codex_runtime'),
            `${g.provider_id} (${g.compat}) / ${m.value} must list codex_runtime in supportedRuntimes — Phase 5b proxy adapter is ready for this tier`,
          );
          assert.equal(
            m.unsupportedReasonByRuntime?.codex_runtime,
            undefined,
            `${g.provider_id} / ${m.value} must not carry a codex_runtime reason — adapter is wired`,
          );
        }
      }
    }
    assert.ok(
      checkedNonEnv || checkedEnv,
      'expected at least one Phase 5b-ready tier provider (env or non-env) in the response so the codex_runtime supportedness can be exercised end-to-end',
    );
  });
});

describe('runtime-compat — codex_runtime supportedness after Phase 5b proxy adapter ships', () => {
  const src = fs.readFileSync(
    path.join(repoRoot, 'lib/runtime-compat.ts'),
    'utf8',
  );

  it('only the unknown tier still gates codex_runtime (wire format undeducible)', () => {
    // Phase 5b: every known compat tier routes through the unified
    // provider-proxy translator. `unknown` is the only tier where the
    // proxy can't pick a wire format without more info, so it stays
    // pending. The proxy-pending reason wording shifted from "尚未
    // 覆盖" (pre-5b sweep) to "暂未识别" (post-5b nuance — proxy is
    // live, just can't infer the protocol for this row).
    assert.match(
      src,
      /Codex provider proxy 暂未识别该 provider 类型，无法判定 wire format/,
    );
  });

  it('Phase 5b-ready tiers add codex_runtime to supported set', () => {
    // Mirror of the switch arms in `getModelCompat` — each Phase 5b
    // adapter-ready tier must call `supported.add('codex_runtime')`.
    for (const tier of [
      'claude_code_ready',
      'claude_code_verified',
      'claude_code_experimental',
      'openrouter_anthropic_skin',
      'codepilot_only',
    ]) {
      const tierBlock = src.match(
        new RegExp(`case ['"]${tier}['"]:[\\s\\S]{0,2000}?break;`),
      );
      assert.ok(tierBlock, `expected case '${tier}' in getModelCompat switch`);
      assert.match(
        tierBlock![0],
        /supported\.add\(['"]codex_runtime['"]\)/,
        `${tier} must add codex_runtime to the supported set — Phase 5b adapter handles it`,
      );
      assert.doesNotMatch(
        tierBlock![0],
        /reasons\.codex_runtime\s*=/,
        `${tier} must NOT set a codex_runtime reason — adapter is wired`,
      );
    }
  });

  it('unknown tier keeps codex_runtime gated with the new wire-format reason', () => {
    const tierBlock = src.match(/case ['"]unknown['"]:[\s\S]{0,2000}?break;/);
    assert.ok(tierBlock, 'expected case unknown in getModelCompat switch');
    assert.match(
      tierBlock![0],
      /reasons\.codex_runtime\s*=\s*CODEX_PROXY_PENDING_REASON_ZH/,
      'unknown tier must still surface the proxy-pending reason',
    );
    assert.doesNotMatch(
      tierBlock![0],
      /supported\.add\(['"]codex_runtime['"]\)/,
      'unknown tier must NOT add codex_runtime to supported — proxy can\'t infer wire format',
    );
  });
});

describe('useProviderModels — full-catalog fetch + client-side compat (Phase 6 UI收口 P2)', () => {
  const hookSrc = fs.readFileSync(
    path.join(repoRoot, 'hooks/useProviderModels.ts'),
    'utf8',
  );

  it('hook fetches /api/providers/models WITHOUT a runtime filter', () => {
    // Pre-P2 the hook appended ?runtime=X so the server filtered the
    // catalog. P2 inverted that: hook always fetches the full
    // catalog, runtime gating happens client-side via
    // compatibleProviderGroups.
    assert.match(hookSrc, /const\s+url\s*=\s*['"]\/api\/providers\/models['"]/);
    assert.doesNotMatch(hookSrc, /\/api\/providers\/models\?runtime=\$\{/);
  });

  it('derives compatibleProviderGroups from the full catalog + runtime param', () => {
    assert.match(hookSrc, /const\s+compatibleProviderGroups\s*=\s*useMemo/);
    // The filter pattern: keep rows without an annotation (legacy
    // fallback) OR rows whose `supportedRuntimes` lists the active
    // runtime. Two clauses, joined by `||`, anchored on the row var.
    assert.match(
      hookSrc,
      /!m\.supportedRuntimes\s*\|\|\s*m\.supportedRuntimes\.includes\(runtime\)/,
    );
  });

  it('noCompatibleProvider is derived from compatibleProviderGroups (not the raw catalog)', () => {
    assert.match(
      hookSrc,
      /noCompatibleProvider:[\s\S]{0,200}compatibleProviderGroups\.length\s*===\s*0/,
    );
  });
});

describe('/api/providers/models — annotated rows always (Phase 6 UI收口 P2)', () => {
  const routeSrc = fs.readFileSync(
    path.join(repoRoot, 'app/api/providers/models/route.ts'),
    'utf8',
  );

  it('every model row carries supportedRuntimes + unsupportedReasonByRuntime', () => {
    // Pre-P2 these fields were computed per-row inside the filter
    // block and then dropped. P2 promotes them to first-class
    // response fields so the picker can render disabled rows + the
    // tooltip without re-running getModelCompat on the client.
    //
    // Phase 5b: the values pass through local variables (so the env
    // exclusion can strip codex_runtime from env rows). Pin the
    // intent (each output row has both fields) rather than the exact
    // expression shape so future tweaks don't accidentally drop them.
    assert.match(routeSrc, /supportedRuntimes,/);
    assert.match(routeSrc, /unsupportedReasonByRuntime,/);
    // The cap pair still has to be the source — assert both names
    // appear, just not necessarily on the same line as the output.
    assert.match(routeSrc, /cap\.supportedRuntimes/);
    assert.match(routeSrc, /cap\.unsupportedReasonByRuntime/);
  });

  it('media rows are still dropped at the row layer (do not belong in chat pickers)', () => {
    // Image / video / embedding don't surface in chat picker
    // regardless of runtime gating — this guard predates P2 and
    // must survive the refactor.
    assert.match(routeSrc, /if\s*\(\s*cap\.media\s*\)\s*return\s+null/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Slice C — Electron before-quit dispose
// ─────────────────────────────────────────────────────────────────────

describe('Electron before-quit — Codex app-server dispose (Slice C)', () => {
  const electronMainSrc = fs.readFileSync(
    path.join(repoRoot, '..', 'electron', 'main.ts'),
    'utf8',
  );

  it('before-quit handler fetches /api/codex/dispose before killServer', () => {
    // Pin the relative ordering by string indices anchored on the
    // 'before-quit' handler start. Non-greedy regex-extracting the
    // handler block doesn't work — nested })s in the embedded
    // Promise.race / setTimeout closures make the match terminate
    // early on the wrong })s.
    const beforeQuitIdx = electronMainSrc.indexOf("app.on('before-quit'");
    const disposeIdx = electronMainSrc.indexOf('/api/codex/dispose', beforeQuitIdx);
    const killServerIdx = electronMainSrc.indexOf('await killServer()', beforeQuitIdx);
    assert.ok(beforeQuitIdx > 0, "app.on('before-quit') handler must exist");
    assert.ok(disposeIdx > beforeQuitIdx, 'dispose fetch must appear after before-quit handler opens');
    assert.ok(killServerIdx > beforeQuitIdx, 'killServer call must appear in before-quit handler');
    assert.ok(
      disposeIdx < killServerIdx,
      'dispose fetch must come BEFORE killServer (graceful before force-kill)',
    );
  });

  it('dispose fetch has a timeout race so a hang cannot block app exit', () => {
    // 1.5s budget per the route docstring — without this the entire
    // quit waits on a hung fetch, which is worse than the orphan we're
    // trying to prevent.
    assert.match(
      electronMainSrc,
      /Promise\.race\([\s\S]{0,500}\/api\/codex\/dispose[\s\S]{0,500}setTimeout\(/,
    );
  });

  it('/api/codex/dispose route exists and calls disposeCodexAppServer', () => {
    const routeSrc = fs.readFileSync(
      path.join(repoRoot, 'app/api/codex/dispose/route.ts'),
      'utf8',
    );
    assert.match(
      routeSrc,
      /import\s*\{\s*disposeCodexAppServer\s*\}\s*from\s*['"]@\/lib\/codex\/app-server-manager['"]/,
    );
    assert.match(routeSrc, /export\s+async\s+function\s+POST/);
    assert.match(routeSrc, /await\s+disposeCodexAppServer\(\)/);
  });
});
