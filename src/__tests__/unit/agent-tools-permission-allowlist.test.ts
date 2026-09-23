/**
 * Phase 5e Phase 0.5 review fix (P0 止血, 2026-05-17) — Native Runtime
 * permission allowlist regression tests.
 *
 * Pre-fix `src/lib/agent-tools.ts` waved EVERY `codepilot_*` tool past
 * the permission wrapper via `name.startsWith('codepilot_')`. That meant
 * the model could silently:
 *
 *   - run `codepilot_cli_tools_install / update / remove` — shell-exec
 *     npm / brew / pip install/uninstall
 *   - fire `codepilot_notify` — system-level toasts / Electron / Telegram
 *   - call `codepilot_dashboard_pin / update / remove` — mutate user's
 *     pinned widgets
 *   - call `codepilot_schedule_task` — durable cross-session DB writes
 *   - call `codepilot_generate_image` / `codepilot_import_media` — write
 *     files to the media library
 *   - call `codepilot_hatch_buddy` (when Native exposure ships) — create
 *     buddy assets in the workspace
 *
 * The Phase 0.5 audit (see
 * `docs/exec-plans/active/phase-5e-runtime-harness-architecture.md`)
 * called this the most dangerous gap on the Native Runtime; the user
 * directed an immediate stop-the-bleed patch BEFORE any larger
 * permission architecture refactor.
 *
 * These tests pin the patch so a future commit cannot re-introduce the
 * prefix-based shortcut.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PERMISSION_SAFE_TOOLS } from '@/lib/agent-tools';

const REPO_ROOT = path.resolve(__dirname, '../../..');

function readSource(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

/** Strip line + block comments so source-pin tests target real code,
 *  not explanatory comments that intentionally quote the pre-fix shape
 *  (e.g. JSDoc here that documents the pattern we forbid). */
function stripComments(src: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    const trimmed = raw.trimStart();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    const idx = raw.indexOf('//');
    out.push(idx >= 0 ? raw.slice(0, idx) : raw);
  }
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// (1) Source pin: no prefix-based codepilot_ shortcut
// ─────────────────────────────────────────────────────────────────────

