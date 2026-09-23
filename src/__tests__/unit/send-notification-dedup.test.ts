/**
 * v7 P2 fix — `sendNotification` return shape must report ONE entry
 * per channel reflecting the FINAL state. Pre-fix it pushed every
 * status flip, so the urgent + Bridge-success path returned both
 * `bridge-telegram: queued` and `bridge-telegram: delivered`. The DB
 * row was correct (UPSERT), but `/api/tasks/notify` (and thus tests
 * / external clients reading the response) saw a duplicate channel
 * with stale state.
 *
 * Two layers of evidence:
 *   1. Runtime test of the non-urgent path (no Bridge candidates →
 *      no Telegram long-poll leak) confirms the candidate-set shape
 *      and dedup invariant on a typical normal-priority notification.
 *   2. Source-grep contract pins the *implementation* to a Map keyed
 *      by channel (rather than `Array.push` of every status change),
 *      so a future refactor can't quietly bring back the duplicate-row
 *      regression even on paths the runtime test can't exercise
 *      (urgent + configured Bridge would start the Telegram bot
 *      long-poll inside this Node process and never let go — kept
 *      out of the runtime sweep on purpose).
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readFileSync } from 'node:fs';

let tempDir: string;
let originalDataDir: string | undefined;

before(() => {
  originalDataDir = process.env.CLAUDE_GUI_DATA_DIR;
});

after(() => {
  if (originalDataDir === undefined) {
    delete process.env.CLAUDE_GUI_DATA_DIR;
  } else {
    process.env.CLAUDE_GUI_DATA_DIR = originalDataDir;
  }
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-dedup-test-'));
  process.env.CLAUDE_GUI_DATA_DIR = tempDir;
});

afterEach(async () => {
  try {
    const { closeDb } = await import('../../lib/db');
    closeDb();
  } catch { /* ignore */ }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__codepilot_notification_queue__;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

function uniqueByChannel<T extends { channel: string }>(arr: T[]): boolean {
  const seen = new Set<string>();
  for (const item of arr) {
    if (seen.has(item.channel)) return false;
    seen.add(item.channel);
  }
  return true;
}

describe('sendNotification dedup return shape (v7 P2 fix)', () => {
  it('non-urgent return has one entry per candidate channel, no duplicates', async () => {
    const { sendNotification } = await import('../../lib/notification-manager');
    for (const priority of ['low', 'normal'] as const) {
      const result = await sendNotification({
        title: priority,
        body: 'hello',
        priority,
      });
      assert.ok(uniqueByChannel(result.deliveries), 'no duplicate channel entries in return');
      assert.deepEqual(
        result.deliveries.map((d) => d.channel),
        ['electron-native'],
        `${priority} priority has one native candidate owned by Electron Main`,
      );
      assert.ok(!result.deliveries.some((d) => d.channel.startsWith('bridge-')));
    }
  });

  it('notification-manager source uses a Map keyed by channel (not Array.push of every status flip)', () => {
    // Source-grep proof of the dedup contract on the urgent + Bridge
    // fire path. We don't run it because Telegram long-polling, once
    // started, keeps the Node event loop alive and hangs `npm run
    // test`. Pin the implementation shape instead so a future
    // refactor that goes back to "deliveries.push(...)" trips this
    // test loudly.
    const src = readFileSync(
      path.resolve(__dirname, '../../lib/notification-manager.ts'),
      'utf-8',
    );

    // Must declare a Map keyed by channel for delivery state. The
    // value type doesn't matter to this test, only that the
    // structure is keyed by channel string (so `set('bridge-telegram',
    // …)` overwrites instead of appending).
    assert.match(
      src,
      /new\s+Map\s*<\s*string\s*,/,
      'notification-manager must keep a Map<string, …> of channel → delivery state to dedup the return shape',
    );
    assert.match(
      src,
      /deliveryStates\.set\(/,
      'every status update must go through `deliveryStates.set(channel, …)` so a queued → delivered/error transition overwrites instead of appending',
    );

    // Negative: the old "deliveries.push({channel, status})" pattern
    // must NOT come back. The intent of v7 P2 was to stop appending.
    assert.doesNotMatch(
      src,
      /deliveries\.push\s*\(\s*\{\s*channel\s*:/,
      'deliveries.push({channel:…}) is the pre-v7 P2 pattern that produced duplicate channel entries — must not be reintroduced',
    );

    // Final return shape must rebuild the array from the Map's
    // entries (not from a separate array that might have appended
    // duplicates along the way).
    assert.match(
      src,
      /Array\.from\(\s*deliveryStates(\.entries\(\))?\s*\)/,
      'final response array must be reconstructed from `Array.from(deliveryStates…)` so callers only see the LAST state per channel',
    );

    // v8 fix — the error field must be preserved through the response.
    // v7 fix #2 dropped it (only took { status }) which broke external
    // consumers' ability to show WHY a Bridge channel failed.
    // Two layers of evidence:
    //   1. Return type signature must declare optional `error?: string`
    //      on each delivery entry — without this the public contract is
    //      a quiet lie.
    //   2. The map projection at the end must destructure `error` from
    //      the Map entry tuple (not just `status`).
    assert.match(
      src,
      /deliveries:\s*Array<\s*\{\s*channel:\s*string;\s*status:\s*string;\s*error\?:\s*string\s*\}\s*>/,
      'sendNotification return type must declare `deliveries: Array<{ channel: string; status: string; error?: string }>` — the optional error field is the only path for external API consumers to see WHY a delivery failed (DB row has it; v7 dropped it from the response)',
    );
    assert.match(
      src,
      /\(\s*\[\s*channel\s*,\s*\{\s*status\s*,\s*error\s*\}\s*\]\s*\)\s*=>/,
      'the final map projection must destructure `error` (alongside `status`) from each Map entry; otherwise the response always serialises as `{ channel, status }` and the error is lost in flight even though the DB row has it',
    );
  });

  // NOTE on a "Bridge unconfigured → not_configured" case: skipped
  // entirely because `db.ts` freezes CLAUDE_GUI_DATA_DIR at module
  // load — settings written in one `it` block would survive into the
  // next one's "fresh" tempDir, making a no-Bridge sub-case unreliable
  // without spawning a child process. The non-urgent test above
  // already proves uniqueByChannel for the no-Bridge candidate set.
});
