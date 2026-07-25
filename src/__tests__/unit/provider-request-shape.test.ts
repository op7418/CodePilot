/**
 * provider-request-shape.test.ts — AI SDK 7 Phase 2: provider request-shape
 * AI SDK 7 provider capability matrix evidence.
 *
 * What this pins: for each provider wire the native runtime can hit
 * (Anthropic Messages, OpenAI Responses [Codex OAuth path], OpenAI Chat
 * Completions [openai-compatible gateways / OpenRouter-class], and the
 * @ai-sdk/openai-compatible candidate adapter), capture the REAL outbound
 * HTTP request produced by the installed AI SDK 7 packages for the four
 * audited dimensions: reasoning, effort, tool choice, file input.
 *
 * Method: a mock `fetch` is injected into the exact same provider factories
 * `src/lib/ai-provider.ts` uses (same beta headers, same `.chat()` vs
 * `.responses()` wire selection), calls go through `generateText`/`streamText`
 * with the same `providerOptions` shapes `src/lib/agent-loop.ts` assembles,
 * and the captured request is sanitized and compared against committed
 * fixtures in src/__tests__/fixtures/provider-request-shape/.
 *
 * Sanitization contract (fixture-sanitized check):
 *   - Secret-bearing headers (authorization, x-api-key, api-key,
 *     chatgpt-account-id) are recorded by NAME with value "[REDACTED]" —
 *     proving which header would carry credentials without the value.
 *     Test API keys are the obviously-fake FAKE_KEY constant anyway.
 *   - Any string in the body longer than 200 chars is replaced with a
 *     "[redacted: N chars]" marker (defense in depth; all probe payloads
 *     are tiny synthetic values, e.g. a 1×1 PNG and a minimal empty PDF).
 *   - Prompts are synthetic capability probes, never real user content.
 *
 * Regenerate fixtures after an intentional SDK upgrade / mapping change:
 *   UPDATE_REQUEST_SHAPE_FIXTURES=1 npx tsx --test src/__tests__/unit/provider-request-shape.test.ts
 *
 * NOT covered here (needs real credentials → human gate, do not guess):
 * whether each upstream/gateway ACCEPTS these fields or silently ignores
 * them. This file only proves what our runtime puts on the wire.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateText, streamText, tool, type LanguageModel, type ModelMessage, type ToolChoice, type ToolSet } from 'ai';
import { z } from 'zod';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { withChatImageDataUrlFetch } from '../../lib/openai-chat-image-normalizer';

// ── Constants ───────────────────────────────────────────────────

const FIXTURE_DIR = path.join(process.cwd(), 'src', '__tests__', 'fixtures', 'provider-request-shape');
const UPDATE = process.env.UPDATE_REQUEST_SHAPE_FIXTURES === '1';

const FAKE_KEY = 'test-key-not-real';
const SYSTEM = 'You are a synthetic capability probe. Reply with the word ok.';
const PROMPT = 'capability probe ping';
// 1×1 transparent PNG (68 bytes) — synthetic, non-sensitive.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// Minimal (invalid-but-shaped) PDF: "%PDF-1.4\n%%EOF"
const PDF_MIN = 'JVBERi0xLjQKJSVFT0Y=';

function pkgVersion(name: string): string {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'node_modules', name, 'package.json'), 'utf8'),
  ).version as string;
}

const VERSIONS = {
  ai: pkgVersion('ai'),
  '@ai-sdk/anthropic': pkgVersion('@ai-sdk/anthropic'),
  '@ai-sdk/openai': pkgVersion('@ai-sdk/openai'),
  '@ai-sdk/xai': pkgVersion('@ai-sdk/xai'),
  '@ai-sdk/openai-compatible': pkgVersion('@ai-sdk/openai-compatible'),
};

// ── Capture harness ─────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

type ResponseKind = 'anthropic' | 'anthropic-stream' | 'openai-chat' | 'openai-responses' | 'xai-responses-stream';

function cannedResponse(kind: ResponseKind): Response {
  switch (kind) {
    case 'anthropic':
      return new Response(
        JSON.stringify({
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    case 'anthropic-stream': {
      const events = [
        ['message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }],
      ] as const;
      const sse = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    case 'openai-chat':
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-fixture',
          object: 'chat.completion',
          created: 1,
          model: 'probe',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    case 'openai-responses':
      return new Response(
        JSON.stringify({
          id: 'resp_fixture',
          object: 'response',
          created_at: 1,
          status: 'completed',
          error: null,
          incomplete_details: null,
          model: 'probe',
          output: [
            {
              type: 'message',
              id: 'msg_fixture',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok', annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    case 'xai-responses-stream': {
      const response = {
        id: 'resp_xai_fixture',
        object: 'response',
        created_at: 1,
        model: 'grok-4.5',
        status: 'completed',
        output: [],
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 2,
        },
      };
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress' } },
        { type: 'response.output_text.delta', item_id: 'msg_xai_fixture', output_index: 0, content_index: 0, delta: 'ok' },
        { type: 'response.output_text.done', item_id: 'msg_xai_fixture', output_index: 0, content_index: 0, text: 'ok' },
        { type: 'response.completed', response },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
  }
}

function makeCaptureFetch(kind: ResponseKind): { calls: CapturedRequest[]; fetch: typeof fetch } {
  const calls: CapturedRequest[] = [];
  const captureFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return cannedResponse(kind);
  }) as typeof fetch;
  return { calls, fetch: captureFetch };
}

// ── Sanitization ────────────────────────────────────────────────

const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'chatgpt-account-id']);
const MAX_STRING = 200;

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(headers).sort()) {
    out[key] = SECRET_HEADERS.has(key) ? '[REDACTED]' : headers[key];
  }
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `[redacted: ${value.length} chars]` : value;
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeValue(v);
    return out;
  }
  return value;
}

interface FixtureMeta {
  package: string;
  version: string;
  mirrors: string;
  note?: string;
}

function checkFixture(name: string, meta: FixtureMeta, captured: CapturedRequest): void {
  const sanitized = {
    meta: { ...meta, ai: VERSIONS.ai },
    request: {
      url: captured.url,
      method: captured.method,
      headers: sanitizeHeaders(captured.headers),
      body: sanitizeValue(captured.body),
    },
  };
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  if (UPDATE || !fs.existsSync(file)) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(sanitized, null, 2)}\n`);
  }
  const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(
    sanitized,
    expected,
    `request-shape drift for ${name} — if intentional (SDK upgrade / mapping change), regenerate with UPDATE_REQUEST_SHAPE_FIXTURES=1 and re-review the matrix doc`,
  );
}

// ── Shared probe inputs ─────────────────────────────────────────

const TOOLS: ToolSet = {
  read_file: tool({
    description: 'Read a UTF-8 file from the workspace',
    inputSchema: z.object({ path: z.string().describe('workspace-relative path') }),
  }),
};

const IMAGE_MESSAGES: ModelMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: PROMPT },
      // Exactly the part shape message-builder.ts produces for attachments
      { type: 'file', data: PNG_1PX, mediaType: 'image/png' },
    ],
  },
];

const PDF_MESSAGES: ModelMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: PROMPT },
      { type: 'file', data: PDF_MIN, mediaType: 'application/pdf' },
    ],
  },
];

// ── Model builders (mirror src/lib/ai-provider.ts) ──────────────

function appAnthropic(fetchImpl: typeof fetch): LanguageModel {
  // Mirrors ai-provider.ts createLanguageModel case 'anthropic':
  // default baseURL (api.anthropic.com/v1) + interleaved-thinking beta header.
  const anthropic = createAnthropic({
    apiKey: FAKE_KEY,
    headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
    fetch: fetchImpl,
  });
  return anthropic('claude-sonnet-4-6');
}

function appAnthropicOpus(fetchImpl: typeof fetch): LanguageModel {
  const anthropic = createAnthropic({
    apiKey: FAKE_KEY,
    headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
    fetch: fetchImpl,
  });
  return anthropic('claude-opus-4-7');
}

function appOpenAIResponses(fetchImpl: typeof fetch): LanguageModel {
  // Mirrors ai-provider.ts useResponsesApi (Codex OAuth) branch. The app's
  // custom fetch wrapper only rewrites URL + auth headers; the JSON body is
  // whatever the SDK produced, so a plain capture fetch is body-faithful.
  const openai = createOpenAI({ apiKey: FAKE_KEY, fetch: fetchImpl });
  return openai.responses('gpt-5.1-codex');
}

function appXaiResponses(fetchImpl: typeof fetch): LanguageModel {
  const xai = createXai({
    apiKey: FAKE_KEY,
    baseURL: 'https://api.x.ai/v1',
    fetch: fetchImpl,
  });
  return xai.responses('grok-4.5');
}

function gatewayOpenAIChat(fetchImpl: typeof fetch): LanguageModel {
  // Mirrors ai-provider.ts non-OAuth 'openai' branch: openai-compatible
  // third-party gateways / OpenRouter-class providers via .chat(), with the
  // same withChatImageDataUrlFetch wrapper the app installs (发现 3 收口).
  const openai = createOpenAI({
    apiKey: FAKE_KEY,
    baseURL: 'https://gateway.example/v1',
    fetch: withChatImageDataUrlFetch(fetchImpl),
  });
  return openai.chat('anthropic/claude-sonnet-4.6');
}

function gatewayOpenAIChatUpstreamRaw(fetchImpl: typeof fetch): LanguageModel {
  // NO normalization wrapper — pins the raw @ai-sdk/openai .chat() output so
  // the upstream bare-base64 bug (发现 3) stays visible. When an SDK upgrade
  // makes this fixture drift to a proper data URL, the upstream bug is fixed
  // and the app-side wrapper can be retired.
  const openai = createOpenAI({
    apiKey: FAKE_KEY,
    baseURL: 'https://gateway.example/v1',
    fetch: fetchImpl,
  });
  return openai.chat('anthropic/claude-sonnet-4.6');
}

function compatOpenAICompatible(fetchImpl: typeof fetch): LanguageModel {
  // NOT an app path today — candidate adapter (@ai-sdk/openai-compatible)
  // captured for the Phase 2 adoption comparison.
  const compat = createOpenAICompatible({
    name: 'openai-compatible',
    baseURL: 'https://openrouter.example/api/v1',
    apiKey: FAKE_KEY,
    fetch: fetchImpl,
  });
  return compat('anthropic/claude-sonnet-4.6');
}

// ── Case runner ─────────────────────────────────────────────────

interface ProbeCall {
  system?: string;
  prompt?: string;
  messages?: ModelMessage[];
  tools?: ToolSet;
  toolChoice?: ToolChoice<ToolSet>;
  maxOutputTokens?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providerOptions?: any;
}

async function captureGenerate(
  kind: ResponseKind,
  build: (fetchImpl: typeof fetch) => LanguageModel,
  call: ProbeCall,
): Promise<CapturedRequest> {
  const { calls, fetch: fetchImpl } = makeCaptureFetch(kind);
  // Cast: ProbeCall flattens generateText's `prompt` XOR `messages` union;
  // every probe case statically supplies exactly one of the two.
  await generateText({ model: build(fetchImpl), ...call } as Parameters<typeof generateText>[0]);
  assert.equal(calls.length, 1, 'expected exactly one provider HTTP call');
  return calls[0];
}

async function captureStream(
  kind: ResponseKind,
  build: (fetchImpl: typeof fetch) => LanguageModel,
  call: ProbeCall,
): Promise<CapturedRequest> {
  const { calls, fetch: fetchImpl } = makeCaptureFetch(kind);
  const result = streamText({ model: build(fetchImpl), ...call } as Parameters<typeof streamText>[0]);
  // Drain the stream so the request is actually issued and completed.
  for await (const _part of result.fullStream) void _part;
  assert.equal(calls.length, 1, 'expected exactly one provider HTTP call');
  return calls[0];
}

// ── Anthropic Messages wire ─────────────────────────────────────

const ANTHROPIC_META = {
  package: '@ai-sdk/anthropic',
  version: VERSIONS['@ai-sdk/anthropic'],
  mirrors: 'src/lib/ai-provider.ts createLanguageModel case anthropic + src/lib/agent-loop.ts providerOptions.anthropic',
};

describe('provider request shape — Anthropic Messages API', () => {
  it('reasoning: thinking {type:enabled, budgetTokens} is sent as body.thinking with snake_case budget', async () => {
    const req = await captureGenerate('anthropic', appAnthropic, {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } } },
    });
    assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
    assert.deepEqual(req.body.thinking, { type: 'enabled', budget_tokens: 4096 });
    assert.equal(req.headers['anthropic-beta']?.includes('interleaved-thinking-2025-05-14'), true);
    checkFixture('anthropic-reasoning-thinking-enabled', ANTHROPIC_META, req);
  });

  it('reasoning: thinking {type:adaptive} (Opus 4.7+/Fable family) is sent as body.thinking', async () => {
    const req = await captureGenerate('anthropic', appAnthropicOpus, {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      providerOptions: { anthropic: { thinking: { type: 'adaptive' } } },
    });
    assert.deepEqual(req.body.thinking, { type: 'adaptive' });
    checkFixture('anthropic-reasoning-thinking-adaptive', ANTHROPIC_META, req);
  });

  it('effort: providerOptions.anthropic.effort is sent (capture shows exact field + any beta header)', async () => {
    const req = await captureGenerate('anthropic', appAnthropicOpus, {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } },
    });
    // Conclusion pinned from the capture itself; fixture shows the full truth.
    checkFixture('anthropic-effort-high', ANTHROPIC_META, req);
  });

  it('context-1m: anthropicBeta option lands in the anthropic-beta header', async () => {
    const req = await captureGenerate('anthropic', appAnthropic, {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      providerOptions: { anthropic: { anthropicBeta: ['context-1m-2025-08-07'] } },
    });
    assert.equal(req.headers['anthropic-beta']?.includes('context-1m-2025-08-07'), true);
    checkFixture('anthropic-context-1m-beta', ANTHROPIC_META, req);
  });

  it('tool choice: tools + toolChoice auto → body.tools[] + tool_choice {type:auto}', async () => {
    const req = await captureGenerate('anthropic', appAnthropic, {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      tools: TOOLS,
      toolChoice: 'auto',
    });
    assert.equal(req.body.tools?.length, 1);
    assert.equal(req.body.tools[0].name, 'read_file');
    assert.deepEqual(req.body.tool_choice, { type: 'auto' });
    checkFixture('anthropic-tool-choice-auto', ANTHROPIC_META, req);
  });

  it('tool choice: required → tool_choice {type:any}', async () => {
    const req = await captureGenerate('anthropic', appAnthropic, {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      tools: TOOLS,
      toolChoice: 'required',
    });
    assert.deepEqual(req.body.tool_choice, { type: 'any' });
    checkFixture('anthropic-tool-choice-required', ANTHROPIC_META, req);
  });

  it('tool choice: named tool → tool_choice {type:tool, name}', async () => {
    const req = await captureGenerate('anthropic', appAnthropic, {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      tools: TOOLS,
      toolChoice: { type: 'tool', toolName: 'read_file' },
    });
    assert.deepEqual(req.body.tool_choice, { type: 'tool', name: 'read_file' });
    checkFixture('anthropic-tool-choice-named', ANTHROPIC_META, req);
  });

  it('tool choice: no tools + toolChoice none (agent-loop no-tool path) → no tools/tool_choice on wire', async () => {
    const req = await captureGenerate('anthropic', appAnthropic, {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      toolChoice: 'none',
    });
    assert.equal(req.body.tools, undefined);
    assert.equal(req.body.tool_choice, undefined);
    checkFixture('anthropic-tool-choice-none-no-tools', ANTHROPIC_META, req);
  });

  it('file input: image/png file part → content block {type:image, source:base64}', async () => {
    const req = await captureGenerate('anthropic', appAnthropic, {
      system: SYSTEM,
      messages: IMAGE_MESSAGES,
      maxOutputTokens: 16384,
    });
    const parts = req.body.messages[0].content;
    const imagePart = parts.find((p: { type: string }) => p.type === 'image');
    assert.ok(imagePart, 'expected an image content block');
    assert.equal(imagePart.source?.type, 'base64');
    assert.equal(imagePart.source?.media_type, 'image/png');
    checkFixture('anthropic-file-image', ANTHROPIC_META, req);
  });

  it('file input: application/pdf file part → content block {type:document}', async () => {
    const req = await captureGenerate('anthropic', appAnthropic, {
      system: SYSTEM,
      messages: PDF_MESSAGES,
      maxOutputTokens: 16384,
    });
    const parts = req.body.messages[0].content;
    const docPart = parts.find((p: { type: string }) => p.type === 'document');
    assert.ok(docPart, 'expected a document content block');
    checkFixture('anthropic-file-pdf', ANTHROPIC_META, req);
  });

  it('stream parity: streamText body equals generateText body except stream:true', async () => {
    const call: ProbeCall = {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } } },
    };
    const generateReq = await captureGenerate('anthropic', appAnthropic, call);
    const streamReq = await captureStream('anthropic-stream', appAnthropic, call);
    assert.deepEqual({ ...streamReq.body, stream: undefined }, { ...generateReq.body, stream: undefined });
    assert.equal(streamReq.body.stream, true);
    checkFixture(
      'anthropic-stream-parity',
      { ...ANTHROPIC_META, note: 'captured via streamText — native runtime path; only delta vs generateText is stream:true' },
      streamReq,
    );
  });
});

// ── OpenAI Responses wire (Codex OAuth path) ────────────────────

const RESPONSES_META = {
  package: '@ai-sdk/openai',
  version: VERSIONS['@ai-sdk/openai'],
  mirrors: 'src/lib/ai-provider.ts useResponsesApi branch + src/lib/agent-loop.ts providerOptions.openai (Codex Responses)',
};

// Exactly the providerOptions agent-loop.ts sets for the Responses path.
const RESPONSES_PROVIDER_OPTIONS = {
  openai: {
    instructions: SYSTEM,
    store: false,
    reasoningEffort: 'medium',
    textVerbosity: 'medium',
  },
};

describe('provider request shape — OpenAI Responses API (Codex path)', () => {
  it('reasoning/effort: reasoningEffort + textVerbosity + store + instructions land on the wire', async () => {
    const req = await captureGenerate('openai-responses', appOpenAIResponses, {
      system: SYSTEM,
      prompt: PROMPT,
      providerOptions: RESPONSES_PROVIDER_OPTIONS,
    });
    assert.equal(req.url, 'https://api.openai.com/v1/responses');
    assert.equal(req.body.reasoning?.effort, 'medium');
    assert.equal(req.body.store, false);
    assert.equal(req.body.instructions, SYSTEM);
    assert.equal(req.body.text?.verbosity, 'medium');
    checkFixture('openai-responses-reasoning-effort', RESPONSES_META, req);
  });

  it('tool choice: tools + auto → body.tools[] (flattened function) + tool_choice auto', async () => {
    const req = await captureGenerate('openai-responses', appOpenAIResponses, {
      system: SYSTEM,
      prompt: PROMPT,
      tools: TOOLS,
      toolChoice: 'auto',
      providerOptions: RESPONSES_PROVIDER_OPTIONS,
    });
    assert.equal(req.body.tools?.length, 1);
    assert.equal(req.body.tools[0].name, 'read_file');
    assert.equal(req.body.tool_choice, 'auto');
    checkFixture('openai-responses-tool-choice-auto', RESPONSES_META, req);
  });

  it('tool choice: required → tool_choice required', async () => {
    const req = await captureGenerate('openai-responses', appOpenAIResponses, {
      system: SYSTEM,
      prompt: PROMPT,
      tools: TOOLS,
      toolChoice: 'required',
      providerOptions: RESPONSES_PROVIDER_OPTIONS,
    });
    assert.equal(req.body.tool_choice, 'required');
    checkFixture('openai-responses-tool-choice-required', RESPONSES_META, req);
  });

  it('tool choice: named tool → tool_choice {type:function, name}', async () => {
    const req = await captureGenerate('openai-responses', appOpenAIResponses, {
      system: SYSTEM,
      prompt: PROMPT,
      tools: TOOLS,
      toolChoice: { type: 'tool', toolName: 'read_file' },
      providerOptions: RESPONSES_PROVIDER_OPTIONS,
    });
    assert.deepEqual(req.body.tool_choice, { type: 'function', name: 'read_file' });
    checkFixture('openai-responses-tool-choice-named', RESPONSES_META, req);
  });

  it('file input: image/png file part → input_image', async () => {
    const req = await captureGenerate('openai-responses', appOpenAIResponses, {
      system: SYSTEM,
      messages: IMAGE_MESSAGES,
      providerOptions: RESPONSES_PROVIDER_OPTIONS,
    });
    const content = req.body.input.find((m: { role: string }) => m.role === 'user').content;
    const image = content.find((p: { type: string }) => p.type === 'input_image');
    assert.ok(image, 'expected input_image part');
    checkFixture('openai-responses-file-image', RESPONSES_META, req);
  });

  it('file input: application/pdf file part → input_file', async () => {
    const req = await captureGenerate('openai-responses', appOpenAIResponses, {
      system: SYSTEM,
      messages: PDF_MESSAGES,
      providerOptions: RESPONSES_PROVIDER_OPTIONS,
    });
    const content = req.body.input.find((m: { role: string }) => m.role === 'user').content;
    const file = content.find((p: { type: string }) => p.type === 'input_file');
    assert.ok(file, 'expected input_file part');
    checkFixture('openai-responses-file-pdf', RESPONSES_META, req);
  });
});

// ── xAI Responses wire (Grok 4.5 API Key / OAuth shared path) ───

const XAI_RESPONSES_META = {
  package: '@ai-sdk/xai',
  version: VERSIONS['@ai-sdk/xai'],
  mirrors: 'src/lib/ai-provider.ts sdkType=xai branch + src/lib/agent-loop.ts providerOptions.xai',
};

const XAI_PROVIDER_OPTIONS = {
  xai: { store: false, reasoningEffort: 'high' as const },
};

describe('provider request shape — xAI Responses API', () => {
  it('uses the branded /responses endpoint and xAI reasoning/store fields', async () => {
    const req = await captureGenerate('openai-responses', appXaiResponses, {
      system: SYSTEM,
      prompt: PROMPT,
      providerOptions: XAI_PROVIDER_OPTIONS,
    });
    assert.equal(req.url, 'https://api.x.ai/v1/responses');
    assert.equal(req.body.model, 'grok-4.5');
    assert.equal(req.body.reasoning?.effort, 'high');
    assert.equal(req.body.store, false);
    checkFixture('xai-responses-reasoning-effort', XAI_RESPONSES_META, req);
  });

  it('serializes function tools and auto tool choice on xAI Responses', async () => {
    const req = await captureGenerate('openai-responses', appXaiResponses, {
      system: SYSTEM,
      prompt: PROMPT,
      tools: TOOLS,
      toolChoice: 'auto',
      providerOptions: XAI_PROVIDER_OPTIONS,
    });
    assert.equal(req.body.tools?.length, 1);
    assert.equal(req.body.tools[0].name, 'read_file');
    assert.equal(req.body.tool_choice, 'auto');
    checkFixture('xai-responses-tool-choice-auto', XAI_RESPONSES_META, req);
  });

  it('streamText uses the same xAI Responses body with stream=true', async () => {
    const req = await captureStream('xai-responses-stream', appXaiResponses, {
      system: SYSTEM,
      prompt: PROMPT,
      providerOptions: XAI_PROVIDER_OPTIONS,
    });
    assert.equal(req.url, 'https://api.x.ai/v1/responses');
    assert.equal(req.body.stream, true);
    assert.equal(req.body.store, false);
    checkFixture('xai-responses-stream', XAI_RESPONSES_META, req);
  });

  it('surfaces xAI error payloads instead of returning an empty success', async () => {
    const xai = createXai({
      apiKey: FAKE_KEY,
      baseURL: 'https://api.x.ai/v1',
      fetch: (async () => new Response(
        JSON.stringify({ error: { message: 'synthetic xAI rejection', type: 'invalid_request_error' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch,
    });
    await assert.rejects(
      () => generateText({ model: xai.responses('grok-4.5'), prompt: PROMPT }),
      /synthetic xAI rejection/,
    );
  });
});

// ── OpenAI Chat Completions wire (openai-compatible gateways) ───

const CHAT_META = {
  package: '@ai-sdk/openai',
  version: VERSIONS['@ai-sdk/openai'],
  mirrors: 'src/lib/ai-provider.ts non-OAuth openai branch (openai.chat) — openai-compatible gateways / OpenRouter-class',
};

describe('provider request shape — OpenAI Chat Completions (gateway path)', () => {
  it('reasoning/effort: providerOptions.openai.reasoningEffort → body.reasoning_effort', async () => {
    const req = await captureGenerate('openai-chat', gatewayOpenAIChat, {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      providerOptions: { openai: { reasoningEffort: 'high' } },
    });
    assert.equal(req.url, 'https://gateway.example/v1/chat/completions');
    assert.equal(req.body.reasoning_effort, 'high');
    checkFixture('openai-chat-reasoning-effort', CHAT_META, req);
  });

  it('tool choice: tools + auto → body.tools[] (nested function) + tool_choice auto', async () => {
    const req = await captureGenerate('openai-chat', gatewayOpenAIChat, {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      tools: TOOLS,
      toolChoice: 'auto',
    });
    assert.equal(req.body.tools?.length, 1);
    assert.equal(req.body.tools[0].type, 'function');
    assert.equal(req.body.tools[0].function?.name, 'read_file');
    assert.equal(req.body.tool_choice, 'auto');
    checkFixture('openai-chat-tool-choice-auto', CHAT_META, req);
  });

  it('tool choice: required → tool_choice required', async () => {
    const req = await captureGenerate('openai-chat', gatewayOpenAIChat, {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      tools: TOOLS,
      toolChoice: 'required',
    });
    assert.equal(req.body.tool_choice, 'required');
    checkFixture('openai-chat-tool-choice-required', CHAT_META, req);
  });

  it('tool choice: named tool → tool_choice {type:function, function:{name}}', async () => {
    const req = await captureGenerate('openai-chat', gatewayOpenAIChat, {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      tools: TOOLS,
      toolChoice: { type: 'tool', toolName: 'read_file' },
    });
    assert.deepEqual(req.body.tool_choice, { type: 'function', function: { name: 'read_file' } });
    checkFixture('openai-chat-tool-choice-named', CHAT_META, req);
  });

  it('file input: image/png file part → image_url data URL (app path: bare-base64 fixed by withChatImageDataUrlFetch)', async () => {
    const req = await captureGenerate('openai-chat', gatewayOpenAIChat, {
      system: SYSTEM,
      messages: IMAGE_MESSAGES,
      maxOutputTokens: 16384,
    });
    const content = req.body.messages.find((m: { role: string }) => m.role === 'user').content;
    const image = content.find((p: { type: string }) => p.type === 'image_url');
    assert.ok(image, 'expected image_url part');
    assert.equal(
      image.image_url.url,
      `data:image/png;base64,${PNG_1PX}`,
      'app gateway path must send a proper data URL, not bare base64',
    );
    checkFixture('openai-chat-file-image', CHAT_META, req);
  });

  it('file input (upstream control, NO wrapper): @ai-sdk/openai .chat() emits image_url as BARE base64 — upstream bug', async () => {
    const req = await captureGenerate('openai-chat', gatewayOpenAIChatUpstreamRaw, {
      system: SYSTEM,
      messages: IMAGE_MESSAGES,
      maxOutputTokens: 16384,
    });
    const content = req.body.messages.find((m: { role: string }) => m.role === 'user').content;
    const image = content.find((p: { type: string }) => p.type === 'image_url');
    assert.ok(image, 'expected image_url part');
    // Drift here (bare base64 → data URL) means upstream fixed the bug:
    // regenerate fixtures and consider retiring withChatImageDataUrlFetch.
    assert.equal(image.image_url.url, PNG_1PX, 'installed @ai-sdk/openai still emits bare base64');
    checkFixture(
      'openai-chat-file-image-upstream-bare-base64',
      { ...CHAT_META, note: 'raw SDK output WITHOUT the app normalization wrapper — documents upstream bare-base64 bug (发现 3)' },
      req,
    );
  });

  it('file input: application/pdf file part → file part (or documented unsupported)', async () => {
    const req = await captureGenerate('openai-chat', gatewayOpenAIChat, {
      system: SYSTEM,
      messages: PDF_MESSAGES,
      maxOutputTokens: 16384,
    });
    const content = req.body.messages.find((m: { role: string }) => m.role === 'user').content;
    const file = content.find((p: { type: string }) => p.type === 'file');
    assert.ok(file, 'expected file part');
    checkFixture('openai-chat-file-pdf', CHAT_META, req);
  });
});

// ── @ai-sdk/openai-compatible candidate adapter ─────────────────

const COMPAT_META = {
  package: '@ai-sdk/openai-compatible',
  version: VERSIONS['@ai-sdk/openai-compatible'],
  mirrors: 'NOT an app path — Phase 2 candidate adapter comparison for OpenRouter-class gateways',
};

describe('provider request shape — @ai-sdk/openai-compatible (candidate adapter)', () => {
  it('reasoning/effort: providerOptions["openai-compatible"].reasoningEffort → body.reasoning_effort', async () => {
    const req = await captureGenerate('openai-chat', compatOpenAICompatible, {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      providerOptions: { 'openai-compatible': { reasoningEffort: 'high' } },
    });
    assert.equal(req.url, 'https://openrouter.example/api/v1/chat/completions');
    assert.equal(req.body.reasoning_effort, 'high');
    checkFixture('compat-reasoning-effort', COMPAT_META, req);
  });

  it('tool choice: tools + auto', async () => {
    const req = await captureGenerate('openai-chat', compatOpenAICompatible, {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      tools: TOOLS,
      toolChoice: 'auto',
    });
    assert.equal(req.body.tools?.[0]?.function?.name, 'read_file');
    assert.equal(req.body.tool_choice, 'auto');
    checkFixture('compat-tool-choice-auto', COMPAT_META, req);
  });

  it('tool choice: named tool', async () => {
    const req = await captureGenerate('openai-chat', compatOpenAICompatible, {
      system: SYSTEM,
      prompt: PROMPT,
      maxOutputTokens: 16384,
      tools: TOOLS,
      toolChoice: { type: 'tool', toolName: 'read_file' },
    });
    assert.deepEqual(req.body.tool_choice, { type: 'function', function: { name: 'read_file' } });
    checkFixture('compat-tool-choice-named', COMPAT_META, req);
  });

  it('file input: image/png file part → image_url data URL', async () => {
    const req = await captureGenerate('openai-chat', compatOpenAICompatible, {
      system: SYSTEM,
      messages: IMAGE_MESSAGES,
      maxOutputTokens: 16384,
    });
    const content = req.body.messages.find((m: { role: string }) => m.role === 'user').content;
    const image = content.find((p: { type: string }) => p.type === 'image_url');
    assert.ok(image, 'expected image_url part');
    checkFixture('compat-file-image', COMPAT_META, req);
  });

  it('file input: application/pdf — capture whether the compat adapter can send it at all', async () => {
    // The compat package historically threw UnsupportedFunctionality for
    // non-image files. Capture the truth either way: a request fixture if it
    // sends, an error fixture if it throws.
    try {
      const req = await captureGenerate('openai-chat', compatOpenAICompatible, {
        system: SYSTEM,
        messages: PDF_MESSAGES,
        maxOutputTokens: 16384,
      });
      checkFixture('compat-file-pdf', COMPAT_META, req);
    } catch (err) {
      const sanitized = {
        meta: { ...COMPAT_META, ai: VERSIONS.ai, note: 'PDF file part is NOT sendable via @ai-sdk/openai-compatible — SDK throws before any HTTP request' },
        error: { name: (err as Error).name, message: (err as Error).message },
      };
      const file = path.join(FIXTURE_DIR, 'compat-file-pdf.json');
      if (UPDATE || !fs.existsSync(file)) {
        fs.mkdirSync(FIXTURE_DIR, { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(sanitized, null, 2)}\n`);
      }
      assert.deepEqual(sanitized, JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  });
});

// ── Fixture hygiene (fixture-sanitized check, enforced in CI) ───

describe('provider request shape — fixture hygiene', () => {
  it('no fixture contains the test key, an unredacted auth header, or oversized strings', () => {
    const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 20, `expected the full fixture set, got ${files.length}`);
    for (const f of files) {
      const raw = fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8');
      assert.ok(!raw.includes(FAKE_KEY), `${f} leaks the API key value`);
      const parsed = JSON.parse(raw);
      const headers: Record<string, string> = parsed.request?.headers ?? {};
      for (const [k, v] of Object.entries(headers)) {
        if (SECRET_HEADERS.has(k)) assert.equal(v, '[REDACTED]', `${f} header ${k} not redacted`);
      }
      // No string anywhere in the body may exceed the sanitizer cap.
      const walk = (value: unknown): void => {
        if (typeof value === 'string') {
          assert.ok(value.length <= MAX_STRING + 32, `${f} contains an oversized string (${value.length} chars)`);
        } else if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') Object.values(value).forEach(walk);
      };
      walk(parsed.request?.body);
    }
  });
});
