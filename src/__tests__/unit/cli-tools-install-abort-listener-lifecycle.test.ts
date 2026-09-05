/**
 * codepilot_cli_tools_install — abort-listener lifecycle / stale-PID hazard.
 *
 * `execWithAbort`'s `signal` is `timeoutCtl.signal` in production — a
 * single, long-lived AbortSignal shared across EVERY tool call in the
 * whole run, not one scoped to a single call. `signal.addEventListener
 * ('abort', onAbort, { once: true })` alone does not remove `onAbort` when
 * a call finishes normally (`{ once: true }` only removes a listener once
 * it has FIRED — a call that settles without ever aborting leaves its
 * listener attached indefinitely). Left unpatched, a LATER abort
 * elsewhere in the same run — a different tool call's timeout, the
 * caller's own Stop — still invokes every earlier call's now-stale
 * `onAbort`, which would `taskkill`/group-kill whatever process now
 * happens to hold that earlier call's long-exited, since-recycled PID.
 *
 * Proven directly, both directions, using Node's own `getEventListeners`
 * (`node:events`) to observe the real listener count on the real signal —
 * not inferred from timing or side effects.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

import { runCliToolInstall } from '@/lib/builtin-tools/cli-tools';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quickCommand = process.platform === 'win32' ? 'cmd /c "echo quick"' : 'echo quick';
const failCommand = process.platform === 'win32' ? 'cmd /c "exit 3"' : 'exit 3';

let wd: string;
before(() => { wd = fs.mkdtempSync(path.join(os.tmpdir(), 'abort-listener-')); });
after(() => { try { fs.rmSync(wd, { recursive: true, force: true }); } catch { /* ignore */ } });

function heartbeatCommand(markerPath: string, iterations = 60): string {
  if (process.platform === 'win32') {
    const escaped = markerPath.replace(/'/g, "''");
    return `powershell -NoProfile -Command "for ($i=0; $i -lt ${iterations}; $i++) { Add-Content -Path '${escaped}' -Value $i; Start-Sleep -Milliseconds 150 }"`;
  }
  const innerPath = markerPath.replace(/\.txt$/, '-inner.mjs');
  const outerPath = markerPath.replace(/\.txt$/, '-outer.mjs');
  fs.writeFileSync(innerPath,
    `import { appendFileSync } from 'node:fs';\n` +
    `for (let i = 0; i < ${iterations}; i++) { appendFileSync(${JSON.stringify(markerPath)}, i + '\\n'); await new Promise((r) => setTimeout(r, 150)); }\n`);
  fs.writeFileSync(outerPath,
    `import { spawn } from 'node:child_process';\n` +
    `const child = spawn('node', [${JSON.stringify(innerPath)}], { stdio: 'ignore' });\n` +
    `await new Promise((resolve) => child.on('exit', resolve));\n`);
  return `node ${JSON.stringify(outerPath)}`;
}
function heartbeatCount(markerPath: string): number {
  if (!fs.existsSync(markerPath)) return 0;
  const c = fs.readFileSync(markerPath, 'utf8').trim();
  return c.length === 0 ? 0 : c.split('\n').filter(Boolean).length;
}
let markerSeq = 0;
function nextMarker(): string {
  markerSeq += 1;
  return path.join(wd, `marker-${markerSeq}.txt`);
}

describe('abort-listener lifecycle', () => {
  it('a normal successful call removes its abort listener — zero left attached to the shared signal', async () => {
    const ac = new AbortController();
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'nothing attached before any call');
    await runCliToolInstall({ command: quickCommand, name: 'x' }, { signal: ac.signal });
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'listener must be gone after a normal settle — this is the actual fix');
  });

  it('a normal FAILING call (non-zero exit, no abort) also removes its abort listener', async () => {
    const ac = new AbortController();
    await runCliToolInstall({ command: failCommand, name: 'x' }, { signal: ac.signal });
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'an ordinary failure is still a terminal settle — listener must be removed the same as success');
  });

  it('firing the signal after a call already settled normally is a pure no-op — no crash, no residual action', async () => {
    const ac = new AbortController();
    await runCliToolInstall({ command: quickCommand, name: 'x' }, { signal: ac.signal });
    assert.doesNotThrow(() => ac.abort());
  });

  it('THE ACTUAL HAZARD, reproduced directly: call A settles normally on a shared signal, call B (a real long-running process) starts on the SAME signal, then the signal fires — B is killed correctly, A\'s already-gone process is never touched, no crash', async () => {
    const marker = nextMarker();
    const ac = new AbortController(); // one shared signal across both calls, exactly like timeoutCtl.signal across a whole run

    // Call A: short, settles normally BEFORE call B even starts.
    await runCliToolInstall({ command: quickCommand, name: 'a' }, { signal: ac.signal });
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'A\'s listener is already gone before B starts');

    // Call B: real long-running process, on the SAME AbortController.
    const bPromise = runCliToolInstall({ command: heartbeatCommand(marker), name: 'b' }, { signal: ac.signal });
    await sleep(400); // let B's real process actually start
    assert.equal(getEventListeners(ac.signal, 'abort').length, 1, 'exactly one listener now — B\'s, not a leftover from A');

    ac.abort();
    // runCliToolInstall deliberately RE-THROWS a signal-triggered
    // AbortError rather than swallowing it into a normal-looking
    // "Installation failed" string (that's the whole point of the earlier
    // fix this call itself depends on) — so B's promise must reject, not
    // resolve.
    await assert.rejects(bPromise, (err: Error) => err.name === 'AbortError');

    await sleep(600);
    const c1 = heartbeatCount(marker);
    await sleep(600);
    const c2 = heartbeatCount(marker);
    assert.equal(c1, c2, `B's real process must actually be dead (c1=${c1}, c2=${c2}) — proves the abort correctly targeted B's own current pid, not a stale one left over from A`);
  });

  it('a PRE-aborted signal rejects AbortError before any child process is created — cross-platform, no marker', async () => {
    // execWithAbortWindows/execWithAbortPosix used to create the real
    // child (exec()/spawn()) unconditionally, checking signal.aborted
    // only afterward — an already-fired signal still started the real
    // shell command, briefly, before being killed. This is the entry-
    // point + defense-in-depth guard's own regression: reject before
    // anything is ever spawned.
    //
    // Deliberately NOT the slow, looping heartbeatCommand used elsewhere
    // in this file: confirmed directly that its own PowerShell/inner-
    // worker startup latency is enough that even the OLD spawn-then-kill
    // sequence (still fast: kill is issued synchronously right after
    // spawn) never lets it reach its first write either — a false pass
    // that would prove nothing. A single near-instant write has no such
    // startup gap: confirmed directly that the OLD sequence DOES let it
    // through (the marker exists) precisely because killing a real OS
    // process is itself not instantaneous, while writing one line is.
    const marker = nextMarker();
    const quickMarkerCommand = process.platform === 'win32'
      ? `cmd /c "echo x>${marker}"`
      : `echo x > ${marker}`;
    const ac = new AbortController();
    ac.abort(); // aborted BEFORE runCliToolInstall is even called

    await assert.rejects(
      runCliToolInstall({ command: quickMarkerCommand, name: 'pre-aborted' }, { signal: ac.signal }),
      (err: Error) => err.name === 'AbortError',
    );
    await sleep(400); // generous margin — the old sequence's marker would already exist well before this
    assert.equal(fs.existsSync(marker), false, 'the marker file must never be created — nothing was ever spawned to create it');
  });
});
