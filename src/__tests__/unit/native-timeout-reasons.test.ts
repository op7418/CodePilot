/**
 * native-timeout-reasons.test.ts — AI SDK 7 Phase 4 ① targeted tests: the
 * four Native-runtime timeout reason codes (connect / first-token /
 * tool-execution / total-run) fire accurately, surface as classified SSE
 * error events, and persist to the DB via the chat route's error fallback.
 *
 * Evidence layout (per the required check "四类 timeout 原因码准确落库且可展示"):
 *   1. Controller unit tests — each budget fires on ITS signal only, is
 *      cleared by ITS anchor part, and reports {reason, budgetMs, source}.
 *   2. End-to-end through the REAL runAgentLoop with a scripted provider
 *      fetch (same harness as toolloop-poc-parity.test.ts): each reason code
 *      arrives as an `error` SSE event with category TIMEOUT_* + timeout
 *      payload, and the run still terminates with `done`.
 *   3. 落库 read-back — the error event's JSON is persisted through the chat
 *      route's `**Error:** <event.data>` fallback into messages.content;
 *      asserted by writing with addMessage and reading back via getMessages.
 *   4. 反例 (anti-fake-data): with budgets configured but generous, a normal
 *      turn produces NO timeout error; a USER abort with budgets armed is
 *      still a clean abort (no TIMEOUT_* misclassification); a connection
 *      BLACK HOLE never produces TIMEOUT_FIRST_TOKEN — not with only
 *      firstTokenMs configured (fires nothing) and not with
 *      firstTokenMs < connectMs (fires connect) — because the first-token
 *      timer is armed only by `start-step` (response arrived).
 *
 * Defaults are all-off: `resolveNativeTimeoutConfig()` with no options and
 * no env returns an empty config and the controller arms nothing — pinned
 * below so enabling timeouts stays an explicit product decision.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

import { runAgentLoop } from '@/lib/agent-loop';
import {
  createNativeTimeoutController,
  resolveNativeTimeoutConfig,
  TIMEOUT_CATEGORY,
} from '@/lib/native-timeout';
import { buildNativeErrorEventData } from '@/lib/agent-loop-error-event';
import { createSession, addMessage, getMessages } from '@/lib/db';
import { tool } from 'ai';
import { z } from 'zod';
import type { SSEEvent } from '@/types';

const MODEL = 'claude-sonnet-4-6';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Canned Anthropic streaming responses (same wire shapes as parity) ──

type AnthropicSseEvent = readonly [string, Record<string, unknown>];

function sseBody(events: readonly AnthropicSseEvent[]): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function messageStart(): AnthropicSseEvent {
  return ['message_start', {
    type: 'message_start',
    message: {
      id: 'msg_timeout', type: 'message', role: 'assistant', model: MODEL,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  }];
}

function textStepResponse(text: string): Response {
  const events: AnthropicSseEvent[] = [
    messageStart(),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(sseBody(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function toolStepResponse(toolName: string, toolInput: Record<string, unknown>): Response {
  const events: AnthropicSseEvent[] = [
    messageStart(),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_timeout_1', name: toolName, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(sseBody(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Response whose headers arrive but that never produces model output. */
function headersOnlyHangingResponse(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseBody([messageStart()])));
      const onAbort = () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        try { controller.error(err); } catch { /* already errored */ }
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Fetch that never responds at all (connection black hole). */
function neverRespond(init: RequestInit | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const onAbort = () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
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
  fetchHandler: (init: RequestInit | undefined, index: number) => Response | Promise<Response>;
  tools?: import('ai').ToolSet;
  onEvent?: (e: SSEEvent, abortController: AbortController) => void;
}

