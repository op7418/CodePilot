/**
 * #49 (stability audit ⑦→①) — native loop must NOT swallow `tool-error`.
 *
 * Reproduction/contrast: when a tool's execute() throws, the AI SDK emits a
 * `tool-error` fullStream part. Pre-fix, agent-loop.ts's switch had no case for
 * it → it fell to `default: break` and was silently dropped, so the UI's
 * tool_use bubble hung with no result.
 *
 * This file has two layers of evidence:
 *   1. Pure builder unit tests + source-pins (fast, defense-in-depth).
 *   2. A REAL integration counter-example (the block the reviewer required):
 *      inject a tool whose execute() throws via `toolsOverride`, drive BOTH the
 *      production `runAgentLoop` and the `runToolLoopAgentPoc` with a scripted
 *      Anthropic fetch, and assert the errored tool_use gets a paired
 *      `tool_result(is_error:true)` — which pre-fix did not exist (swallowed) —
 *      then feed the real SSE into useSSEStream's parse layer and assert
 *      onToolResult receives the is_error error bubble.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { buildToolErrorResultData } from '@/lib/agent-loop-tool-error';
import { runAgentLoop, type AgentLoopOptions } from '@/lib/agent-loop';
import { runToolLoopAgentPoc } from '@/lib/experimental/agent-loop-toolloop-poc';
import { createSession, addMessage } from '@/lib/db';
import { consumeSSEStream, type SSECallbacks } from '@/hooks/useSSEStream';
import type { SSEEvent } from '@/types';

// Env-mode Anthropic provider (no DB provider rows needed, isolated temp DB via
// db-isolation.setup). The key never leaves the process — the scripted fetch
// intercepts every request. Same setup as toolloop-poc-parity.test.ts.
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

const MODEL = 'claude-sonnet-4-6';
const THROW_MSG = 'tool execute() threw on purpose (#49 boom)';

describe('buildToolErrorResultData (#49)', () => {
  it('Error → is_error:true tool_result carrying the message', () => {
    const data = buildToolErrorResultData({ toolCallId: 'call_1', error: new Error('exec boom') });
    assert.equal(data.tool_use_id, 'call_1');
    assert.equal(data.content, 'exec boom');
    assert.equal(data.is_error, true);
  });

  it('string error is passed through as content', () => {
    const data = buildToolErrorResultData({ toolCallId: 'c', error: 'raw failure' });
    assert.equal(data.content, 'raw failure');
    assert.equal(data.is_error, true);
  });

  it('non-Error/non-string error is JSON-stringified', () => {
    const data = buildToolErrorResultData({ toolCallId: 'c', error: { code: 500, why: 'nope' } });
    assert.equal(data.content, JSON.stringify({ code: 500, why: 'nope' }));
    assert.equal(data.is_error, true);
  });

  it('反例对照：tool-error payload is is_error:true, distinct from the tool-result path (is_error:false)', () => {
    // The whole point of #49: a thrown tool surfaces as an ERROR bubble, not a
    // success. Before the fix there was no payload at all (swallowed).
    const data = buildToolErrorResultData({ toolCallId: 'c', error: new Error('x') });
    assert.notEqual(data.is_error as boolean, false);
  });
});

// ── 源码钉：tool-error 不再被 default 吞掉 ──
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

describe('agent-loop fullStream switch 补 case tool-error（#49 源码钉，对照吞掉前）', () => {
  for (const rel of ['../../lib/agent-loop.ts', '../../lib/experimental/agent-loop-toolloop-poc.ts']) {
    it(`${rel} forwards tool-error as an is_error tool_result (not swallowed by default)`, () => {
      const src = read(rel);
      assert.ok(src.includes("case 'tool-error'"), `${rel} 必须有 case 'tool-error'（否则落到 default 被吞）`);
      assert.ok(src.includes('buildToolErrorResultData'), `${rel} 必须用 buildToolErrorResultData 构造错误气泡`);
      // The tool-error block must enqueue a tool_result event.
      const block = src.slice(src.indexOf("case 'tool-error'"));
      assert.ok(/type:\s*'tool_result'/.test(block), `${rel} tool-error 分支必须 enqueue tool_result`);
    });
  }
});

// ── Scripted Anthropic Messages streaming (minimal replica of the harness in
//    toolloop-poc-parity.test.ts) ──────────────────────────────────────────

type AnthropicSseEvent = readonly [string, Record<string, unknown>];

function sseBody(events: readonly AnthropicSseEvent[]): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function messageStart(): AnthropicSseEvent {
  return ['message_start', {
    type: 'message_start',
    message: {
      id: 'msg_toolerr', type: 'message', role: 'assistant', model: MODEL,
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
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working. ' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_err_1', name: toolName, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(sseBody(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

type FetchScript = (body: unknown) => Response;

function installScriptedFetch(script: FetchScript): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    return script(body);
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; } };
}

function hasToolResultInBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const msgs = (body as { messages?: unknown }).messages;
  if (!Array.isArray(msgs)) return false;
  return msgs.some((m) => {
    const content = (m as { content?: unknown }).content;
    return Array.isArray(content) && content.some((p) => (p as { type?: unknown }).type === 'tool_result');
  });
}

/** First request (no tool_result yet) → tool step; follow-up → final text. */
function toolTurnScript(toolName: string, toolInput: Record<string, unknown>, finalText: string): FetchScript {
  return (body) => (hasToolResultInBody(body) ? textStepResponse(finalText) : toolStepResponse(toolName, toolInput));
}

