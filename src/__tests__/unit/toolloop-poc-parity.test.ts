/**
 * toolloop-poc-parity.test.ts — AI SDK 7 Phase 3: ToolLoopAgent side-by-side
 * AI SDK 7 ToolLoop parity evidence.
 *
 * What this pins: `runToolLoopAgentPoc()` (src/lib/experimental/
 * agent-loop-toolloop-poc.ts, built on AI SDK 7 ToolLoopAgent) must produce
 * the SAME externally observable behavior as the production `runAgentLoop()`
 * (src/lib/agent-loop.ts, manual while-loop) across three parity classes:
 *
 *   1. SSE parity — event-by-event: status init, rewind_point, text delta,
 *      thinking, tool_use, tool_call result, step_complete (finish reason),
 *      permission_request, error, result, done. Compared as full normalized
 *      sequences, plus a committed golden snapshot for the tool-call turn.
 *   2. DB history parity — both streams are fed through a faithful replica of
 *      the chat route's SSE→contentBlocks consumer (collectStreamResponse in
 *      src/lib/chat-collect-stream-response.ts) and
 *      must persist byte-identical assistant message content + token_usage,
 *      and rebuild byte-identical next-turn model messages from DB.
 *   3. Permission parity — approve / deny / abort-while-pending run through
 *      the REAL assembleTools permission wrapper on both loops (the wrapper
 *      and permission-registry are shared code, so timeout semantics are
 *      additionally covered by permission-registry-finalize.test.ts).
 *
 * Method: both loops run against the SAME isolated DB (db-isolation.setup),
 * the SAME working directory, and a scripted global fetch that replays
 * identical canned Anthropic Messages streaming responses (env-mode provider
 * via ANTHROPIC_API_KEY=fake, official base URL → non-proxy code path). The
 * scripted fetch also CAPTURES outbound request bodies so the test asserts
 * wire parity (system prompt, messages, tools, tool_choice, max_tokens) —
 * the strongest form of "the two loops drive the provider identically".
 *
 * Anything that fails equality here is a Phase 3 parity gap and must be
 * recorded in the AI SDK 7 ToolLoop parity notes, not papered
 * over in the adapter.
 *
 * Regenerate the golden snapshot after an intentional contract change:
 *   UPDATE_TOOLLOOP_PARITY_FIXTURES=1 npx tsx --test \
 *     --import ./src/__tests__/db-isolation.setup.ts \
 *     src/__tests__/unit/toolloop-poc-parity.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Env-mode Anthropic provider (no DB provider rows needed). Must be set
// before the loops resolve a provider; the key never leaves the process —
// the scripted fetch intercepts every request.
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

import { runAgentLoop, type AgentLoopOptions } from '@/lib/agent-loop';
import { runToolLoopAgentPoc } from '@/lib/experimental/agent-loop-toolloop-poc';
import { createSession, addMessage, getMessages, getPermissionRequest } from '@/lib/db';
import { resolvePendingPermission } from '@/lib/permission-registry';
import { buildCoreMessages } from '@/lib/message-builder';
import type { SSEEvent } from '@/types';

const FIXTURE_DIR = path.join(
  process.cwd(), 'src', '__tests__', 'fixtures', 'toolloop-poc-parity',
);
const UPDATE = process.env.UPDATE_TOOLLOOP_PARITY_FIXTURES === '1';
const MODEL = 'claude-sonnet-4-6';

// ── Canned Anthropic Messages streaming responses ───────────────

type AnthropicSseEvent = readonly [string, Record<string, unknown>];

function sseBody(events: readonly AnthropicSseEvent[]): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function messageStart(): AnthropicSseEvent {
  return ['message_start', {
    type: 'message_start',
    message: {
      id: 'msg_parity', type: 'message', role: 'assistant', model: MODEL,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  }];
}

/** Final text-only step (stop_reason end_turn). */
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

