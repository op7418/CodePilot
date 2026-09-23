import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { telemetryReportBudget } from '../../lib/telemetry/report-budget';
import { runAgentLoop, type AgentLoopOptions } from '@/lib/agent-loop';
import { runToolLoopAgentPoc } from '@/lib/experimental/agent-loop-toolloop-poc';
import { addMessage, createSession } from '@/lib/db';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

const MODEL = 'claude-sonnet-4-6';
type Loop = (options: AgentLoopOptions) => ReadableStream<string>;

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function providerErrorStream(errorType: string, text?: string): Response {
  const chunks = [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_in_band_error',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    ...(text === undefined ? [] : [sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    })]),
    sseEvent('error', {
      type: 'error',
      error: { type: errorType, message: `${errorType} in-band fixture` },
    }),
  ];
  return new Response(chunks.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function providerHttpError(status: number, errorType: string): Response {
  return new Response(JSON.stringify({
    type: 'error',
    error: { type: errorType, message: `${errorType} initial request fixture` },
  }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function runLoop(
  loop: Loop,
  workingDirectory: string,
  responseFactory: () => Response,
): Promise<string> {
  const session = createSession('stream-telemetry', MODEL, '', workingDirectory);
  addMessage(session.id, 'user', 'probe provider stream failure');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => responseFactory()) as typeof fetch;
  try {
    const stream = loop({
      callScene: 'interactive_chat',
      prompt: 'probe provider stream failure',
      sessionId: session.id,
      model: MODEL,
      systemPrompt: 'Return the fixture response.',
      workingDirectory,
      abortController: new AbortController(),
      permissionMode: 'normal',
    });
    let raw = '';
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += value;
    }
    return raw;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function sentryEvents(envelopes: unknown[]): Array<Record<string, unknown>> {
  return envelopes.flatMap((envelope) => {
    if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) return [];
    return envelope[1].flatMap((item) => {
      if (!Array.isArray(item) || !item[0] || typeof item[0] !== 'object') return [];
      if ((item[0] as { type?: unknown }).type !== 'event') return [];
      return item[1] && typeof item[1] === 'object' ? [item[1] as Record<string, unknown>] : [];
    });
  });
}

async function waitForCapturedEvents(
  sentry: typeof import('@sentry/node'),
  envelopes: unknown[],
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await sentry.flush(5_000);
    if (sentryEvents(envelopes).length === expected) {
      // captureProviderFailure imports Sentry asynchronously. Give any duplicate
      // terminal callback one more turn before the exact-once assertion.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      await sentry.flush(5_000);
      return;
    }
  }
}

describe('native loops capture provider stream failures', () => {
  // Each fixture proves one terminal lifecycle, independent of cross-request budgeting.
  beforeEach(() => telemetryReportBudget.reset());
  let workingDirectory: string;
  let originalNodeEnv: string | undefined;
  let originalChannel: string | undefined;
  let sentry: typeof import('@sentry/node');
  const mutableEnv = process.env as unknown as Record<string, string | undefined>;
  const envelopes: unknown[] = [];

  before(async () => {
    workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-in-band-telemetry-'));
    originalNodeEnv = process.env.NODE_ENV;
    originalChannel = process.env.NEXT_PUBLIC_CODEPILOT_CHANNEL;
    mutableEnv.NODE_ENV = 'production';
    mutableEnv.NEXT_PUBLIC_CODEPILOT_CHANNEL = 'stable';
    // Match error-classifier's dynamic import so both references share the
    // same initialized carrier in Node's conditional-export graph.
    sentry = await import('@sentry/node');
    sentry.init({
      dsn: 'https://public@example.invalid/1',
      defaultIntegrations: false,
      transport: () => ({
        send(envelope) {
          envelopes.push(envelope);
          return Promise.resolve({ statusCode: 200 });
        },
        flush() {
          return Promise.resolve(true);
        },
      }),
    });
  });

  after(async () => {
    await sentry.close(1_000);
    if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = originalNodeEnv;
    if (originalChannel === undefined) delete mutableEnv.NEXT_PUBLIC_CODEPILOT_CHANNEL;
    else mutableEnv.NEXT_PUBLIC_CODEPILOT_CHANNEL = originalChannel;
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  });

  for (const [label, loop] of [
    ['production loop', runAgentLoop],
    ['ToolLoop POC', runToolLoopAgentPoc],
  ] as const) {
    for (const [shape, text] of [
      ['empty', undefined],
      ['partial-content', 'partial answer'],
    ] as const) {
      it(`${label}: ${shape} in-band overload produces one HTTP 5xx transient event`, async () => {
        envelopes.length = 0;
        const raw = await runLoop(
          loop,
          workingDirectory,
          () => providerErrorStream('overloaded_error', text),
        );
        await waitForCapturedEvents(sentry, envelopes, 1);

        if (text !== undefined) assert.match(raw, /partial answer/);
        const events = sentryEvents(envelopes);
        assert.equal(events.length, 1, `${label}/${shape} must capture exactly once`);
        const tags = events[0].tags as Record<string, unknown>;
        assert.equal(tags['error.category'], 'PROVIDER_HTTP_5XX');
        assert.equal(tags['error.outcome'], 'transient_upstream');
        assert.equal(tags['status.class'], '5xx');
      });
    }

    it(`${label}: empty in-band permission error produces zero Sentry Issue`, async () => {
      envelopes.length = 0;
      const raw = await runLoop(
        loop,
        workingDirectory,
        () => providerErrorStream('permission_error'),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      await sentry.flush(5_000);

      assert.match(raw, /data: \{"type":"error"/);
      assert.match(raw, /data: \{"type":"done"/);
      assert.equal(sentryEvents(envelopes).length, 0);
    });

    it(`${label}: initial HTTP 403 produces zero Sentry Issue`, async () => {
      envelopes.length = 0;
      await runLoop(
        loop,
        workingDirectory,
        () => providerHttpError(403, 'permission_error'),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      await sentry.flush(5_000);

      assert.equal(sentryEvents(envelopes).length, 0);
    });

    it(`${label}: initial HTTP 503 produces exactly one transient Issue`, async () => {
      envelopes.length = 0;
      await runLoop(
        loop,
        workingDirectory,
        () => providerHttpError(503, 'api_error'),
      );
      await waitForCapturedEvents(sentry, envelopes, 1);

      const events = sentryEvents(envelopes);
      assert.equal(events.length, 1, `${label}/initial-503 must capture exactly once`);
      const tags = events[0].tags as Record<string, unknown>;
      assert.equal(tags['error.category'], 'PROVIDER_HTTP_5XX');
      assert.equal(tags['error.outcome'], 'transient_upstream');
      assert.equal(tags['status.class'], '5xx');
    });
  }
});
