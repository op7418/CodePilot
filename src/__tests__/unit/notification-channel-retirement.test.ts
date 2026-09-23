import '../db-isolation.setup';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDb,
  insertNotificationEvent,
  listNotificationDeliveries,
  migrateQueuedRendererNotificationsToNative,
  upsertNotificationDelivery,
} from '../../lib/db';

let counter = 0;

function eventId(label: string): string {
  counter += 1;
  return `evt-retire-${label}-${Date.now()}-${counter}`;
}

function insertEvent(id: string): void {
  insertNotificationEvent({
    event_id: id,
    title: 'Legacy notification',
    body: 'Body',
    priority: 'low',
  });
}

describe('renderer notification channel retirement', () => {
  it('moves queued renderer work to native without deleting audit rows', () => {
    const migratable = eventId('migrate');
    const duplicate = eventId('duplicate');
    insertEvent(migratable);
    insertEvent(duplicate);
    upsertNotificationDelivery({ event_id: migratable, channel: 'renderer-toast', status: 'queued' });
    upsertNotificationDelivery({ event_id: duplicate, channel: 'renderer-toast', status: 'queued' });
    upsertNotificationDelivery({ event_id: duplicate, channel: 'electron-native', status: 'queued' });

    const result = migrateQueuedRendererNotificationsToNative(
      getDb(),
      new Date('2026-08-28T09:00:00.000Z'),
    );
    assert.equal(result.migrated, 1);
    assert.equal(result.skippedDuplicates, 1);

    assert.deepEqual(
      listNotificationDeliveries(migratable).map((row) => [row.channel, row.status]),
      [['electron-native', 'queued']],
    );
    const duplicateRows = listNotificationDeliveries(duplicate);
    assert.equal(duplicateRows.length, 2, 'migration preserves both historical delivery rows');
    assert.equal(
      duplicateRows.find((row) => row.channel === 'renderer-toast')?.status,
      'skipped',
    );
    assert.equal(
      duplicateRows.find((row) => row.channel === 'electron-native')?.status,
      'queued',
    );

    assert.deepEqual(
      migrateQueuedRendererNotificationsToNative(getDb()),
      { migrated: 0, skippedDuplicates: 0 },
      'migration is idempotent',
    );
  });
});
