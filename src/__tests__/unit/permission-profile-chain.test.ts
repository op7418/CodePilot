/**
 * `runtime-permission-modes.md` Phase 0/1 — the three-profile union has to
 * survive the whole chain, not just the type file.
 *
 *   a01 — DB roundtrip + real route 400s
 *   a05 — bare `allowedTools` narrowing at the real options boundary
 *   a09 — negatives: nothing elevates a profile behind the user's back
 *
 * ## Why these call the real thing (review round #3, P1)
 *
 * The previous version asserted a01/a05/a09 by reading source files and
 * matching strings. That proves a file CONTAINS some text — not that the route
 * returns 400, not that the wire omits a server, not that a pending prompt
 * survives a profile switch. A rename or a reordered branch could keep every
 * assertion green while the behaviour broke. These now invoke the shipping
 * route handlers, the shipping options assembly and the shipping registry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSession, getSession, updateSessionAccessLevel, updateSessionPermissionProfile, createPermissionRequest } from '@/lib/db';
import { POST as createSessionRoute } from '@/app/api/chat/sessions/route';
import { PATCH as patchSessionRoute } from '@/app/api/chat/sessions/[id]/route';
import { registerPendingPermission, resolvePendingPermission } from '@/lib/permission-registry';
import {
  PERMISSION_PROFILES,
  isPermissionProfile,
  isHumanOnlyTool,
  buildClaudePermissionQueryOptions,
  decideHostToolPermission,
  type SessionPermissionProfile,
} from '@/lib/permission/profile';

const REPO_ROOT = path.resolve(__dirname, '../../..');
/**
 * Still used where the claim genuinely IS about the source: "this module never
 * names an elevated profile" is a statement about the code, and the absence of
 * a string is the honest way to assert it. Everything about behaviour below
 * calls the real thing instead.
 */
const readSource = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

