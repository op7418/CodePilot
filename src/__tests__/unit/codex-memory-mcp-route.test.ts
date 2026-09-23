/**
 * Phase 8 — CodePilot built-in MCP servers served to Codex over the generic
 * streamable-HTTP route (/api/codex/mcp/[server]). Phase 1 (memory) + #31 (widget).
 *
 * Run: npx tsx --test src/__tests__/unit/codex-memory-mcp-route.test.ts
 *
 * Concerns:
 *  (a) REUSE: routes mount the SAME createSdkMcpServer the ClaudeCode path
 *      uses (no duplicated tool logic) — proven via an in-memory MCP client.
 *  (b) ROUTE: the generic POST handler authorizes per-server (memory scoped
 *      to the configured workspace; widget open) and answers initialize.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMemorySearchMcpServer } from '@/lib/memory-search-mcp';
import { createWidgetMcpServer } from '@/lib/widget-guidelines';
import { createNotificationMcpServer } from '@/lib/notification-mcp';
import { getBuiltinMcpServer } from '@/lib/codex/builtin-mcp-servers';
import { POST } from '@/app/api/codex/mcp/[server]/route';
import { getSetting, setSetting, createSession } from '@/lib/db';

import { bindAssistantMemory } from '@/lib/memory-binding';

let ws: string;
let otherWs: string;
let priorAssistantWs: string | undefined;
let sessionId: string;
let projectSessionId: string;
let planSessionId: string;
before(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mem-mcp-'));
  fs.writeFileSync(path.join(ws, 'memory.md'), '# Long-term\nMEMTEST_MARKER preferred language is Chinese.\n', 'utf-8');
  otherWs = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mem-other-'));
  fs.writeFileSync(path.join(otherWs, 'memory.md'), 'SECRET other-workspace memory\n', 'utf-8');
  priorAssistantWs = getSetting('assistant_workspace_path');
  setSetting('assistant_workspace_path', ws);
  sessionId = createSession('memory test', undefined, undefined, ws).id;
  bindAssistantMemory(sessionId);
  projectSessionId = createSession('ordinary project memory', undefined, undefined, otherWs).id;
  planSessionId = createSession('plan memory', undefined, undefined, ws, 'plan').id;
  bindAssistantMemory(planSessionId);
});
after(() => {
  setSetting('assistant_workspace_path', priorAssistantWs ?? '');
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(otherWs, { recursive: true, force: true });
});

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1.0' } },
});

function callRoute(server: string, headers: Record<string, string>, body = INIT_BODY) {
  const req = new Request(`http://local/api/codex/mcp/${server}`, { method: 'POST', headers, body });
  return POST(req as never, { params: Promise.resolve({ server }) });
}

describe('built-in MCP reuse (in-memory)', () => {
  it('memory: default adapter exposes 6 shared read/write tools and reads the workspace', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const { instance } = createMemorySearchMcpServer(ws);
    await instance.connect(serverT);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientT);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['codepilot_memory_forget', 'codepilot_memory_get', 'codepilot_memory_recent', 'codepilot_memory_remember', 'codepilot_memory_search', 'codepilot_memory_update']);
    const recent = await client.callTool({ name: 'codepilot_memory_recent', arguments: {} });
    assert.match((recent.content as { text: string }[])[0]?.text ?? '', /MEMTEST_MARKER/);
    await client.close();
    await instance.close();
  });

  it('widget: exposes codepilot_load_widget_guidelines', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const { instance } = createWidgetMcpServer();
    await instance.connect(serverT);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientT);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes('codepilot_load_widget_guidelines'));
    await client.close();
    await instance.close();
  });

  // ── Codex tool-surface audit (2026-05-28) ──────────────────────────────
  // The Codex `codepilot_tasks` route must NOT expose `codepilot_hatch_buddy`.
  // notification-mcp.ts ships 5 tools (notify + 3 task tools + buddy); the
  // capability matrix says assistant_buddy = perception_only on Codex Account,
  // so the Codex route filters buddy out via the entry's `excludeTools`.
  // Audit guards: (1) the SDK MCP still gives ALL 5 to non-Codex callers
  // (no regression for ClaudeCode SDK / Native), (2) the Codex `codepilot_tasks`
  // entry's create() yields EXACTLY 4 tools without buddy — no surprise
  // additions if notification-mcp.ts gains tools later.
  it('notification MCP without excludeTools serves all 5 tools (SDK / Native unchanged)', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const { instance } = createNotificationMcpServer({});
    await instance.connect(serverT);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientT);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [
      'codepilot_cancel_task',
      'codepilot_hatch_buddy',
      'codepilot_list_tasks',
      'codepilot_notify',
      'codepilot_schedule_task',
    ]);
    await client.close();
    await instance.close();
  });

  it('Codex `codepilot_tasks` entry excludes codepilot_hatch_buddy (matrix says perception_only)', async () => {
    const entry = getBuiltinMcpServer('codepilot_tasks');
    assert.ok(entry, 'codepilot_tasks must be registered in the Codex builtin MCP registry');
    const instance = entry!.create({ workspacePath: '/tmp', sessionId: 'audit' });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await instance.connect(serverT);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientT);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(
      tools,
      ['codepilot_cancel_task', 'codepilot_list_tasks', 'codepilot_notify', 'codepilot_schedule_task'],
      'Codex tasks MCP must expose EXACTLY these 4 tools — no buddy, no surprise additions',
    );
    assert.ok(!tools.includes('codepilot_hatch_buddy'), 'buddy must not leak to Codex');
    await client.close();
    await instance.close();
  });

  // ── Dashboard + CLI mutation-level split (Codex review next slice, 2026-05-28)
  // Same `tools/list` guard pattern as `codepilot_tasks`: each split MCP must
  // expose EXACTLY the expected subset (auto_accept for safe-read, user_approval
  // for mutating). Catches future tool additions accidentally landing on the
  // wrong side of the split (or leaking into Codex at all).
  const splitCases: ReadonlyArray<{
    serverName: string;
    expectedTools: readonly string[];
    needsWorkspace: boolean;
  }> = [
    {
      serverName: 'codepilot_dashboard_read',
      expectedTools: ['codepilot_dashboard_list', 'codepilot_dashboard_refresh'],
      needsWorkspace: true,
    },
    {
      serverName: 'codepilot_dashboard_write',
      expectedTools: [
        'codepilot_dashboard_pin',
        'codepilot_dashboard_remove',
        'codepilot_dashboard_update',
      ],
      needsWorkspace: true,
    },
    {
      serverName: 'codepilot_cli_tools_read',
      expectedTools: ['codepilot_cli_tools_check_updates', 'codepilot_cli_tools_list'],
      needsWorkspace: false,
    },
    {
      serverName: 'codepilot_cli_tools_write',
      expectedTools: [
        'codepilot_cli_tools_add',
        'codepilot_cli_tools_install',
        'codepilot_cli_tools_remove',
        'codepilot_cli_tools_update',
      ],
      needsWorkspace: false,
    },
  ];

  for (const { serverName, expectedTools, needsWorkspace } of splitCases) {
    it(`Codex \`${serverName}\` entry exposes EXACTLY its mutation-level subset`, async () => {
      const entry = getBuiltinMcpServer(serverName);
      assert.ok(entry, `${serverName} must be registered in the Codex builtin MCP registry`);
      const instance = entry!.create({ workspacePath: needsWorkspace ? ws : '/tmp', sessionId: 'split-audit' });
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await instance.connect(serverT);
      const client = new Client({ name: 'test', version: '1.0.0' });
      await client.connect(clientT);
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(
        tools,
        [...expectedTools].sort(),
        `${serverName} must expose EXACTLY ${expectedTools.length} tool(s) (no leaks, no missing)`,
      );
      await client.close();
      await instance.close();
    });
  }
});

describe('built-in MCP route — /api/codex/mcp/[server]', () => {
  const accept = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

  it('unknown server → 404', async () => {
    const res = await callRoute('nope', accept);
    assert.equal(res.status, 404);
  });

  it('memory without a session or with a mismatched workspace → 403', async () => {
    assert.equal((await callRoute('codepilot_memory', accept)).status, 403); // no header
    assert.equal(
      (await callRoute('codepilot_memory', { ...accept, 'x-codepilot-workspace-path': otherWs, 'x-codepilot-session-id': sessionId })).status,
      403, // attacker-chosen dir
    );
  });

  it('memory with the session workspace → 200 initialize', async () => {
    const res = await callRoute('codepilot_memory', { ...accept, 'x-codepilot-workspace-path': ws, 'x-codepilot-session-id': sessionId });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { result?: { serverInfo?: { name?: string } }; error?: unknown };
    assert.equal(json.error, undefined);
    assert.equal(json.result?.serverInfo?.name, 'codepilot-memory');
  });

  it('ordinary project is denied; bound assistant retains write approval and Plan read-only', async () => {
    const projectHeaders = { ...accept, 'x-codepilot-workspace-path': otherWs, 'x-codepilot-session-id': projectSessionId };
    assert.equal((await callRoute('codepilot_memory', projectHeaders)).status, 403);
    assert.equal((await callRoute('codepilot_memory_write', projectHeaders)).status, 403);
    assert.equal(getBuiltinMcpServer('codepilot_memory')?.elicitationPolicy, 'auto_accept');
    assert.equal(getBuiltinMcpServer('codepilot_memory_write')?.elicitationPolicy, 'user_approval');
    const planHeaders = { ...accept, 'x-codepilot-workspace-path': ws, 'x-codepilot-session-id': planSessionId };
    assert.equal((await callRoute('codepilot_memory', planHeaders)).status, 200);
    assert.equal((await callRoute('codepilot_memory_write', planHeaders)).status, 403);
    for (const [serverName, expected] of [
      ['codepilot_memory', ['codepilot_memory_get', 'codepilot_memory_recent', 'codepilot_memory_search']],
      ['codepilot_memory_write', ['codepilot_memory_forget', 'codepilot_memory_remember', 'codepilot_memory_update']],
    ] as const) {
      const instance = getBuiltinMcpServer(serverName)!.create({ workspacePath: ws, sessionId });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'memory-permission-fixture', version: '1.0.0' });
      try {
        await instance.connect(serverTransport);
        await client.connect(clientTransport);
        assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [...expected]);
      } finally {
        await client.close();
        await instance.close();
      }
    }
  });

  it('widget → 200 initialize WITHOUT a workspace header (no file access, not scoped)', async () => {
    const res = await callRoute('codepilot_widget', accept);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { result?: { serverInfo?: { name?: string } }; error?: unknown };
    assert.equal(json.error, undefined);
    assert.equal(json.result?.serverInfo?.name, 'codepilot-widget-guidelines');
  });
});