describe('agent-tools.ts — no codepilot_ prefix shortcut (P0 regression pin)', () => {
  // Strip comments so the JSDoc above PERMISSION_SAFE_TOOLS (which
  // quotes the pre-fix shape for context) doesn't trip the source-pin.
  const SRC = stripComments(readSource('src/lib/agent-tools.ts'));

  it('agent-tools.ts must NOT contain `name.startsWith(\'codepilot_\')` in real code', () => {
    // The exact pre-fix shape. Re-appearing in code (not comments)
    // re-introduces the silent-install / silent-notify hole.
    assert.equal(
      /name\.startsWith\(\s*['"]codepilot_['"]\s*\)/.test(SRC),
      false,
      'agent-tools.ts contains `name.startsWith(\'codepilot_\')` — this is the pre-fix shortcut that lets every codepilot_* tool bypass permission. Use the explicit PERMISSION_SAFE_TOOLS allowlist instead.',
    );
  });

  it('agent-tools.ts must use PERMISSION_SAFE_TOOLS.has(name) in the wrapper', () => {
    assert.match(
      SRC,
      /PERMISSION_SAFE_TOOLS\.has\(name\)/,
      'wrapWithPermissions must consult PERMISSION_SAFE_TOOLS — the explicit allowlist is the only gate that decides which tools skip permission',
    );
  });

  it('PERMISSION_SAFE_TOOLS export exists + is a Set', () => {
    assert.ok(PERMISSION_SAFE_TOOLS instanceof Set);
    assert.ok(PERMISSION_SAFE_TOOLS.size > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// (2) Allowlist contents — read-only tools required to be present
// ─────────────────────────────────────────────────────────────────────

describe('PERMISSION_SAFE_TOOLS — read-only tools that MUST be on the list', () => {
  // Core read-only tools — same as READ_ONLY_TOOLS export but extended
  // with Skill (also read-only by SDK contract).
  for (const name of ['Read', 'Glob', 'Grep', 'Skill']) {
    it(`includes core read-only tool "${name}"`, () => {
      assert.ok(
        PERMISSION_SAFE_TOOLS.has(name),
        `${name} is a read-only core tool — it should not require approval`,
      );
    });
  }

  // CodePilot read-only tools — each entry must have a rationale; the
  // test description records WHY it's safe so a future reviewer can
  // sanity-check.
  const readOnlyCodePilotTools = [
    { name: 'codepilot_memory_recent', why: 'reads daily memory files only' },
    { name: 'codepilot_memory_search', why: 'searches memory text, no writes' },
    { name: 'codepilot_memory_get', why: 'retrieves a memory entry by id' },
    {
      name: 'codepilot_load_widget_guidelines',
      why: 'loads static design spec; no model state mutation',
    },
    {
      name: 'codepilot_list_tasks',
      why: 'queries task list; mutating schedule / cancel are NOT on the allowlist',
    },
    {
      name: 'codepilot_dashboard_list',
      why: 'queries pinned widget list; mutating pin / update / remove are NOT on the allowlist',
    },
    {
      name: 'codepilot_dashboard_refresh',
      why: 'dashboard.ts:12 — "Read source data for a widget"; does NOT mutate the pin set',
    },
    {
      name: 'codepilot_cli_tools_list',
      why: 'queries installed CLI tools; mutating install / update / remove are NOT on the allowlist',
    },
    {
      name: 'codepilot_cli_tools_check_updates',
      why: 'queries upstream registries for available updates; does not install anything',
    },
    {
      name: 'codepilot_session_search',
      why: 'reads SQLite messages table only',
    },
    {
      name: 'codepilot_list_subagent_runs',
      why: 'reads durable managed Sub-agent lifecycle facts for the current parent session',
    },
    {
      name: 'codepilot_spawn_subagent',
      why: 'spawning does not mutate host state; inherited child tools retain the parent approval/sandbox boundary and recursive delegation is blocked',
    },
  ];

  for (const { name, why } of readOnlyCodePilotTools) {
    it(`includes "${name}" (rationale: ${why})`, () => {
      assert.ok(PERMISSION_SAFE_TOOLS.has(name), `${name} missing from allowlist`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// (3) Allowlist contents — mutating tools that MUST NOT be on the list
// ─────────────────────────────────────────────────────────────────────

describe('PERMISSION_SAFE_TOOLS — mutating / side-effect tools that MUST NOT be on the list', () => {
  // Each entry pinned with the specific danger. Adding any of these to
  // the allowlist re-opens the P0 silent-side-effect hole.
  const mustRequirePermission = [
    { name: 'codepilot_memory_remember', danger: 'persists a workspace memory record' },
    { name: 'codepilot_memory_update', danger: 'replaces an active memory version' },
    { name: 'codepilot_memory_forget', danger: 'revokes and erases memory content' },
    // CLI install/uninstall — shell exec of npm / brew / pip etc.
    {
      name: 'codepilot_cli_tools_install',
      danger: 'shell-execs `npm install` / `brew install` / `pip install` etc.',
    },
    {
      name: 'codepilot_cli_tools_add',
      danger: 'adds tool to user CLI catalog (writes config)',
    },
    {
      name: 'codepilot_cli_tools_remove',
      danger: 'shell-execs uninstall commands',
    },
    {
      name: 'codepilot_cli_tools_update',
      danger: 'shell-execs upgrade commands',
    },
    // System notifications — user-visible side effects
    {
      name: 'codepilot_notify',
      danger: 'fires system toast / Electron notification / Telegram bridge',
    },
    // Durable DB writes that fire later cross-session
    {
      name: 'codepilot_schedule_task',
      danger: 'writes durable scheduled task; fires later cross-session',
    },
    {
      name: 'codepilot_cancel_task',
      danger: 'cancels user-created scheduled task',
    },
    // Buddy assets / workspace mutations
    {
      name: 'codepilot_hatch_buddy',
      danger: 'creates buddy assets in user workspace (Phase 5e round 8 follow-up: Native parity shipped — both ClaudeCode + Native mount this and write to assistant workspace metadata)',
    },
    // Media writes — external API calls + filesystem writes
    {
      name: 'codepilot_generate_image',
      danger: 'calls upstream image-gen API + writes to media library',
    },
    {
      name: 'codepilot_generate_video',
      danger: 'calls billed Grok Imagine video API + writes to media library',
    },
    {
      name: 'codepilot_import_media',
      danger: 'writes user file into the media library',
    },
    // Dashboard mutations — affects user's pinned widgets surface
    {
      name: 'codepilot_dashboard_pin',
      danger: 'pins widget to user dashboard (mutates UI surface)',
    },
    {
      name: 'codepilot_dashboard_update',
      danger: 'rewrites an existing pinned widget',
    },
    {
      name: 'codepilot_dashboard_remove',
      danger: 'unpins a widget',
    },
  ];

  for (const { name, danger } of mustRequirePermission) {
    it(`excludes "${name}" (danger: ${danger})`, () => {
      assert.equal(
        PERMISSION_SAFE_TOOLS.has(name),
        false,
        `${name} is on the allowlist but it is mutating / side-effecting (${danger}). Remove it; the permission wrapper is the fail-safe gate.`,
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// (4) AskUserQuestion — special case, must NOT be on allowlist
// ─────────────────────────────────────────────────────────────────────

describe('AskUserQuestion — must flow through the permission wrapper to render UI', () => {
  // AskUserQuestion is a Native-only built-in (no codepilot_ prefix
  // — already a quirk). It DOES go through the permission wrapper by
  // design: the wrapper emits a permission_request SSE which the
  // frontend renders as `AskUserQuestionUI` instead of the default
  // PermissionPrompt. Putting it on the allowlist would break that
  // rendering path. See ask-user-question.ts:10.
  it('AskUserQuestion is NOT on the allowlist (wrapper renders the UI)', () => {
    assert.equal(
      PERMISSION_SAFE_TOOLS.has('AskUserQuestion'),
      false,
      'AskUserQuestion must flow through the permission wrapper — that is how the frontend AskUserQuestionUI gets rendered',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// (5a) Set equality pin — PERMISSION_SAFE_TOOLS cannot silently grow.
//
//      Codex review (2026-05-17, post-P0): the earlier tests only
//      assert "X is on the list" / "Y is NOT on the list". They do not
//      assert the list is EXACTLY the set documented in the JSDoc.
//      Someone could add `codepilot_dashboard_pin` to the allowlist
//      (defeating the whole patch) and tests (1)-(4) would still pass
//      as long as the other already-pinned entries are intact.
//
//      This block fixes that: declare the expected allowlist here,
//      and assert set equality with the runtime value. Adding any
//      new entry to PERMISSION_SAFE_TOOLS REQUIRES adding it here
//      with a rationale; removing requires removing it here. Set
//      equality is the closed surface — no silent expansion.
// ─────────────────────────────────────────────────────────────────────

describe('PERMISSION_SAFE_TOOLS — exact set equality (no silent expansion)', () => {
  /** Expected allowlist, in lockstep with the production value. Each
   *  entry's rationale is documented in section (2) above. Membership
   *  rule (recap):
   *
   *    - reads filesystem / DB / network state (no writes)
   *    - returns the data inline (no side effects on user surfaces)
   *    - does NOT execute shell commands or install/uninstall software
   *
   *  Editing this list: add the entry here AND in PERMISSION_SAFE_TOOLS
   *  (src/lib/agent-tools.ts) AND in section (2) above with rationale.
   *  Set equality is what locks the closed surface. */
  const EXPECTED_ALLOWLIST: ReadonlySet<string> = new Set([
    // Core read-only
    'Read',
    'Glob',
    'Grep',
    'Skill',
    // CodePilot read-only
    'codepilot_memory_recent',
    'codepilot_memory_search',
    'codepilot_memory_get',
    'codepilot_load_widget_guidelines',
    'codepilot_list_tasks',
    'codepilot_dashboard_list',
    'codepilot_dashboard_refresh',
    'codepilot_cli_tools_list',
    'codepilot_cli_tools_check_updates',
    'codepilot_session_search',
    'codepilot_list_subagent_runs',
    'codepilot_spawn_subagent',
  ]);

  it('size is exactly the documented count (currently 16)', () => {
    // The literal count is part of the contract — bumping it requires
    // updating this test, which forces explicit reviewer attention to
    // the new entry.
    assert.equal(
      PERMISSION_SAFE_TOOLS.size,
      EXPECTED_ALLOWLIST.size,
      `PERMISSION_SAFE_TOOLS has ${PERMISSION_SAFE_TOOLS.size} entries; expected ${EXPECTED_ALLOWLIST.size}. If you added or removed an entry, update EXPECTED_ALLOWLIST + section (2) rationale + section (3) cross-check.`,
    );
  });

  it('no UNKNOWN entries (every member of PERMISSION_SAFE_TOOLS is in EXPECTED_ALLOWLIST)', () => {
    const unknown: string[] = [];
    for (const name of PERMISSION_SAFE_TOOLS) {
      if (!EXPECTED_ALLOWLIST.has(name)) unknown.push(name);
    }
    assert.deepEqual(
      unknown,
      [],
      `Unknown entries in PERMISSION_SAFE_TOOLS: ${unknown.join(', ')}. Adding to the production allowlist without updating EXPECTED_ALLOWLIST is forbidden — set equality is what closes the surface against silent expansion.`,
    );
  });

  it('no MISSING entries (every EXPECTED_ALLOWLIST member is in PERMISSION_SAFE_TOOLS)', () => {
    const missing: string[] = [];
    for (const name of EXPECTED_ALLOWLIST) {
      if (!PERMISSION_SAFE_TOOLS.has(name)) missing.push(name);
    }
    assert.deepEqual(
      missing,
      [],
      `Expected entries missing from PERMISSION_SAFE_TOOLS: ${missing.join(', ')}. EXPECTED_ALLOWLIST is the documented contract — removing from production without removing here is forbidden.`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// (5b) Cross-check: catalog tools not on allowlist all show up as
//     "mutating" candidates above. Catches new codepilot_* tools added
//     without being classified.
// ─────────────────────────────────────────────────────────────────────

describe('PERMISSION_SAFE_TOOLS — completeness vs capability catalog', () => {
  it('every catalog toolName is either allowlisted OR explicitly flagged as mutating in this test file', async () => {
    const { HARNESS_CAPABILITIES } = await import('@/lib/harness/capability-contract');
    const catalogTools = new Set<string>();
    for (const cap of HARNESS_CAPABILITIES) {
      for (const t of cap.toolNames) catalogTools.add(t);
    }
    // Tools classified as mutating in section (3) above. Keep in sync
    // with that list.
    const classifiedMutating = new Set<string>([
      'codepilot_memory_remember',
      'codepilot_memory_update',
      'codepilot_memory_forget',
      'codepilot_cli_tools_install',
      'codepilot_cli_tools_add',
      'codepilot_cli_tools_remove',
      'codepilot_cli_tools_update',
      'codepilot_notify',
      'codepilot_schedule_task',
      'codepilot_cancel_task',
      'codepilot_hatch_buddy',
      'codepilot_generate_image',
      'codepilot_generate_video',
      'codepilot_import_media',
      'codepilot_dashboard_pin',
      'codepilot_dashboard_update',
      'codepilot_dashboard_remove',
    ]);

    for (const toolName of catalogTools) {
      const allowed = PERMISSION_SAFE_TOOLS.has(toolName);
      const flaggedMutating = classifiedMutating.has(toolName);
      assert.ok(
        allowed || flaggedMutating,
        `Catalog tool "${toolName}" is NEITHER on PERMISSION_SAFE_TOOLS NOR explicitly flagged as mutating in this regression test. Classify it: either add to the allowlist with a rationale (if read-only) or add to the mutating list with the danger note.`,
      );
    }
  });
});
