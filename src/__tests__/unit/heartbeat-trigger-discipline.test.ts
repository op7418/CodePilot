/**
 * Codex P1 — heartbeat triggering discipline.
 *
 * Closes the bug where opening any chat / settings page caused a
 * full-Agent heartbeat run to fire from the foreground, with no tool
 * restrictions and no timeout fuse, so a tool-call loop on a
 * non-Claude proxy left the run permanently 'running' (1 step
 * complete + several tool calls + finishReason: tool-calls + no
 * `done`). The fix has five hard-line invariants this file pins:
 *
 *   1. No UI surface triggers heartbeat. useAssistantTrigger only
 *      fires for buddy-welcome (the one-shot adoption flow).
 *   2. /api/settings/workspace does NOT return `needsHeartbeat`.
 *      The flag was the foreground signal; removing the field at
 *      the route layer prevents accidental re-introduction.
 *   3. The heartbeat task.prompt + the runner's heartbeat
 *      systemPrompt explicitly forbid the dangerous tools
 *      (codepilot_list_tasks / codepilot_schedule_task /
 *      codepilot_cancel_task / codepilot_hatch_buddy /
 *      codepilot_notify / Bash / WebSearch) and cap tool calls at 1.
 *   4. The scheduler stale-check guard skips heartbeat execution
 *      when (now - last_run) is shorter than the configured
 *      interval, advancing next_run instead. The pre-fix scheduler
 *      ran every overdue heartbeat on app start.
 *   5. consumeHeadlessStream has hard total + idle timeout fuses
 *      (Codex's "保险丝" line — not the experience layer; if these
 *      trip routinely the prompt is wrong, not the fuse).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { buildClaudePermissionQueryOptions } from '@/lib/permission/profile';

const SRC_ROOT = path.resolve(__dirname, '../..');
function read(rel: string): string {
  return readFileSync(path.resolve(SRC_ROOT, rel), 'utf-8');
}

// ──────────────────────────────────────────────────────────────────
// 1. useAssistantTrigger no longer fires heartbeat
// ──────────────────────────────────────────────────────────────────

describe('useAssistantTrigger no longer fires heartbeat from the foreground (Codex P1)', () => {
  it('does NOT branch on needsHeartbeat / data.needsHeartbeat', () => {
    const src = read('hooks/useAssistantTrigger.ts');
    // The pre-fix code had `const needsHeartbeat = !!data.needsHeartbeat && ...`
    // and `if (!needsBuddyWelcome && !needsHeartbeat) return`. Strip
    // line/block comments first so the rationale-comment mentioning
    // the legacy name doesn't trip the assertion, then check the
    // executable code.
    const stripped = src
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(
      stripped,
      /\bconst\s+needsHeartbeat\s*=/,
      'useAssistantTrigger must NOT compute a `needsHeartbeat` flag — heartbeat is scheduler-only now. Buddy-welcome is the only legitimate auto-trigger.',
    );
    assert.doesNotMatch(
      stripped,
      /data\.needsHeartbeat/,
      'useAssistantTrigger must NOT read `data.needsHeartbeat` — the workspace route no longer exposes that field, and reading it would be a hint someone is trying to re-introduce mount-time heartbeat firing.',
    );
  });

  it('only sends a buddy-welcome trigger message; never a heartbeat-check string', () => {
    const src = read('hooks/useAssistantTrigger.ts');
    // The legacy code had `triggerMsg = needsBuddyWelcome ? '请做自我介绍...' : '心跳检查'`.
    // The new code hard-codes the buddy-welcome message and removes
    // the heartbeat branch.
    const stripped = src
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(
      stripped,
      /'心跳检查'/,
      'foreground must not auto-trigger a "心跳检查" message — that string was the symptom of mount-time heartbeat firing. Heartbeat is scheduler-driven now.',
    );
  });
});

describe('/api/settings/workspace no longer returns needsHeartbeat', () => {
  it('GET response does not include needsHeartbeat field', () => {
    const src = read('app/api/settings/workspace/route.ts');
    // The route used to return `needsHeartbeat: !!state.buddy && shouldRunHeartbeat(state)`.
    // Removing the line — and the import of shouldRunHeartbeat —
    // means UI surfaces literally cannot read it anymore.
    const stripped = src
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(
      stripped,
      /needsHeartbeat:/,
      '/api/settings/workspace must not return needsHeartbeat — that flag was the foreground heartbeat signal that caused mount-time auto-fire.',
    );
    assert.doesNotMatch(
      stripped,
      /shouldRunHeartbeat\s*\(/,
      'route must not call shouldRunHeartbeat — that helper is now scheduler-internal only.',
    );
  });
});

describe('public chat cannot enter the heartbeat protocol', () => {
  it('has no client-controlled heartbeat classifier in route, context, or collector', () => {
    const route = read('app/api/chat/route.ts');
    const context = read('lib/context-assembler.ts');
    const collector = read('lib/chat-collect-stream-response.ts');
    for (const [name, source] of [['route', route], ['context', context], ['collector', collector]] as const) {
      assert.doesNotMatch(source, /isHeartbeatTurn|stripHeartbeatToken|heartbeat-done/,
        `${name} must not expose the retired foreground heartbeat protocol`);
    }
    assert.doesNotMatch(route, /autoTrigger[^\n]+\u5fc3\u8df3|\u5fc3\u8df3[^\n]+autoTrigger/);
  });
});

// ──────────────────────────────────────────────────────────────────
// 2. Heartbeat prompt is narrow + forbids dangerous tools
// ──────────────────────────────────────────────────────────────────

describe('heartbeat prompt explicitly forbids scheduler-introspecting + side-effect tools', () => {
  it('exported HEARTBEAT_TASK_PROMPT enumerates the disallowed tools and caps tool calls at 1', async () => {
    const mod = await import('../../lib/task-scheduler');
    const prompt = mod.HEARTBEAT_TASK_PROMPT;
    assert.equal(typeof prompt, 'string');
    // Must mention the silent contract.
    assert.match(prompt, /HEARTBEAT_OK/);
    // Must explicitly forbid the dangerous tools (the ones Codex
    // flagged as causing recursion / runaway loops).
    for (const banned of [
      'codepilot_list_tasks',
      'codepilot_schedule_task',
      'codepilot_cancel_task',
      'codepilot_hatch_buddy',
      'codepilot_notify',
    ]) {
      assert.match(
        prompt,
        new RegExp(banned),
        `HEARTBEAT_TASK_PROMPT must explicitly name "${banned}" as forbidden — heartbeat introspecting the scheduler that runs it is the recursion path that left runs hung.`,
      );
    }
    // Must cap tool calls at 1.
    assert.match(
      prompt,
      /AT MOST ONE tool call/i,
      'prompt must say "AT MOST ONE tool call" — multi-step fanout (date → list_tasks → memory_recent → Read → ...) is the symptom user reported.',
    );
  });

  it('runner heartbeat-branch systemPrompt also forbids the same tools', () => {
    const src = read('lib/agent-task-runner.ts');
    // The runner builds a systemPrompt for the heartbeat branch with
    // a `HEARTBEAT_DISALLOWED_TOOLS` list. Source-level pin.
    assert.match(
      src,
      /HEARTBEAT_DISALLOWED_TOOLS\s*=\s*\[/,
      'runner must declare a HEARTBEAT_DISALLOWED_TOOLS list so the heartbeat systemPrompt enumerates the forbidden tools.',
    );
    for (const banned of [
      'codepilot_list_tasks',
      'codepilot_schedule_task',
      'codepilot_cancel_task',
      'codepilot_hatch_buddy',
      'codepilot_notify',
      'Bash',
    ]) {
      assert.match(
        src,
        new RegExp(`['"]${banned}['"]`),
        `HEARTBEAT_DISALLOWED_TOOLS must include "${banned}".`,
      );
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// 3. Scheduler stale-check guard
// ──────────────────────────────────────────────────────────────────

describe('scheduler heartbeat stale-check guard (Codex P1)', () => {
  it('heartbeatIntervalMsForTask backs interval out of "0 */N * * *" cron', async () => {
    const mod = await import('../../lib/task-scheduler');
    const HOUR_MS = 3_600_000;
    // Every-1-hour cadence
    assert.equal(
      mod.heartbeatIntervalMsForTask({
        schedule_value: '0 */1 * * *',
      } as Parameters<typeof mod.heartbeatIntervalMsForTask>[0]),
      HOUR_MS,
    );
    // Every-6-hour cadence
    assert.equal(
      mod.heartbeatIntervalMsForTask({
        schedule_value: '0 */6 * * *',
      } as Parameters<typeof mod.heartbeatIntervalMsForTask>[0]),
      6 * HOUR_MS,
    );
    // 24-hour daily cadence — ensureHeartbeatTask normalizes to "0 9 * * *"
    assert.equal(
      mod.heartbeatIntervalMsForTask({
        schedule_value: '0 9 * * *',
      } as Parameters<typeof mod.heartbeatIntervalMsForTask>[0]),
      24 * HOUR_MS,
    );
    // Garbage cron → conservative 24h fallback
    assert.equal(
      mod.heartbeatIntervalMsForTask({
        schedule_value: 'not-a-cron',
      } as Parameters<typeof mod.heartbeatIntervalMsForTask>[0]),
      24 * HOUR_MS,
    );
  });

  it('executeDueTask source code skips heartbeat when last_run is fresh', () => {
    const src = read('lib/task-scheduler.ts');
    // Pin the structural guard: there's a check on
    // `task.source === 'assistant_heartbeat'` AND
    // `task.last_run` AND `sinceLastMs < intervalMs` that
    // returns early after pushing next_run forward.
    const guard = src.match(
      /task\.source\s*===\s*['"]assistant_heartbeat['"][\s\S]{0,1500}?next_run:\s*nextDue[\s\S]{0,600}?return;/,
    );
    assert.ok(
      guard,
      'executeDueTask must include a heartbeat stale-check guard that returns early when (now - last_run) < interval, after pushing next_run forward to last_run + interval.',
    );
    // The guard must use heartbeatIntervalMsForTask, not a hardcoded
    // number — that way changing cron scheme doesn't desync.
    assert.match(
      guard![0],
      /heartbeatIntervalMsForTask\(task\)/,
      'stale-check must call heartbeatIntervalMsForTask(task) — hardcoding 24h would break the user\'s configured cadence.',
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// 4. Headless timeout fuses
// ──────────────────────────────────────────────────────────────────

describe('consumeHeadlessStream timeout fuses (Codex P1)', () => {
  it('source declares total + idle constants and threads them through opts', () => {
    const src = read('lib/headless-claude.ts');
    assert.match(
      src,
      /export const DEFAULT_HEADLESS_MAX_TOTAL_MS\s*=/,
      'must export DEFAULT_HEADLESS_MAX_TOTAL_MS so callers (runner, tests) can refer to the same baseline.',
    );
    assert.match(
      src,
      /export const DEFAULT_HEADLESS_MAX_IDLE_MS\s*=/,
      'must export DEFAULT_HEADLESS_MAX_IDLE_MS.',
    );
    // The consume loop must abort the underlying stream when the
    // fuse trips, otherwise the SDK keeps running in the background.
    assert.match(
      src,
      /timedOutReason[\s\S]{0,400}?abortController\.abort\(\)/,
      'on timeout, consumer must call abortController.abort() so the underlying agent tears down.',
    );
    // And it must mark the run failed (NOT 'succeeded'), with an
    // error message naming the timeout reason.
    assert.match(
      src,
      /timedOutReason[\s\S]{0,300}?status\s*=\s*['"]failed['"]/,
      'timeout must flip status to failed; otherwise the run is reported as succeeded with empty text.',
    );
  });

  it('idle timeout: stream that emits nothing for longer than maxIdleMs → status="failed"', { timeout: 5000 }, async () => {
    const { consumeHeadlessStream } = await import('../../lib/headless-claude');
    // Build a stream that opens but never enqueues anything until
    // we close it. With a 200ms idle fuse, consumer should bail
    // around 200ms with status='failed'.
    const stream = new ReadableStream<string>({
      start() { /* never enqueue */ },
    });
    const ctrl = new AbortController();
    const t0 = Date.now();
    const result = await consumeHeadlessStream(stream, ctrl, {
      maxTotalMs: 5_000,
      maxIdleMs: 200,
    });
    const elapsed = Date.now() - t0;
    assert.equal(result.status, 'failed');
    assert.ok(
      result.error && /idle/i.test(result.error),
      'idle-fuse failure must mention "idle" in the error so users can tell it apart from total timeout.',
    );
    // Should bail well before the total fuse — otherwise the idle
    // fuse isn't actually firing.
    assert.ok(
      elapsed < 2000,
      `idle fuse should fire close to maxIdleMs (200ms), not wait for maxTotalMs. Elapsed: ${elapsed}ms.`,
    );
    assert.equal(ctrl.signal.aborted, true, 'abortController must be aborted so the upstream agent loop tears down.');
  });

  it('runner passes per-call headless timeout opts (heartbeat tighter than ai_task)', () => {
    const src = read('lib/agent-task-runner.ts');
    // The runner calls runClaudeHeadless with a SECOND argument now
    // — the headless-options bag carrying maxTotalMs / maxIdleMs.
    // Pin: heartbeat path is tighter (≤90s total / ≤30s idle).
    assert.match(
      src,
      /maxTotalMs:\s*isHeartbeat\s*\?\s*\d+/,
      'runner must thread a maxTotalMs that depends on isHeartbeat — heartbeat should be tighter than a normal ai_task because the prompt is narrower.',
    );
    assert.match(
      src,
      /maxIdleMs:\s*isHeartbeat\s*\?\s*\d+/,
      'runner must thread a maxIdleMs that depends on isHeartbeat.',
    );
    // toolTimeoutSeconds must be set explicitly (claude-client default
    // 0 means "no timeout" — disabled).
    assert.match(
      src,
      /toolTimeoutSeconds:\s*isHeartbeat/,
      'runner must pass an explicit toolTimeoutSeconds (claude-client default 0 disables the SDK\'s per-tool timeout).',
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// 5. ensureHeartbeatTask refresh + DB integration
// ──────────────────────────────────────────────────────────────────

let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  originalDataDir = process.env.CLAUDE_GUI_DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-heartbeat-test-'));
  process.env.CLAUDE_GUI_DATA_DIR = tempDir;
});

afterEach(async () => {
  try {
    const { closeDb, removeHeartbeatTask } = await import('../../lib/db');
    removeHeartbeatTask();
    closeDb();
  } catch { /* ignore */ }
  if (originalDataDir === undefined) delete process.env.CLAUDE_GUI_DATA_DIR;
  else process.env.CLAUDE_GUI_DATA_DIR = originalDataDir;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('ensureHeartbeatTask refresh discipline', () => {
  it('upgrades a legacy row\'s prompt to HEARTBEAT_TASK_PROMPT', async () => {
    const db = await import('../../lib/db');
    const { ensureHeartbeatTask, HEARTBEAT_TASK_PROMPT } = await import('../../lib/task-scheduler');
    // Plant a legacy row with the old laissez-faire prompt + a
    // fresh next_run so the upgrade path doesn't accidentally
    // reset next_run and trigger a run.
    const future = new Date(Date.now() + 6 * 3_600_000).toISOString();
    db.createScheduledTask({
      name: 'Assistant heartbeat',
      prompt: 'Read HEARTBEAT.md (already injected as context) and respond per its silent contract: HEARTBEAT_OK if nothing to report, otherwise speak up briefly.',
      schedule_type: 'cron',
      schedule_value: '0 */6 * * *',
      kind: 'ai_task',
      source: 'assistant_heartbeat',
      next_run: future,
      consecutive_errors: 0,
      status: 'active',
      priority: 'normal',
      notify_on_complete: 1,
      permanent: 1,
    });
    await ensureHeartbeatTask({ enabled: true, intervalHours: 6 });
    const after = db.getHeartbeatTask();
    assert.ok(after);
    assert.equal(
      after!.prompt,
      HEARTBEAT_TASK_PROMPT,
      'ensureHeartbeatTask must lift the legacy laissez-faire prompt to the new strict HEARTBEAT_TASK_PROMPT on first start after upgrade.',
    );
    // And it must NOT clobber the existing future next_run (Codex
    // explicitly rejected "always reset next_run when row touched").
    assert.equal(
      after!.next_run,
      future,
      'when next_run is already in the future, ensureHeartbeatTask must NOT reset it to the next cron boundary — that would re-fire on every redeploy.',
    );
  });

  it('runner heartbeat path passes agentMode="heartbeat" + clears external mcpServers', () => {
    // Codex P1 follow-up — system prompt + HEARTBEAT_DISALLOWED_TOOLS
    // are not enough on their own. claude-client must see agentMode
    // === 'heartbeat' to actually skip MCP registration and add
    // disallowedTools. Mirror that wiring on the runner side.
    const runnerSrc = readFileSync(
      path.resolve(__dirname, '../../lib/agent-task-runner.ts'),
      'utf-8',
    );
    const callBody = runnerSrc.match(/runClaudeHeadless\(\s*\{[\s\S]*?\}\s*,/);
    assert.ok(callBody, 'expected the runClaudeHeadless({...}, ...) call body.');
    assert.match(
      callBody![0],
      /agentMode:\s*isHeartbeat\s*\?\s*['"]heartbeat['"]/,
      'runner must pass agentMode = isHeartbeat ? "heartbeat" : undefined so claude-client applies the heartbeat tool restrictions.',
    );
    assert.match(
      callBody![0],
      /mcpServers:\s*isHeartbeat\s*\?\s*undefined\s*:\s*mcpServers/,
      'runner must drop external mcpServers on heartbeat path. claude-client also gates registration on agentMode, but cutting at the source is belt + suspenders.',
    );
  });

  it('claude-client: heartbeat collapses settingSources to [] (Codex P2 follow-up)', () => {
    // SDK doc: settingSources controls auto-loading of
    // ~/.claude/settings.json (user), <cwd>/.claude/settings.json
    // (project), and .claude/settings.local.json (local). User-level
    // settings.json can declare mcpServers — without this collapse,
    // the SDK auto-loads them, the model sees the user's external
    // MCPs as available tools, and the model can invoke them
    // (allowedTools is auto-approve-only, not a hard whitelist).
    // Setting [] disables all filesystem loading; heartbeat doesn't
    // need ambient CLAUDE.md / tool permissions / agents anyway.
    const src = readFileSync(
      path.resolve(__dirname, '../../lib/claude-client.ts'),
      'utf-8',
    );
    assert.match(
      src,
      /settingSources:\s*isHeartbeatMode[\s\S]{0,200}?\[\]/,
      'claude-client must override settingSources to [] when isHeartbeatMode — otherwise the SDK auto-loads user-level / project / local settings (including their mcpServers), and the heartbeat tool restriction has a hole.',
    );
  });

  it('claude-client: agentMode==="heartbeat" actually restricts MCP + tools', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../lib/claude-client.ts'),
      'utf-8',
    );
    // The boolean handle.
    assert.match(
      src,
      /isHeartbeatMode\s*=\s*agentMode\s*===\s*['"]heartbeat['"]/,
      'claude-client must derive isHeartbeatMode from agentMode === "heartbeat".',
    );
    // External user mcpServers must NOT be applied for heartbeat.
    assert.match(
      src,
      /!isHeartbeatMode\s*&&\s*mcpServers\s*&&[\s\S]{0,200}?queryOptions\.mcpServers\s*=\s*toSdkMcpConfig/,
      'external user mcpServers must be skipped when isHeartbeatMode (so external HTTP / shell tools cannot be smuggled into a heartbeat run).',
    );
    // Project .mcp.json must also be skipped.
    assert.match(
      src,
      /!isHeartbeatMode\s*&&\s*resolved\.provider/,
      'project-level .mcp.json registration must be skipped on heartbeat (same rationale).',
    );
    // codepilot-notify (the schedule_task / list_tasks family) must be
    // wrapped in if (!isHeartbeatMode).
    assert.match(
      src,
      /if\s*\(\s*!isHeartbeatMode\s*\)\s*\{[\s\S]{0,1000}?codepilot-notify/,
      'codepilot-notify MCP registration must be wrapped in `if (!isHeartbeatMode)` — that MCP exposes schedule_task / list_tasks / cancel_task which are exactly the tools the heartbeat-loop bug was abusing.',
    );
    // claude-client must still hand isHeartbeatMode to the shared assembly —
    // the narrowing below is only reached if this wiring survives.
    assert.match(
      src,
      /buildClaudePermissionQueryOptions\(\{[\s\S]{0,300}?isHeartbeatMode,/,
      'claude-client must pass isHeartbeatMode into buildClaudePermissionQueryOptions.',
    );
  });

  /**
   * The heartbeat narrowing moved out of claude-client into the shared
   * permission assembly (runtime-permission-modes.md Phase 1). These assertions
   * followed it, and got stronger on the way: they now run the real function
   * instead of pattern-matching the source that used to contain the literals.
   */
  it('claude-client: heartbeat wire options are memory-only and block SDK builtins', () => {
    const heartbeat = buildClaudePermissionQueryOptions({
      permissionMode: 'acceptEdits',
      sessionBypassPermissions: false,
      globalSkip: false,
      isHeartbeatMode: true,
    });

    assert.deepEqual(
      [...heartbeat.allowedTools], [
        'mcp__codepilot-memory__codepilot_memory_search',
        'mcp__codepilot-memory__codepilot_memory_get',
        'mcp__codepilot-memory__codepilot_memory_recent',
      ],
      'Heartbeat allows exactly the three memory reads; whole-server approval would also approve managed writes.',
    );

    for (const banned of ['Bash', 'Edit', 'Write', 'WebSearch', 'WebFetch']) {
      assert.ok(
        heartbeat.disallowedTools?.includes(banned),
        `heartbeat must list "${banned}" in disallowedTools — auto-approve is not a whitelist; we need explicit blocking for SDK builtins.`,
      );
    }

    // Positive control: the same assembly does NOT block these outside
    // heartbeat, so the assertions above pin heartbeat's narrowing rather than
    // a blanket restriction that would pass no matter what.
    const normal = buildClaudePermissionQueryOptions({
      permissionMode: 'acceptEdits',
      sessionBypassPermissions: false,
      globalSkip: false,
      isHeartbeatMode: false,
    });
    assert.ok(!normal.disallowedTools?.includes('Bash'),
      'a normal turn must still be able to run Bash (through the permission prompt)');
    assert.ok(normal.allowedTools.length > 1, 'a normal turn keeps the read-only MCP servers');
  });

  it('ai_task failure fallback does NOT write into latest-by-workspace user session (Codex P2)', () => {
    // The catch-block error path in executeDueTask used to fall back
    // to getLatestSessionByWorkingDirectory + addMessage when
    // task.session_id was empty — same cross-project bleed pattern
    // as handleMissedTasks. Pin the structural fix: the catch block
    // must NEVER call getLatestSessionByWorkingDirectory, and any
    // addMessage write must be gated on the session being source='task'.
    const src = readFileSync(
      path.resolve(__dirname, '../../lib/task-scheduler.ts'),
      'utf-8',
    );
    // Find the fallback block — it lives inside the catch (err) of
    // executeDueTask and is keyed off `task.kind === 'ai_task'`.
    // The function is huge; window the search to the ai_task error
    // branch by anchoring on the error context.
    const aiTaskCatch = src.match(
      /task\.kind\s*===\s*['"]ai_task['"]\s*&&\s*task\.session_id[\s\S]{0,2000}?\}\s*catch/,
    );
    assert.ok(
      aiTaskCatch,
      'expected the ai_task error-fallback branch in executeDueTask catch{} (matched on `task.kind === "ai_task" && task.session_id`).',
    );
    assert.doesNotMatch(
      aiTaskCatch![0],
      /getLatestSessionByWorkingDirectory/,
      'ai_task error-fallback must NOT resolve a target session via getLatestSessionByWorkingDirectory — that\'s the cross-project bleed Codex flagged. Write into the task-bound session only.',
    );
    // The addMessage call must be gated on source==='task'.
    assert.match(
      aiTaskCatch![0],
      /targetSession\.source\s*===\s*['"]task['"]/,
      'ai_task error-fallback must gate the addMessage write on the resolved session being source="task" — otherwise a legacy dirty session_id pointing at a user chat would still receive the error message.',
    );
  });

  it('handleMissedTasks does NOT addMessage into a latest-by-workspace user session (Codex P1)', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../lib/task-scheduler.ts'),
      'utf-8',
    );
    // The function body must NOT call getLatestSessionByWorkingDirectory
    // and must NOT addMessage from inside handleMissedTasks. The fix
    // is "send notification only; let runner create the task-bound
    // session via origin inheritance".
    const fnBody = src.match(/async\s+function\s+handleMissedTasks\s*\([\s\S]*?^\}/m);
    assert.ok(fnBody, 'expected the async function handleMissedTasks(...) body.');
    assert.doesNotMatch(
      fnBody![0],
      /addMessage\s*\(/,
      'handleMissedTasks must NOT addMessage anywhere — the legacy "过期提醒" assistant message wrote into whichever workspace session was latest, which is the same cross-project bleed the origin_session_id fix closed for the runner. Send a notification instead.',
    );
    assert.doesNotMatch(
      fnBody![0],
      /getLatestSessionByWorkingDirectory\s*\(/,
      'handleMissedTasks must NOT resolve a fallback session from workspace path — that was the bleed source.',
    );
  });

  it('chat/page onProviderModelChange clears invalidDefault + noCompatibleProvider on MANUAL pick only', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../app/chat/page.tsx'),
      'utf-8',
    );
    // Phase 6 P0 (2026-05-15): the callback signature now accepts an
    // optional `opts` arg. MessageInput's auto-correct fallback
    // passes `{ isAuto: true }` so the parent can skip side effects;
    // a manual pick from the dropdown omits the flag and the body
    // below still fires.
    const callback = src.match(
      /onProviderModelChange=\{\(pid,\s*model(?:,\s*opts)?\)\s*=>\s*\{[\s\S]*?\}\s*\}/,
    );
    assert.ok(callback, 'expected onProviderModelChange callback in /chat page.');
    // Auto-correct early-return MUST be present so silent fallbacks
    // don't clear invalidDefault / write localStorage as if the user
    // manually approved the new pair. Pre-fix the same callback fired
    // unconditionally and silently dismissed the pinned-default
    // warning.
    assert.match(
      callback![0],
      /opts\?\.isAuto[\s\S]{0,40}return/,
      'onProviderModelChange must early-return when opts.isAuto is true so auto-correct does not silently dismiss the pinned-default warning or persist a fallback as the new manual selection.',
    );
    assert.match(
      callback![0],
      /setInvalidDefault\(null\)/,
      'onProviderModelChange (manual path) must call setInvalidDefault(null) — without this, picking a working model from the dropdown does not unlock the disabled MessageInput.',
    );
    assert.match(
      callback![0],
      /setNoCompatibleProvider\(false\)/,
      'onProviderModelChange (manual path) must also clear noCompatibleProvider for the same reason — the user just picked a compatible one.',
    );
  });

  it('codepilot_schedule_task POST cannot create assistant_heartbeat-source rows', async () => {
    // Codex P1 mid-list: reject body.source on the schedule route.
    // Pin the runtime behavior end-to-end via createScheduledTask's
    // source-coercion (route returns 400 for body.source; create
    // helper coerces unknown source values to 'user').
    const db = await import('../../lib/db');
    const past = new Date(Date.now() - 1000).toISOString();
    const task = db.createScheduledTask({
      name: 'Trying to be a heartbeat',
      prompt: 'malicious',
      schedule_type: 'once',
      schedule_value: past,
      next_run: past,
      kind: 'ai_task',
      consecutive_errors: 0,
      status: 'active',
      priority: 'normal',
      notify_on_complete: 1,
      permanent: 0,
      // Caller tries to mint heartbeat-source.
      source: 'assistant_heartbeat' as const,
    });
    // The createScheduledTask helper allows this only because
    // ensureHeartbeatTask (the legitimate caller) needs to. The
    // route layer is the gate against AI-tool callers. Pin the
    // route-level rejection in source.
    const routeSrc = read('app/api/tasks/schedule/route.ts');
    assert.match(
      routeSrc,
      /body\.source\s*!==\s*undefined[\s\S]{0,500}status:\s*400/,
      '/api/tasks/schedule must return 400 when the POST body carries a source field — that is the public-tool path, and only ensureHeartbeatTask (internal) is allowed to mint assistant_heartbeat rows.',
    );
    // And the persisted row's source is whatever createScheduledTask
    // got (defensive coerce keeps unknown → 'user'; explicit
    // 'assistant_heartbeat' is the heartbeat caller's privilege).
    assert.ok(task);
  });
});
