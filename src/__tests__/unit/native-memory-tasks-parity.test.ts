/**
 * Phase 5e Phase 0.5 P1 parity (2026-05-18) — Native memory + tasks
 * runtime-level tests.
 *
 * Codex Phase 5e Phase 0.5 audit flagged four Native parity gaps:
 *   1. memory_search ignores `tags` / `file_type` parameters
 *   2. memory_recent reads `<workspace>/daily/` instead of authoritative
 *      `<workspace>/memory/daily/` + `<workspace>/memory.md`
 *   3. list_tasks doesn't merge session-only tasks
 *   4. cancel_task doesn't try session-only first
 *
 * These tests verify the FIX at runtime, not just source-grep.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Native memory_recent — authoritative memory layout', () => {
  let workspacePath: string;

  before(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mem-recent-'));
  });

  after(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clean and rebuild a known fixture each test
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.mkdirSync(workspacePath, { recursive: true });
  });

  it('reads memory/daily/<YYYY-MM-DD>.md (authoritative layout)', async () => {
    fs.mkdirSync(path.join(workspacePath, 'memory', 'daily'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, 'memory', 'daily', '2026-05-18.md'),
      '## 今天的笔记\nProject X notes.',
      'utf-8',
    );
    const { createMemorySearchTools } = await import('@/lib/builtin-tools/memory-search');
    const tools = createMemorySearchTools(workspacePath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recent = tools.codepilot_memory_recent as any;
    const result = (await recent.execute({}, {})) as string;
    assert.match(result, /2026-05-18\.md/);
    assert.match(result, /Project X/);
  });

  it('reads workspace memory.md as long-term summary', async () => {
    fs.writeFileSync(
      path.join(workspacePath, 'memory.md'),
      '# Long-term\nKey project facts.',
      'utf-8',
    );
    const { createMemorySearchTools } = await import('@/lib/builtin-tools/memory-search');
    const tools = createMemorySearchTools(workspacePath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recent = tools.codepilot_memory_recent as any;
    const result = (await recent.execute({}, {})) as string;
    assert.match(result, /Long-term Memory/);
    assert.match(result, /Key project facts/);
  });

  it('falls back to legacy daily/ + longterm/summary.md when authoritative layout absent', async () => {
    // Legacy workspace shape — pre-Phase-5e users still on old layout
    fs.mkdirSync(path.join(workspacePath, 'daily'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, 'daily', '2026-05-18.md'),
      'Legacy entry.',
      'utf-8',
    );
    const { createMemorySearchTools } = await import('@/lib/builtin-tools/memory-search');
    const tools = createMemorySearchTools(workspacePath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recent = tools.codepilot_memory_recent as any;
    const result = (await recent.execute({}, {})) as string;
    assert.match(result, /Legacy entry/);
  });
});

describe('Native list_tasks — runtime behaviour against session task fixtures', () => {
  // Phase 5e review fix P1 #3 (2026-05-18) — replaces the previous
  // source-pin tests with real runtime invocations that fail when
  // either (a) the session task field shape is wrong, or (b) the
  // status filter is forgotten on session rows. We mock `fetch` for
  // the durable /api/tasks/list call and populate the global session
  // task map directly (it lives on `globalThis` per task-scheduler.ts:22).

  const SESSION_TASKS_KEY = '__codepilot_session_tasks__' as const;

  function setSessionTasks(tasks: Record<string, unknown>[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    const map = new Map<string, unknown>();
    for (const t of tasks) map.set((t as { id: string }).id, t);
    g[SESSION_TASKS_KEY] = map;
  }

  function clearSessionTasks() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    g[SESSION_TASKS_KEY] = new Map();
  }

  function stubFetch(durable: Array<Record<string, unknown>>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    g.fetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ tasks: durable }),
      }) as unknown as Response;
  }

  afterEach(() => {
    clearSessionTasks();
  });

  it('renders session task with snake_case schedule_type / schedule_value (catches camelCase bug)', async () => {
    stubFetch([]);
    setSessionTasks([
      {
        id: 'sess-1',
        name: 'My session task',
        status: 'active',
        // Real ScheduledTask interface uses snake_case (src/types/index.ts:1683)
        schedule_type: 'interval',
        schedule_value: '5m',
        prompt: 'do thing',
        kind: 'reminder',
        next_run: '2026-05-18T00:00:00Z',
        consecutive_errors: 0,
        priority: 'normal',
        notify_on_complete: 0,
      },
    ]);

    const { createNotificationTools } = await import('@/lib/builtin-tools/notification');
    const tools = createNotificationTools({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listTasks = tools.codepilot_list_tasks as any;
    const result = (await listTasks.execute({}, {})) as string;

    // The schedule must render with the real values, not the
    // pre-fix fallback (which produced `[one-shot: ]`).
    assert.match(
      result,
      /\[interval: 5m\]/,
      `Native list_tasks must read snake_case schedule_type / schedule_value from session tasks. Got: ${result}`,
    );
    assert.match(result, /My session task/);
    assert.match(result, /session-only/);
    assert.equal(
      /\[one-shot:\s*\]/.test(result),
      false,
      'rendering [one-shot: ] would mean session fields are read as camelCase (the pre-fix bug)',
    );
  });

  it('status filter applies to session tasks (not just durable)', async () => {
    stubFetch([]);
    setSessionTasks([
      {
        id: 'sess-active',
        name: 'Active task',
        status: 'active',
        schedule_type: 'interval',
        schedule_value: '5m',
        prompt: '', kind: 'reminder', next_run: 'x', consecutive_errors: 0, priority: 'normal', notify_on_complete: 0,
      },
      {
        id: 'sess-paused',
        name: 'Paused task',
        status: 'paused',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        prompt: '', kind: 'reminder', next_run: 'x', consecutive_errors: 0, priority: 'normal', notify_on_complete: 0,
      },
    ]);

    const { createNotificationTools } = await import('@/lib/builtin-tools/notification');
    const tools = createNotificationTools({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listTasks = tools.codepilot_list_tasks as any;
    const result = (await listTasks.execute({ status: 'active' }, {})) as string;

    // Active included, paused excluded — status filter must apply to
    // session tasks too (mirrors MCP authority notification-mcp.ts:228).
    assert.match(result, /Active task/);
    assert.equal(
      result.includes('Paused task'),
      false,
      `status=active filter must exclude session tasks with status=paused. Got: ${result}`,
    );
  });

  it('status=all keeps every session task', async () => {
    stubFetch([]);
    setSessionTasks([
      { id: 's1', name: 'A', status: 'active',    schedule_type: 'cron', schedule_value: '0 1 * * *', prompt: '', kind: 'reminder', next_run: 'x', consecutive_errors: 0, priority: 'normal', notify_on_complete: 0 },
      { id: 's2', name: 'B', status: 'paused',    schedule_type: 'cron', schedule_value: '0 2 * * *', prompt: '', kind: 'reminder', next_run: 'x', consecutive_errors: 0, priority: 'normal', notify_on_complete: 0 },
      { id: 's3', name: 'C', status: 'completed', schedule_type: 'cron', schedule_value: '0 3 * * *', prompt: '', kind: 'reminder', next_run: 'x', consecutive_errors: 0, priority: 'normal', notify_on_complete: 0 },
    ]);

    const { createNotificationTools } = await import('@/lib/builtin-tools/notification');
    const tools = createNotificationTools({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listTasks = tools.codepilot_list_tasks as any;
    const result = (await listTasks.execute({ status: 'all' }, {})) as string;

    for (const name of ['A', 'B', 'C']) {
      assert.match(result, new RegExp(name));
    }
  });

  it('cancel_task removes session-only task BEFORE durable DELETE (runtime)', async () => {
    const target = {
      id: 'sess-to-cancel',
      name: 'cancel-me',
      status: 'active',
      schedule_type: 'cron',
      schedule_value: '0 5 * * *',
      prompt: '', kind: 'reminder' as const, next_run: 'x', consecutive_errors: 0, priority: 'normal' as const, notify_on_complete: 0,
    };
    setSessionTasks([target]);

    let durableDeleteCalled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') durableDeleteCalled = true;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    };

    const { createNotificationTools } = await import('@/lib/builtin-tools/notification');
    const tools = createNotificationTools({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cancelTask = tools.codepilot_cancel_task as any;
    const result = (await cancelTask.execute({ task_id: 'sess-to-cancel' }, {})) as string;

    assert.match(result, /session-only/);
    assert.equal(
      durableDeleteCalled,
      false,
      'cancel_task must NOT hit /api/tasks/:id DELETE when a session-only task with the same id exists — session-only removal is the first hit, durable is a fallback only',
    );

    // After cancel, the session map should no longer contain the task.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionMap = (globalThis as any)[SESSION_TASKS_KEY] as Map<string, unknown>;
    assert.equal(sessionMap.has('sess-to-cancel'), false);
  });

  it('cancel_task falls back to durable DELETE when no session-only match', async () => {
    setSessionTasks([]); // empty
    let durableDeleteCalled = false;
    let deleteUrl = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        durableDeleteCalled = true;
        deleteUrl = url;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    };

    const { createNotificationTools } = await import('@/lib/builtin-tools/notification');
    const tools = createNotificationTools({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cancelTask = tools.codepilot_cancel_task as any;
    const result = (await cancelTask.execute({ task_id: 'durable-only-id' }, {})) as string;

    assert.equal(durableDeleteCalled, true, 'durable DELETE must fire when no session-only match');
    assert.match(deleteUrl, /\/api\/tasks\/durable-only-id$/);
    assert.match(result, /cancelled/);
  });
});

describe('Native memory_search — tags + file_type real filtering', () => {
  it('memory_search filters a fresh workspace by tags and type before selecting hits', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mem-tags-'));
    try {
      fs.mkdirSync(path.join(workspacePath, 'memory/daily'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, 'memory/daily/2026-09-21.md'), '---\ntags: [chosen]\n---\n# Daily\napple');
      fs.writeFileSync(path.join(workspacePath, 'random.md'), '# apple\nwrong type and tag');
      const { createMemorySearchTools } = await import('@/lib/builtin-tools/memory-search');
      const execute = createMemorySearchTools(workspacePath).codepilot_memory_search!.execute!;
      const result = String(await execute({ query: 'apple', tags: ['chosen'], file_type: 'daily', limit: 1 }, { toolCallId: 'test', messages: [], context: {} }));
      assert.match(result, /2026-09-21/);
      assert.doesNotMatch(result, /random\.md/);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('memory_search file_type behaviour: filters daily-only when file_type=daily (runtime)', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mem-filter-'));
    try {
      // Set up workspace with a daily entry + a non-daily note
      fs.mkdirSync(path.join(workspacePath, 'memory', 'daily'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'memory', 'daily', '2026-05-18.md'),
        'apple orange banana',
        'utf-8',
      );
      fs.writeFileSync(path.join(workspacePath, 'random.md'), 'apple orange notes', 'utf-8');

      const { createMemorySearchTools } = await import('@/lib/builtin-tools/memory-search');
      const tools = createMemorySearchTools(workspacePath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const search = tools.codepilot_memory_search as any;

      // file_type=daily → only daily/ entries
      const dailyResult = (await search.execute({ query: 'apple', file_type: 'daily', limit: 10 }, {})) as string;
      // The result content varies based on the indexer state; the
      // key invariant: random.md must NOT appear when file_type=daily.
      assert.ok(
        !dailyResult.includes('random.md'),
        `file_type=daily must filter out non-daily files; got: ${dailyResult}`,
      );
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase 5e round 8 follow-up (2026-05-18) — Native parity for the
// assistant_buddy capability. The MCP authority
// (`src/lib/notification-mcp.ts:287`) mounts `codepilot_hatch_buddy`
// inside the same MCP server as notify / schedule / list / cancel.
// Round 8 user direction: "我们自家 Runtime 是基础盘 — CodePilot
// 不能停在 7/8". This block pins the Native factory's mount and
// blocks a catalog drift back to "claudecode-only".
// ─────────────────────────────────────────────────────────────────────

describe('Native createNotificationTools — assistant_buddy parity (round 8)', () => {
  it('createNotificationTools mounts codepilot_hatch_buddy', async () => {
    const { createNotificationTools } = await import('@/lib/builtin-tools/notification');
    const tools = createNotificationTools();
    assert.ok(
      Object.prototype.hasOwnProperty.call(tools, 'codepilot_hatch_buddy'),
      'Native factory must include codepilot_hatch_buddy alongside notify / schedule / list / cancel — mirrors the MCP authority for assistant_buddy capability',
    );
  });

  it('codepilot_hatch_buddy on Native has a description string and inputSchema', async () => {
    const { createNotificationTools } = await import('@/lib/builtin-tools/notification');
    const tools = createNotificationTools();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hatch = (tools as any).codepilot_hatch_buddy;
    assert.ok(hatch);
    assert.ok(
      typeof hatch.description === 'string' && hatch.description.length > 0,
      'tool must carry a description for the model to know when to call it',
    );
    assert.ok(hatch.inputSchema, 'tool must declare an inputSchema');
  });

  it('source pin: capability-contract.ts has assistant_buddy.exposure.native.kind === ai_sdk_tool', async () => {
    // Belt-and-suspenders: if a future commit flips Native exposure
    // BACK to 'unsupported' without removing the Native factory
    // mount above, the contract / matrix / Settings clipboard would
    // tell three different stories. This pin keeps them aligned.
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const src = fsMod.readFileSync(
      pathMod.resolve(__dirname, '../../lib/harness/capability-contract.ts'),
      'utf-8',
    );
    // Find the assistant_buddy block and assert native.kind = ai_sdk_tool
    const buddyBlock = src.match(/id:\s*'assistant_buddy'[\s\S]*?uiRenderPath:/);
    assert.ok(buddyBlock, 'cannot locate assistant_buddy block in capability-contract.ts');
    assert.match(
      buddyBlock![0],
      /native:\s*\{[\s\S]*?kind:\s*'ai_sdk_tool'/,
      'capability-contract.ts assistant_buddy.exposure.native.kind must be ai_sdk_tool (round 8 Native parity)',
    );
  });
});
