/**
 * Regression test: codepilot_cli_tools_install / codepilot_cli_tools_update
 * must actually terminate their underlying shell command when the AI SDK
 * fires the tool's abortSignal, instead of leaving the real process running
 * in the background after the agent loop has already moved on.
 *
 * Background: native-timeout.ts documents that "ai@7 merely passes the
 * abort signal INTO execute() and still awaits its promise" — the SDK's own
 * timeout/cancellation machinery unblocks the *consumer* loop
 * (timeoutCtl.guardStream), but does nothing to the real OS process unless
 * execute() itself forwards the signal into the command it runs. Before this
 * fix, execAsync() in cli-tools.ts's install/update handlers was never given
 * a `signal` option, so a fired budget (or an aborted run) never actually
 * killed the shell command — only stopped the loop from waiting on it.
 *
 * Run with: node scripts/run-node-tests.mjs unit
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// Cross-platform long-running command: invokes the same `node` binary the
// test itself runs under, so it needs no OS-specific flags (no `ping -n`
// vs `ping -c`, no `sleep` vs `timeout`).
const LONG_RUNNING_COMMAND = `node -e "setTimeout(() => {}, 10000)"`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('cli-tools abortSignal wiring', () => {
  it('exec() actually kills the child process once the passed signal aborts', async () => {
    const controller = new AbortController();
    const promise = execAsync(LONG_RUNNING_COMMAND, { timeout: 300_000, signal: controller.signal });
    promise.catch(() => {}); // observed below; avoid an unhandled-rejection warning from the race

    setTimeout(() => controller.abort(), 300);

    const outcome = await Promise.race([
      promise.then(() => 'completed' as const).catch(() => 'aborted' as const),
      delay(4000).then(() => 'still-running' as const),
    ]);

    assert.equal(
      outcome,
      'aborted',
      'exec() with a signal option must reject (process killed) once that signal aborts, not keep running',
    );
  });

  it('control: exec() WITHOUT a signal option does not stop on its own AbortController firing (proves the bug this test guards against)', async () => {
    // This mirrors the pre-fix call shape: an AbortController exists and
    // fires, but nothing was ever wired to `exec()`, so the child process
    // has no way to learn about it and keeps running.
    const controller = new AbortController();
    const promise = execAsync(LONG_RUNNING_COMMAND, { timeout: 300_000 }); // no `signal` here, intentionally
    promise.catch(() => {});

    setTimeout(() => controller.abort(), 300);

    const outcome = await Promise.race([
      promise.then(() => 'completed' as const).catch(() => 'aborted' as const),
      delay(1500).then(() => 'still-running' as const),
    ]);

    assert.equal(
      outcome,
      'still-running',
      'this control case demonstrates the exact orphaned-process bug: without `signal`, an aborted controller has no effect on the running command',
    );
  });
});