async function runLoop(opts: RunOpts): Promise<{ sessionId: string; events: SSEEvent[] }> {
  const session = createSession('native-timeout-test', MODEL, '', wd);
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
      timeouts: opts.timeouts,
      ...(opts.tools ? { tools: opts.tools } : {}),
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

let wd: string;
before(() => { wd = fs.mkdtempSync(path.join(os.tmpdir(), 'native-timeout-')); });
after(() => { try { fs.rmSync(wd, { recursive: true, force: true }); } catch { /* ignore */ } });

// ── 1. Config resolution: all-off default is pinned ─────────────

describe('resolveNativeTimeoutConfig', () => {
  it('defaults to NO budgets (empty config) with no options and no env', () => {
    const cfg = resolveNativeTimeoutConfig(undefined, {} as NodeJS.ProcessEnv);
    assert.deepEqual(Object.values(cfg).filter(Boolean), []);
  });

  it('explicit options win over env', () => {
    const cfg = resolveNativeTimeoutConfig(
      { connectMs: 111 },
      { CODEPILOT_NATIVE_TIMEOUTS: '{"connectMs":999}' } as unknown as NodeJS.ProcessEnv,
    );
    assert.equal(cfg.connectMs, 111);
  });

  it('parses the env JSON and drops non-positive / non-numeric budgets', () => {
    const cfg = resolveNativeTimeoutConfig(undefined, {
      CODEPILOT_NATIVE_TIMEOUTS: '{"connectMs":30000,"firstTokenMs":-5,"toolExecutionMs":"x","totalRunMs":600000}',
    } as unknown as NodeJS.ProcessEnv);
    assert.deepEqual(cfg, { connectMs: 30000, firstTokenMs: undefined, toolExecutionMs: undefined, totalRunMs: 600000 });
  });

  it('ignores malformed env JSON (never breaks chat)', () => {
    const cfg = resolveNativeTimeoutConfig(undefined, {
      CODEPILOT_NATIVE_TIMEOUTS: '{not json',
    } as unknown as NodeJS.ProcessEnv);
    assert.deepEqual(cfg, {});
  });
});

// ── 2. Controller: each budget anchored to its own signal ────────

describe('createNativeTimeoutController', () => {
  it('arms nothing with an empty config (no fire, signal mirrors caller)', async () => {
    const user = new AbortController();
    const ctl = createNativeTimeoutController({}, user.signal);
    ctl.onRunStart();
    ctl.onStepRequest();
    await sleep(60);
    assert.equal(ctl.fired, null);
    assert.equal(ctl.signal.aborted, false);
    user.abort();
    assert.equal(ctl.signal.aborted, true);
    assert.equal(ctl.fired, null, 'user abort is not a timeout');
    ctl.dispose();
  });

  it('connect: fires when no start-step arrives; cleared by start-step', async () => {
    const a = createNativeTimeoutController({ connectMs: 40 }, new AbortController().signal);
    a.onStepRequest();
    await sleep(80);
    assert.deepEqual(a.fired, { reason: 'connect', budgetMs: 40, source: 'agent-loop.fullStream[start-step]' });
    a.dispose();

    const b = createNativeTimeoutController({ connectMs: 40 }, new AbortController().signal);
    b.onStepRequest();
    b.onStreamPart({ type: 'start-step' });
    await sleep(80);
    assert.equal(b.fired, null, 'start-step clears the connect budget');
    b.dispose();
  });

  it('first-token: fires when the response has output nothing; cleared by the first output part', async () => {
    const a = createNativeTimeoutController({ firstTokenMs: 40 }, new AbortController().signal);
    a.onStepRequest();
    a.onStreamPart({ type: 'start-step' }); // response arrived…
    await sleep(80); // …but no output part
    assert.deepEqual(a.fired, { reason: 'first-token', budgetMs: 40, source: 'agent-loop.fullStream[first-output-part]' });
    a.dispose();

    const b = createNativeTimeoutController({ firstTokenMs: 40 }, new AbortController().signal);
    b.onStepRequest();
    b.onStreamPart({ type: 'start-step' });
    b.onStreamPart({ type: 'text-delta' });
    await sleep(80);
    assert.equal(b.fired, null, 'first output part clears the first-token budget');
    b.dispose();
  });

  // 反例 (P1 fix): first-token must never pre-empt the connect window. A
  // black-hole connection produces no start-step, so the first-token timer
  // must never even be armed.
  it('first-token: black hole with ONLY firstTokenMs configured fires nothing', async () => {
    const ctl = createNativeTimeoutController({ firstTokenMs: 30 }, new AbortController().signal);
    ctl.onStepRequest();
    await sleep(90); // 3× the budget, still no response
    assert.equal(ctl.fired, null, 'no start-step → first-token must not fire (that window belongs to connect)');
    assert.equal(ctl.signal.aborted, false, 'no spurious abort either');
    ctl.dispose();
  });

  it('first-token: black hole with firstTokenMs < connectMs is classified as connect, never first-token', async () => {
    const ctl = createNativeTimeoutController({ connectMs: 80, firstTokenMs: 20 }, new AbortController().signal);
    ctl.onStepRequest();
    await sleep(160);
    assert.equal(ctl.fired?.reason, 'connect', 'the smaller first-token budget must not pre-empt connect');
    assert.equal(ctl.fired?.source, 'agent-loop.fullStream[start-step]');
    ctl.dispose();
  });

  it('first-token: the budget window starts at start-step, not at the request', async () => {
    const ctl = createNativeTimeoutController({ firstTokenMs: 60 }, new AbortController().signal);
    ctl.onStepRequest();
    await sleep(120); // 2× the budget elapses BEFORE the response — must not count
    assert.equal(ctl.fired, null, 'pre-response time must not consume the first-token budget');
    ctl.onStreamPart({ type: 'start-step' });
    await sleep(120);
    assert.deepEqual(ctl.fired, { reason: 'first-token', budgetMs: 60, source: 'agent-loop.fullStream[first-output-part]' });
    ctl.dispose();
  });

  it('tool-execution: fires between tool-call and tool-result; cleared by the matching tool-result', async () => {
    const a = createNativeTimeoutController({ toolExecutionMs: 40 }, new AbortController().signal);
    a.onStepRequest();
    a.onStreamPart({ type: 'start-step' });
    a.onStreamPart({ type: 'tool-call', toolCallId: 't1' });
    await sleep(80);
    assert.deepEqual(a.fired, { reason: 'tool-execution', budgetMs: 40, source: 'agent-loop.fullStream[tool-call→tool-result]' });
    a.dispose();

    const b = createNativeTimeoutController({ toolExecutionMs: 40 }, new AbortController().signal);
    b.onStepRequest();
    b.onStreamPart({ type: 'tool-call', toolCallId: 't1' });
    b.onStreamPart({ type: 'tool-result', toolCallId: 't1' });
    await sleep(80);
    assert.equal(b.fired, null, 'tool-result clears its tool timer');
    b.dispose();
  });

  it('total-run: fires from run start regardless of stream progress; only the FIRST budget wins', async () => {
    const ctl = createNativeTimeoutController({ totalRunMs: 40, connectMs: 200 }, new AbortController().signal);
    ctl.onRunStart();
    ctl.onStepRequest();
    // keep the stream "healthy" — total-run must still fire
    ctl.onStreamPart({ type: 'start-step' });
    ctl.onStreamPart({ type: 'text-delta' });
    await sleep(80);
    assert.equal(ctl.fired?.reason, 'total-run');
    assert.equal(ctl.fired?.source, 'agent-loop.run');
    ctl.dispose();
  });

  it('guardStream: a fired budget unblocks a consumer stuck on a never-resolving stream read', async () => {
    // ai@7 keeps fullStream open while it awaits a hung tool execute even
    // after the abort signal fires — guardStream is what lets the loop
    // escape. Model that: a stream whose second read never resolves.
    const ctl = createNativeTimeoutController({ toolExecutionMs: 40 }, new AbortController().signal);
    const hungStream: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        yield 'first';
        await new Promise<never>(() => { /* never resolves, ignores all signals */ });
      },
    };
    ctl.onStreamPart({ type: 'tool-call', toolCallId: 't1' }); // arm the budget
    const seen: string[] = [];
    await assert.rejects(
      (async () => {
        for await (const v of ctl.guardStream(hungStream)) seen.push(v);
      })(),
      (err: Error) => err.name === 'AbortError',
      'guarded iteration must reject once the budget fires',
    );
    assert.deepEqual(seen, ['first'], 'parts before the hang still flow through');
    assert.equal(ctl.fired?.reason, 'tool-execution');
    ctl.dispose();
  });

  it('guardStream: with NO budgets it passes the iterable through and never injects a rejection', async () => {
    const ctl = createNativeTimeoutController({}, new AbortController().signal);
    const values: number[] = [];
    async function* src() { yield 1; yield 2; yield 3; }
    for await (const v of ctl.guardStream(src())) values.push(v);
    assert.deepEqual(values, [1, 2, 3]);
    assert.equal(ctl.fired, null);
    ctl.dispose();
  });
});

