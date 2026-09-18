/**
 * codepilot_cli_tools_install — timeout/abort lifecycle.
 *
 * native-timeout.ts's own semantic contract says a `tool-execution` budget
 * is anchored `tool-call` part -> matching `tool-result`/`tool-error` part,
 * and that for permission-gated tools the in-execute approval wait counts
 * toward that budget. codepilot_cli_tools_install has no native execute —
 * its real work (PSJ authority, permission wait, the real shell command)
 * all happens manually in agent-loop.ts, AFTER the step's fullStream is
 * already fully consumed. These tests prove that manual path honours the
 * same contract: the timer stays armed across permission wait + real shell
 * execution, a fired budget or a caller abort actually kills the real
 * child process (not just rejects a promise while an orphan keeps
 * running), and two concurrent installs in the same step keep fully
 * independent timeout state.
 *
 * Same real-wire harness as native-timeout-reasons.test.ts: a scripted
 * Anthropic SSE fetch drives the REAL runAgentLoop end to end — never a
 * hand-built substitute for the SDK or the timeout controller.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

import { runAgentLoop } from '@/lib/agent-loop';
import type { SSEEvent } from '@/types';

const MODEL = 'claude-sonnet-4-6';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Real-wire Anthropic SSE builders (same shapes as native-timeout-reasons.test.ts) ──

type AnthropicSseEvent = readonly [string, Record<string, unknown>];

function sseBody(events: readonly AnthropicSseEvent[]): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function messageStart(): AnthropicSseEvent {
  return ['message_start', {
    type: 'message_start',
    message: { id: 'msg_life', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
  }];
}

/** One assistant turn making N tool calls, each fully-streamed (real, complete JSON). */
function toolStepResponse(calls: Array<{ id: string; name: string; input: Record<string, unknown> }>): Response {
  const events: AnthropicSseEvent[] = [messageStart()];
  calls.forEach((call, index) => {
    events.push(
      ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }],
      ['content_block_stop', { type: 'content_block_stop', index }],
    );
  });
  events.push(
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  );
  return new Response(sseBody(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * One assistant turn with a single, COMPLETE, fully-evidenced tool call —
 * but an unsafe stop_reason ('max_tokens' -> ai-sdk's unified 'length').
 * This is PSJ's actual reject path reachable at the real Anthropic wire
 * level: full raw tool-input-delta evidence exists (so ai-sdk parses and
 * validates the input fine, no AI_InvalidToolInputError), but the guard
 * still refuses authority because the surrounding response didn't finish
 * safely — the exact historical bug this whole PR exists to close.
 *
 * (A genuinely truncated/unparseable-JSON tool call was tried first and
 * rejected as the PSJ-guard test case: ai-sdk's OWN AI_InvalidToolInputError
 * intercepts that before PSJ's guard is ever consulted — confirmed
 * directly, not assumed. That's consistent with this session's earlier,
 * separately-verified finding that Anthropic's adapter ties its final
 * projected tool-call input directly to the accumulated raw deltas
 * (`contentBlock.input += delta`) with no independent SDK-projected value
 * to diverge from — unlike OpenAI's adapter, incomplete raw evidence and
 * invalid JSON are the same failure mode for Anthropic, and ai-sdk's own
 * input validation claims that failure first, via the ordinary tool-error
 * path already unconditionally covered by timeoutCtl.onStreamPart. The
 * unsafe-finish-reason path below is what actually reaches this manual
 * dispatch's own decision.action !== 'execute' branch.)
 */
function unsafeFinishToolStepResponse(id: string, name: string, input: Record<string, unknown>): Response {
  const events: AnthropicSseEvent[] = [
    messageStart(),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(sseBody(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function installFetch(handler: (init: RequestInit | undefined, index: number) => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    return handler(init, index++);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

async function collectStream(stream: ReadableStream<string>, onEvent?: (e: SSEEvent) => void): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of value.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6)) as SSEEvent;
      events.push(event);
      onEvent?.(event);
    }
  }
  return events;
}

interface RunOpts {
  timeouts?: Record<string, number>;
  bypassPermissions?: boolean;
  fetchHandler: (init: RequestInit | undefined, index: number) => Response | Promise<Response>;
  onEvent?: (e: SSEEvent, abortController: AbortController) => void;
}

async function runLoop(opts: RunOpts): Promise<{ sessionId: string; events: SSEEvent[] }> {
  const { createSession, addMessage } = await import('@/lib/db');
  const session = createSession('cli-install-timeout-test', MODEL, '', wd);
  addMessage(session.id, 'user', 'timeout probe');
  const abortController = new AbortController();
  const restore = installFetch(opts.fetchHandler);
  try {
    const stream = runAgentLoop({
      callScene: 'interactive_chat',
      prompt: 'timeout probe',
      sessionId: session.id,
      model: MODEL,
      systemPrompt: 'You are a timeout probe.',
      workingDirectory: wd,
      abortController,
      permissionMode: 'normal',
      bypassPermissions: opts.bypassPermissions,
      timeouts: opts.timeouts,
    });
    const events = await collectStream(stream, (e) => opts.onEvent?.(e, abortController));
    return { sessionId: session.id, events };
  } finally {
    restore();
  }
}

function errorEventData(events: SSEEvent[]): Record<string, unknown> | null {
  const e = events.find((ev) => ev.type === 'error');
  if (!e) return null;
  try { return JSON.parse(e.data) as Record<string, unknown>; } catch { return null; }
}

function toolResultFor(events: SSEEvent[], toolCallId: string): Record<string, unknown> | null {
  for (const e of events) {
    if (e.type !== 'tool_result') continue;
    try {
      const data = JSON.parse(e.data) as Record<string, unknown>;
      if (data.tool_use_id === toolCallId) return data;
    } catch { /* ignore */ }
  }
  return null;
}

// ── Real child-process heartbeat: the only honest way to prove a process ──
// was actually killed, not just that a promise rejected. Same technique
// used to discover (and fix) the underlying bug empirically, on both
// platforms this file actually runs against — not just Windows.
//
// Windows: a PowerShell loop appends its counter to a marker file every
// ~150ms, run via the taskkill-tree mechanism execWithAbortWindows uses.
//
// POSIX: a plain `sh` loop would get execve-replaced into directly by
// `sh -c "<command>"` (no separate descendant to leave orphaned), which
// would pass even against a NAIVE, still-broken implementation and prove
// nothing about the process-GROUP kill this file exists to verify. So the
// POSIX heartbeat is structured the way this bug was actually found and
// fixed: an outer `sh` command spawns a plain (non-detached) `node`
// worker — the shape real install tooling (npm/pip/build steps) uses
// internally — and the WORKER writes the heartbeat. Only a real
// process-group kill (not a single-pid signal) reaches it.
function heartbeatCommand(markerPath: string, iterations = 80): string {
  if (process.platform === 'win32') {
    const escaped = markerPath.replace(/'/g, "''");
    return `powershell -NoProfile -Command "for ($i=0; $i -lt ${iterations}; $i++) { Add-Content -Path '${escaped}' -Value $i; Start-Sleep -Milliseconds 150 }"`;
  }
  // Two levels, deliberately: `sh -c "node <outerPath>"` is a single
  // trailing command, so `sh` execve-replaces itself into that outer node
  // process directly (same pid) — killing that one pid alone WOULD work,
  // proving nothing about the group-kill fix. The outer script instead
  // spawns a plain (non-detached) INNER worker and awaits it — the shape
  // real install tooling (npm/pip/build steps) uses internally — and the
  // inner worker is what actually writes the heartbeat. Only a real
  // process-GROUP kill (not a single-pid signal to the outer process)
  // reaches it.
  const innerPath = markerPath.replace(/\.txt$/, '-inner.mjs');
  const outerPath = markerPath.replace(/\.txt$/, '-outer.mjs');
  fs.writeFileSync(
    innerPath,
    `import { appendFileSync } from 'node:fs';\n` +
      `for (let i = 0; i < ${iterations}; i++) { appendFileSync(${JSON.stringify(markerPath)}, i + '\\n'); await new Promise((r) => setTimeout(r, 150)); }\n`,
  );
  fs.writeFileSync(
    outerPath,
    `import { spawn } from 'node:child_process';\n` +
      `const child = spawn('node', [${JSON.stringify(innerPath)}], { stdio: 'ignore' });\n` +
      `await new Promise((resolve) => child.on('exit', resolve));\n`,
  );
  return `node ${JSON.stringify(outerPath)}`;
}

/** A command that finishes almost immediately and echoes `text` to stdout — platform-neutral. */
function quickCommand(text: string): string {
  return process.platform === 'win32' ? `cmd /c "echo ${text}"` : `echo ${text}`;
}

function heartbeatCount(markerPath: string): number {
  if (!fs.existsSync(markerPath)) return 0;
  const content = fs.readFileSync(markerPath, 'utf8').trim();
  return content.length === 0 ? 0 : content.split('\n').length;
}

/** True if the heartbeat file's line count stopped growing (process dead). */
async function assertProcessKilled(markerPath: string): Promise<void> {
  await sleep(600);
  const c1 = heartbeatCount(markerPath);
  await sleep(600);
  const c2 = heartbeatCount(markerPath);
  assert.equal(c1, c2, `heartbeat still growing after the expected kill point (c1=${c1}, c2=${c2}) — real process was NOT killed, it's an orphan`);
}

let wd: string;
let markerDir: string;
before(() => {
  wd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-install-timeout-'));
  markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-install-heartbeat-'));
});
after(() => {
  try { fs.rmSync(wd, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(markerDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
let markerSeq = 0;
function nextMarker(): string {
  markerSeq += 1;
  return path.join(markerDir, `marker-${markerSeq}-${Date.now()}.txt`);
}

// ── TEST 1 ────────────────────────────────────────────────────────────
describe('TEST 1 — toolExecutionMs shorter than a long-running manual install', () => {
  it('fires TIMEOUT_TOOL_EXECUTION at the configured budget, kills the real process, no late success tool-result', async () => {
    const marker = nextMarker();
    const { events } = await runLoop({
      timeouts: { toolExecutionMs: 400 },
      bypassPermissions: true,
      fetchHandler: () => toolStepResponse([{ id: 'toolu_t1', name: 'codepilot_cli_tools_install', input: { command: heartbeatCommand(marker), name: 't1' } }]),
    });
    const err = errorEventData(events);
    assert.ok(err, 'error event present');
    assert.equal(err.category, 'TIMEOUT_TOOL_EXECUTION');
    assert.equal((err.timeout as Record<string, unknown>).reason, 'tool-execution');
    assert.equal(events[events.length - 1].type, 'done');
    assert.equal(toolResultFor(events, 'toolu_t1'), null, 'no synthetic tool-result at all for the timed-out call — the abort must propagate, not masquerade as a normal result');
    await assertProcessKilled(marker);
  });
});

// ── TEST 2 ────────────────────────────────────────────────────────────
describe('TEST 2 — toolExecutionMs expires while waiting for user permission', () => {
  it('approval wait counts toward the budget; run terminates as TIMEOUT_TOOL_EXECUTION; shell never executes', async () => {
    const marker = nextMarker();
    const { events } = await runLoop({
      timeouts: { toolExecutionMs: 350 },
      // normal mode (default in runLoop) — nobody ever answers the
      // permission_request, so the wait itself must be what times out.
      fetchHandler: () => toolStepResponse([{ id: 'toolu_t2', name: 'codepilot_cli_tools_install', input: { command: heartbeatCommand(marker), name: 't2' } }]),
    });
    const err = errorEventData(events);
    assert.ok(err, 'error event present');
    assert.equal(err.category, 'TIMEOUT_TOOL_EXECUTION');
    assert.equal((err.timeout as Record<string, unknown>).reason, 'tool-execution');
    assert.equal(events[events.length - 1].type, 'done');
    assert.equal(heartbeatCount(marker), 0, 'shell never executed — the marker file was never even created');
  });
});

// ── TEST 3 ────────────────────────────────────────────────────────────
describe('TEST 3 — permission denied before timeout', () => {
  it('clears the timer; no late timeout fires', async () => {
    const marker = nextMarker();
    const { events } = await runLoop({
      timeouts: { toolExecutionMs: 700 },
      fetchHandler: () => toolStepResponse([{ id: 'toolu_t3', name: 'codepilot_cli_tools_install', input: { command: heartbeatCommand(marker), name: 't3' } }]),
      onEvent: (e) => {
        if (e.type !== 'permission_request') return;
        const parsed = JSON.parse(e.data) as { permissionRequestId: string };
        queueMicrotask(async () => {
          const { resolvePendingPermission } = await import('@/lib/permission-registry');
          resolvePendingPermission(parsed.permissionRequestId, { behavior: 'deny', message: 'no, thanks' });
        });
      },
    });
    // Wait past the ORIGINAL budget window from run completion — proves
    // the clear was real, not merely that the deny raced ahead of it.
    await sleep(750);
    assert.equal(errorEventData(events), null, 'no TIMEOUT_* error — this was an ordinary deny, not a timeout');
    const result = toolResultFor(events, 'toolu_t3');
    assert.ok(result, 'tool-result present');
    assert.equal(result.is_error, true);
    assert.match(String(result.content), /denied/i);
    assert.equal(events[events.length - 1].type, 'done');
    assert.equal(heartbeatCount(marker), 0, 'shell never executed');
  });
});

// ── TEST 4 ────────────────────────────────────────────────────────────
describe('TEST 4 — PSJ-rejected call', () => {
  it('no permission, no shell, timer cleared when the synthetic rejected result becomes terminal, no late timeout', async () => {
    const { events } = await runLoop({
      timeouts: { toolExecutionMs: 400 },
      bypassPermissions: true,
      // Complete, fully-evidenced, schema-valid tool call — but an unsafe
      // finish reason. PSJ's guard must still refuse authority.
      fetchHandler: () => unsafeFinishToolStepResponse('toolu_t4', 'codepilot_cli_tools_install', { command: 'echo should-not-run', name: 't4' }),
    });
    await sleep(700); // past the budget window — proves no late timeout
    assert.equal(errorEventData(events), null, 'no TIMEOUT_* error — PSJ rejection is not a timeout');
    const result = toolResultFor(events, 'toolu_t4');
    assert.ok(result, 'synthetic skipped tool-result present');
    assert.equal(result.is_error, true);
    assert.match(String(result.content), /not confirmed safe|skipped/i);
    assert.equal(events[events.length - 1].type, 'done');
  });
});

// ── TEST 5 ────────────────────────────────────────────────────────────
describe('TEST 5 — totalRunMs expires during manual shell execution', () => {
  it('kills the real process; correct timeout classification', async () => {
    const marker = nextMarker();
    const { events } = await runLoop({
      timeouts: { totalRunMs: 400 },
      bypassPermissions: true,
      fetchHandler: () => toolStepResponse([{ id: 'toolu_t5', name: 'codepilot_cli_tools_install', input: { command: heartbeatCommand(marker), name: 't5' } }]),
    });
    const err = errorEventData(events);
    assert.ok(err, 'error event present');
    assert.equal(err.category, 'TIMEOUT_TOTAL_RUN');
    assert.equal((err.timeout as Record<string, unknown>).reason, 'total-run');
    assert.equal(events[events.length - 1].type, 'done');
    await assertProcessKilled(marker);
  });
});

// ── TEST 6 ────────────────────────────────────────────────────────────
describe('TEST 6 — caller/user abort during manual shell execution', () => {
  it('kills the real process; no orphan process; no budgets needed', async () => {
    const marker = nextMarker();
    const { events } = await runLoop({
      // No timeouts configured at all — proves this is not piggybacking
      // on a budget; it's the caller's own Stop.
      bypassPermissions: true,
      fetchHandler: () => toolStepResponse([{ id: 'toolu_t6', name: 'codepilot_cli_tools_install', input: { command: heartbeatCommand(marker), name: 't6' } }]),
      onEvent: (e, abortController) => {
        // Abort right after the model's tool call is announced — the
        // shell command is either about to start or just started.
        if (e.type === 'tool_use') setTimeout(() => abortController.abort(), 150);
      },
    });
    assert.ok(!events.some((e) => e.type === 'error'), 'a user abort must never surface as an error event');
    assert.equal(events[events.length - 1].type, 'done');
    await assertProcessKilled(marker);
  });
});

// ── TEST 7 ────────────────────────────────────────────────────────────
describe('TEST 7 — two same-step install calls', () => {
  it('independent toolCallId timers; completing call A does not clear call B\'s timer', async () => {
    const markerB = nextMarker();
    const { events } = await runLoop({
      timeouts: { toolExecutionMs: 500 },
      bypassPermissions: true,
      fetchHandler: () => toolStepResponse([
        { id: 'toolu_t7a', name: 'codepilot_cli_tools_install', input: { command: quickCommand('quick-a'), name: 't7a' } },
        { id: 'toolu_t7b', name: 'codepilot_cli_tools_install', input: { command: heartbeatCommand(markerB), name: 't7b' } },
      ]),
    });
    // A finished fast and successfully — proves its own clear happened,
    // and proves the run's error (from B) didn't erase A's own result.
    const resultA = toolResultFor(events, 'toolu_t7a');
    assert.ok(resultA, 'call A produced its own tool-result');
    assert.equal(resultA.is_error, false);
    assert.match(String(resultA.content), /quick-a/);
    // B never got a tool-result of its own — it was the one that timed out.
    assert.equal(toolResultFor(events, 'toolu_t7b'), null, 'B has no synthetic tool-result — it timed out, not completed');
    const err = errorEventData(events);
    assert.ok(err, 'error event present (from B timing out on its own, independent budget)');
    assert.equal(err.category, 'TIMEOUT_TOOL_EXECUTION');
    assert.equal(events[events.length - 1].type, 'done');
    await assertProcessKilled(markerB);
  });
});

// ── TEST 8 ────────────────────────────────────────────────────────────
describe('TEST 8 — default timeout config disabled', () => {
  it('behavior unchanged, no extra timeout', async () => {
    const { events } = await runLoop({
      // No `timeouts` at all.
      bypassPermissions: true,
      fetchHandler: () => toolStepResponse([{ id: 'toolu_t8', name: 'codepilot_cli_tools_install', input: { command: quickCommand('no-budget-configured'), name: 't8' } }]),
    });
    assert.equal(errorEventData(events), null, 'no timeout error with no budgets configured');
    const result = toolResultFor(events, 'toolu_t8');
    assert.ok(result, 'tool-result present');
    assert.equal(result.is_error, false);
    assert.match(String(result.content), /no-budget-configured/);
    assert.equal(events[events.length - 1].type, 'done');
  });
});
