/**
 * codepilot_cli_tools_install — abort/timeout coverage of the POST-install
 * phase (which / --version / --help / DB registration).
 *
 * runCliToolInstall's main shell command was already signal-protected by
 * an earlier fix in this PR — but everything AFTER it (binary discovery
 * via `which`, the `--version` probe, `getHelpOutput`'s `--help`/`-h`
 * probes, and the final `createCustomCliTool` DB write) previously ran
 * with no abort awareness at all. Confirmed directly, on real Linux, with
 * a real slow binary and a real DB before writing this fix: a caller
 * abort fired 500ms in (main install already succeeded, --version still
 * sleeping) had no effect — runCliToolInstall resolved normally 3.5+
 * seconds later with a completely normal-looking success string, and the
 * tool WAS registered in the DB despite the abort.
 *
 * This whole code path depends on a hardcoded `/usr/bin/which` — it does
 * not resolve on Windows at all (confirmed: ENOENT), so `binPath` always
 * stays null there and this branch is structurally unreachable outside
 * POSIX. That is a separate, pre-existing limitation this file does not
 * touch — these tests are POSIX-only for that reason, not because the
 * underlying bug or fix is platform-specific.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

const isPosix = process.platform !== 'win32';
const skipReason = 'runCliToolInstall\'s which-based binary discovery depends on a hardcoded /usr/bin/which that does not resolve on Windows (ENOENT) — this whole code path is structurally unreachable there, unrelated to this fix.';

import { runAgentLoop } from '@/lib/agent-loop';
import type { SSEEvent } from '@/types';

const MODEL = 'claude-sonnet-4-6';

type AnthropicSseEvent = readonly [string, Record<string, unknown>];
function sseBody(events: readonly AnthropicSseEvent[]): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}
function messageStart(): AnthropicSseEvent {
  return ['message_start', {
    type: 'message_start',
    message: { id: 'msg_pia', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
  }];
}
function toolStepResponse(id: string, input: Record<string, unknown>): Response {
  const events: AnthropicSseEvent[] = [
    messageStart(),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'codepilot_cli_tools_install', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(sseBody(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function installFetch(handler: () => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => handler()) as typeof fetch;
  return () => { globalThis.fetch = original; };
}
async function collectStream(stream: ReadableStream<string>, onEvent?: (e: SSEEvent, abortController: AbortController) => void, abortController?: AbortController): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of value.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6)) as SSEEvent;
      events.push(event);
      onEvent?.(event, abortController!);
    }
  }
  return events;
}
function errorEventData(events: SSEEvent[]): Record<string, unknown> | null {
  const e = events.find((ev) => ev.type === 'error');
  if (!e) return null;
  try { return JSON.parse(e.data) as Record<string, unknown>; } catch { return null; }
}

let wd: string;
let fakeBinDir: string;
before(() => {
  wd = fs.mkdtempSync(path.join(os.tmpdir(), 'postinstall-abort-'));
  if (!isPosix) return;
  // A fake, controllable "CLI tool" that sleeps before responding to
  // --version / --help, so an abort can be timed to land reliably inside
  // that window, well after the (separate, fast) main install command
  // already succeeded.
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postinstall-fakebin-'));
  const binPath = path.join(fakeBinDir, 'myfaketool');
  // -h ALSO sleeps (and would succeed if actually tried) — deliberately,
  // so test 2 can prove getHelpOutput does NOT fall through to it after
  // --help aborts: measured elapsed time distinguishes "stopped after the
  // first abort" from "kept trying the next flag anyway" (an instant -h
  // couldn't tell the two apart).
  fs.writeFileSync(binPath, `#!/bin/sh
if [ "$1" = "--version" ]; then sleep 3; echo "myfaketool version 1.0.0"; exit 0; fi
if [ "$1" = "--help" ]; then sleep 3; echo "myfaketool help text goes here, long enough to pass the 50-char length check for real"; exit 0; fi
if [ "$1" = "-h" ]; then sleep 3; echo "myfaketool short help text goes here, long enough to pass the 50-char length check too"; exit 0; fi
exit 0
`);
  fs.chmodSync(binPath, 0o755);
  process.env.PATH = `${fakeBinDir}:${process.env.PATH}`;
});
after(() => {
  try { fs.rmSync(wd, { recursive: true, force: true }); } catch { /* ignore */ }
  if (isPosix) { try { fs.rmSync(fakeBinDir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

async function toolCount(): Promise<number> {
  const { getAllCustomCliTools } = await import('@/lib/db');
  return getAllCustomCliTools().filter((t) => t.name === 'myfaketool' || t.binName === 'myfaketool').length;
}

describe('post-install phase abort/timeout coverage', { skip: isPosix ? false : skipReason }, () => {
  it('1. main install succeeds, slow --version, toolExecutionMs fires: timeout classification, registration zero', async () => {
    const before = await toolCount();
    const session = (await import('@/lib/db')).createSession('postinstall-1', MODEL, '', wd);
    (await import('@/lib/db')).addMessage(session.id, 'user', 'x');
    const abortController = new AbortController();
    const restore = installFetch(() => toolStepResponse('toolu_pia1', { command: 'echo done && echo install myfaketool', name: undefined }));
    let events: SSEEvent[];
    try {
      const stream = runAgentLoop({
        callScene: 'interactive_chat',
        prompt: 'x',
        sessionId: session.id,
        model: MODEL,
        systemPrompt: 'probe',
        workingDirectory: wd,
        abortController,
        permissionMode: 'normal',
        bypassPermissions: true,
        timeouts: { toolExecutionMs: 800 }, // fires well inside the 3s --version sleep, well after the fast main install
      });
      events = await collectStream(stream);
    } finally {
      restore();
    }
    const err = errorEventData(events);
    assert.ok(err, 'error event present');
    assert.equal(err.category, 'TIMEOUT_TOOL_EXECUTION');
    assert.equal(events[events.length - 1].type, 'done');
    const after = await toolCount();
    assert.equal(after, before, 'no registration happened despite the main install command itself succeeding');
  });

  it('2. main install succeeds, slow --help, caller abort: no continuing probe after abort', async () => {
    // Confirmed by reading the real code before writing this test (not
    // assumed): createCustomCliTool runs BEFORE getHelpOutput in
    // runCliToolInstall — registration is real, committed work that
    // completes once --version succeeds, strictly before --help is even
    // attempted. An abort landing during --help therefore cannot "prevent"
    // that earlier registration (there is nothing to prevent — it already
    // happened, correctly, before the abort fired), and asserting zero
    // registrations here would be asserting something false about the
    // real code's own ordering. What this DOES prove: getHelpOutput must
    // propagate the abort immediately rather than falling through to try
    // `-h` next — measured by elapsed time, since this fake binary's `-h`
    // ALSO sleeps 3s and would succeed if actually invoked, so "stopped
    // after --help's own abort" (~3.8s total) and "kept trying -h anyway"
    // (~6.8s+) are only distinguishable this way.
    const before = await toolCount();
    const session = (await import('@/lib/db')).createSession('postinstall-2', MODEL, '', wd);
    (await import('@/lib/db')).addMessage(session.id, 'user', 'x');
    const abortController = new AbortController();
    const restore = installFetch(() => toolStepResponse('toolu_pia2', { command: 'echo done && echo install myfaketool', name: undefined }));
    const started = Date.now();
    let events: SSEEvent[];
    try {
      const stream = runAgentLoop({
        callScene: 'interactive_chat',
        prompt: 'x',
        sessionId: session.id,
        model: MODEL,
        systemPrompt: 'probe',
        workingDirectory: wd,
        abortController,
        permissionMode: 'normal',
        bypassPermissions: true,
        // No timeouts configured — this is a pure caller abort, timed to
        // land after --version has already finished (~3s, registration
        // already committed by then) and while --help is sleeping (its
        // own separate 3s window).
      });
      events = await collectStream(stream, (e, ac) => {
        if (e.type === 'tool_use') setTimeout(() => ac.abort(), 3800);
      }, abortController);
    } finally {
      restore();
    }
    const elapsedMs = Date.now() - started;
    assert.ok(!events.some((e) => e.type === 'error'), 'a user abort must never surface as an error event');
    assert.equal(events[events.length - 1].type, 'done');
    const after = await toolCount();
    assert.equal(after, before + 1, 'registration DID happen — it completed correctly before the abort, during the earlier --version phase');
    assert.ok(elapsedMs < 6000, `getHelpOutput must not fall through to -h after --help's own abort — took ${elapsedMs}ms, which would be >=6800ms if it tried both flags sequentially`);
  });

  it('3. normal (no abort/timeout) probes still preserve existing behavior', async () => {
    const normalBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postinstall-normalbin-'));
    fs.writeFileSync(path.join(normalBinDir, 'normaltool'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "normaltool version 2.0.0"; exit 0; fi
if [ "$1" = "--help" ]; then echo "normaltool help text goes here, long enough to pass the 50-char length check for real"; exit 0; fi
exit 0
`);
    fs.chmodSync(path.join(normalBinDir, 'normaltool'), 0o755);
    process.env.PATH = `${normalBinDir}:${process.env.PATH}`;

    const session = (await import('@/lib/db')).createSession('postinstall-3', MODEL, '', wd);
    (await import('@/lib/db')).addMessage(session.id, 'user', 'x');
    const abortController = new AbortController();
    const restore = installFetch(() => toolStepResponse('toolu_pia3', { command: 'echo done && echo install normaltool', name: undefined }));
    let events: SSEEvent[];
    try {
      const stream = runAgentLoop({
        callScene: 'interactive_chat',
        prompt: 'x',
        sessionId: session.id,
        model: MODEL,
        systemPrompt: 'probe',
        workingDirectory: wd,
        abortController,
        permissionMode: 'normal',
        bypassPermissions: true,
      });
      events = await collectStream(stream);
    } finally {
      restore();
      try { fs.rmSync(normalBinDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    assert.ok(!events.some((e) => e.type === 'error'), 'no error on the normal path');
    const toolResult = events.find((e) => e.type === 'tool_result');
    assert.ok(toolResult, 'tool_result present');
    const data = JSON.parse(toolResult!.data) as { content: string };
    assert.match(data.content, /Successfully installed and registered "normaltool"/);
    assert.match(data.content, /normaltool help text goes here/);
    const { getAllCustomCliTools } = await import('@/lib/db');
    assert.ok(getAllCustomCliTools().some((t) => t.name === 'normaltool'), 'normal registration still happens when nothing aborts');
  });
});

describe('post-install phase abort/timeout coverage (Windows note)', { skip: isPosix ? true : false }, () => {
  it('documents why these tests are skipped on this platform', () => {
    assert.ok(true, skipReason);
  });
});
