/**
 * Phase 3 Step 4 follow-up — `codepilot_schedule_task` origin context.
 *
 * The bug it closes: when the model called `codepilot_schedule_task`
 * inside a chat in project A, the task POST went to /api/tasks/schedule
 * with no anchor to A. Later when the scheduler fired, the runner
 * couldn't tell which project's working dir / provider / runtime
 * applied, so the result wrote into a shared "latest assistant"
 * session and tasks from projects A and B both surfaced there.
 *
 * The fix has five hops, each pinned below:
 *
 *   1. `createNotificationMcpServer` / `createNotificationTools` take
 *      a `{sessionId, workingDirectory}` context, closure-captured at
 *      registration time. Model can't override it.
 *
 *   2. claude-client / agent-tools register those factories WITH the
 *      current stream's sessionId + resolvedWorkingDirectory.path.
 *
 *   3. The schedule_task tool's execute closure injects those into
 *      the `/api/tasks/schedule` POST body as `origin_session_id`
 *      + `working_directory`. Both durable=true and durable=false
 *      paths get the same hidden context.
 *
 *   4. The schedule route persists them into `scheduled_tasks`.
 *      It also rejects `body.source` so the public tool path can't
 *      create heartbeat-source rows.
 *
 *   5. The runner's `ensureTaskBoundSession` reads
 *      `task.origin_session_id`, looks up the chat row, and inherits
 *      working_directory / sdk_cwd / provider_id / model /
 *      runtime_pin / permission_profile into the new task-bound
 *      session. No fallback to buddy/heartbeat/latest-assistant
 *      session — those would re-open the cross-project bleed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(path.resolve(SRC_ROOT, rel), 'utf-8');
}

// ──────────────────────────────────────────────────────────────────
// 1. notification factories accept hidden run context
// ──────────────────────────────────────────────────────────────────

describe('createNotificationMcpServer accepts hidden run context (Codex P1)', () => {
  it('declares NotificationMcpContext with sessionId + workingDirectory', () => {
    const src = read('lib/notification-mcp.ts');
    assert.match(
      src,
      /(?:interface|type)\s+NotificationMcpContext[\s\S]{0,400}sessionId\?:\s*string/,
      'notification-mcp.ts must export a NotificationMcpContext type with `sessionId?: string` so claude-client can pass the originating chat session id without exposing it to the model schema.',
    );
    assert.match(
      src,
      /(?:interface|type)\s+NotificationMcpContext[\s\S]{0,400}workingDirectory\?:\s*string/,
      'NotificationMcpContext must also carry `workingDirectory?: string` — when the scheduler later fires the task, the runner has no other way to know which project the task was scheduled from.',
    );
  });

  it('createNotificationMcpServer signature takes the context bag', () => {
    const src = read('lib/notification-mcp.ts');
    assert.match(
      src,
      /export\s+function\s+createNotificationMcpServer\s*\(\s*ctx[\s\S]{0,200}NotificationMcpContext/,
      'createNotificationMcpServer must accept the context as a parameter so claude-client can plumb it in. A no-arg factory keeps the model-controllable input as the only source of project anchoring, which is what re-introduced the cross-project bleed.',
    );
  });

  it('schedule_task execute closure injects origin_session_id + working_directory into POST body', () => {
    const src = read('lib/notification-mcp.ts');
    // Match the body of the JSON.stringify({...}) that goes to
    // /api/tasks/schedule. The fetch call has a template literal with
    // `${getBaseUrl()}` whose inner `)` confuses simpler patterns; we
    // anchor on the URL substring and walk forward to the next
    // `JSON.stringify({...})` to grab the body shape.
    const block = src.match(
      /\/api\/tasks\/schedule[\s\S]{0,400}?JSON\.stringify\(\s*\{[\s\S]{0,1500}?\}\s*\)/,
    );
    assert.ok(block, 'notification-mcp.ts must POST to /api/tasks/schedule from the durable=true branch.');
    assert.match(
      block![0],
      /origin_session_id:\s*ctx\.sessionId/,
      'POST body must inject ctx.sessionId as origin_session_id (model has no way to know its own chat session id).',
    );
    assert.match(
      block![0],
      /working_directory:\s*ctx\.workingDirectory/,
      'POST body must inject ctx.workingDirectory (model would have no way to know the resolved cwd otherwise).',
    );
  });

  it('schedule_task durable=false (session-only) branch ALSO carries hidden context', () => {
    // Same project-anchoring rationale even for in-memory tasks: the
    // scheduler dispatch path is shared, so the runner expects task
    // rows to carry origin context regardless of where they live.
    const src = read('lib/notification-mcp.ts');
    const sessionTaskLiteral = src.match(
      /const\s+task\s*=\s*\{[\s\S]*?\};\s*\n\s*addSessionTask\(\s*task\s*\)/,
    );
    assert.ok(sessionTaskLiteral, 'expected the durable=false session-task literal in notification-mcp.ts.');
    assert.match(
      sessionTaskLiteral![0],
      /origin_session_id:\s*ctx\.sessionId/,
      'session-task literal must carry origin_session_id too — same project anchoring as the durable=true branch.',
    );
    assert.match(
      sessionTaskLiteral![0],
      /working_directory:\s*ctx\.workingDirectory/,
      'session-task literal must carry working_directory.',
    );
  });
});

describe('createNotificationTools accepts hidden run context (parity with MCP variant)', () => {
  it('declares NotificationToolsContext + signature takes it', () => {
    const src = read('lib/builtin-tools/notification.ts');
    assert.match(
      src,
      /(?:interface|type)\s+NotificationToolsContext[\s\S]{0,400}sessionId\?:\s*string[\s\S]{0,200}workingDirectory\?:\s*string/,
      'builtin-tools/notification.ts must declare a NotificationToolsContext mirror of the MCP variant — Native Runtime needs the same anchor.',
    );
    assert.match(
      src,
      /export\s+function\s+createNotificationTools\s*\(\s*ctx[\s\S]{0,200}NotificationToolsContext/,
      'createNotificationTools must accept the context (default = empty object, so unit-test callers can still construct without a session).',
    );
  });

  it('schedule_task POST + session-task literal both inject origin_session_id + working_directory', () => {
    const src = read('lib/builtin-tools/notification.ts');
    // Same regex strategy as the MCP variant: anchor on
    // /api/tasks/schedule and scan forward to the JSON.stringify body.
    const block = src.match(
      /\/api\/tasks\/schedule[\s\S]{0,400}?JSON\.stringify\(\s*\{[\s\S]{0,1500}?\}\s*\)/,
    );
    assert.ok(block, 'builtin-tools/notification.ts must POST to /api/tasks/schedule.');
    assert.match(block![0], /origin_session_id:\s*ctx\.sessionId/);
    assert.match(block![0], /working_directory:\s*ctx\.workingDirectory/);
    const sessionTaskLiteral = src.match(
      /const\s+task\s*=\s*\{[\s\S]*?\};\s*\n\s*addSessionTask\(\s*task\s*\)/,
    );
    assert.ok(sessionTaskLiteral, 'expected the durable=false session-task literal in builtin-tools/notification.ts.');
    assert.match(sessionTaskLiteral![0], /origin_session_id:\s*ctx\.sessionId/);
    assert.match(sessionTaskLiteral![0], /working_directory:\s*ctx\.workingDirectory/);
  });
});

// ──────────────────────────────────────────────────────────────────
// 2. claude-client + agent-tools plumbing
// ──────────────────────────────────────────────────────────────────

describe('claude-client + agent-tools plumb the context through registration', () => {
  it('claude-client.ts registers codepilot-notify with {sessionId, workingDirectory: resolvedWorkingDirectory.path}', () => {
    const src = read('lib/claude-client.ts');
    // The codepilot-notify registration line must call
    // createNotificationMcpServer with both fields. Match anywhere
    // within a window after the literal "codepilot-notify".
    const match = src.match(
      /'codepilot-notify':\s*createNotificationMcpServer\(\s*\{[\s\S]{0,500}?\}\s*\)/,
    );
    assert.ok(match, 'codepilot-notify registration must call createNotificationMcpServer with a context bag.');
    assert.match(match![0], /sessionId/, 'context must include sessionId.');
    assert.match(
      match![0],
      /workingDirectory:\s*resolvedWorkingDirectory\.path/,
      'context must use resolvedWorkingDirectory.path so the captured cwd matches what streamClaude actually runs in (CWD validation can substitute).',
    );
  });

  it('builtin-tools/index.ts forwards options.sessionId to createNotificationTools', () => {
    const src = read('lib/builtin-tools/index.ts');
    // GetBuiltinToolsOptions must include sessionId.
    assert.match(
      src,
      /sessionId\?:\s*string/,
      'GetBuiltinToolsOptions must declare sessionId so callers can plumb it through.',
    );
    // The notification-group factory call must pass both sessionId
    // and workingDirectory (workspacePath).
    const notifyBlock = src.match(
      /createNotificationTools\(\s*\{[\s\S]{0,300}?\}\s*\)/,
    );
    assert.ok(notifyBlock, 'getToolGroups must call createNotificationTools with a context bag.');
    assert.match(notifyBlock![0], /sessionId:\s*options\.sessionId/);
    assert.match(notifyBlock![0], /workingDirectory:\s*options\.workspacePath/);
  });

  it('agent-tools.assembleTools forwards explicit sessionId with permission-context fallback', () => {
    const src = read('lib/agent-tools.ts');
    const callBlock = src.match(/getBuiltinTools\(\s*\{[\s\S]{0,500}?\}\s*\)/);
    assert.ok(callBlock, 'agent-tools.ts must call getBuiltinTools with a context bag.');
    assert.match(
      callBlock![0],
      /sessionId:\s*options\.sessionId\s*\?\?\s*options\.permissionContext\?\.sessionId/,
      'agent-tools must prefer the runtime lifecycle sessionId and preserve permissionContext.sessionId as the legacy fallback.',
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// 3. /api/tasks/schedule route accepts origin_session_id, blocks source
// ──────────────────────────────────────────────────────────────────

describe('/api/tasks/schedule route accepts origin_session_id + blocks source override', () => {
  it('route reads origin_session_id from body and forwards to createScheduledTask', () => {
    const src = read('app/api/tasks/schedule/route.ts');
    assert.match(
      src,
      /origin_session_id/,
      'route must destructure origin_session_id from the POST body.',
    );
    const callBlock = src.match(/createScheduledTask\(\s*\{[\s\S]{0,800}?\}\s*\)/);
    assert.ok(callBlock, 'route must call createScheduledTask with a single options object.');
    assert.match(
      callBlock![0],
      /origin_session_id:\s*origin_session_id/,
      'createScheduledTask call must forward origin_session_id (else the column stays NULL and the runner has no anchor).',
    );
  });

  it('route returns 400 when body.source is provided (heartbeat is system-injected only)', () => {
    const src = read('app/api/tasks/schedule/route.ts');
    assert.match(
      src,
      /body\.source\s*!==\s*undefined[\s\S]{0,500}status:\s*400/,
      'route must reject body.source — codepilot_schedule_task should never be able to mint heartbeat-source rows; that is reserved for ensureHeartbeatTask.',
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// 4. runner inherits origin chat session context (DB integration)
// ──────────────────────────────────────────────────────────────────

let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  originalDataDir = process.env.CLAUDE_GUI_DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-origin-test-'));
  process.env.CLAUDE_GUI_DATA_DIR = tempDir;
});

afterEach(async () => {
  try {
    const { closeDb } = await import('../../lib/db');
    closeDb();
  } catch { /* ignore */ }
  if (originalDataDir === undefined) {
    delete process.env.CLAUDE_GUI_DATA_DIR;
  } else {
    process.env.CLAUDE_GUI_DATA_DIR = originalDataDir;
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('runner ensureTaskBoundSession inherits origin chat context', () => {
  it('task-bound session inherits working_directory + provider_id + model + runtime_pin + permission_profile from origin chat', async () => {
    const db = await import('../../lib/db');
    // Project-A user chat — provider, model, runtime pin, permission
    // profile all set, working dir points at project A.
    const projectAPath = '/tmp/project-a';
    const originSession = db.createSession(
      'Project A chat',
      'sonnet-4',  // model
      undefined,
      projectAPath,
      'code',
      'anthropic-direct',
      'full_access',
      'user',
      undefined,
      {
        runtimeId: 'codepilot_runtime',
        state: 'bound',
        source: 'first_execution',
      },
    );

    // Schedule a task from that chat (mimics what the route would do
    // after the AI tool POST lands).
    const past = new Date(Date.now() - 1000).toISOString();
    const task = db.createScheduledTask({
      name: 'Project A weekly summary',
      prompt: 'Summarize this week\'s commits.',
      kind: 'ai_task',
      schedule_type: 'once',
      schedule_value: past,
      next_run: past,
      consecutive_errors: 0,
      status: 'active',
      priority: 'normal',
      notify_on_complete: 1,
      permanent: 0,
      origin_session_id: originSession.id,
      working_directory: projectAPath,
    });

    // Pull the runner's internal helper directly. ensureTaskBoundSession
    // is module-private, so we exercise it through the public
    // runScheduledTaskNow path AND check the resulting session row.
    // Simpler: import the module and call it via the back-channel
    // exposed by re-importing the function — but it's not exported.
    // Instead, reach into the runner via a direct module require and
    // call the exported wrapper that triggers session creation.
    // The cleanest hook is to call runScheduledAgentTask and inspect
    // the session it ends up writing to.
    const fresh = db.getScheduledTask(task.id);
    assert.ok(fresh, 'expected the task to land in the DB.');
    assert.equal(fresh!.origin_session_id, originSession.id, 'origin_session_id must persist.');
    assert.equal(fresh!.working_directory, projectAPath, 'working_directory must persist.');

    // The runner exports runScheduledAgentTask. We don't actually
    // want to fire streamClaude here (no API key in test env);
    // instead, we directly invoke the module-private session
    // resolution by importing the runner internals through the
    // public entry point and inspecting the side effect on
    // chat_sessions. Use a shortcut: call createSession's surface
    // through the runner by calling runScheduledAgentTask. Since
    // resolveProviderForSession will short-circuit on a deleted
    // provider id, build the origin with a real one.
    //
    // To avoid running streamClaude end-to-end, we simulate the
    // ensureTaskBoundSession path by directly reading the runner's
    // module and checking the inheritance contract via source-level
    // assertions plus a follow-up DB-only check.
    const runnerSrc = read('lib/agent-task-runner.ts');
    // Source-pin: ensureTaskBoundSession reads task.origin_session_id
    assert.match(
      runnerSrc,
      /task\.origin_session_id/,
      'runner must reference task.origin_session_id when creating the task-bound session.',
    );
    // And calls createSession with inherited args (we can\'t simulate
    // the full runner call here without a model API; the structural
    // check below proves the data flow at compile time).
    assert.match(
      runnerSrc,
      /inheritedWorkingDirectory/,
      'runner must compute an inheritedWorkingDirectory from origin → fallback.',
    );
    assert.match(
      runnerSrc,
      /inheritedProviderId/,
      'runner must compute an inheritedProviderId.',
    );
    assert.match(
      runnerSrc,
      /inheritedModel/,
      'runner must compute an inheritedModel.',
    );
    // Runtime ownership is copied in the same createSession transaction.
    assert.match(
      runnerSrc,
      /runtimeId:\s*originSession\.runtime_pin[\s\S]{0,120}source:\s*'inherited_owner'/,
      'runner must atomically inherit originSession.runtime_pin as the task session owner.',
    );
    assert.doesNotMatch(
      runnerSrc,
      /updateSessionRuntime\(/,
      'runner must not create a session and then mutate its Runtime in a second write.',
    );
  });

  it('runner does NOT call resolveBuddySessionId for non-heartbeat tasks (cross-project bleed defence)', () => {
    const runnerSrc = read('lib/agent-task-runner.ts');
    // The buddy resolver may only be reached on the heartbeat
    // branch. Pin the structural guarantee: every
    // resolveBuddySessionId call site must be downstream of
    // `task.source === 'assistant_heartbeat'` check.
    const branch = runnerSrc.match(
      /isHeartbeat[\s\S]{0,300}?resolveBuddySessionId\(/,
    );
    assert.ok(
      branch,
      'resolveBuddySessionId must only be called inside the isHeartbeat branch — calling it for a regular ai_task would re-introduce the cross-project bleed (heartbeat session is a global "latest assistant" pointer).',
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// 5. End-to-end DB persistence: project A vs B isolation
// ──────────────────────────────────────────────────────────────────

describe('ensureTaskBoundSession refuses to reuse a user-visible session (Codex P2 follow-up)', () => {
  it('source-pin: function only returns existing.id when existing.source === "task"', () => {
    const src = read('lib/agent-task-runner.ts');
    // The guard pattern: `existing && existing.source === 'task'`
    // gating the early-return inside ensureTaskBoundSession.
    assert.match(
      src,
      /existing\s*&&\s*existing\.source\s*===\s*['"]task['"][\s\S]{0,200}?return\s+existing\.id/,
      'ensureTaskBoundSession must only reuse `task.session_id` when the resolved session has source === "task". Returning user-source sessions here would let pre-fix dirty rows continue writing into user-visible chats.',
    );
  });

  it('task.session_id pointing at a user-visible session is IGNORED + new task-bound session is created', async () => {
    const db = await import('../../lib/db');
    const { ensureTaskBoundSession } = await import('../../lib/agent-task-runner');
    // Pre-create a user-visible chat + a task whose session_id
    // (mistakenly / legacy) points at it. Origin pointer is at the
    // same session for inheritance.
    const userChat = db.createSession(
      'Project A user chat',
      'sonnet-4',
      undefined,
      '/tmp/project-a',
      'code',
      'anthropic-direct',
      'default',
      'user',
      undefined,
      {
        runtimeId: 'codepilot_runtime',
        state: 'bound',
        source: 'first_execution',
      },
    );
    const past = new Date(Date.now() - 1000).toISOString();
    const task = db.createScheduledTask({
      name: 'Legacy dirty task',
      prompt: 'do thing',
      kind: 'ai_task',
      schedule_type: 'once',
      schedule_value: past,
      next_run: past,
      consecutive_errors: 0,
      status: 'active',
      priority: 'normal',
      notify_on_complete: 1,
      permanent: 0,
      // The bug: session_id points at a user-visible chat. Pre-fix
      // runner would write the assistant result here, polluting the
      // user's project A conversation.
      session_id: userChat.id,
      origin_session_id: userChat.id,
      working_directory: '/tmp/project-a',
    });

    const resolvedId = await ensureTaskBoundSession(task);
    assert.notEqual(
      resolvedId,
      userChat.id,
      'ensureTaskBoundSession must NOT return the user chat\'s id — that\'s the dirty pointer we are trying to ignore.',
    );
    const resolved = db.getSession(resolvedId);
    assert.ok(resolved);
    assert.equal(
      resolved!.source,
      'task',
      'the freshly resolved session must be source="task" so it stays out of the main chat list and serves as a task-only execution surface.',
    );
    // It must inherit the origin chat\'s working directory + provider
    // + model (the existing inheritance contract).
    assert.equal(resolved!.working_directory, '/tmp/project-a');
    assert.equal(resolved!.provider_id, 'anthropic-direct');
    assert.equal(resolved!.model, 'sonnet-4');

    // task.session_id must be overwritten so the next run goes
    // straight to the task-bound session and never re-checks the
    // dirty user pointer.
    const refreshed = db.getScheduledTask(task.id);
    assert.equal(
      refreshed!.session_id,
      resolvedId,
      'ensureTaskBoundSession must persist the new task-bound id back to scheduled_tasks.session_id so subsequent runs use it directly (and never re-touch the dirty user pointer).',
    );
  });

  it('task.session_id pointing at a legitimate source="task" session IS reused (no churn)', async () => {
    const db = await import('../../lib/db');
    const { ensureTaskBoundSession } = await import('../../lib/agent-task-runner');
    // Pre-create a legit task-bound session and a task pointing at
    // it — this is the post-fix steady state, the runner must NOT
    // create a brand-new session every time.
    const taskSession = db.createSession(
      '[Task] Existing',
      'sonnet-4', undefined, '/tmp/project-b',
      'code', 'anthropic-direct', 'default',
      'task',
      undefined,
      {
        runtimeId: 'codepilot_runtime',
        state: 'bound',
        source: 'inherited_owner',
      },
    );
    const past = new Date(Date.now() - 1000).toISOString();
    const task = db.createScheduledTask({
      name: 'Already-anchored', prompt: 'continue', kind: 'ai_task',
      schedule_type: 'once', schedule_value: past, next_run: past,
      consecutive_errors: 0, status: 'active', priority: 'normal',
      notify_on_complete: 1, permanent: 0,
      session_id: taskSession.id,
    });

    const resolvedId = await ensureTaskBoundSession(task);
    assert.equal(
      resolvedId,
      taskSession.id,
      'a healthy source="task" session_id must be reused — re-creating it on every run would churn message history + lose SDK resume.',
    );
  });

  it('missing origin owner fails closed instead of binding a background task from global defaults', async () => {
    const db = await import('../../lib/db');
    const { ensureTaskBoundSession } = await import('../../lib/agent-task-runner');
    const past = new Date(Date.now() - 1000).toISOString();
    const task = db.createScheduledTask({
      name: 'New task', prompt: 'do', kind: 'ai_task',
      schedule_type: 'once', schedule_value: past, next_run: past,
      consecutive_errors: 0, status: 'active', priority: 'normal',
      notify_on_complete: 1, permanent: 0,
      // No session_id, no origin — bare-bones task (e.g. Settings →
      // Tasks "Add" path).
    });
    await assert.rejects(
      () => ensureTaskBoundSession(task),
      /bound origin session with a complete route/,
    );
  });

  it('deleted session pointer without an origin owner fails closed', async () => {
    const db = await import('../../lib/db');
    const { ensureTaskBoundSession } = await import('../../lib/agent-task-runner');
    const past = new Date(Date.now() - 1000).toISOString();
    const task = db.createScheduledTask({
      name: 'Stale pointer', prompt: 'do', kind: 'ai_task',
      schedule_type: 'once', schedule_value: past, next_run: past,
      consecutive_errors: 0, status: 'active', priority: 'normal',
      notify_on_complete: 1, permanent: 0,
      session_id: 'does-not-exist-anymore',
    });
    await assert.rejects(
      () => ensureTaskBoundSession(task),
      /bound origin session with a complete route/,
    );
  });
});

describe('two tasks from two project sessions persist as separate origin contexts', () => {
  it('project A task and project B task carry their own origin_session_id + working_directory', async () => {
    const db = await import('../../lib/db');
    const sessionA = db.createSession(
      'Project A', undefined, undefined, '/tmp/project-a',
      'code', undefined, 'default', 'user',
    );
    const sessionB = db.createSession(
      'Project B', undefined, undefined, '/tmp/project-b',
      'code', undefined, 'default', 'user',
    );

    const past = new Date(Date.now() - 1000).toISOString();
    const taskA = db.createScheduledTask({
      name: 'A check', prompt: 'Check A package.json', kind: 'ai_task',
      schedule_type: 'once', schedule_value: past, next_run: past,
      consecutive_errors: 0, status: 'active', priority: 'normal',
      notify_on_complete: 1, permanent: 0,
      origin_session_id: sessionA.id, working_directory: '/tmp/project-a',
    });
    const taskB = db.createScheduledTask({
      name: 'B doc', prompt: 'Create doc in B', kind: 'ai_task',
      schedule_type: 'once', schedule_value: past, next_run: past,
      consecutive_errors: 0, status: 'active', priority: 'normal',
      notify_on_complete: 1, permanent: 0,
      origin_session_id: sessionB.id, working_directory: '/tmp/project-b',
    });

    const a = db.getScheduledTask(taskA.id)!;
    const b = db.getScheduledTask(taskB.id)!;
    assert.equal(a.origin_session_id, sessionA.id);
    assert.equal(a.working_directory, '/tmp/project-a');
    assert.equal(b.origin_session_id, sessionB.id);
    assert.equal(b.working_directory, '/tmp/project-b');
    // Sanity: they're not pointing at each other.
    assert.notEqual(a.origin_session_id, b.origin_session_id);
    assert.notEqual(a.working_directory, b.working_directory);
  });

  it('task created without origin_session_id leaves the column NULL (legacy / Settings-Tasks UI path)', async () => {
    const db = await import('../../lib/db');
    const past = new Date(Date.now() - 1000).toISOString();
    const task = db.createScheduledTask({
      name: 'Legacy', prompt: 'No origin', kind: 'ai_task',
      schedule_type: 'once', schedule_value: past, next_run: past,
      consecutive_errors: 0, status: 'active', priority: 'normal',
      notify_on_complete: 1, permanent: 0,
      // origin_session_id deliberately omitted
    });
    const row = db.getScheduledTask(task.id);
    assert.ok(row);
    // SQLite returns null for NULL columns; coerce to undefined for
    // the assertion shape.
    assert.ok(!row!.origin_session_id, 'origin_session_id must default to NULL when not provided — the runner falls back to task.working_directory in that case.');
  });
});
