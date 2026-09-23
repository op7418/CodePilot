/**
 * Phase 3 Step 3 — Bridge × priority delivery visibility.
 *
 * v3 / v4 plan locks two rules:
 *   • events:deliveries is 1:N. `sendNotification` writes ONE row in
 *     `notification_events` per logical fire. The `notification_deliveries`
 *     table gets one row per candidate channel (renderer-toast,
 *     electron-native, bridge-*).
 *   • Bridge is a candidate channel ONLY for `priority='urgent'`.
 *     - urgent → exactly one `bridge-telegram` row, status one of
 *       {not_configured, skipped, delivered, error}.
 *     - low / normal → NO `bridge-*` row at all (Bridge wasn't a
 *       candidate; the absence expresses "we never tried" without
 *       writing a misleading `skipped_by_priority` placeholder).
 *
 * Asserts (no live Telegram — we toggle settings to drive each state):
 *   1. urgent + Bridge unconfigured → bridge-telegram: not_configured
 *   2. urgent + Bridge configured but disabled → bridge-telegram: skipped
 *   3. normal priority → no bridge-* row (negative test)
 *   4. low priority → no bridge-* row (negative test)
 *   5. event:delivery row count is 1 event row regardless of N channels
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-bridge-test-'));
  process.env.CLAUDE_GUI_DATA_DIR = tempDir;
});

afterEach(async () => {
  try {
    const { closeDb } = await import('../../lib/db');
    closeDb();
  } catch { /* ignore */ }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('bridge × priority — Phase 3 Step 3', () => {
  it('urgent + Bridge unconfigured writes bridge-telegram: not_configured', async () => {
    const { sendNotification } = await import('../../lib/notification-manager');
    const { listNotificationDeliveries, getDb } = await import('../../lib/db');

    // No telegram_* settings written → unconfigured.
    const result = await sendNotification({
      title: 'Urgent test',
      body: 'something is on fire',
      priority: 'urgent',
    });

    const deliveries = listNotificationDeliveries(result.event_id);
    const bridgeRow = deliveries.find((d) => d.channel === 'bridge-telegram');
    assert.ok(bridgeRow, 'urgent must produce one bridge-telegram delivery row');
    assert.equal(
      bridgeRow!.status,
      'not_configured',
      'no telegram_bot_token / chat_id → not_configured (visible "we considered but no creds")',
    );

    // 1 events row regardless of N deliveries.
    const events = (getDb() as unknown as { prepare: (s: string) => { all: (...args: unknown[]) => unknown[] } })
      .prepare('SELECT event_id FROM notification_events WHERE event_id = ?')
      .all(result.event_id) as Array<{ event_id: string }>;
    assert.equal(events.length, 1, '1:N event:delivery — exactly one events row per logical fire (v4 fix #2)');
  });

  it('urgent + Bridge configured-but-disabled writes bridge-telegram: skipped', async () => {
    const { sendNotification } = await import('../../lib/notification-manager');
    const { listNotificationDeliveries, setSetting } = await import('../../lib/db');

    setSetting('telegram_bot_token', 'fake-token');
    setSetting('telegram_chat_id', '12345');
    setSetting('telegram_enabled', 'false');

    const result = await sendNotification({
      title: 'Urgent test',
      body: 'still on fire',
      priority: 'urgent',
    });

    const deliveries = listNotificationDeliveries(result.event_id);
    const bridgeRow = deliveries.find((d) => d.channel === 'bridge-telegram');
    assert.ok(bridgeRow);
    assert.equal(
      bridgeRow!.status,
      'skipped',
      'configured + telegram_enabled=false → skipped (distinct from not_configured)',
    );
  });

  it('non-urgent priorities write NO bridge-* row at all (rejects skipped_by_priority)', async () => {
    const { sendNotification } = await import('../../lib/notification-manager');
    const { listNotificationDeliveries, setSetting } = await import('../../lib/db');

    // Even with Bridge fully configured, normal/low priority must
    // not produce a bridge row — Bridge is urgent-only candidate.
    setSetting('telegram_bot_token', 'fake-token');
    setSetting('telegram_chat_id', '12345');
    setSetting('telegram_enabled', 'true');

    for (const priority of ['low', 'normal'] as const) {
      const result = await sendNotification({
        title: `${priority} test`,
        body: 'low-stakes',
        priority,
      });
      const deliveries = listNotificationDeliveries(result.event_id);
      const bridgeRows = deliveries.filter((d) => d.channel.startsWith('bridge-'));
      assert.equal(
        bridgeRows.length,
        0,
        `priority=${priority} must produce zero bridge-* rows — Bridge isn't a candidate at this priority (v4 fix #3)`,
      );
      assert.deepEqual(
        deliveries.map((d) => d.channel),
        ['electron-native'],
        `priority=${priority} must use the Main-owned system notification channel`,
      );
    }
  });
});
