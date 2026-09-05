/**
 * codepilot_cli_tools_install — POSIX output bound (maxBuffer parity).
 *
 * Node's own `child_process.exec()` enforces a `maxBuffer` (default 1
 * MiB) — confirmed empirically before writing this fix: exactly 1048576
 * bytes resolves, 1048577 rejects with `ERR_CHILD_PROCESS_STDIO_
 * MAXBUFFER`. `execWithAbortPosix` (added earlier in this PR, for the
 * process-group-kill fix) spawns the command itself via
 * `child_process.spawn()` and accumulates stdout/stderr manually, which
 * did NOT inherit that protection — confirmed directly: an unpatched
 * version accepted 5 MiB of real stdout and resolved normally. A model-
 * controlled arbitrary command's output size is not something CodePilot
 * controls, so this is real unbounded-memory exposure, POSIX-only (the
 * Windows path still uses real `exec()` under the hood, which keeps
 * Node's own default automatically).
 *
 * Fixed by counting real bytes off the raw Buffer chunks (never a JS
 * string's `.length`, which is UTF-16 code units, not bytes) and, on
 * overflow, killing the whole process GROUP — the same mechanism the
 * abort/timeout fixes elsewhere in this PR already use — not merely
 * rejecting the promise while a still-producing-output real process
 * would otherwise be exactly the same kind of orphan those fixes exist
 * to prevent.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

import { runCliToolInstall } from '@/lib/builtin-tools/cli-tools';

const isPosix = process.platform !== 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let wd: string;
before(() => { wd = fs.mkdtempSync(path.join(os.tmpdir(), 'posix-output-bound-')); });
after(() => { try { fs.rmSync(wd, { recursive: true, force: true }); } catch { /* ignore */ } });

describe(
  'POSIX output bound (execWithAbortPosix maxBuffer parity)',
  { skip: isPosix ? false : 'execWithAbortPosix only runs on POSIX (process.platform !== \'win32\') — the Windows path uses real exec(), which already has Node\'s own default maxBuffer.' },
  () => {
    it('real process/group emits output beyond limit: bounded memory/output, process group killed, deterministic error, no orphan heartbeat process', async () => {
      const marker = path.join(wd, 'heartbeat.txt');
      // Outer -> inner worker (the same shape proven necessary for the
      // process-group-kill fix elsewhere in this PR — a single trailing
      // command would exec-replace and not exercise the group kill at
      // all): the inner worker BOTH writes a real heartbeat file (to
      // prove real process death, not merely promise rejection) AND
      // floods stdout well past the 1 MiB bound.
      const innerPath = path.join(wd, 'inner.mjs');
      const outerPath = path.join(wd, 'outer.mjs');
      fs.writeFileSync(innerPath, `
import { appendFileSync } from 'node:fs';
for (let i = 0; i < 200; i++) {
  appendFileSync(${JSON.stringify(marker)}, i + '\\n');
  process.stdout.write('x'.repeat(50000)); // 200 * 50000 = 10,000,000 bytes >> 1 MiB
  await new Promise((r) => setTimeout(r, 20));
}
`);
      fs.writeFileSync(outerPath, `
import { spawn } from 'node:child_process';
const child = spawn('node', [${JSON.stringify(innerPath)}], { stdio: ['ignore', 'inherit', 'ignore'] });
await new Promise((resolve) => child.on('exit', resolve));
`);

      // A real, never-aborted signal — matching production exactly
      // (agent-loop always passes timeoutCtl.signal, a real AbortSignal,
      // even with no budgets configured) — forces execWithAbortPosix's
      // own spawn()-based path rather than the `!signal` fast-path back
      // to plain execAsync (which would just hit Node's OWN pre-existing
      // maxBuffer instead of this fix's own new bound).
      const neverAbortedSignal = new AbortController().signal;

      const started = Date.now();
      const outcome = await runCliToolInstall(
        { command: `node ${outerPath}`, name: undefined },
        { signal: neverAbortedSignal },
      );
      const elapsedMs = Date.now() - started;

      // Deterministic error, bounded — never a silent multi-megabyte
      // "success", never hangs waiting for the full 4-second flood to
      // finish on its own.
      assert.match(outcome, /Installation failed:.*maxBuffer length exceeded/i);
      assert.ok(elapsedMs < 3500, `must reject quickly once the bound is crossed, not wait for the full ~4s flood to finish naturally (took ${elapsedMs}ms)`);
      assert.ok(outcome.length < 10000, `the reported outcome itself must stay small — never echoes the flooded output (length ${outcome.length})`);

      // Real descendant kill proof: the inner worker's heartbeat must
      // stop growing, not merely the promise having rejected.
      await sleep(600);
      const count = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length : 0;
      const c1 = count();
      await sleep(600);
      const c2 = count();
      assert.equal(c1, c2, `real descendant must be dead, not orphaned (c1=${c1}, c2=${c2})`);
    });

    it('ordinary, bounded output still works normally (no regression from the new byte-counting)', async () => {
      const neverAbortedSignal = new AbortController().signal;
      const outcome = await runCliToolInstall(
        { command: 'echo small-output-fits-fine', name: undefined },
        { signal: neverAbortedSignal },
      );
      assert.match(outcome, /small-output-fits-fine/);
    });
  },
);

describe('POSIX output bound (Windows note)', { skip: isPosix ? true : false }, () => {
  it('documents why these tests are skipped on this platform', () => {
    assert.ok(true, 'execWithAbortPosix only runs on POSIX; Windows keeps real exec()\'s own default maxBuffer automatically.');
  });
});
