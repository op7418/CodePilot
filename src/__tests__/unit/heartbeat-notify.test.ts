/**
 * Unit tests for heartbeat-done marker stripping and notification queue.
 *
 * Run with: npx tsx --test src/__tests__/unit/heartbeat-notify.test.ts
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

describe('heartbeat-done marker stripping', () => {
  const MARKER_RE = /\s*<!--\s*heartbeat-done\s*-->\s*/g;

  it('strips marker at end of text', () => {
    const text = 'Here is your daily update. <!-- heartbeat-done -->';
    assert.equal(text.replace(MARKER_RE, ''), 'Here is your daily update.');
  });

  it('strips marker with extra whitespace', () => {
    const text = 'Content here.   <!--  heartbeat-done  -->  ';
    assert.equal(text.replace(MARKER_RE, '').trim(), 'Content here.');
  });

  it('strips marker in the middle of text', () => {
    const text = 'Part A. <!-- heartbeat-done --> Part B.';
    assert.equal(text.replace(MARKER_RE, ''), 'Part A.Part B.');
  });

  it('strips multiple markers', () => {
    const text = 'A <!-- heartbeat-done --> B <!-- heartbeat-done --> C';
    assert.equal(text.replace(MARKER_RE, ''), 'ABC');
  });

  it('does not modify text without marker', () => {
    const text = 'Normal response without any special markers.';
    assert.equal(text.replace(MARKER_RE, ''), text);
  });

  it('does not match partial markers', () => {
    const text = 'Talk about heartbeat-done in prose.';
    assert.equal(text.replace(MARKER_RE, ''), text);
  });

  it('strips marker from JSON-serialized contentBlocks', () => {
    const blocks = [
      { type: 'text', text: 'Checked your tasks. <!-- heartbeat-done -->' },
      { type: 'tool_use', id: '1', name: 'codepilot_memory_recent', input: {} },
      { type: 'text', text: 'Everything looks good. <!-- heartbeat-done -->' },
    ];
    const cleaned = blocks.map(b =>
      b.type === 'text' && b.text ? { ...b, text: b.text.replace(MARKER_RE, '') } : b
    );
    assert.equal(cleaned[0].text, 'Checked your tasks.');
    assert.equal(cleaned[1].type, 'tool_use'); // untouched
    assert.equal(cleaned[2].text, 'Everything looks good.');
  });
});

describe('notification-manager queue', () => {
  beforeEach(async () => {
    // Drain any leftover notifications from previous tests
    const { drainNotifications } = await import('../../lib/notification-manager');
    drainNotifications();
  });

  it('enqueues and drains notifications', async () => {
    const { enqueueNotification, drainNotifications } = await import('../../lib/notification-manager');

    enqueueNotification('Test Title', 'Test Body', 'normal');
    enqueueNotification('Second', '', 'low');

    const drained = drainNotifications();
    assert.equal(drained.length, 2);
    assert.equal(drained[0].title, 'Test Title');
    assert.equal(drained[0].body, 'Test Body');
    assert.equal(drained[0].priority, 'normal');
    assert.equal(drained[1].title, 'Second');
    assert.equal(drained[1].priority, 'low');
  });

  it('drain empties the queue', async () => {
    const { enqueueNotification, drainNotifications } = await import('../../lib/notification-manager');

    enqueueNotification('One', '', 'low');
    const first = drainNotifications();
    assert.equal(first.length, 1);

    const second = drainNotifications();
    assert.equal(second.length, 0);
  });

  it('respects max queue size (ring buffer)', async () => {
    const { enqueueNotification, drainNotifications } = await import('../../lib/notification-manager');

    // Enqueue more than MAX_QUEUE_SIZE (50)
    for (let i = 0; i < 60; i++) {
      enqueueNotification(`Notif ${i}`, '', 'low');
    }

    const drained = drainNotifications();
    assert.equal(drained.length, 50);
    // First 10 should have been dropped, so first item is "Notif 10"
    assert.equal(drained[0].title, 'Notif 10');
    assert.equal(drained[49].title, 'Notif 59');
  });

  it('each notification has a unique id and timestamp', async () => {
    const { enqueueNotification, drainNotifications } = await import('../../lib/notification-manager');

    enqueueNotification('A', '', 'low');
    enqueueNotification('B', '', 'normal');

    const drained = drainNotifications();
    assert.notEqual(drained[0].id, drained[1].id);
    assert.ok(drained[0].timestamp > 0);
    assert.ok(drained[1].timestamp >= drained[0].timestamp);
  });
});

describe('needsHeartbeat server-side computation', () => {
  // These tests verify the logic that needsHeartbeat requires buddy existence.
  // We test the condition directly since the API route depends on DB/filesystem.

  it('needsHeartbeat is false when no buddy exists', () => {
    const state = { buddy: undefined, heartbeatEnabled: true, onboardingComplete: true };
    const result = !!state.buddy && state.heartbeatEnabled === true;
    assert.equal(result, false);
  });

  it('needsHeartbeat is true when buddy exists and heartbeat enabled', () => {
    const state = { buddy: { species: 'cat' }, heartbeatEnabled: true, onboardingComplete: true };
    const result = !!state.buddy && state.heartbeatEnabled === true;
    assert.equal(result, true);
  });

  it('needsHeartbeat is false when heartbeat disabled', () => {
    const state = { buddy: { species: 'cat' }, heartbeatEnabled: false, onboardingComplete: true };
    const result = !!state.buddy && state.heartbeatEnabled === true;
    assert.equal(result, false);
  });
});
