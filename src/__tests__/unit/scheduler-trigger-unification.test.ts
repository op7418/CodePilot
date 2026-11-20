import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(__dirname, '../../lib/task-scheduler.ts'),
  'utf-8',
);

describe('durable scheduler trigger unification', () => {
  it('poll and missed-task recovery use the same lock-aware, capped dispatch as each other', () => {
    const poll = source.match(/const intervalId = setInterval[\s\S]*?\/\/ Check session-only tasks/);
    assert.ok(poll);
    assert.match(poll![0], /dispatchDueTasks\(getDueTasks\(\)\)/);
    assert.doesNotMatch(poll![0], /executeDueTask\(task\)/);

    const missed = source.match(/async function handleMissedTasks[\s\S]*?async function checkExpiredTasks/);
    assert.ok(missed);
    assert.match(missed![0], /dispatchDueTasks\(missedOnce\)/);
    assert.doesNotMatch(missed![0], /executeDueTask\(task\)/);

    const dispatch = source.match(/export async function dispatchDueTasks[\s\S]*?\n}\n/);
    assert.ok(dispatch);
    assert.match(dispatch![0], /startLockedRun\(task\.id\)/, 'dispatch shares the manual run row lock');

    const manual = source.match(/export async function runScheduledTaskNow[\s\S]*?\n}\n/);
    assert.ok(manual);
    assert.match(manual![0], /startLockedRun\(taskId\)/);
  });
});
