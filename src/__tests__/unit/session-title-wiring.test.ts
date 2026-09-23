/**
 * Source pins for the title wiring.
 *
 * These are deliberately source-level: the behaviours below are properties of
 * *which* expression each route feeds the title function, and a route-level
 * integration harness (Next request context + streaming provider) can't
 * observe them without booting the whole chat stack. What they lock:
 *
 *  - the three legacy `slice(0, 50)` truncations are gone and cannot come back
 *  - the chat route titles on user-VISIBLE text, not on model-facing content
 *  - autoTrigger turns can't name a chat
 *  - the top bar actually subscribes to title changes (the t04 regression)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';

const read = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

const chatRoute = read('app/api/chat/route.ts');
const importRoute = read('app/api/claude-sessions/import/route.ts');
const chatPage = read('app/chat/page.tsx');
const sessionRoute = read('app/api/chat/sessions/[id]/route.ts');
const sessionsRoute = read('app/api/chat/sessions/route.ts');
const chatIdPage = read('app/chat/[id]/page.tsx');
const splitColumn = read('components/layout/SplitColumn.tsx');
const streamManager = read('lib/stream-session-manager.ts');

describe('the three legacy truncation sites are collapsed into the pure function', () => {
  it('no title-producing site hand-rolls slice(0, 50) any more', () => {
    for (const [name, src] of [
      ['app/api/chat/route.ts', chatRoute],
      ['app/api/claude-sessions/import/route.ts', importRoute],
      ['app/chat/page.tsx', chatPage],
    ] as const) {
      assert.doesNotMatch(src, /\.slice\(0,\s*50\)/, `${name} must not truncate titles by hand`);
    }
  });

  it('no site hand-rolls the old "..." ellipsis for titles', () => {
    for (const src of [chatRoute, importRoute, chatPage]) {
      assert.doesNotMatch(src, /length > 50 \? '\.\.\.' : ''/);
    }
  });

  it('each of the three routes calls deriveConversationTitle', () => {
    assert.match(chatRoute, /deriveConversationTitle\(/);
    assert.match(importRoute, /deriveConversationTitle\(/);
    // page.tsx no longer titles at all — it creates a placeholder and lets the
    // server decide, which is the point.
    assert.doesNotMatch(chatPage, /title: content/);
  });
});

describe('chat route — fallback trigger conditions', () => {
  it('titles on displayOverride || content, never on raw content alone', () => {
    assert.match(
      chatRoute,
      /deriveConversationTitle\(displayOverride \|\| content\)/,
      'raw `content` carries the hidden [Referenced Directories] expansion — titling on it leaks attachment paths',
    );
  });

  it('the fallback write lives inside the !autoTrigger branch', () => {
    // An autoTrigger turn is an invisible system trigger (onboarding /
    // heartbeat). If it could name the chat, the user would see a title they
    // never typed. The write must sit after `if (!autoTrigger) {` and before
    // that block closes at the committed-route comment.
    const guardIdx = chatRoute.indexOf('if (!autoTrigger) {\n      if (files && files.length > 0)');
    assert.ok(guardIdx > 0, 'expected the !autoTrigger persistence branch');
    const modelIdx = chatRoute.indexOf('// Runtime + provider + model was committed atomically before execution.');
    assert.ok(modelIdx > guardIdx, 'expected the committed-route block after it');
    const branch = chatRoute.slice(guardIdx, modelIdx);
    assert.match(branch, /deriveConversationTitle/, 'the fallback title must be derived inside !autoTrigger');
    assert.match(branch, /expectOrigin: \['placeholder'\]/);
  });

  it('the fallback write is a CAS on placeholder, not a blind title === "New Chat" check', () => {
    assert.doesNotMatch(
      chatRoute,
      /if \(session\.title === 'New Chat'\) \{\s*const title/,
      'the old gate let a manual rename back to "New Chat" be clobbered',
    );
    assert.match(chatRoute, /updateSessionTitle\(\s*session_id,\s*fallbackTitle,\s*'fallback',/);
  });
});

describe('import route — origin', () => {
  it('records import origin so semantic generation never renames a foreign transcript', () => {
    assert.match(importRoute, /'import',\s*\n\s*\{[\s\S]*runtimeId:\s*'claude_code'/);
    assert.match(importRoute, /source:\s*'legacy_runtime_ref'/);
  });
});

describe('PATCH rename validation', () => {
  it('no longer accepts any truthy title verbatim', () => {
    assert.doesNotMatch(
      sessionRoute,
      /if \(body\.title\) \{\s*updateSessionTitle\(id, body\.title\);/,
      'the old truthy check stored "   " as a blank sidebar row',
    );
  });

  it('validates through sanitizeManualTitle and 400s on rejection', () => {
    assert.match(sessionRoute, /sanitizeManualTitle\(body\.title\)/);
    assert.match(sessionRoute, /status: 400/);
  });

  it('records manual origin', () => {
    assert.match(sessionRoute, /updateSessionTitle\(id, result\.title, 'manual'\)/);
  });
});

describe('session create — placeholder by default', () => {
  it('the composer no longer names the session at create time', () => {
    assert.doesNotMatch(chatPage, /title: content\.slice/);
  });

  it('an explicitly-named session via POST is validated and marked manual', () => {
    assert.match(sessionsRoute, /sanitizeManualTitle\(body\.title\)/);
    assert.match(sessionsRoute, /titleOrigin = 'manual'/);
  });
});

describe('UI title sync (t04)', () => {
  it('the top bar subscribes to title changes instead of reading once on mount', () => {
    assert.match(
      chatIdPage,
      /subscribeSessionTitle\(id, \(title\) => setPanelSessionTitle\(title\)\)/,
      '/chat/[id] read the title once on mount — the fallback never reached the top bar',
    );
  });

  it('split view subscribes too', () => {
    assert.match(splitColumn, /subscribeSessionTitle\(sessionId/);
  });

  it('the stream manager refreshes the title at accept, and skips autoTrigger', () => {
    assert.match(streamManager, /if \(!params\.autoTrigger\) \{\s*void refreshSessionTitle\(params\.sessionId\);/);
  });

  it('the first-message path refreshes the title at accept', () => {
    assert.match(chatPage, /void refreshSessionTitle\(session\.id\)/);
  });

  // The behaviour these two guard (all views land on the SERVER's canonical
  // title) is covered for real in session-title-canonical-sync.test.ts against
  // `renameSession`. These only pin that both call sites still route through
  // it rather than re-growing their own PATCH + echo-what-I-sent.
  it('neither rename call site PATCHes the title behind renameSession\'s back', () => {
    for (const [name, src] of [
      ['UnifiedTopBar', read('components/layout/UnifiedTopBar.tsx')],
      ['ChatListPanel', read('components/layout/ChatListPanel.tsx')],
    ] as const) {
      assert.match(src, /renameSession\(/, `${name} must rename through the shared helper`);
      assert.doesNotMatch(
        src,
        /body: JSON\.stringify\(\{\s*title:/,
        `${name} must not hand-roll a title PATCH — that is how it drifted from the server's canonical title`,
      );
    }
  });
});

describe('system sessions name themselves', () => {
  it('bridge / task / heartbeat / worktree all pass system origin', () => {
    for (const [name, rel] of [
      ['bridge', 'lib/bridge/channel-router.ts'],
      ['task + heartbeat', 'lib/agent-task-runner.ts'],
      ['worktree derive', 'app/api/git/worktrees/derive/route.ts'],
    ] as const) {
      assert.match(read(rel), /'system',/, `${name} must record system origin`);
    }
  });

  it('the heartbeat session records system origin despite source=user', () => {
    const runner = read('lib/agent-task-runner.ts');
    const idx = runner.indexOf("'Assistant heartbeat'");
    assert.ok(idx > 0);
    const call = runner.slice(idx, idx + 700);
    assert.match(call, /'system',/);
  });
});
