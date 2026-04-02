/**
 * Unit tests for task-scheduler — cron parsing and interval parsing.
 *
 * Run with: npx tsx --test src/__tests__/unit/task-scheduler.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('getNextCronTime', () => {
  it('returns a future Date for a simple daily cron', async () => {
    const { getNextCronTime } = await import('../../lib/task-scheduler');
    const result = getNextCronTime('0 9 * * *'); // every day at 9:00
    assert.ok(result instanceof Date);
    assert.ok(result!.getTime() > Date.now());
    assert.equal(result!.getMinutes(), 0);
    assert.equal(result!.getHours(), 9);
  });

  it('returns a future Date for a weekly cron', async () => {
    const { getNextCronTime } = await import('../../lib/task-scheduler');
    const result = getNextCronTime('0 10 * * 1'); // every Monday at 10:00
    assert.ok(result instanceof Date);
    assert.ok(result!.getTime() > Date.now());
    assert.equal(result!.getDay(), 1); // Monday
  });

  it('returns a future Date for a monthly cron', async () => {
    const { getNextCronTime } = await import('../../lib/task-scheduler');
    const result = getNextCronTime('30 8 15 * *'); // 15th of each month at 8:30
    assert.ok(result instanceof Date);
    assert.ok(result!.getTime() > Date.now());
    assert.equal(result!.getDate(), 15);
    assert.equal(result!.getHours(), 8);
    assert.equal(result!.getMinutes(), 30);
  });

  it('handles Feb 29 in a leap year (sparse schedule)', async () => {
    const { getNextCronTime } = await import('../../lib/task-scheduler');
    const result = getNextCronTime('0 9 29 2 *'); // Feb 29 at 9:00
    // Should find a leap year within 4 years or return null
    if (result) {
      assert.equal(result.getMonth(), 1); // February (0-indexed)
      assert.equal(result.getDate(), 29);
    }
    // Either a valid leap-year match or null — both are acceptable
    // The key is it must NOT be a premature fallback like now + 1h
    if (result) {
      const daysDiff = (result.getTime() - Date.now()) / 86400000;
      assert.ok(daysDiff > 1, 'Feb 29 should not be tomorrow (unless it actually is)');
    }
  });

  it('returns null for an invalid cron expression', async () => {
    const { getNextCronTime } = await import('../../lib/task-scheduler');
    const result = getNextCronTime('invalid cron');
    assert.equal(result, null);
  });

  it('returns null for a 4-field expression', async () => {
    const { getNextCronTime } = await import('../../lib/task-scheduler');
    const result = getNextCronTime('0 9 * *');
    assert.equal(result, null);
  });

  it('returns null for an impossible date like Feb 30', async () => {
    const { getNextCronTime } = await import('../../lib/task-scheduler');
    const result = getNextCronTime('0 9 30 2 *'); // Feb 30 — impossible
    assert.equal(result, null);
  });

  it('returns null for Feb 31', async () => {
    const { getNextCronTime } = await import('../../lib/task-scheduler');
    const result = getNextCronTime('0 9 31 2 *'); // Feb 31 — impossible
    assert.equal(result, null);
  });

  it('handles wildcard hour/minute on sparse date', async () => {
    const { getNextCronTime } = await import('../../lib/task-scheduler');
    // Every minute on Feb 29 — sparse but valid in leap years
    const result = getNextCronTime('* * 29 2 *');
    if (result) {
      assert.equal(result.getMonth(), 1); // February
      assert.equal(result.getDate(), 29);
    }
    // null also acceptable if no leap year within 4 years
  });

  it('handles step expressions like */5', async () => {
    const { getNextCronTime } = await import('../../lib/task-scheduler');
    const result = getNextCronTime('*/5 * * * *'); // every 5 minutes
    assert.ok(result instanceof Date);
    assert.ok(result!.getTime() > Date.now());
    assert.equal(result!.getMinutes() % 5, 0);
  });

  it('handles comma-separated values', async () => {
    const { getNextCronTime } = await import('../../lib/task-scheduler');
    const result = getNextCronTime('0 9,18 * * *'); // 9:00 and 18:00
    assert.ok(result instanceof Date);
    assert.ok([9, 18].includes(result!.getHours()));
  });

  it('handles range expressions', async () => {
    const { getNextCronTime } = await import('../../lib/task-scheduler');
    const result = getNextCronTime('0 9 * * 1-5'); // weekdays at 9:00
    assert.ok(result instanceof Date);
    assert.ok(result!.getDay() >= 1 && result!.getDay() <= 5);
  });
});

describe('parseInterval', () => {
  it('parses seconds', async () => {
    const { parseInterval } = await import('../../lib/task-scheduler');
    assert.equal(parseInterval('30s'), 30000);
  });

  it('parses minutes', async () => {
    const { parseInterval } = await import('../../lib/task-scheduler');
    assert.equal(parseInterval('5m'), 300000);
  });

  it('parses hours', async () => {
    const { parseInterval } = await import('../../lib/task-scheduler');
    assert.equal(parseInterval('2h'), 7200000);
  });

  it('parses days', async () => {
    const { parseInterval } = await import('../../lib/task-scheduler');
    assert.equal(parseInterval('1d'), 86400000);
  });

  it('returns default 10m for invalid input', async () => {
    const { parseInterval } = await import('../../lib/task-scheduler');
    assert.equal(parseInterval('invalid'), 600000);
  });
});