/** Drives the real POST handler the composer hits. */
const postSession = (body: unknown) =>
  createSessionRoute(new Request('http://local/api/chat/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never);

/** Drives the real PATCH handler the permission chip hits. */
const patchSession = (id: string, body: unknown) =>
  patchSessionRoute(
    new Request(`http://local/api/chat/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id }) },
  );

describe('DB roundtrip (a01)', () => {
  it('persists and reads back every profile unchanged', () => {
    for (const profile of PERMISSION_PROFILES) {
      const session = createSession(`perm-${profile}`, '', '', '/tmp', 'code', '', profile);
      const loaded = getSession(session.id);
      assert.equal(loaded?.permission_profile, profile, `${profile} did not survive the roundtrip`);
    }
  });

  it('defaults to the restrictive profile when the caller passes nothing', () => {
    const session = createSession('perm-none', '', '', '/tmp', 'code', '');
    assert.equal(getSession(session.id)?.permission_profile, 'default');
  });

  it('updates across all three profiles', () => {
    const session = createSession('perm-update', '', '', '/tmp', 'code', '', 'default');
    for (const profile of ['auto_review', 'full_access', 'default'] as SessionPermissionProfile[]) {
      updateSessionPermissionProfile(session.id, profile);
      assert.equal(getSession(session.id)?.permission_profile, profile);
    }
  });

  it('updates the consolidated mode/profile pair through one DB boundary', () => {
    const session = createSession('perm-access-pair', '', '', '/tmp', 'code', '', 'auto_review');
    updateSessionAccessLevel(session.id, 'plan', 'default');
    assert.equal(getSession(session.id)?.mode, 'plan');
    assert.equal(getSession(session.id)?.permission_profile, 'default');
    updateSessionAccessLevel(session.id, 'code', 'full_access');
    assert.equal(getSession(session.id)?.mode, 'code');
    assert.equal(getSession(session.id)?.permission_profile, 'full_access');
  });

  it('writes fail closed if an unvalidated value reaches the DB layer', () => {
    const session = createSession('perm-bad', '', '', '/tmp', 'code', '', 'default');
    // Simulating an un-typechecked caller (JS, old client, bad migration).
    updateSessionPermissionProfile(session.id, 'super_admin' as unknown as SessionPermissionProfile);
    assert.equal(getSession(session.id)?.permission_profile, 'default',
      'an unknown profile must never persist as itself');
  });

  it('createSession fails closed on an unvalidated profile too', () => {
    const session = createSession('perm-bad-create', '', '', '/tmp', 'code', '',
      'full' as unknown as SessionPermissionProfile);
    assert.equal(getSession(session.id)?.permission_profile, 'default');
  });
});

describe('API validation rejects unknown profiles (a01)', () => {
  it('POST /api/chat/sessions 400s on an unknown profile, and persists nothing', async () => {
    const res = await postSession({
      working_directory: REPO_ROOT,
      permission_profile: 'super_admin',
    });
    assert.equal(res.status, 400, 'creation with an unknown profile must be rejected');
    const body = await res.json() as { error?: string };
    // The message names the legal values — a 400 the caller can't act on is
    // only marginally better than a silent coercion.
    assert.match(String(body.error), /permission_profile/);
    for (const profile of PERMISSION_PROFILES) assert.match(String(body.error), new RegExp(profile));
  });

  it('POST accepts each canonical profile and stores exactly what was asked for', async () => {
    for (const profile of PERMISSION_PROFILES) {
      const res = await postSession({ working_directory: REPO_ROOT, permission_profile: profile });
      assert.equal(res.status, 201, `${profile} must be accepted`);
      const { session } = await res.json() as { session: { id: string; permission_profile: string } };
      // Both what the caller is told AND what was stored — a route that
      // echoes the requested profile while persisting another is the exact
      // state-drift this contract exists to prevent.
      assert.equal(session.permission_profile, profile, `${profile} must be echoed back honestly`);
      assert.equal(getSession(session.id)?.permission_profile, profile,
        `${profile} must not be rewritten on the way in`);
    }
  });

  it('POST without a profile creates the restrictive one (no implicit elevation)', async () => {
    const res = await postSession({ working_directory: REPO_ROOT });
    const { session } = await res.json() as { session: { id: string } };
    assert.equal(getSession(session.id)?.permission_profile, 'default');
  });

  it('PATCH 400s on an unknown profile and leaves the stored profile untouched', async () => {
    const session = createSession('perm-patch-bad', '', '', '/tmp', 'code', '', 'auto_review');
    const res = await patchSession(session.id, { permission_profile: 'bypass' });
    assert.equal(res.status, 400);
    assert.equal(getSession(session.id)?.permission_profile, 'auto_review',
      'a rejected PATCH must not disturb the existing profile');
  });

  it('validates the consolidated mode/profile pair before writing either half', async () => {
    const session = createSession('perm-pair-bad', '', '', '/tmp', 'code', '', 'auto_review');
    const rejected = await patchSession(session.id, {
      mode: 'plan',
      permission_profile: 'bypass',
    });
    assert.equal(rejected.status, 400);
    assert.equal(getSession(session.id)?.mode, 'code');
    assert.equal(getSession(session.id)?.permission_profile, 'auto_review');

    const accepted = await patchSession(session.id, {
      mode: 'plan',
      permission_profile: 'default',
    });
    assert.equal(accepted.status, 200);
    assert.equal(getSession(session.id)?.mode, 'plan');
    assert.equal(getSession(session.id)?.permission_profile, 'default');
  });

  it('PATCH moves between all three profiles', async () => {
    const session = createSession('perm-patch-ok', '', '', '/tmp', 'code', '', 'default');
    for (const profile of ['auto_review', 'full_access', 'default'] as SessionPermissionProfile[]) {
      const res = await patchSession(session.id, { permission_profile: profile });
      assert.equal(res.status, 200, `PATCH to ${profile} should succeed`);
      assert.equal(getSession(session.id)?.permission_profile, profile);
    }
  });

  it('the union the routes reject against is the canonical one', () => {
    assert.equal(isPermissionProfile('auto_review'), true);
    assert.equal(isPermissionProfile('bypass'), false);
  });
});

describe('bare allowedTools narrowing at the real options boundary (a05)', () => {
  // The SHIPPING assembly — claude-client spreads this exact result into the
  // Agent SDK Options.
  const wire = (over: Partial<Parameters<typeof buildClaudePermissionQueryOptions>[0]> = {}) =>
    buildClaudePermissionQueryOptions({
      permissionMode: 'acceptEdits',
      sessionBypassPermissions: false,
      globalSkip: false,
      isHeartbeatMode: false,
      // Default this suite to "no external MCP" so the allowlist assertions
      // below test the allowlist, not the external-MCP gate. The gate has its
      // own suite in permission-external-mcp.test.ts.
      externalMcp: { present: false },
      ...over,
    });

  it('mutating MCP servers are absent from the wire allowlist', () => {
    const { allowedTools } = wire();
    // `allowedTools` is auto-approve, not a whitelist: presence here means the
    // request never reaches canUseTool. Each of these auto-approved a whole
    // server before — including codepilot_cli_tools_install, which shell-execs.
    for (const server of [
      'mcp__codepilot-cli-tools',
      'mcp__codepilot-media',
      'mcp__codepilot-image-gen',
      'mcp__codepilot-dashboard',
      'mcp__codepilot-notify',
    ]) {
      assert.ok(!allowedTools.includes(server),
        `${server} must not be auto-approved at the SDK boundary`);
    }
  });

  it('read-only MCP servers stay on the wire — they are why the list exists', () => {
    const { allowedTools } = wire();
    for (const server of ['mcp__codepilot-memory__codepilot_memory_search', 'mcp__codepilot-memory__codepilot_memory_get', 'mcp__codepilot-memory__codepilot_memory_recent', 'mcp__codepilot-widget', 'mcp__codepilot-widget-guidelines']) {
      assert.ok(allowedTools.includes(server), `${server} should remain prompt-free`);
    }
  });

  it('memory mutations are not auto-approved through the read server prefix', () => {
    const { allowedTools } = wire();
    for (const name of ['codepilot_memory_remember', 'codepilot_memory_update', 'codepilot_memory_forget']) {
      const qualified = `mcp__codepilot-memory__${name}`;
      assert.ok(!allowedTools.some(entry => qualified === entry || qualified.startsWith(`${entry}__`)));
      assert.notEqual(decideHostToolPermission(name).decision, 'rule-approved');
    }
    assert.ok(!allowedTools.includes('mcp__codepilot-memory'));
  });

  it('a mutating MCP tool now reaches the permission decision path', () => {
    const { allowedTools } = wire();
    // Two halves of one claim: the SDK won't auto-approve it (not covered by
    // any allowlist entry), and our own rule engine won't either — so it lands
    // in front of a human. Server-prefix check mirrors how the SDK matches a
    // bare server rule against `mcp__server__tool`.
    for (const tool of ['codepilot_generate_image', 'codepilot_cli_tools_install', 'codepilot_notify']) {
      const qualified = `mcp__codepilot-x__${tool}`;
      assert.ok(!allowedTools.some((entry) => qualified.startsWith(entry)),
        `${tool} must not be covered by a bare allowlist entry`);
      assert.notEqual(decideHostToolPermission(tool).decision, 'rule-approved',
        `${tool} must not be auto-approved by the rule engine either`);
    }
  });

  it('heartbeat narrowing does not regress (Codex P1)', () => {
    const { allowedTools, disallowedTools } = wire({ isHeartbeatMode: true });
    assert.deepEqual([...allowedTools], ['mcp__codepilot-memory__codepilot_memory_search', 'mcp__codepilot-memory__codepilot_memory_get', 'mcp__codepilot-memory__codepilot_memory_recent'], 'heartbeat must stay memory-read-only');
    for (const tool of ['Bash', 'Edit', 'Write', 'Read', 'WebFetch']) {
      assert.ok(disallowedTools?.includes(tool), `heartbeat must still block ${tool}`);
    }
  });

  it('the tools the old hand-written list waved through are now gated', () => {
    // These three sat in a drifted `autoApprovedTools` array and returned allow
    // before any classifier ran. They are the regression this guards.
    for (const tool of ['codepilot_generate_image', 'codepilot_cli_tools_add', 'codepilot_cli_tools_remove']) {
      assert.equal(isHumanOnlyTool(tool), true, `${tool} must now reach the user`);
      assert.equal(decideHostToolPermission(tool).decision, 'human-only');
    }
  });

  it('an UNKNOWN tool fails closed at the decision head, not just in a helper', () => {
    // The fail-closed claim is about what the callback DOES with a tool nobody
    // classified — asserting isHostAutoApproved(x) === false only shows one
    // helper's opinion.
    for (const tool of ['totally_unknown_tool', 'mcp__third-party__do_something', '']) {
      assert.equal(decideHostToolPermission(tool).decision, 'ask',
        `unknown tool ${tool || '(empty)'} must route to a human`);
    }
  });
});

describe('no path elevates a profile on its own (a09)', () => {
  it('background task sessions inherit, never upgrade', () => {
    const src = readSource('src/lib/agent-task-runner.ts');
    assert.ok(src.includes('normalizePermissionProfile(originSession?.permission_profile)'));
    assert.ok(!src.includes("'full_access'"), 'the task runner must never name an elevated profile');
  });

  it('worktree-derived sessions inherit, never upgrade', () => {
    const src = readSource('src/app/api/git/worktrees/derive/route.ts');
    assert.ok(src.includes('normalizePermissionProfile(source.permission_profile)'));
    assert.ok(!src.includes("'full_access'"));
  });

  it('the bridge never auto-approves under auto_review', () => {
    const src = readSource('src/lib/bridge/permission-broker.ts');
    assert.ok(src.includes("profile === 'full_access' && !humanOnly"),
      'only full_access may auto-approve, and only for non-human-only tools');
    assert.ok(!src.includes("profile === 'auto_review'"),
      'auto_review must not get an auto-approve branch in the bridge');
  });

  it('the bridge leaves human-only prompts for the user when elevating', () => {
    const src = readSource('src/lib/bridge/permission-broker.ts');
    assert.ok(src.includes('getHumanOnlyCategory(row.tool_name)'),
      'autoApprovePendingForSession must skip human-only rows');
  });

  it('the bridge never auto-approves under auto_review (source)', () => {
    const src = readSource('src/lib/bridge/permission-broker.ts');
    assert.ok(!src.includes("profile === 'auto_review'"),
      'auto_review must not get an auto-approve branch in the bridge');
  });
});

/**
 * In-flight prompts across a profile switch (a09), driven through the real
 * PATCH handler and the real pending-permission registry.
 *
 * The rule: only the deliberate `→ full_access` elevation resolves a prompt
 * that is already on screen — the user is looking at that request when they
 * click. Every other transition leaves it alone; `→ auto_review` especially,
 * because "let a model review things" is not a decision about the specific
 * question already in front of the user.
 */
describe('in-flight prompts across a profile switch (a09)', () => {
  /** Registers a pending prompt in BOTH the registry and the DB table the broker reads. */
  const arm = (sessionId: string, toolName: string) => {
    const id = `perm-${toolName}-${Math.random().toString(36).slice(2, 8)}`;
    createPermissionRequest({
      id,
      sessionId,
      toolName,
      toolInput: '{}',
      expiresAt: new Date(Date.now() + 300_000).toISOString().replace('T', ' ').split('.')[0],
    });
    let settled: unknown = null;
    const waiter = registerPendingPermission(id, {}).then((r) => {
      settled = r;
      return r;
    });
    const cleanup = async () => {
      // Tests that deliberately assert "still pending" must nevertheless
      // finalize the real registry entry before their worker exits. Otherwise
      // the five-minute production timer can survive the assertion and hold the
      // parallel full-suite worker open (the assertion is about the profile
      // transition, not about leaking a waiter forever).
      resolvePendingPermission(id, { behavior: 'deny', message: 'test cleanup' });
      await waiter;
      // clearTimeout() marks the timer destroyed synchronously, but Node emits
      // the async-resource destroy event on the next loop turn. Yield once so
      // the test worker cannot finish while that resource is still registered.
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    return { id, outcome: () => settled, cleanup };
  };

  it('switching to auto_review leaves the pending prompt for the user', async () => {
    const session = createSession('perm-inflight-auto', '', '', '/tmp', 'code', '', 'default');
    const pending = arm(session.id, 'Bash');
    try {
      const res = await patchSession(session.id, { permission_profile: 'auto_review' });
      assert.equal(res.status, 200);
      await new Promise((r) => setImmediate(r));

      assert.equal(pending.outcome(), null,
        'auto_review must not answer a question the user is already being asked');
    } finally {
      await pending.cleanup();
    }
  });

  it('switching to full_access resolves the pending prompt', async () => {
    const session = createSession('perm-inflight-full', '', '', '/tmp', 'code', '', 'default');
    const pending = arm(session.id, 'Bash');
    try {
      const res = await patchSession(session.id, { permission_profile: 'full_access' });
      assert.equal(res.status, 200);
      await new Promise((r) => setImmediate(r));

      assert.deepEqual((pending.outcome() as { behavior?: string })?.behavior, 'allow',
        'the user elevated while looking at this request — it should go through');
    } finally {
      await pending.cleanup();
    }
  });

  it('full_access does NOT resolve a pending human-only prompt', async () => {
    const session = createSession('perm-inflight-human', '', '', '/tmp', 'code', '', 'default');
    // Bills the user's image API — elevation is not consent to spend.
    const pending = arm(session.id, 'codepilot_generate_image');
    try {
      const res = await patchSession(session.id, { permission_profile: 'full_access' });
      assert.equal(res.status, 200);
      await new Promise((r) => setImmediate(r));

      assert.equal(pending.outcome(), null,
        'human-only prompts survive even the deliberate elevation');
    } finally {
      await pending.cleanup();
    }
  });

  it('leaving full_access does not resolve anything', async () => {
    const session = createSession('perm-inflight-down', '', '', '/tmp', 'code', '', 'full_access');
    const pending = arm(session.id, 'Bash');
    try {
      const res = await patchSession(session.id, { permission_profile: 'default' });
      assert.equal(res.status, 200);
      await new Promise((r) => setImmediate(r));

      assert.equal(pending.outcome(), null, 'de-escalating must never auto-allow');
    } finally {
      await pending.cleanup();
    }
  });

  it('the client cannot auto-click allow for a human-only tool', () => {
    const src = readSource('src/components/chat/PermissionPrompt.tsx');
    assert.ok(src.includes('isHumanOnlyTool'), 'the client must share the server classification');
    assert.ok(!src.includes("new Set(['AskUserQuestion'])"),
      'the drift-prone local set must be gone');
    assert.ok(!/permissionProfile === 'auto_review'[\s\S]{0,120}onPermissionResponse\('allow'\)/.test(src),
      'auto_review must never auto-approve in the client');
  });
});