// ── Stream collection ───────────────────────────────────────────

function makeReader(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return stream.getReader();
}

async function collectStream(stream: ReadableStream<string>): Promise<{ events: SSEEvent[]; raw: string }> {
  const events: SSEEvent[] = [];
  let raw = '';
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += value;
    for (const line of value.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      events.push(JSON.parse(line.slice(6)) as SSEEvent);
    }
  }
  return { events, raw };
}

function noopCallbacks(): SSECallbacks {
  return {
    onText: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onToolOutput: () => {},
    onToolProgress: () => {},
    onStatus: () => {},
    onResult: () => {},
    onPermissionRequest: () => {},
    onToolTimeout: () => {},
    onModeChanged: () => {},
    onTaskUpdate: () => {},
    onRewindPoint: () => {},
    onKeepAlive: () => {},
    onError: () => {},
  };
}

// ── Injected tools (bypass assembleTools/permission-wrapping via toolsOverride) ──

function throwingTool(): ToolSet {
  return {
    probe: tool({
      description: 'A probe tool whose execute always throws (#49 repro).',
      inputSchema: z.object({}) as z.ZodType,
      // Explicit Promise<string> return type so the throw-only body doesn't
      // infer Promise<never> (which breaks the tool() output-type overload).
      execute: async (): Promise<string> => { throw new Error(THROW_MSG); },
    }),
  };
}

function okTool(): ToolSet {
  return {
    probe: tool({
      description: 'A probe tool that returns normally (contrast control).',
      inputSchema: z.object({}) as z.ZodType,
      execute: async (): Promise<string> => 'probe ok output',
    }),
  };
}

async function runToolTurn(
  loopFn: (o: AgentLoopOptions) => ReadableStream<string>,
  tools: ToolSet,
  wd: string,
): Promise<{ events: SSEEvent[]; raw: string }> {
  const session = createSession('tool-error', MODEL, '', wd);
  addMessage(session.id, 'user', 'do the probe');
  const scripted = installScriptedFetch(toolTurnScript('probe', {}, 'done, no more tools.'));
  try {
    const stream = loopFn({
      callScene: 'interactive_chat',
      prompt: 'do the probe',
      sessionId: session.id,
      model: MODEL,
      systemPrompt: 'You are a probe.',
      workingDirectory: wd,
      abortController: new AbortController(),
      permissionMode: 'normal',
      tools,
    });
    return await collectStream(stream);
  } finally {
    scripted.restore();
  }
}

// ── Integration counter-example (the reviewer-required block) ────

describe('#49 反例：工具 execute() 抛错 → is_error 错误气泡（真实链路，对照吞掉前）', () => {
  let wd: string;
  before(() => { wd = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-error-repro-')); });
  after(() => { fs.rmSync(wd, { recursive: true, force: true }); });

  const loops: Array<[string, (o: AgentLoopOptions) => ReadableStream<string>]> = [
    ['production runAgentLoop', runAgentLoop],
    ['POC runToolLoopAgentPoc', runToolLoopAgentPoc],
  ];

  for (const [label, loopFn] of loops) {
    it(`${label}: 抛错工具产出配对 tool_result(is_error:true)，UI onToolResult 收到错误气泡`, async () => {
      const { events, raw } = await runToolTurn(loopFn, throwingTool(), wd);

      const toolUse = events.find((e) => e.type === 'tool_use');
      assert.ok(toolUse, `${label}: tool_use 必须被 emit`);
      const tu = JSON.parse(toolUse!.data) as { id: string };

      const toolResults = events
        .filter((e) => e.type === 'tool_result')
        .map((e) => JSON.parse(e.data) as { tool_use_id: string; content: string; is_error?: boolean });
      const errored = toolResults.find((r) => r.tool_use_id === tu.id);

      // 对照吞掉前：修复前 tool-error 落到 default 被丢弃，这个配对 tool_result 根本不存在，
      // tool_use 气泡会一直空转。现在必须存在且 is_error:true。
      assert.ok(errored, `${label}: 抛错的 tool_use 必须有配对 tool_result（修复前被 default 吞掉→无 result）`);
      assert.equal(errored!.is_error, true, `${label}: is_error 必须为 true（错误气泡而非成功）`);
      assert.match(String(errored!.content), /boom/, `${label}: 抛出的错误消息必须透传到 content`);

      // UI 链路：把真实 SSE 喂给 useSSEStream 的解析层，onToolResult 必须收到 is_error 错误气泡。
      let bubble: { is_error?: boolean; content: string } | null = null;
      await consumeSSEStream(makeReader([raw]), {
        ...noopCallbacks(),
        onToolResult: (r) => { if (r.is_error) bubble = r; },
      });
      assert.ok(bubble, `${label}: useSSEStream onToolResult 必须收到错误气泡`);
      assert.equal((bubble as { is_error?: boolean }).is_error, true);
      assert.match((bubble as { content: string }).content, /boom/);
    });
  }

  it('对照控制组：不抛错的工具产出 is_error:false（证明 is_error 由抛错触发，而非恒真）', async () => {
    const { events } = await runToolTurn(runAgentLoop, okTool(), wd);
    const toolResults = events
      .filter((e) => e.type === 'tool_result')
      .map((e) => JSON.parse(e.data) as { content: string; is_error?: boolean });
    assert.ok(toolResults.length >= 1, '正常工具也必须 emit tool_result');
    assert.equal(toolResults[0].is_error ?? false, false, '正常工具 is_error 为 false');
    assert.match(toolResults[0].content, /probe ok output/);
  });
});
