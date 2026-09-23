/**
 * Where semantic title generation is allowed to fire (Phase 2, g01).
 *
 * Behavioral (real-driven), same shape as collect-owner-gate.test.ts: it drives
 * the REAL `collectStreamResponse` with a real SSE stream and real DB lock
 * state, and observes whether generation was reached.
 *
 * "Was it reached" is observed via the module's own telemetry line
 * (`[title-generation] outcome=...`), driven with `runtime: 'codex_runtime'` so
 * the orchestrator returns `unsupported-runtime` immediately — the trigger is
 * exercised end-to-end without any provider call, network, or timing luck.
 *
 * The three ways this can go wrong, each a case below:
 *   - firing on a turn that ERRORED → a chat gets named after a failed answer
 *   - firing on a turn whose assistant row was DROPPED by the owner gate → a
 *     superseded turn names the new owner's chat
 *   - firing on a later turn → a chat gets renamed out from under the user
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { collectStreamResponse } from '../../lib/chat-collect-stream-response';
import {
  createSession,
  acquireSessionLock,
  getMessages,
  getSession,
  updateSessionTitle,
} from '../../lib/db';

function sse(type: string, data: unknown): string {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${JSON.stringify({ type, data: dataStr })}\n\n`;
}

function streamOf(chunks: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

const NO_TELEGRAM = {} as { sessionId?: string; sessionTitle?: string; workingDirectory?: string };

/** Generation context as the route builds it on a first real turn. Codex so the
 *  orchestrator short-circuits without a provider call. */
const TITLE_CTX = {
  userText: 'How do I set up a Postgres read replica?',
  runtime: 'codex_runtime' as const,
  providerId: 'provider-x',
  model: 'model-x',
};

let logs: string[] = [];
let originalLog: typeof console.log;

beforeEach(() => {
  logs = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
});

afterEach(() => {
  console.log = originalLog;
});

/** Let the fire-and-forget dynamic import + orchestrator settle. */
async function drainMicrotasks() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

const generationFired = () => logs.some((l) => l.includes('[title-generation] outcome='));

/**
 * A positive assertion must wait for its own detached dynamic import to finish.
 * Twenty zero-delay turns are enough in an isolated file but not under the full
 * repository load; returning early lets this test's telemetry land in the next
 * test after beforeEach has replaced the log buffer, producing a paired false
 * negative / false positive. Keep the wait bounded so a real missing trigger
 * still fails promptly.
 */
async function waitForGeneration(timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!generationFired() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return generationFired();
}

let lockSeq = 0;

function freshSession() {
  const s = createSession(undefined, undefined, undefined, process.cwd(), 'code');
  updateSessionTitle(s.id, 'Fallback title', 'fallback', { expectOrigin: ['placeholder'] });
  const lockId = `title-gen-lock-${++lockSeq}`;
  assert.equal(acquireSessionLock(s.id, lockId, 'title-gen-test', 600), true, 'lock should be acquired');
  return { sessionId: s.id, lockId };
}

