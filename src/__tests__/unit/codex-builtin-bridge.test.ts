/**
 * Phase 5c (2026-05-16) — CodePilot built-in tool bridge contract.
 *
 * The bridge mounts CodePilot's built-in tools onto the ai-sdk
 * ToolSet the proxy passes to streamText. Pre-5c the proxy dropped
 * every non-function Codex tool AND didn't inject any CodePilot
 * tools, so GLM/Kimi saw `imagegen` Skill text but had no real tool
 * to call and started CLI/auth.json/npm fallback chains.
 *
 * This file pins the bridge's:
 *   1. Mount/skip decisions (sessionId required, codex_account
 *      excluded).
 *   2. Tool surface — which tools land on the ToolSet, which only
 *      mount when a workspace is bound.
 *   3. Side-channel event emission shape — tool_started → handler →
 *      tool_completed with optional media.
 *   4. Error mapping — handler exceptions become tool_completed.error
 *      rather than throwing out of execute().
 *
 * We don't pin the underlying handlers' business logic here (that's
 * `image-gen-mcp.test.ts` / `memory-search-mcp.test.ts` etc.) —
 * just the bridge's wrapping behaviour.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCodexAccountManagedTools,
  createCodePilotBuiltinTools,
  CODEPILOT_BUILTIN_TOOL_NAMES,
} from '@/lib/codex/proxy/builtin-bridge';
import {
  subscribeBuiltinEvents,
  __resetBuiltinEventBusForTests,
} from '@/lib/codex/proxy/builtin-event-bus';
import type { RuntimeRunEvent } from '@/lib/runtime/contract';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSession, setSetting } from '@/lib/db';
import { bindAssistantMemory } from '@/lib/memory-binding';

beforeEach(() => {
  __resetBuiltinEventBusForTests();
});

describe('createCodePilotBuiltinTools — mount + skip', () => {
  it('returns empty bridge when sessionId is missing (older runtime / smoke without CodexRuntime)', () => {
    const bridge = createCodePilotBuiltinTools({ sessionId: '', targetProviderId: 'prov-1' });
    assert.equal(Object.keys(bridge.tools).length, 0);
    assert.equal(bridge.toolNames.size, 0);
    assert.equal(bridge.systemPrompt, '');
    assert.match(bridge.skippedReason ?? '', /Empty sessionId/);
  });

  it('returns empty bridge for codex_account (Codex Account routes natively, no bridge needed)', () => {
    const bridge = createCodePilotBuiltinTools({
      sessionId: 'chat-1',
      targetProviderId: 'codex_account',
    });
    assert.equal(Object.keys(bridge.tools).length, 0);
    assert.match(bridge.skippedReason ?? '', /Codex Account/);
  });

  it('exposes only managed delegation/query as Codex Account dynamic tools', () => {
    const bridge = createCodexAccountManagedTools({
      sessionId: 'chat-account-1',
      targetProviderId: 'codex_account',
      workspacePath: '/Users/me/proj',
    });
    assert.deepEqual(
      Object.keys(bridge.tools).sort(),
      ['codepilot_list_subagent_runs', 'codepilot_spawn_subagent'],
    );
    assert.deepEqual(
      bridge.dynamicTools.map((entry) => entry.name).sort(),
      ['codepilot_list_subagent_runs', 'codepilot_spawn_subagent'],
    );
    const spawn = bridge.dynamicTools.find((entry) => entry.name === 'codepilot_spawn_subagent');
    assert.ok(spawn);
    assert.deepEqual(spawn.inputSchema.required, ['prompt', 'provider_id', 'model']);
    assert.match(spawn.description, /native workers inherit the parent route/i);
    assert.match(spawn.description, /stop and ask the user/i);
    assert.equal(bridge.tools.codepilot_generate_image, undefined);
    assert.equal(bridge.tools.codepilot_memory_search, undefined);
  });

  it('returns an empty bridge inside a managed child so delegation depth stays one', () => {
    const bridge = createCodePilotBuiltinTools({
      sessionId: 'codex-subagent-child-1',
      targetProviderId: 'prov-glm',
    });
    assert.equal(Object.keys(bridge.tools).length, 0);
    assert.match(bridge.skippedReason ?? '', /depth is limited to one/);
  });

  it('mounts the non-workspace-gated tools when sessionId present but no workspace', () => {
    const bridge = createCodePilotBuiltinTools({
      sessionId: 'chat-1',
      targetProviderId: 'prov-glm',
    });
    // Image / media import / widget / notify / schedule / list / cancel /
    // managed Sub Agent always mount.
    assert.ok(bridge.tools.codepilot_generate_image, 'image gen must mount without workspace');
    assert.ok(bridge.tools.codepilot_import_media);
    assert.ok(bridge.tools.codepilot_load_widget_guidelines);
    assert.ok(bridge.tools.codepilot_notify);
    assert.ok(bridge.tools.codepilot_schedule_task);
    assert.ok(bridge.tools.codepilot_list_tasks);
    assert.ok(bridge.tools.codepilot_cancel_task);
    assert.ok(bridge.tools.codepilot_list_subagent_runs, 'durable Sub-agent run query must mount');
    assert.ok(bridge.tools.codepilot_spawn_subagent, 'managed Codex Sub Agent tool must mount');
    // Memory tools require a workspace.
    assert.equal(bridge.tools.codepilot_memory_recent, undefined, 'memory recent requires workspace');
    assert.equal(bridge.tools.codepilot_memory_search, undefined);
    assert.equal(bridge.tools.codepilot_memory_get, undefined);
  });

  it('lets Codex own child capabilities instead of asking the parent model to classify them', () => {
    const bridge = createCodePilotBuiltinTools({
      sessionId: 'chat-1',
      targetProviderId: 'prov-glm',
    });
    const spawn = bridge.tools.codepilot_spawn_subagent as unknown as {
      description?: string;
      inputSchema?: {
        jsonSchema?: {
          required?: string[];
          properties?: Record<string, unknown>;
        };
      };
    };
    assert.match(spawn.description ?? '', /inherits the parent Codex native tools, MCP servers, sandbox, approval policy/i);
    assert.match(spawn.description ?? '', /only Sub Agent entry point/i);
    assert.match(spawn.description ?? '', /never wrap it with Codex native multi_agent_v1\/spawn_agent\/wait_agent workers/i);
    assert.match(spawn.description ?? '', /returns only after the child reaches a terminal status/i);
    assert.match(spawn.description ?? '', /never describe it as merely submitted, launched, queued, or still processing/i);
    assert.deepEqual(spawn.inputSchema?.jsonSchema?.required, ['prompt', 'provider_id', 'model']);
    assert.equal(
      spawn.inputSchema?.jsonSchema?.properties?.required_capabilities,
      undefined,
      'Codex app-server is the capability source of truth; CodePilot must not add a second gate',
    );
  });

  it('exposes an authoritative progress query instead of asking Codex to inspect workspace files', () => {
    const bridge = createCodePilotBuiltinTools({
      sessionId: 'chat-1',
      targetProviderId: 'prov-glm',
    });
    const listRuns = bridge.tools.codepilot_list_subagent_runs as unknown as {
      description?: string;
      inputSchema?: {
        jsonSchema?: {
          properties?: Record<string, unknown>;
        };
      };
    };
    assert.match(listRuns.description ?? '', /authoritative durable lifecycle records/i);
    assert.match(listRuns.description ?? '', /Never infer .* workspace files/i);
    assert.ok(listRuns.inputSchema?.jsonSchema?.properties?.include_results);

    const adapterSource = fs.readFileSync(
      path.resolve(__dirname, '../../lib/codex/proxy/unified-adapter.ts'),
      'utf8',
    );
    assert.match(
      adapterSource,
      /buildCodexSubagentRunContext\(input\.sessionId\)/,
      'every later Codex proxy turn must receive the durable session snapshot',
    );
  });

  it('suppresses every bridge-executed tool from the Codex-bound stream', () => {
    const adapterSource = fs.readFileSync(
      path.resolve(__dirname, '../../lib/codex/proxy/unified-adapter.ts'),
      'utf8',
    );
    assert.match(
      adapterSource,
      /const bridgeOwnedToolNames = new Set\(\[\s*\.\.\.adapted\.builtinToolNames,\s*\.\.\.bridge\.toolNames,/,
      'codepilot_spawn_subagent and every other executed bridge tool must not leak back as an unsupported app-server call',
    );
    assert.match(
      adapterSource,
      /const providerExecutedToolNames = new Set\(\[\s*\.\.\.Object\.keys\(hostedSearchTools\),/,
      'provider-hosted tools need a distinct lifecycle set so they can be mirrored without duplicating bridge events',
    );
  });

  it('mounts memory only for explicitly bound assistant sessions, not same-cwd projects', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-scope-'));
    try {
      setSetting('assistant_workspace_path', root);
      const session = createSession('memory scope', undefined, undefined, root);
      const options = { sessionId: session.id, targetProviderId: 'fixture', workspacePath: root };
      assert.equal(createCodePilotBuiltinTools(options).tools.codepilot_memory_search, undefined);
      bindAssistantMemory(session.id);
      const bridge = createCodePilotBuiltinTools(options);
      assert.ok(bridge.tools.codepilot_memory_recent);
      assert.ok(bridge.tools.codepilot_memory_search);
      assert.ok(bridge.tools.codepilot_memory_get);
      assert.equal(bridge.systemPrompt, '');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('bridge mounts the expected tool surface for live capabilities (prompt text is compiler\'s job)', () => {
    const bridge = createCodePilotBuiltinTools({
      sessionId: 'chat-1',
      targetProviderId: 'prov-glm',
      workspacePath: '/w',
      grokVideoAvailable: true,
    });
    // Phase 5d Phase 2 slice 2e (2026-05-17) — the bridge's job is
    // tool mounting + side-channel event emission. Prompt assembly
    // moved to the Context Compiler (see harness-context-compiler.test.ts).
    // This test pins the tool surface only; the test that used to
    // grep bridge.systemPrompt for capability tags is replaced by
    // the compiler's `runtimeHints / capability fragments` pins.
    assert.ok(bridge.tools.codepilot_generate_image, 'image tool must mount');
    assert.ok(bridge.tools.codepilot_import_media);
    assert.ok(bridge.tools.codepilot_load_widget_guidelines);
    assert.ok(bridge.tools.codepilot_notify);
    assert.ok(bridge.tools.codepilot_schedule_task);
    assert.ok(bridge.tools.codepilot_list_tasks);
    assert.ok(bridge.tools.codepilot_cancel_task);
    assert.ok(bridge.tools.codepilot_list_subagent_runs);
    assert.ok(bridge.tools.codepilot_spawn_subagent);
    assert.equal(bridge.systemPrompt, '', 'bridge.systemPrompt must be empty after slice 2e');
  });
});

describe('CODEPILOT_BUILTIN_TOOL_NAMES — catalog drift guard', () => {
  it('hides the Grok video bridge when OAuth is unavailable', () => {
    const bridge = createCodePilotBuiltinTools({
      sessionId: 'chat-no-grok',
      targetProviderId: 'prov-glm',
      grokVideoAvailable: false,
    });
    assert.ok(bridge.tools.codepilot_generate_image);
    assert.equal(bridge.tools.codepilot_generate_video, undefined);
    assert.equal(bridge.toolNames.has('codepilot_generate_video'), false);
  });

  it('lists exactly the tool names the bridge registers (workspace + non-workspace combined)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-catalog-'));
    setSetting('assistant_workspace_path', root);
    const session = createSession('catalog', undefined, undefined, root);
    bindAssistantMemory(session.id);
    try {
    const bridge = createCodePilotBuiltinTools({
      sessionId: session.id,
      targetProviderId: 'prov-glm',
      workspacePath: root,
      grokVideoAvailable: true,
    });
    const mounted = new Set(Object.keys(bridge.tools));
    const expected = new Set(CODEPILOT_BUILTIN_TOOL_NAMES);
    assert.deepEqual([...mounted].sort(), [...expected].sort(), 'CODEPILOT_BUILTIN_TOOL_NAMES must list exactly what createCodePilotBuiltinTools mounts when fully unlocked');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('toolNames matches Object.keys(tools)', () => {
    const bridge = createCodePilotBuiltinTools({
      sessionId: 'chat-1',
      targetProviderId: 'prov-glm',
      workspacePath: '/w',
    });
    assert.deepEqual([...bridge.toolNames].sort(), Object.keys(bridge.tools).sort());
  });
});

describe('Tool execute() — side-channel event emission', () => {
  it('codepilot_notify success: emits tool_started then tool_completed with output text', async () => {
    const events: RuntimeRunEvent[] = [];
    subscribeBuiltinEvents('chat-1', (e) => events.push(e));
    const bridge = createCodePilotBuiltinTools({
      sessionId: 'chat-1',
      targetProviderId: 'prov-glm',
    });
    // codepilot_notify hits sendNotification — we patch the module.
    // Easiest test isolation: spy via global mock state on the
    // notification-manager export.
    const origFetch = globalThis.fetch;
    // sendNotification doesn't network-touch in this codebase (it
    // queues into notification-manager's in-memory ring buffer), so
    // just call the execute() directly.
    const notify = bridge.tools.codepilot_notify;
    assert.ok(notify, 'codepilot_notify must be mounted');
    // ai-sdk tool() exposes execute under `.execute`.
    const exec = (notify as { execute?: (input: unknown, opts?: unknown) => unknown }).execute;
    assert.ok(typeof exec === 'function', 'tool must expose execute()');
    const result = await exec!({ title: 'Hi', body: 'There', priority: 'low' }, {});
    assert.equal(typeof result, 'string');
    assert.match(String(result), /Notification sent/);
    // Side channel saw both ends of the call.
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'tool_started');
    if (events[0].type !== 'tool_started') return;
    assert.equal(events[0].name, 'codepilot_notify');
    assert.deepEqual(events[0].input, { title: 'Hi', body: 'There', priority: 'low' });
    assert.equal(events[1].type, 'tool_completed');
    if (events[1].type !== 'tool_completed') return;
    assert.equal(events[1].toolId, events[0].toolId, 'tool_started + tool_completed share the same toolId');
    assert.match(String(events[1].output ?? ''), /Notification sent/);
    assert.equal(events[1].error, undefined);
    assert.equal(events[1].media, undefined);
    // Restore fetch just in case.
    globalThis.fetch = origFetch;
  });

  it('handler exception is caught and surfaced as tool_completed.error (NOT thrown out of execute)', async () => {
    const events: RuntimeRunEvent[] = [];
    subscribeBuiltinEvents('chat-1', (e) => events.push(e));
    const bridge = createCodePilotBuiltinTools({
      sessionId: 'chat-1',
      targetProviderId: 'prov-glm',
      // workspacePath omitted on purpose so memory_recent throws.
    });
    // codepilot_memory_recent isn't mounted without a workspace. Use
    // codepilot_cancel_task with a bad id so the API call fails —
    // we override fetch so it returns 500.
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response;
    try {
      const cancel = bridge.tools.codepilot_cancel_task;
      assert.ok(cancel);
      const exec = (cancel as { execute?: (input: unknown, opts?: unknown) => Promise<unknown> }).execute;
      const result = await exec!({ task_id: 'fake-id' }, {});
      assert.match(String(result), /Tool execution failed/);
      assert.equal(events.length, 2);
      assert.equal(events[1].type, 'tool_completed');
      if (events[1].type !== 'tool_completed') return;
      assert.ok(events[1].error, 'tool_completed.error must be set on failure');
      assert.match(events[1].error!, /task not found|HTTP 404/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('codepilot_load_widget_guidelines: success emits non-empty output (text)', async () => {
    const events: RuntimeRunEvent[] = [];
    subscribeBuiltinEvents('chat-1', (e) => events.push(e));
    const bridge = createCodePilotBuiltinTools({
      sessionId: 'chat-1',
      targetProviderId: 'prov-glm',
    });
    const widget = bridge.tools.codepilot_load_widget_guidelines;
    assert.ok(widget);
    const exec = (widget as { execute?: (input: unknown, opts?: unknown) => Promise<unknown> }).execute;
    const result = await exec!({ modules: ['interactive', 'chart'] }, {});
    assert.equal(typeof result, 'string');
    assert.ok(String(result).length > 0, 'widget guidelines text must be non-empty');
    assert.equal(events.length, 2);
    assert.equal(events[1].type, 'tool_completed');
  });

  it('events isolate to the bridge\'s sessionId — a probe on a different session sees nothing', async () => {
    const aEvents: RuntimeRunEvent[] = [];
    const bEvents: RuntimeRunEvent[] = [];
    subscribeBuiltinEvents('chat-A', (e) => aEvents.push(e));
    subscribeBuiltinEvents('chat-B', (e) => bEvents.push(e));
    const bridgeA = createCodePilotBuiltinTools({
      sessionId: 'chat-A',
      targetProviderId: 'prov-glm',
    });
    const exec = (bridgeA.tools.codepilot_load_widget_guidelines as {
      execute?: (input: unknown, opts?: unknown) => Promise<unknown>;
    }).execute;
    await exec!({ modules: ['interactive'] }, {});
    assert.ok(aEvents.length >= 2, 'sessionId A must see its events');
    assert.equal(bEvents.length, 0, 'sessionId B must not see A\'s events — cross-session leak guard');
  });
});

describe('Image generation handler — failure-path text does not mention anti-pattern fallbacks', () => {
  it('source-level pin: bridge throws a structured message for NoImageGeneratedError, NOT a CLI / auth.json fallback hint', () => {
    // Module-mocking the underlying image-generator across the ESM
    // boundary isn't straightforward in node:test. We pin the
    // failure-path WORDING via source grep instead, paired with the
    // larger anti-pattern grep in codex-builtin-no-anti-patterns.test.ts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../lib/codex/proxy/builtin-bridge.ts'),
      'utf-8',
    );
    // 1. The bridge handles NoImageGeneratedError by rethrowing a
    //    descriptive Error — the runWithEvents wrapper catches it
    //    and emits tool_completed.error.
    assert.match(src, /NoImageGeneratedError\.isInstance/);
    assert.match(
      src,
      /no image was returned by the model/i,
      'NoImageGeneratedError branch must surface a model-not-helpful message, NOT a generic "try CLI" hint',
    );
    // 2. The error message MUST NOT instruct the model to chase any
    //    of the four anti-patterns we want to keep out of prod.
    //    Lines that surface to the model are quoted strings; grep
    //    them out and assert none mention the forbidden recovery
    //    paths. Comments are allowed to NAME the anti-patterns
    //    (the file's docstring does that).
    const codeLines = src.split('\n').filter(line => {
      const stripped = line.trimStart();
      if (stripped.startsWith('//')) return false;
      if (stripped.startsWith('*')) return false;
      if (stripped.startsWith('/*')) return false;
      return true;
    });
    const stringLiteralLines = codeLines.filter(line => /'[^']*'|"[^"]*"|`[^`]*`/.test(line));
    for (const line of stringLiteralLines) {
      assert.doesNotMatch(
        line,
        /OPENAI_API_KEY|auth\.json|npm install|scripts\/image_gen\.py/i,
        `bridge string literal mentions an anti-pattern: ${line}`,
      );
    }
  });
});