/** Tool-call step: short text then one tool_use block (stop_reason tool_use). */
function toolStepResponse(toolName: string, toolInput: Record<string, unknown>): Response {
  const events: AnthropicSseEvent[] = [
    messageStart(),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check. ' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_parity_1', name: toolName, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(sseBody(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Streaming response that emits one text delta and then never closes (until abort). */
function hangingStepResponse(signal: AbortSignal | null | undefined): Response {
  const prelude: AnthropicSseEvent[] = [
    messageStart(),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial…' } }],
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseBody(prelude)));
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

// ── Scripted fetch harness ──────────────────────────────────────

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

type FetchScript = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any,
  callIndex: number,
  init: RequestInit | undefined,
) => Response;

function installScriptedFetch(script: FetchScript): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const index = calls.length;
    calls.push({ url, headers, body });
    return script(body, index, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Step-aware script: first request (no tool_result in messages) → tool step, follow-up → final text. */
function toolTurnScript(toolName: string, toolInput: Record<string, unknown>, finalText: string): FetchScript {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (body: any) => {
    const hasToolResult = Array.isArray(body?.messages) && body.messages.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'tool_result'),
    );
    return hasToolResult ? textStepResponse(finalText) : toolStepResponse(toolName, toolInput);
  };
}

// ── Stream collection + normalization ───────────────────────────

async function collectStream(
  stream: ReadableStream<string>,
  onEvent?: (event: SSEEvent) => void,
): Promise<SSEEvent[]> {
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

/**
 * Normalize per-run volatile values so two runs are comparable:
 *   - drop keep_alive (timer-based)
 *   - session ids → <SID>
 *   - rewind userMessageId (DB message id) → <MID>
 *   - permissionRequestId → <PERM-n> in order of first appearance
 *   - approvalToken (HMAC over per-run id+expiry, Phase 4 ②) → <TOKEN-n>
 *   - working directory absolute path → <WD>
 */
function normalizeEvents(
  events: SSEEvent[],
  opts: { sessionId: string; workingDirectory: string },
): Array<{ type: string; data: unknown }> {
  const permIds = new Map<string, string>();
  return events
    .filter((e) => e.type !== 'keep_alive')
    .map((e) => {
      let data: unknown = e.data;
      if (typeof e.data === 'string' && e.data.length > 0) {
        let text = e.data;
        // Bind permission ids before generic replacements.
        if (e.type === 'permission_request' || e.type === 'permission_resolved') {
          try {
            const parsed = JSON.parse(text) as { permissionRequestId?: string; approvalToken?: string };
            const id = parsed.permissionRequestId;
            if (id && !permIds.has(id)) permIds.set(id, `<PERM-${permIds.size + 1}>`);
            // The token is volatile (HMAC of per-run id + expiry) but must be
            // PRESENT on both loops — map it to a stable marker rather than
            // dropping it, so a loop that stops emitting it fails parity.
            const token = parsed.approvalToken;
            if (token && !permIds.has(token)) permIds.set(token, `<TOKEN-${permIds.size + 1}>`);
          } catch { /* keep raw */ }
        }
        for (const [id, marker] of permIds) text = text.split(id).join(marker);
        text = text.split(opts.sessionId).join('<SID>');
        text = text.split(opts.workingDirectory).join('<WD>');
        if (e.type === 'rewind_point') {
          try {
            const parsed = JSON.parse(text) as { userMessageId?: string };
            if (parsed.userMessageId) text = text.split(parsed.userMessageId).join('<MID>');
          } catch { /* keep raw */ }
        }
        try { data = JSON.parse(text); } catch { data = text; }
      }
      return { type: e.type, data };
    });
}

// ── Chat route consumer replica (DB history parity) ─────────────
//
// Faithful subset of collectStreamResponse in src/lib/chat-collect-stream-response.ts:
// thinking phase separation, text flushing before tool_use, tool_result
// last-wins dedup, error capture, result usage capture, and the final
// structured-JSON vs plain-text persistence decision. Media saving is not
// replicated (no media in these scenarios).
interface RouteBlock { type: string; [k: string]: unknown }

function consumeLikeChatRoute(events: SSEEvent[]): { content: string; tokenUsage: unknown } {
  const contentBlocks: RouteBlock[] = [];
  let currentText = '';
  let thinkingText = '';
  let thinkingPhaseEnded = false;
  let tokenUsage: unknown;
  let hasError = false;
  let errorMessage = '';
  const seenToolResultIds = new Set<string>();

  for (const event of events) {
    if (event.type === 'permission_request' || event.type === 'tool_output') {
      // not persisted
    } else if (event.type === 'thinking') {
      if (thinkingPhaseEnded) {
        if (thinkingText) thinkingText += '\n\n---\n\n';
        thinkingPhaseEnded = false;
      }
      thinkingText += event.data;
    } else if (event.type === 'text') {
      currentText += event.data;
      if (thinkingText) thinkingPhaseEnded = true;
    } else if (event.type === 'tool_use') {
      if (thinkingText) thinkingPhaseEnded = true;
      if (currentText.trim()) {
        contentBlocks.push({ type: 'text', text: currentText });
        currentText = '';
      }
      const toolData = JSON.parse(event.data);
      contentBlocks.push({ type: 'tool_use', id: toolData.id, name: toolData.name, input: toolData.input });
    } else if (event.type === 'tool_result') {
      const resultData = JSON.parse(event.data);
      const newBlock: RouteBlock = {
        type: 'tool_result',
        tool_use_id: resultData.tool_use_id,
        content: resultData.content,
        is_error: resultData.is_error || false,
      };
      if (seenToolResultIds.has(resultData.tool_use_id)) {
        const idx = contentBlocks.findIndex(
          (b) => b.type === 'tool_result' && b.tool_use_id === resultData.tool_use_id,
        );
        if (idx >= 0) contentBlocks[idx] = newBlock;
      } else {
        seenToolResultIds.add(resultData.tool_use_id);
        contentBlocks.push(newBlock);
      }
    } else if (event.type === 'error') {
      hasError = true;
      errorMessage = event.data || 'Unknown error';
    } else if (event.type === 'result') {
      const resultData = JSON.parse(event.data);
      if (resultData.usage) tokenUsage = resultData.usage;
    }
  }

  if (currentText.trim()) contentBlocks.push({ type: 'text', text: currentText });
  if (thinkingText.trim()) contentBlocks.unshift({ type: 'thinking', thinking: thinkingText.trim() });
  if (hasError && contentBlocks.length === 0 && errorMessage) {
    contentBlocks.push({ type: 'text', text: `**Error:** ${errorMessage}` });
  }

  const hasStructuredBlocks = contentBlocks.some(
    (b) => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'thinking',
  );
  const content = hasStructuredBlocks
    ? JSON.stringify(contentBlocks)
    : contentBlocks.filter((b) => b.type === 'text').map((b) => b.text as string).join('').trim();
  return { content, tokenUsage };
}

// ── Side-by-side scenario runner ────────────────────────────────

type LoopFn = (options: AgentLoopOptions) => ReadableStream<string>;

interface LoopRunResult {
  sessionId: string;
  raw: SSEEvent[];
  normalized: Array<{ type: string; data: unknown }>;
  calls: CapturedCall[];
}

interface ScenarioOptions {
  prompt: string;
  workingDirectory: string;
  script: FetchScript;
  permissionMode?: string;
  onEvent?: (event: SSEEvent, abortController: AbortController) => void;
}

async function runLoopScenario(loopFn: LoopFn, opts: ScenarioOptions): Promise<LoopRunResult> {
  const session = createSession('parity', MODEL, '', opts.workingDirectory);
  addMessage(session.id, 'user', opts.prompt);
  const abortController = new AbortController();
  const scripted = installScriptedFetch(opts.script);
  try {
    const stream = loopFn({
      callScene: 'interactive_chat',
      prompt: opts.prompt,
      sessionId: session.id,
      model: MODEL,
      systemPrompt: 'You are a parity probe. Answer briefly.',
      workingDirectory: opts.workingDirectory,
      abortController,
      permissionMode: opts.permissionMode || 'normal',
    });
    const raw = await collectStream(stream, (event) => opts.onEvent?.(event, abortController));
    return {
      sessionId: session.id,
      raw,
      normalized: normalizeEvents(raw, { sessionId: session.id, workingDirectory: opts.workingDirectory }),
      calls: scripted.calls,
    };
  } finally {
    scripted.restore();
  }
}

/** Run the same scenario through both loops (production first, then POC). */
async function runSideBySide(opts: ScenarioOptions): Promise<{ prod: LoopRunResult; poc: LoopRunResult }> {
  const prod = await runLoopScenario(runAgentLoop, opts);
  const poc = await runLoopScenario(runToolLoopAgentPoc, opts);
  return { prod, poc };
}

/** Wire parity: the request bodies both loops send to the provider must match. */
function assertWireParity(prod: LoopRunResult, poc: LoopRunResult) {
  assert.equal(
    poc.calls.length, prod.calls.length,
    `request count parity: prod=${prod.calls.length} poc=${poc.calls.length}`,
  );
  for (let i = 0; i < prod.calls.length; i++) {
    assert.equal(poc.calls[i].url, prod.calls[i].url, `request ${i} URL parity`);
    assert.deepEqual(poc.calls[i].body, prod.calls[i].body, `request ${i} body parity (system/messages/tools/tool_choice/max_tokens)`);
  }
}

function assertDbHistoryParity(prod: LoopRunResult, poc: LoopRunResult, workingDirectory: string) {
  const prodPersist = consumeLikeChatRoute(prod.raw);
  const pocPersist = consumeLikeChatRoute(poc.raw);
  // Persisted assistant content must be byte-identical.
  assert.equal(pocPersist.content, prodPersist.content, 'persisted assistant message content parity');
  // Token usage + context accounting snapshot (result event) must match.
  assert.deepEqual(pocPersist.tokenUsage, prodPersist.tokenUsage, 'token_usage + context_accounting parity');

  // Round-trip: persist into each session, rebuild next-turn model messages
  // from the DB, and require identical wire-ready histories.
  addMessage(prod.sessionId, 'assistant', prodPersist.content, JSON.stringify(prodPersist.tokenUsage ?? null));
  addMessage(poc.sessionId, 'assistant', pocPersist.content, JSON.stringify(pocPersist.tokenUsage ?? null));
  const prodNext = buildCoreMessages(getMessages(prod.sessionId, { limit: 200, excludeHeartbeatAck: true }).messages);
  const pocNext = buildCoreMessages(getMessages(poc.sessionId, { limit: 200, excludeHeartbeatAck: true }).messages);
  assert.deepEqual(pocNext, prodNext, `next-turn DB history rebuild parity (wd=${workingDirectory})`);
}

// ── Suites ──────────────────────────────────────────────────────

let wd: string;

before(() => {
  wd = fs.mkdtempSync(path.join(os.tmpdir(), 'toolloop-parity-'));
  fs.writeFileSync(path.join(wd, 'note.txt'), 'parity note line 1\nparity note line 2\n');
});

after(() => {
  fs.rmSync(wd, { recursive: true, force: true });
});

describe('SSE parity — text-only turn', () => {
  it('emits an identical normalized event sequence and identical wire requests', async () => {
    const { prod, poc } = await runSideBySide({
      prompt: 'parity: say ok',
      workingDirectory: wd,
      script: () => textStepResponse('ok, parity.'),
    });

    assert.deepEqual(
      poc.normalized, prod.normalized,
      'text-only turn: POC SSE sequence must equal production agent-loop sequence',
    );
    // Sanity on the shared sequence shape (not just equality of two empties).
    const types = prod.normalized.map((e) => e.type);
    assert.deepEqual(types.filter((t) => t === 'text'), ['text'], 'one text delta');
    assert.ok(types.includes('rewind_point'), 'rewind_point present');
    assert.ok(types.includes('result'), 'result present');
    assert.equal(types[types.length - 1], 'done', 'terminates with done');
    assertWireParity(prod, poc);
  });
});

describe('SSE parity — tool call turn (Read, permission-safe)', () => {
  it('matches event-by-event across tool_use/tool_result/step_complete/finish and on the wire', async () => {
    const notePath = path.join(wd, 'note.txt');
    const { prod, poc } = await runSideBySide({
      prompt: 'parity: read the note file',
      workingDirectory: wd,
      script: toolTurnScript('Read', { file_path: notePath }, 'The note has two lines.'),
    });

    assert.deepEqual(
      poc.normalized, prod.normalized,
      'tool turn: POC SSE sequence must equal production agent-loop sequence',
    );

    const types = prod.normalized.map((e) => e.type);
    assert.ok(types.includes('tool_use'), 'tool_use present');
    assert.ok(types.includes('tool_result'), 'tool_result present');
    // Two steps → two step_complete status events with tool-calls → stop.
    const stepEvents = prod.normalized.filter(
      (e) => e.type === 'status' && (e.data as { subtype?: string })?.subtype === 'step_complete',
    ) as Array<{ data: { finishReason: string } }>;
    assert.deepEqual(
      stepEvents.map((e) => e.data.finishReason), ['tool-calls', 'stop'],
      'finish reason per step: tool-calls then stop',
    );
    assertWireParity(prod, poc);

    // Golden snapshot — reviewable committed evidence of the exact contract.
    const goldenPath = path.join(FIXTURE_DIR, 'sse-golden-tool-turn.json');
    const golden = prod.normalized.map((e) => ({
      ...e,
      // The Read result embeds the temp path; keep the fixture stable.
      data: typeof e.data === 'object' ? JSON.parse(JSON.stringify(e.data).split(notePath).join('<FILE>')) : e.data,
    }));
    if (UPDATE) {
      fs.mkdirSync(FIXTURE_DIR, { recursive: true });
      fs.writeFileSync(goldenPath, JSON.stringify(golden, null, 2) + '\n');
    }
    assert.ok(fs.existsSync(goldenPath), 'golden fixture committed (regenerate with UPDATE_TOOLLOOP_PARITY_FIXTURES=1)');
    assert.deepEqual(golden, JSON.parse(fs.readFileSync(goldenPath, 'utf8')), 'golden SSE snapshot for the tool turn');

    assertDbHistoryParity(prod, poc, wd);
  });
});

describe('DB history parity — text-only turn', () => {
  it('persists identical content/token_usage and rebuilds identical next-turn history', async () => {
    const { prod, poc } = await runSideBySide({
      prompt: 'parity: db round trip',
      workingDirectory: wd,
      script: () => textStepResponse('db parity answer.'),
    });
    assertDbHistoryParity(prod, poc, wd);
  });
});

describe('Permission parity — Bash requires approval in normal mode', () => {
  function bashScenario(onPermission: (permId: string) => void): ScenarioOptions {
    return {
      prompt: 'parity: run a command',
      workingDirectory: wd,
      permissionMode: 'normal',
      script: toolTurnScript('Bash', { command: 'sleep 0' }, 'Command finished.'),
      onEvent: (event) => {
        if (event.type === 'permission_request') {
          const { permissionRequestId } = JSON.parse(event.data) as { permissionRequestId: string };
          // Resolve on the next tick — the loop is awaiting the registry.
          setImmediate(() => onPermission(permissionRequestId));
        }
      },
    };
  }

  it('approve: both loops emit permission_request, execute the tool, and finish identically', async () => {
    const seen: string[] = [];
    const scenario = bashScenario((id) => {
      seen.push(id);
      resolvePendingPermission(id, { behavior: 'allow' });
    });
    const { prod, poc } = await runSideBySide(scenario);

    assert.equal(seen.length, 2, 'both loops raised exactly one permission_request each');
    assert.deepEqual(
      poc.normalized, prod.normalized,
      'approve flow: POC SSE sequence must equal production agent-loop sequence',
    );
    const types = prod.normalized.map((e) => e.type);
    assert.ok(types.includes('permission_request'), 'permission_request present');
    assert.ok(types.includes('tool_result'), 'tool executed after approval');
    assert.equal(types[types.length - 1], 'done', 'turn completes (back to sendable state)');
    // Registry persisted the SAME terminal status for both loops.
    assert.equal(getPermissionRequest(seen[0])?.status, 'allow');
    assert.equal(getPermissionRequest(seen[1])?.status, 'allow');
    assertWireParity(prod, poc);
    assertDbHistoryParity(prod, poc, wd);
  });

  it('deny: both loops surface the deny as the tool result and keep looping identically', async () => {
    const seen: string[] = [];
    const scenario = bashScenario((id) => {
      seen.push(id);
      resolvePendingPermission(id, { behavior: 'deny', message: 'not now' });
    });
    const { prod, poc } = await runSideBySide(scenario);

    assert.deepEqual(
      poc.normalized, prod.normalized,
      'deny flow: POC SSE sequence must equal production agent-loop sequence',
    );
    const toolResults = prod.normalized.filter((e) => e.type === 'tool_result') as Array<{ data: { content: string } }>;
    assert.equal(toolResults.length, 1);
    assert.match(toolResults[0].data.content, /Permission denied by user: not now/);
    assert.equal(prod.normalized[prod.normalized.length - 1].type, 'done', 'turn completes after deny');
    assert.equal(getPermissionRequest(seen[0])?.status, 'deny');
    assert.equal(getPermissionRequest(seen[1])?.status, 'deny');
    assertDbHistoryParity(prod, poc, wd);
  });

  it('abort while approval is pending: registry auto-denies, both loops terminate with done and no error event', async () => {
    const seen: string[] = [];
    const scenario: ScenarioOptions = {
      prompt: 'parity: run a command',
      workingDirectory: wd,
      permissionMode: 'normal',
      script: toolTurnScript('Bash', { command: 'sleep 0' }, 'Command finished.'),
      onEvent: (event, abortController) => {
        if (event.type === 'permission_request') {
          const { permissionRequestId } = JSON.parse(event.data) as { permissionRequestId: string };
          seen.push(permissionRequestId);
          setImmediate(() => abortController.abort());
        }
      },
    };
    const { prod, poc } = await runSideBySide(scenario);

    assert.deepEqual(
      poc.normalized, prod.normalized,
      'abort-while-pending flow: POC SSE sequence must equal production agent-loop sequence',
    );
    assert.equal(prod.normalized[prod.normalized.length - 1].type, 'done', 'stream closes → composer returns to sendable state');
    assert.ok(!prod.normalized.some((e) => e.type === 'error'), 'user abort must not surface an error bubble');
    // Registry persisted aborted for both loops' requests.
    assert.equal(getPermissionRequest(seen[0])?.status, 'aborted');
    assert.equal(getPermissionRequest(seen[1])?.status, 'aborted');
    // NOTE: timeout auto-deny parity is covered by construction — both loops
    // share wrapWithPermissions + registerPendingPermission, whose 5-minute
    // timeout / permission_resolved contract is pinned in
    // permission-registry-finalize.test.ts.
  });
});

describe('SSE parity — provider error turn', () => {
  it('non-retryable 401 → identical error surface and both terminate with done', async () => {
    const { prod, poc } = await runSideBySide({
      prompt: 'parity: error path',
      workingDirectory: wd,
      script: () => new Response(
        JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key (parity probe)' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    });

    assert.deepEqual(
      poc.normalized, prod.normalized,
      'error turn: POC SSE sequence must equal production agent-loop sequence',
    );
    assert.ok(prod.normalized.some((e) => e.type === 'error'), 'error event surfaced');
    assert.equal(prod.normalized[prod.normalized.length - 1].type, 'done', 'terminates with done');
  });
});

describe('SSE parity — abort mid-stream', () => {
  it('user abort during text streaming → identical teardown, done, no error bubble', async () => {
    const scenario: ScenarioOptions = {
      prompt: 'parity: abort mid stream',
      workingDirectory: wd,
      script: (_body, _index, init) => hangingStepResponse(init?.signal),
      onEvent: (event, abortController) => {
        if (event.type === 'text') setImmediate(() => abortController.abort());
      },
    };
    const { prod, poc } = await runSideBySide(scenario);

    assert.deepEqual(
      poc.normalized, prod.normalized,
      'abort mid-stream: POC SSE sequence must equal production agent-loop sequence',
    );
    assert.equal(prod.normalized[prod.normalized.length - 1].type, 'done', 'stream closes after abort');
    assert.ok(!prod.normalized.some((e) => e.type === 'error'), 'user abort must not surface an error bubble');
  });
});