describe('title generation trigger — g01', () => {
  it('fires after a clean first turn, once the assistant message has persisted', async () => {
    const { sessionId, lockId } = freshSession();
    await collectStreamResponse(
      streamOf([sse('text', 'You can use streaming replication.'), sse('result', { subtype: 'success' })]),
      sessionId,
      lockId,
      NO_TELEGRAM,
      undefined,
      { suppressNotifications: true, titleGeneration: TITLE_CTX },
    );
    // The assistant row is written inside the try, BEFORE the finally that
    // fires generation — so by the time generation is reachable, it is.
    assert.equal(getMessages(sessionId).messages.filter((m) => m.role === 'assistant').length, 1);

    assert.ok(
      await waitForGeneration(),
      'a clean first turn should reach generation',
    );
    // Codex is unsupported, so the fallback stands — the honest degradation.
    assert.ok(logs.some((l) => l.includes('outcome=unsupported-runtime')));
    assert.equal(getSession(sessionId)!.title, 'Fallback title');
  });

  it('does NOT fire when the turn ended in an error event', async () => {
    const { sessionId, lockId } = freshSession();
    await collectStreamResponse(
      streamOf([sse('text', 'partial'), sse('error', 'upstream 500')]),
      sessionId,
      lockId,
      NO_TELEGRAM,
      undefined,
      { suppressNotifications: true, titleGeneration: TITLE_CTX },
    );
    await drainMicrotasks();
    assert.equal(generationFired(), false, 'a failed answer must not name the chat');
    assert.equal(getSession(sessionId)!.title, 'Fallback title');
  });

  it('does NOT fire when the stream aborts mid-turn', async () => {
    const { sessionId, lockId } = freshSession();
    const aborting = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(sse('text', 'partial answer'));
        controller.error(new Error('aborted by user'));
      },
    });
    await collectStreamResponse(
      aborting, sessionId, lockId, NO_TELEGRAM, undefined,
      { suppressNotifications: true, titleGeneration: TITLE_CTX },
    );
    await drainMicrotasks();
    assert.equal(generationFired(), false, 'a Stopped turn must not name the chat');
    assert.equal(getSession(sessionId)!.title, 'Fallback title');
  });

  it('does NOT fire for a Codex interrupted result followed by usage accounting', async () => {
    const { sessionId, lockId } = freshSession();
    await collectStreamResponse(
      streamOf([
        sse('text', 'partial answer before Stop'),
        sse('result', { finish_reason: 'interrupted' }),
        sse('result', { usage: { input_tokens: 3, output_tokens: 1 } }),
      ]),
      sessionId,
      lockId,
      NO_TELEGRAM,
      undefined,
      { suppressNotifications: true, titleGeneration: TITLE_CTX },
    );
    await drainMicrotasks();
    assert.equal(generationFired(), false, 'Codex usage accounting must not rename a Stopped turn');
    assert.equal(getSession(sessionId)!.title, 'Fallback title');
  });

  it('does NOT fire when the assistant row was dropped by the owner gate', async () => {
    const { sessionId } = freshSession();
    // A superseded turn: it carries a stale lockId, so its writes are dropped.
    const staleLockId = 'stale-lock-id';
    await collectStreamResponse(
      streamOf([sse('text', 'late answer'), sse('result', { subtype: 'success' })]),
      sessionId,
      staleLockId,
      NO_TELEGRAM,
      undefined,
      { suppressNotifications: true, titleGeneration: TITLE_CTX },
    );
    await drainMicrotasks();
    assert.equal(getMessages(sessionId).messages.filter((m) => m.role === 'assistant').length, 0);
    assert.equal(generationFired(), false, 'a dropped turn must not name the chat');
  });

  it('does NOT fire when the route passed no generation context (a later turn)', async () => {
    const { sessionId, lockId } = freshSession();
    await collectStreamResponse(
      streamOf([sse('text', 'second answer'), sse('result', { subtype: 'success' })]),
      sessionId,
      lockId,
      NO_TELEGRAM,
      undefined,
      { suppressNotifications: true },
    );
    await drainMicrotasks();
    assert.equal(generationFired(), false, 'only the first real turn names the chat');
  });
});

describe('trigger is off the hot path — g01 structural pins', () => {
  const collectSrc = fs.readFileSync(
    path.join(__dirname, '../../lib/chat-collect-stream-response.ts'),
    'utf-8',
  );
  const routeSrc = fs.readFileSync(
    path.join(__dirname, '../../app/api/chat/route.ts'),
    'utf-8',
  );

  it('the generation call is never awaited', () => {
    const call = collectSrc.slice(collectSrc.indexOf("import('@/lib/title-generation')"));
    assert.ok(call.length > 0, 'generation call site should exist');
    // The statement that starts it must not be an await/return-await.
    const stmtStart = collectSrc.lastIndexOf('\n', collectSrc.indexOf("import('@/lib/title-generation')"));
    const stmt = collectSrc.slice(stmtStart, collectSrc.indexOf("import('@/lib/title-generation')"));
    assert.ok(!/\bawait\b/.test(stmt), 'title generation must not be awaited on any path');
    // And it must swallow its own rejection so it can never surface.
    assert.match(call.slice(0, 600), /\.catch\(/);
  });

  it('generation is gated on a clean, persisted turn', () => {
    assert.match(
      collectSrc,
      /opts\?\.titleGeneration\s*&& !hasError\s*&& !sawNonSuccessfulTerminalResult\s*&& lastSavedAssistantMsgId !== null/,
    );
  });

  it('the route only arms generation when the fallback CAS actually landed', () => {
    // `landed` is true exactly once per session — on the placeholder→fallback
    // transition — which is what makes this the FIRST real turn and no other.
    assert.match(routeSrc, /const landed = updateSessionTitle\(/);
    assert.match(routeSrc, /if \(landed\) \{\s*titleGenerationInput = displayOverride \|\| content;/);
    // And it is declared inside the request scope, defaulting to "do not fire".
    assert.match(routeSrc, /let titleGenerationInput: string \| null = null;/);
  });

  it('the route hands over the session\'s own runtime and provider, not globals', () => {
    const handover = routeSrc.slice(routeSrc.indexOf('titleGeneration: titleGenerationInput'));
    const block = handover.slice(0, 500);
    assert.match(block, /runtime: effectiveSessionRuntime/);
    assert.match(block, /providerId: persistProviderId \|\| effectiveProviderId/);
    assert.ok(!/getSetting\(|default_provider|resolveAuxiliary/.test(block));
  });
});
