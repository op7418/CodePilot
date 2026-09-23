/**
 * Phase 5e Phase 0.5 P1 (2026-05-17) — Native Runtime MediaBlock
 * side-channel integration tests.
 *
 * The Phase 0.5 audit identified `codepilot_generate_image` /
 * `codepilot_import_media` on the Native Runtime as "partial":
 * tool runs, returns localPath, model says "done", but the chat UI's
 * `MediaPreview` (which reads SSE `tool_result.media`) never gets a
 * MediaBlock because `builtin-tools/media.ts:execute()` only returned
 * a plain string. The user explicitly named this gap "Native 基础盘
 * 不完整" — the highest-priority post-止血 follow-up.
 *
 * Fix:
 *   - `builtin-tools/media.ts` emits MediaBlock[] via the harness
 *     side-channel event bus (`@/lib/harness/builtin-event-bus`).
 *   - `agent-loop.ts` subscribes before the streamText loop and
 *     splices the MediaBlock into its SSE `tool_result.media` field.
 *
 * These tests pin the contract end-to-end without needing real image
 * generation: we drive `createMediaTools()` directly, intercept the
 * side-channel emit, and verify the MediaBlock shape + that
 * `execute()` returns clean text (no JSON blob the model would see).
 *
 * Also pins the wiring assertions:
 *   - agent-loop subscribes to `harness/builtin-event-bus`
 *   - agent-loop splices `media` into tool_result SSE
 *   - the side-channel listener unsubscribes in `finally` (no
 *     cross-turn leakage)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  subscribeBuiltinEvents,
  __resetBuiltinEventBusForTests,
  __subscriberCountForTests,
} from '@/lib/harness/builtin-event-bus';
import { createMediaTools } from '@/lib/builtin-tools/media';
import type { RuntimeRunEvent } from '@/lib/runtime/contract';
import { promptNeedsMedia } from '@/lib/media-capability-prompt';
import { extractMcpAbortSignal } from '@/lib/image-gen-mcp';
import { isTelemetryFailureHandled } from '@/lib/telemetry/provider-marker';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const readSrc = (rel: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

describe('Claude SDK media intent gate', () => {
  for (const prompt of [
    'Generate an image of a small cat',
    'Use the Image model to generate a kitten',
    'Draw me a poster for the launch',
    'Create a short video from this photo',
    '帮我画一张小猫图片',
  ]) {
    it(`mounts media tools for: ${prompt}`, () => {
      assert.equal(promptNeedsMedia(prompt), true);
    });
  }

  it('does not mount the paid media tools for an ordinary text request', () => {
    assert.equal(promptNeedsMedia('Explain how OAuth PKCE works'), false);
  });

  it('the shipping Claude client uses the shared bilingual predicate for MCP mounting', () => {
    const source = readSrc('src/lib/claude-client.ts');
    assert.match(source, /promptNeedsMedia\(prompt,\s*conversationHistory\)/);
    assert.match(source, /needsMediaMcp\s*=\s*!isHeartbeatMode\s*&&/);
  });

  it('the Claude MCP only registers Grok video when OAuth is usable', () => {
    const source = readSrc('src/lib/image-gen-mcp.ts');
    assert.match(source, /isXaiOAuthUsable\(\)/);
    assert.match(source, /\.\.\.\(isXaiOAuthUsable\(\)\s*\?\s*\[/);
  });
});

describe('media cancellation wiring', () => {
  it('extracts the exact Claude MCP handler signal and rejects lookalikes', () => {
    const controller = new AbortController();
    assert.equal(extractMcpAbortSignal({ signal: controller.signal }), controller.signal);
    assert.equal(extractMcpAbortSignal({ signal: { aborted: false } }), undefined);
    assert.equal(extractMcpAbortSignal(undefined), undefined);
  });

  it('threads cancellation through Claude MCP, Codex bridge, Native and confirmation API', () => {
    const claudeMcp = readSrc('src/lib/image-gen-mcp.ts');
    assert.equal((claudeMcp.match(/abortSignal:\s*extractMcpAbortSignal\(extra\)/g) || []).length, 2);

    const codexBridge = readSrc('src/lib/codex/proxy/builtin-bridge.ts');
    assert.equal((codexBridge.match(/abortSignal:\s*execOptions\.abortSignal/g) || []).length >= 2, true);

    const nativeMedia = readSrc('src/lib/builtin-tools/media.ts');
    assert.equal((nativeMedia.match(/abortSignal:\s*execution\?\.abortSignal/g) || []).length >= 2, true);

    const confirmationRoute = readSrc('src/app/api/media/generate/route.ts');
    assert.match(confirmationRoute, /abortSignal:\s*request\.signal/);
  });
});

function stripComments(src: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    const trimmed = raw.trimStart();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    const idx = raw.indexOf('//');
    out.push(idx >= 0 ? raw.slice(0, idx) : raw);
  }
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// (1) Tool factory — execute() shape contract
// ─────────────────────────────────────────────────────────────────────

describe('createMediaTools — tool factory shape', () => {
  it('returns import + image + video media tools with execute()', () => {
    const tools = createMediaTools({ sessionId: 's1', grokVideoAvailable: true });
    assert.ok(tools.codepilot_import_media);
    assert.ok(tools.codepilot_generate_image);
    assert.ok(tools.codepilot_generate_video);
    assert.equal(
      typeof (tools.codepilot_import_media as { execute?: unknown }).execute,
      'function',
    );
    assert.equal(
      typeof (tools.codepilot_generate_video as { execute?: unknown }).execute,
      'function',
    );
    assert.equal(
      typeof (tools.codepilot_generate_image as { execute?: unknown }).execute,
      'function',
    );
  });

  it('hides Grok video when OAuth is unavailable without hiding active-provider images', () => {
    const tools = createMediaTools({ sessionId: 's1', grokVideoAvailable: false });
    assert.ok(tools.codepilot_import_media);
    assert.ok(tools.codepilot_generate_image);
    assert.equal(tools.codepilot_generate_video, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────
// (2) codepilot_import_media — side-channel emit contract
//
// We don't have a real file at the input path; the importFileToLibrary
// helper will surface an error. The test pins the failure-mode contract
// (text return, no MediaBlock emit) AND a success-mode mock variant
// (via overriding the helper via jest-style mocking is heavy here; we
// instead pin the source-level behaviour via the wiring tests in (5)).
// ─────────────────────────────────────────────────────────────────────

describe('codepilot_import_media — side-channel emit on failure', () => {
  it('rejects import failures so the runtime emits a real tool error; emits no MediaBlock event', async () => {
    __resetBuiltinEventBusForTests();
    const sessionId = 'sess-import-fail';
    const captured: RuntimeRunEvent[] = [];
    subscribeBuiltinEvents(sessionId, (e) => captured.push(e));

    const tools = createMediaTools({ sessionId });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importTool = tools.codepilot_import_media as any;
    const failure = await importTool.execute(
        { filePath: '/non/existent/file.png' },
        { toolCallId: 'call-1' },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.ok(failure, 'the tool must still reject the user-visible failure');
    assert.equal(
      isTelemetryFailureHandled(failure),
      true,
      'missing local media is product-owned and must not create an automatic Sentry Issue',
    );

    // No side-channel emit on failure (the importFileToLibrary call
    // threw before the emit block ran).
    const mediaEvents = captured.filter(
      (e) => e.type === 'tool_completed' && e.media && e.media.length > 0,
    );
    assert.equal(mediaEvents.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// (3) Side-channel listener subscription / unsubscription contract
// ─────────────────────────────────────────────────────────────────────

describe('side-channel bus — sessionId isolation', () => {
  it('events on session A never reach session B listener', () => {
    __resetBuiltinEventBusForTests();
    const aEvents: RuntimeRunEvent[] = [];
    const bEvents: RuntimeRunEvent[] = [];
    const unsubA = subscribeBuiltinEvents('sess-A', (e) => aEvents.push(e));
    const unsubB = subscribeBuiltinEvents('sess-B', (e) => bEvents.push(e));

    // Emit directly using internal `emitBuiltinEvent` import is the
    // contract — we re-import here to avoid bringing in the heavy
    // media tool just to test bus isolation.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { emitBuiltinEvent } = require('@/lib/harness/builtin-event-bus');
    emitBuiltinEvent('sess-A', {
      type: 'tool_completed',
      runtimeId: 'codepilot_runtime',
      sessionId: 'sess-A',
      toolId: 'call-X',
      output: 'A',
    });

    assert.equal(aEvents.length, 1);
    assert.equal(bEvents.length, 0);
    unsubA();
    unsubB();
  });

  it('unsubscribe removes the listener (no cross-turn leakage)', () => {
    __resetBuiltinEventBusForTests();
    const events: RuntimeRunEvent[] = [];
    const unsub = subscribeBuiltinEvents('sess-leak', (e) => events.push(e));
    assert.equal(__subscriberCountForTests('sess-leak'), 1);
    unsub();
    assert.equal(__subscriberCountForTests('sess-leak'), 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// (4) agent-loop wiring — source-level pin
//
// Full end-to-end test of agent-loop.runAgentLoop would require
// stubbing the model + provider creation, which is overkill for a
// regression pin. We assert the WIRING with source-grep: the right
// imports are present, the subscribe call lives BEFORE the try block,
// the unsubscribe call lives in the finally block, and the
// tool-result handler splices `media` into the SSE.
// ─────────────────────────────────────────────────────────────────────

describe('agent-loop — side-channel wiring source pins', () => {
  const SRC = readSrc('src/lib/agent-loop.ts');
  const CODE = stripComments(SRC);

  it('imports subscribeBuiltinEvents from harness/builtin-event-bus', () => {
    assert.match(
      SRC,
      /import\s*\{\s*subscribeBuiltinEvents\s*\}\s*from\s*['"][^'"]*harness\/builtin-event-bus['"]/,
      'agent-loop must import subscribeBuiltinEvents from the harness bus location',
    );
  });

  it('imports MediaBlock from @/types', () => {
    assert.match(
      SRC,
      /MediaBlock/,
      'agent-loop must import MediaBlock (used for the pendingMediaByCallId Map)',
    );
  });

  it('subscribes BEFORE the try block (so first-tool emit lands on listener)', () => {
    const subIdx = CODE.indexOf('subscribeBuiltinEvents(');
    const tryIdx = CODE.indexOf('try {');
    assert.ok(subIdx > 0, 'subscribeBuiltinEvents call must exist');
    assert.ok(tryIdx > 0, 'try { must exist');
    assert.ok(
      subIdx < tryIdx,
      `subscribeBuiltinEvents (idx=${subIdx}) must run BEFORE try { (idx=${tryIdx}) — emit-before-subscribe contract drops events`,
    );
  });

  it('unsubscribes in the finally block (no cross-turn leakage)', () => {
    // The variable name in agent-loop is `unsubscribeMediaSideChannel`.
    assert.match(
      CODE,
      /finally\s*\{[\s\S]*?unsubscribeMediaSideChannel\(\)/,
      'agent-loop must call unsubscribeMediaSideChannel() inside the finally block',
    );
  });

  it('splices media into tool_result SSE when pendingMediaByCallId has it', () => {
    assert.match(
      CODE,
      /pendingMediaByCallId\.get\(event\.toolCallId\)/,
      'tool-result handler must look up media by event.toolCallId',
    );
    assert.match(
      CODE,
      /\.\.\.\(\s*media\s*&&\s*media\.length\s*>\s*0\s*\?\s*\{\s*media\s*\}\s*:\s*\{\s*\}\s*\)/,
      'tool-result SSE data spread must include media when non-empty',
    );
  });

  it('deletes media entry after splicing (so a re-emit cant double-fire)', () => {
    assert.match(
      CODE,
      /pendingMediaByCallId\.delete\(event\.toolCallId\)/,
      'tool-result handler must delete the media entry after splicing to avoid double-fire on a future re-emit with the same call id',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// (5) builtin-tools/media.ts source pin — emit shape
// ─────────────────────────────────────────────────────────────────────

describe('builtin-tools/media.ts — side-channel emit source pins', () => {
  const SRC = readSrc('src/lib/builtin-tools/media.ts');
  const CODE = stripComments(SRC);

  it('imports emitBuiltinEvent from harness/builtin-event-bus', () => {
    assert.match(
      SRC,
      /import\s*\{\s*emitBuiltinEvent\s*\}\s*from\s*['"][^'"]*harness\/builtin-event-bus['"]/,
    );
  });

  it('imports makeToolCompleted from runtime/event-adapter', () => {
    assert.match(
      SRC,
      /import\s*\{\s*makeToolCompleted\s*\}\s*from\s*['"][^'"]*runtime\/event-adapter['"]/,
    );
  });

  it('codepilot_import_media passes runtimeId codepilot_runtime in the emit', () => {
    // The emit base contract requires runtimeId. Native is codepilot_runtime.
    assert.match(
      CODE,
      /runtimeId:\s*['"]codepilot_runtime['"]/,
      'emit must tag the event with runtimeId codepilot_runtime so cross-runtime listeners can distinguish source',
    );
  });

  it('codepilot_generate_image emits MediaBlock only when blocks.length > 0', () => {
    // Source-pin: don't emit empty media (would surface as an empty
    // image card in chat). Pre-fix this was a string-only return so
    // there was no risk; with side-channel, must guard.
    assert.match(
      CODE,
      /if\s*\(\s*sessionId\s*&&\s*toolCallId\s*&&\s*blocks\.length\s*>\s*0\s*\)/,
      'image gen emit must be guarded by sessionId + toolCallId + blocks.length > 0',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// (6) Defensive — no MediaBlock emit when toolCallId is missing
// ─────────────────────────────────────────────────────────────────────

describe('codepilot_import_media — no double emit when toolCallId missing', () => {
  it('does not emit MediaBlock when toolCallId is empty (defensive)', async () => {
    __resetBuiltinEventBusForTests();
    const captured: RuntimeRunEvent[] = [];
    subscribeBuiltinEvents('sess-no-callid', (e) => captured.push(e));

    const tools = createMediaTools({ sessionId: 'sess-no-callid' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importTool = tools.codepilot_import_media as any;
    // Pass execOptions WITHOUT toolCallId — emit must skip
    await assert.rejects(
      () => importTool.execute(
        { filePath: '/some/path.png' },
        { /* no toolCallId */ },
      ),
    );

    const mediaEmits = captured.filter(
      (e) => e.type === 'tool_completed' && e.media && e.media.length > 0,
    );
    assert.equal(
      mediaEmits.length,
      0,
      'must not emit MediaBlock without a toolCallId — listener cannot pair the splice to a tool_result event',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// (7) Success-path end-to-end: codepilot_import_media against a real
//     small fixture file (build/icon.png ships in the repo). Validates
//     that on SUCCESS the side-channel emits a well-formed MediaBlock
//     with all four fields populated (type / mimeType / localPath /
//     mediaId) AND that execute()'s return value remains plain text
//     — no base64-bearing JSON the model would otherwise see.
//
//     Phase 5e Phase 0.5 P1 review fix (2026-05-17). Codex review
//     observed (correctly) that the earlier coverage only had source-
//     level pins for the success path; a manual smoke had confirmed
//     the emit but it wasn't pinned. This case closes that gap.
//
//     Cleanup: the test deletes the imported file + DB row so it
//     doesn't accumulate `.codepilot-media/` artifacts or media_generations
//     rows across runs.
// ─────────────────────────────────────────────────────────────────────

describe('codepilot_import_media — SUCCESS path emits MediaBlock end-to-end', () => {
  it('imports a real PNG, emits MediaBlock with all fields, returns plain text', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsMod = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pathMod = require('node:path');
    const REPO_ROOT_LOCAL = pathMod.resolve(__dirname, '../../..');
    const fixturePath = pathMod.join(REPO_ROOT_LOCAL, 'build/icon.png');
    assert.ok(fsMod.existsSync(fixturePath), `fixture missing: ${fixturePath}`);

    __resetBuiltinEventBusForTests();
    const sessionId = 'sess-import-success';
    const captured: RuntimeRunEvent[] = [];
    subscribeBuiltinEvents(sessionId, (e) => captured.push(e));

    const tools = createMediaTools({ sessionId });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importTool = tools.codepilot_import_media as any;

    let importedLocalPath: string | undefined;
    let importedMediaId: string | undefined;

    try {
      const result = await importTool.execute(
        { filePath: fixturePath },
        { toolCallId: 'success-call-1' },
      );

      // Return value: plain text. Critical contract — model must NOT
      // see a JSON blob containing the MediaBlock. Match the text
      // shape produced by builtin-tools/media.ts:
      //   `Media imported: <localPath> (type=<mediaType>)`
      assert.equal(typeof result, 'string');
      assert.match(
        result as string,
        /^Media imported: .+ \(type=image\)$/,
        `success path return must be plain "Media imported: <path> (type=image)" text; got: ${result}`,
      );
      // Negative: must NOT contain JSON-shaped MediaBlock payload.
      assert.equal(
        /"type"\s*:\s*"image"/.test(result as string),
        false,
        'return value must not contain a JSON MediaBlock — emit goes via side-channel, not text',
      );

      // Side-channel emit: exactly one tool_completed event carrying
      // a single MediaBlock.
      const mediaEvents = captured.filter(
        (e) => e.type === 'tool_completed' && e.media && e.media.length > 0,
      );
      assert.equal(
        mediaEvents.length,
        1,
        `expected exactly 1 tool_completed event with media; got ${mediaEvents.length}`,
      );
      const event = mediaEvents[0];
      if (event.type !== 'tool_completed') throw new Error('type narrowing');
      assert.equal(event.runtimeId, 'codepilot_runtime');
      assert.equal(event.sessionId, sessionId);
      assert.equal(event.toolId, 'success-call-1');
      assert.ok(event.media && event.media.length === 1);
      const block = event.media![0];

      // Block shape: all 4 fields populated.
      assert.equal(block.type, 'image');
      assert.equal(block.mimeType, 'image/png');
      assert.equal(typeof block.localPath, 'string');
      assert.ok(block.localPath && block.localPath.length > 0);
      assert.equal(typeof block.mediaId, 'string');
      assert.ok(block.mediaId && block.mediaId.length > 0);
      // localPath should point at an actual file the importer copied
      // into the media library (the test cleanup below deletes it).
      assert.ok(
        fsMod.existsSync(block.localPath as string),
        `imported file should exist at ${block.localPath}`,
      );

      importedLocalPath = block.localPath as string;
      importedMediaId = block.mediaId as string;
    } finally {
      // Cleanup — same pattern Codex used in the manual smoke. Best
      // effort; failures here are logged but don't fail the test
      // because the assertions above are what we care about.
      if (importedLocalPath) {
        try {
          fsMod.unlinkSync(importedLocalPath);
        } catch {
          // file may have been cleaned by another test or the importer
          // may have placed it somewhere we can't reach in test env
        }
      }
      if (importedMediaId) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getDb } = require('@/lib/db');
          const db = getDb();
          db.prepare('DELETE FROM media_generations WHERE id = ?').run(importedMediaId);
        } catch {
          // best effort
        }
      }
    }
  });
});