// ── 3. End-to-end through the real agent loop ────────────────────

describe('runAgentLoop timeout reason codes (end-to-end)', () => {
  it('connect: black-hole fetch → TIMEOUT_CONNECT error event, then done', async () => {
    const { events } = await runLoop({
      timeouts: { connectMs: 150 },
      fetchHandler: (init) => neverRespond(init),
    });
    const err = errorEventData(events);
    assert.ok(err, 'error event present');
    assert.equal(err.category, 'TIMEOUT_CONNECT');
    const timeout = err.timeout as Record<string, unknown>;
    assert.equal(timeout.reason, 'connect');
    assert.equal(timeout.budgetMs, 150);
    assert.equal(timeout.source, 'agent-loop.fullStream[start-step]');
    assert.equal(events[events.length - 1].type, 'done', 'stream still terminates with done');
    assert.ok(!events.some((e) => e.type === 'result'), 'timed-out turn must not persist a result');
  });

  it('first-token: headers arrive but no output → TIMEOUT_FIRST_TOKEN', async () => {
    const { events } = await runLoop({
      timeouts: { firstTokenMs: 200 },
      fetchHandler: (init) => headersOnlyHangingResponse(init?.signal),
    });
    const err = errorEventData(events);
    assert.ok(err, 'error event present');
    assert.equal(err.category, 'TIMEOUT_FIRST_TOKEN');
    assert.equal((err.timeout as Record<string, unknown>).reason, 'first-token');
    assert.equal(events[events.length - 1].type, 'done');
  });

  it('tool-execution: hung tool execute → TIMEOUT_TOOL_EXECUTION', async () => {
    const hungTool = tool({
      description: 'A tool that never finishes',
      inputSchema: z.object({ note: z.string() }),
      execute: () => new Promise<string>(() => { /* never resolves */ }),
    });
    const { events } = await runLoop({
      timeouts: { toolExecutionMs: 250 },
      tools: { hung_probe: hungTool },
      fetchHandler: () => toolStepResponse('hung_probe', { note: 'x' }),
    });
    const err = errorEventData(events);
    assert.ok(err, 'error event present');
    assert.equal(err.category, 'TIMEOUT_TOOL_EXECUTION');
    assert.equal((err.timeout as Record<string, unknown>).reason, 'tool-execution');
    assert.equal(events[events.length - 1].type, 'done');
  });

  it('total-run: healthy-but-endless stream → TIMEOUT_TOTAL_RUN', async () => {
    const { events } = await runLoop({
      timeouts: { totalRunMs: 300 },
      fetchHandler: (init) => headersOnlyHangingResponse(init?.signal),
    });
    const err = errorEventData(events);
    assert.ok(err, 'error event present');
    assert.equal(err.category, 'TIMEOUT_TOTAL_RUN');
    assert.equal((err.timeout as Record<string, unknown>).reason, 'total-run');
    assert.equal(events[events.length - 1].type, 'done');
  });

  it('落库: the timeout error JSON persists via the chat route error fallback and reads back with the reason code', async () => {
    const { sessionId, events } = await runLoop({
      timeouts: { connectMs: 150 },
      fetchHandler: (init) => neverRespond(init),
    });
    const errorEvent = events.find((e) => e.type === 'error');
    assert.ok(errorEvent, 'error event present');
    // Replica of route.ts's error fallback: no other content was produced,
    // so the persisted assistant message is `**Error:** <event.data>`.
    const persisted = `**Error:** ${errorEvent.data}`;
    addMessage(sessionId, 'assistant', persisted, null);
    const readBack = getMessages(sessionId, { limit: 10 }).messages.find((m) => m.role === 'assistant');
    assert.ok(readBack, 'assistant error message persisted');
    assert.ok(readBack.content.includes('TIMEOUT_CONNECT'), 'reason category stored in DB');
    const stored = JSON.parse(readBack.content.replace('**Error:** ', '')) as Record<string, unknown>;
    assert.equal((stored.timeout as Record<string, unknown>).reason, 'connect');
    assert.equal((stored.timeout as Record<string, unknown>).source, 'agent-loop.fullStream[start-step]');
  });

  // 反例 1 (anti-fake-data): budgets configured but generous → normal turn,
  // no timeout error, result present.
  it('does NOT fire on a healthy turn with generous budgets', async () => {
    const { events } = await runLoop({
      timeouts: { connectMs: 10_000, firstTokenMs: 10_000, totalRunMs: 30_000 },
      fetchHandler: () => textStepResponse('healthy answer'),
    });
    assert.ok(!events.some((e) => e.type === 'error'), 'no error on a healthy turn');
    assert.ok(events.some((e) => e.type === 'result'), 'normal result event present');
  });

  // 反例 2 (P1 fix): a black-hole connection with firstTokenMs < connectMs
  // must surface as TIMEOUT_CONNECT — the shorter first-token budget cannot
  // pre-empt the connect window because it only arms after start-step.
  it('black-hole with firstTokenMs < connectMs → TIMEOUT_CONNECT, not first-token', async () => {
    const { events } = await runLoop({
      timeouts: { connectMs: 300, firstTokenMs: 100 },
      fetchHandler: (init) => neverRespond(init),
    });
    const err = errorEventData(events);
    assert.ok(err, 'error event present');
    assert.equal(err.category, 'TIMEOUT_CONNECT', 'black hole must classify as connect');
    const timeout = err.timeout as Record<string, unknown>;
    assert.equal(timeout.reason, 'connect');
    assert.equal(timeout.budgetMs, 300, 'the connect budget fired, not the smaller first-token one');
    assert.equal(events[events.length - 1].type, 'done');
  });

  // 反例 3: USER abort with budgets armed must stay a clean abort — never a
  // TIMEOUT_* misclassification, never an error bubble.
  it('classifies a user abort as abort, not as a timeout', async () => {
    const { events } = await runLoop({
      timeouts: { firstTokenMs: 60_000 },
      fetchHandler: (init) => headersOnlyHangingResponse(init?.signal),
      onEvent: (e, abortController) => {
        if (e.type === 'status') setTimeout(() => abortController.abort(), 50);
      },
    });
    assert.ok(!events.some((e) => e.type === 'error'), 'user abort produces no error event');
    assert.equal(events[events.length - 1].type, 'done');
  });
});

// ── 4. Error-event payload mapping (pure) ────────────────────────

describe('buildNativeErrorEventData timeout mapping', () => {
  it('maps each fired reason to its TIMEOUT_* category with the breadcrumb attached', () => {
    for (const [reason, category] of Object.entries(TIMEOUT_CATEGORY)) {
      const data = buildNativeErrorEventData(new Error('aborted'), undefined, {
        reason: reason as keyof typeof TIMEOUT_CATEGORY,
        budgetMs: 1234,
        source: 'test-source',
      });
      assert.equal(data.category, category);
      assert.equal(data.timeout?.budgetMs, 1234);
      assert.equal(data.timeout?.source, 'test-source');
      assert.ok(data.userMessage.includes('1234ms'));
    }
  });

  it('keeps the legacy AGENT_ERROR shape when no timeout fired', () => {
    const data = buildNativeErrorEventData(new Error('boom'));
    assert.deepEqual(data, { category: 'AGENT_ERROR', userMessage: 'boom' });
  });
});
