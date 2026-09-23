import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runCliMaintenanceCommand } from '../../../electron/cli-maintenance-runner';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('CLI maintenance process runner', () => {
  it('caps output and never needs a shell to preserve argv boundaries', async () => {
    const result = await runCliMaintenanceCommand({
      spec: { command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(4096))"] },
      timeoutMs: 5_000,
      platform: process.platform,
      expandedPath: process.env.PATH ?? '',
      outputCapBytes: 128,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.length, 128);
    assert.equal(result.stderr, '');
  });

  it('cancels the owned child process tree and reports the terminal state', async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'codepilot-cli-runner-'));
    const fixture = path.join(fixtureRoot, 'parent.cjs');
    writeFileSync(fixture, [
      "const { spawn } = require('node:child_process');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "process.stdout.write(JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }) + '\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n'));

    let publishCancel!: (cancel: () => Promise<void>) => void;
    const spawned = new Promise<() => Promise<void>>((resolve) => { publishCancel = resolve; });
    try {
      const running = runCliMaintenanceCommand({
        spec: { command: process.execPath, args: [fixture] },
        timeoutMs: 10_000,
        platform: process.platform,
        expandedPath: process.env.PATH ?? '',
        outputCapBytes: 4_096,
        onSpawn: publishCancel,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const cancel = await spawned;
      await cancel();
      const result = await running;
      const pids = JSON.parse(result.stdout.trim()) as { parent: number; grandchild: number };
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(result.cancelled, true);
      assert.equal(result.timedOut, false);
      assert.equal(result.cleanupIncomplete, false);
      assert.equal(processAlive(pids.parent), false);
      assert.equal(processAlive(pids.grandchild), false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
