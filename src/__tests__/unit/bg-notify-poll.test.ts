/**
 * Unit tests for background notification polling (tray-only mode).
 *
 * Tests the pure parsing/filtering logic in src/lib/bg-notify-parser.ts,
 * which is the canonical implementation also used by electron/main.ts.
 *
 * Electron-specific behavior (Notification, BrowserWindow, click → reopen)
 * requires manual testing in a running Electron instance:
 *   1. Enable bridge → close all windows → verify tray icon appears
 *   2. Trigger a scheduled task → verify system notification pops up
 *   3. Click notification → verify window re-opens and focuses
 *
 * Run with: npx tsx --test src/__tests__/unit/bg-notify-poll.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('parseBgNotifications', () => {
  it('parses valid notification response', async () => {
    const { parseBgNotifications } = await import('../../lib/bg-notify-parser');
    const json = JSON.stringify({
      notifications: [
        { title: 'Task done', body: 'Result here', priority: 'normal' },
        { title: 'Reminder', body: '', priority: 'low' },
      ],
    });
    const result = parseBgNotifications(json);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, 'Task done');
    assert.equal(result[0].body, 'Result here');
    assert.equal(result[1].title, 'Reminder');
  });

  it('filters out notifications without title', async () => {
    const { parseBgNotifications } = await import('../../lib/bg-notify-parser');
    const json = JSON.stringify({
      notifications: [
        { title: '', body: 'no title', priority: 'low' },
        { title: 'Has title', body: 'ok', priority: 'normal' },
      ],
    });
    const result = parseBgNotifications(json);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Has title');
  });

  it('returns empty array for invalid JSON', async () => {
    const { parseBgNotifications } = await import('../../lib/bg-notify-parser');
    assert.deepEqual(parseBgNotifications('not json'), []);
  });

  it('returns empty array for empty notifications', async () => {
    const { parseBgNotifications } = await import('../../lib/bg-notify-parser');
    const json = JSON.stringify({ notifications: [] });
    assert.deepEqual(parseBgNotifications(json), []);
  });

  it('returns empty array when notifications key is missing', async () => {
    const { parseBgNotifications } = await import('../../lib/bg-notify-parser');
    const json = JSON.stringify({ other: 'data' });
    assert.deepEqual(parseBgNotifications(json), []);
  });

  it('preserves priority field', async () => {
    const { parseBgNotifications } = await import('../../lib/bg-notify-parser');
    const json = JSON.stringify({
      notifications: [
        { title: 'Urgent!', body: 'Fire', priority: 'urgent' },
        { title: 'FYI', body: '', priority: 'low' },
      ],
    });
    const result = parseBgNotifications(json);
    assert.equal(result[0].priority, 'urgent');
    assert.equal(result[1].priority, 'low');
  });

  it('handles mixed valid and empty-title notifications', async () => {
    const { parseBgNotifications } = await import('../../lib/bg-notify-parser');
    const json = JSON.stringify({
      notifications: [
        { title: 'A', body: '', priority: 'low' },
        { title: '', body: 'orphan', priority: 'normal' },
        { title: 'B', body: 'content', priority: 'urgent' },
        { title: '', body: '', priority: 'low' },
      ],
    });
    const result = parseBgNotifications(json);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, 'A');
    assert.equal(result[1].title, 'B');
  });
});
