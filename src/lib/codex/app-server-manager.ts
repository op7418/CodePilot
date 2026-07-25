/**
 * Codex app-server process manager.
 *
 * Phase 5 Phase 1 (2026-05-13). Handles:
 *   - binary discovery (`codex` on PATH; future custom-path setting)
 *   - spawn lifecycle (`codex app-server`, default stdio transport)
 *   - JSON-RPC client wiring over the child's stdio
 *   - graceful close (avoid orphan processes per plan §硬约束)
 *
 * Singleton-per-process. Renderer / dev-server / Electron main all
 * import the same module and share the cached app-server instance —
 * concurrent `getAppServer()` calls deduplicate via an in-flight
 * promise so we don't double-spawn.
 *
 * IMPORTANT: this module is node-only (child_process / fs). Don't
 * import from client components; the `/api/codex/*` routes are the
 * client's access path.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, win32 as win32Path } from 'node:path';
import { CodexAppServerClient, type CodexTransport } from './app-server-client';
import type { CodexAvailability } from './types';
import { shouldDropCodexTraceLine, resolveCodexRustLog } from './codex-trace-filter';

interface SpawnedTransport extends CodexTransport {
  readonly proc: ChildProcessWithoutNullStreams;
}

/**
 * Detect a FATAL config-parse error in Codex stderr.
 *
 * P0.2 (2026-06-01): some codex builds print a fatal config error to
 * stderr and then linger ~30s before the process actually exits — observed
 * with old `/opt/homebrew/bin/codex` 0.45.0 rejecting `model_reasoning_effort
 * = "xhigh"` from the user's `~/.codex/config.toml`:
 *   `Failed to deserialize overridden config: unknown variant `xhigh``
 * Waiting for the `exit` event would hang the model-list fetch (and the
 * chat composer + Settings that depend on it) for that whole window, so we
 * fail the moment this signature appears on stderr.
 */
export function isFatalCodexConfigStderr(chunk: string): boolean {
  // Two explicit, already config-scoped fatal signatures — a config load /
  // deserialize failure is terminal regardless of the specific cause.
  if (/Failed to deserialize overridden config|error loading config/i.test(chunk)) return true;
  // `unknown variant` ALONE is too broad — a future non-fatal Codex warning /
  // log line could contain it and we'd SIGKILL a healthy process. Only treat it
  // as fatal when it co-occurs with config-load / deserialization context in
  // the SAME chunk (Codex review 2026-06-01 P2). The real fatal lines read
  // `... config: unknown variant \`xhigh\` ...`, so the context is always present.
  return /unknown variant/i.test(chunk) && /config|deserializ/i.test(chunk);
}

/**
 * Wrap a spawned child process in the CodexTransport interface.
 * Buffers partial stdout lines until newline.
 */
function makeStdioTransport(proc: ChildProcessWithoutNullStreams): SpawnedTransport {
  let buffer = '';
  let messageHandler: ((line: string) => void) | null = null;
  const closeHandlers = new Set<(reason?: Error) => void>();
  let closed = false;
  let closeReason: Error | undefined;

  // P0 (2026-06-01): surface process death to the JSON-RPC client so it
  // rejects pending requests immediately instead of waiting out the 30s
  // RPC timeout. Fires on both a non-zero exit (e.g. an old codex binary
  // fatally rejecting ~/.codex/config.toml) and a spawn/runtime 'error'.
  // `fireClose` is idempotent so exit + error can't double-notify.
  function fireClose(reason?: Error) {
    if (closed) return;
    closed = true;
    closeReason = reason;
    for (const handler of closeHandlers) {
      try { handler(reason); } catch { /* a bad subscriber must not block others */ }
    }
  }
  proc.once('exit', (code, signal) => {
    fireClose(new Error(`Codex app-server exited (code=${code} signal=${signal})`));
  });
  proc.on('error', (err) => {
    fireClose(err instanceof Error ? err : new Error(String(err)));
  });

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      const trimmed = line.trim();
      if (trimmed && messageHandler) {
        messageHandler(trimmed);
      }
      newlineIdx = buffer.indexOf('\n');
    }
  });

  // Stderr is for diagnostics; tee to console at debug level so
  // tracing logs from `RUST_LOG` flow through to the operator.
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      // B-025: drop the high-frequency INFO span flood (codex_core::tasks /
      // session::handlers enter/exit) from the tee by default — it otherwise
      // streams into the persistent main log via the server's stdout. Warn /
      // error / fatal lines are never dropped (see shouldDropCodexTraceLine),
      // and the fatal-config fail-fast below runs on the full chunk regardless.
      if (line.trim() && !shouldDropCodexTraceLine(line)) {
        console.debug('[codex.app-server]', line);
      }
    }
    // P0.2 — fatal config error on stderr: fail NOW + kill the child so a
    // lingering old binary can't hold the RPC open for its ~30s timeout.
    // fireClose() rejects every pending request via the onClose subscriber.
    if (isFatalCodexConfigStderr(chunk)) {
      const fatalLine = chunk.split(/\r?\n/).find((l) => isFatalCodexConfigStderr(l)) ?? chunk.trim().slice(0, 200);
      console.warn('[codex.app-server] fatal config error on stderr — failing fast + killing child:', fatalLine);
      fireClose(new Error(`Codex app-server fatal config error: ${fatalLine.trim()}`));
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });

  return {
    proc,
    async send(message: string): Promise<void> {
      if (!proc.stdin.writable) {
        throw new Error('Codex app-server stdin closed');
      }
      const ok = proc.stdin.write(message + '\n', 'utf8');
      if (!ok) {
        await new Promise<void>((resolve) => proc.stdin.once('drain', resolve));
      }
    },
    onMessage(handler) {
      messageHandler = handler;
      return () => {
        if (messageHandler === handler) messageHandler = null;
      };
    },
    onClose(handler) {
      // Already dead → notify synchronously so a client that attaches
      // after a fast exit still fast-fails (closes the exit-before-attach
      // race). Otherwise queue for the eventual exit/error.
      if (closed) {
        handler(closeReason);
        return () => { /* nothing to unsubscribe */ };
      }
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    async close() {
      messageHandler = null;
      // Already exited (self-exit / crash) — nothing to wait for. Without
      // this guard we'd block on a `proc.once('exit')` that has already
      // fired and only resolve after the 2s SIGTERM fallback, adding 2s to
      // every failure path. (`proc.killed` is only set when WE kill it, so
      // it stays false for a process that exited on its own.)
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      if (!proc.killed) {
        // Gentle shutdown first — close stdin so app-server exits its
        // request loop. Force-kill after 2s if it hasn't exited.
        try { proc.stdin.end(); } catch { /* ignore */ }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            try { proc.kill('SIGTERM'); } catch { /* ignore */ }
            resolve();
          }, 2000);
          proc.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}

/** Parse a `codex --version` line (`codex-cli 0.135.0-alpha.1` or bare
 *  `0.45.0`) into `[major, minor, patch]`. Returns null if unparseable. */
export function parseCodexVersion(versionOutput: string | null | undefined): [number, number, number] | null {
  if (!versionOutput) return null;
  const m = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

interface ParsedCodexRelease {
  readonly core: [number, number, number];
  /** `null` is a stable release and therefore newer than any prerelease. */
  readonly prerelease: readonly string[] | null;
}

function parseCodexRelease(versionOutput: string | null | undefined): ParsedCodexRelease | null {
  if (!versionOutput) return null;
  const match = versionOutput.match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : null,
  };
}

function compareCodexVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function compareCodexRelease(a: ParsedCodexRelease, b: ParsedCodexRelease): number {
  const core = compareCodexVersion(a.core, b.core);
  if (core !== 0) return core;
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
    const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return left.localeCompare(right);
  }
  return 0;
}

/** First Codex build whose generated schema has been verified for auto review. */
export const CODEX_AUTO_REVIEW_MIN_VERSION = '0.145.0-alpha.18';

/** Conservative version gate: unknown and older builds never advertise support. */
export function codexVersionSupportsAutoReview(versionOutput: string | null | undefined): boolean {
  const installed = parseCodexRelease(versionOutput);
  const minimum = parseCodexRelease(CODEX_AUTO_REVIEW_MIN_VERSION);
  return installed !== null && minimum !== null && compareCodexRelease(installed, minimum) >= 0;
}

export type CodexAutoReviewCapability =
  | { readonly supported: true; readonly installedVersion: string; readonly minVersion: string }
  | {
      readonly supported: false;
      readonly installedVersion: string | null;
      readonly minVersion: string;
      readonly reason: 'not_installed' | 'version_unknown' | 'version_too_old';
    };

export interface CodexBinaryCandidate {
  path: string;
  /** Raw `codex --version` output, or null if the probe failed. */
  version: string | null;
}

/**
 * Pick the best codex binary among candidates by VERSION (highest wins).
 *
 * P0.1 (2026-06-01): the macOS packaged-app P0 was an old Homebrew
 * `/opt/homebrew/bin/codex` 0.45.0 on PATH shadowing the newer
 * `/Applications/Codex.app/.../codex` 0.135.0 — the old build rejected the
 * user's `xhigh` effort config fatally. PATH-first discovery picked the
 * stale binary every time. So when more than one codex is installed we pick
 * the highest version instead of blindly trusting PATH order.
 *
 * Tiebreak rules: a parseable version always beats an unparseable one; among
 * equal versions (or all-unparseable) the FIRST candidate wins — and since
 * callers pass PATH candidates before the Codex.app fallback, an equal-version
 * custom build on PATH still wins (preserves the original round-6 intent).
 */
export function selectBestCodexCandidate(candidates: readonly CodexBinaryCandidate[]): string | null {
  let best: { path: string; v: [number, number, number] | null } | null = null;
  for (const c of candidates) {
    const v = parseCodexVersion(c.version);
    if (best === null) { best = { path: c.path, v }; continue; }
    if (v && !best.v) { best = { path: c.path, v }; continue; }
    if (v && best.v && compareCodexVersion(v, best.v) > 0) { best = { path: c.path, v }; }
    // equal version / lower / both-unparseable → keep current (input-order tiebreak)
  }
  return best?.path ?? null;
}

/**
 * Windows `.cmd` / `.bat` shims (e.g. the npm-global `codex.cmd` under
 * `%AppData%\npm`) are NOT directly executable: Node hands the path straight
 * to CreateProcess, which rejects a batch file with `EINVAL`. That is the
 * packaged-Windows "Codex app-server spawn failed: spawn EINVAL" report — the
 * resolved binary was a `.cmd`. Such shims must run through the command
 * interpreter.
 *
 * We wrap them as `cmd.exe /d /s /c "<quoted-command-line>"` — the same shape
 * cross-spawn / Node's own `{ shell: true }` produce — and set
 * windowsVerbatimArguments so Node forwards our already-quoted command line
 * unchanged. The whole command line gets an OUTER pair of quotes because
 * `cmd /s /c` strips exactly the first and last quote, which lets a shim path
 * containing spaces (`Program Files`, `AppData\Roaming`) survive.
 *
 * Real `.exe` binaries and ALL macOS / Linux paths are returned for a direct
 * spawn, unchanged — preserving the `app-server` stdio contract (never
 * `--listen`) that older Codex.app builds depend on.
 *
 * `platform` / `comspec` are injectable so both branches are unit-testable
 * without actually running on Windows.
 */
export interface CodexLaunchSpec {
  readonly command: string;
  readonly args: string[];
  readonly windowsVerbatimArguments?: boolean;
}

function quoteWinArg(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export function buildCodexLaunch(
  binaryPath: string,
  codexArgs: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string = process.env.ComSpec || 'cmd.exe',
): CodexLaunchSpec {
  const lower = binaryPath.toLowerCase();
  const isWindowsShim = platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'));
  if (!isWindowsShim) {
    return { command: binaryPath, args: [...codexArgs] };
  }
  const commandLine = [binaryPath, ...codexArgs].map(quoteWinArg).join(' ');
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

/** Best-effort `codex --version` probe. Returns null on any failure
 *  (not executable / hung / non-zero) so the candidate ranks lowest.
 *  Routes through buildCodexLaunch so a Windows `.cmd` shim is probed via
 *  cmd.exe too — otherwise version detection fails and ranking goes unstable. */
function probeCodexVersion(binaryPath: string): string | null {
  try {
    const launch = buildCodexLaunch(binaryPath, ['--version']);
    // spawnSync (not execFileSync) so we can pass windowsVerbatimArguments for
    // the cmd.exe shim wrapper; it also won't throw on a non-zero exit.
    const res = spawnSync(launch.command, launch.args, {
      timeout: 2500,
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    if (res.error || res.status !== 0) return null;
    return (res.stdout ?? '').trim() || null;
  } catch {
    return null;
  }
}

export interface CodexCandidateDiscoveryOptions {
  readonly platform?: NodeJS.Platform;
  readonly pathValue?: string;
  readonly homeDir?: string;
  readonly exists?: (candidatePath: string) => boolean;
}

/**
 * Known macOS desktop-client bundle locations, in tiebreak priority order.
 *
 * OpenAI's desktop bundle now ships as `ChatGPT.app` while older installs used
 * `Codex.app`. Check both the system-wide and per-user Applications folders so
 * a bundled CLI remains discoverable even when no shell shim exists on PATH.
 */
export function getMacOSCodexBundleCandidates(homeDir: string = homedir()): string[] {
  return [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    join(homeDir, 'Applications/ChatGPT.app/Contents/Resources/codex'),
    join(homeDir, 'Applications/Codex.app/Contents/Resources/codex'),
  ];
}

/** Cheap existence-only candidate scan. No subprocesses are spawned here. */
export function collectCodexCandidatePaths(options: CodexCandidateDiscoveryOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const pathValue = options.pathValue ?? process.env.PATH ?? '';
  const homeDir = options.homeDir ?? homedir();
  const exists = options.exists ?? existsSync;
  const pathJoin = platform === 'win32' ? win32Path.join : join;
  const sep = platform === 'win32' ? ';' : ':';
  const exts = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const candidatePaths: string[] = [];

  for (const dir of pathValue.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = pathJoin(dir, `codex${ext}`);
      if (exists(candidate) && !candidatePaths.includes(candidate)) candidatePaths.push(candidate);
    }
  }

  // Bundle paths are appended AFTER PATH so equal-version custom builds keep
  // winning the input-order tiebreak in selectBestCodexCandidate().
  if (platform === 'darwin') {
    for (const candidate of getMacOSCodexBundleCandidates(homeDir)) {
      if (exists(candidate) && !candidatePaths.includes(candidate)) candidatePaths.push(candidate);
    }
  }

  return candidatePaths;
}

/** Stable, cheap fingerprint used to notice install/uninstall/PATH changes. */
export function fingerprintCodexCandidates(candidatePaths: readonly string[]): string {
  return JSON.stringify(candidatePaths);
}

// `findCodexBinary()` is a hot path, so successful version probes stay cached.
// Unlike the old process-lifetime cache, the selected result is only reused
// while a fresh existence scan produces the same candidate fingerprint.
let resolvedBinaryCache: { fingerprint: string; value: string | null } | null = null;
let versionProbeCache: { binary: string; value: string | null } | null = null;

/** Test-only: clear the memoized binary resolution between cases. */
export function resetCodexBinaryCacheForTests(): void {
  resolvedBinaryCache = null;
  versionProbeCache = null;
  if (!cached) lastAvailability = { kind: 'unknown' };
}

/**
 * Read the selected binary's version once and turn it into the UI capability
 * fact for `approvalsReviewer:auto_review`.
 *
 * The runtime still verifies the thread/start or thread/resume response echo.
 * This preflight only controls whether the composer may offer the option.
 */
export function getCodexAutoReviewCapability(): CodexAutoReviewCapability {
  const binary = findCodexBinary();
  if (!binary) {
    return {
      supported: false,
      installedVersion: null,
      minVersion: CODEX_AUTO_REVIEW_MIN_VERSION,
      reason: 'not_installed',
    };
  }

  const rawVersion = lastAvailability.kind === 'ready'
    ? lastAvailability.version
    : versionProbeCache?.binary === binary
      ? versionProbeCache.value
      : probeCodexVersion(binary);
  if (lastAvailability.kind !== 'ready' && versionProbeCache?.binary !== binary) {
    versionProbeCache = { binary, value: rawVersion };
  }

  if (!rawVersion) {
    return {
      supported: false,
      installedVersion: null,
      minVersion: CODEX_AUTO_REVIEW_MIN_VERSION,
      reason: 'version_unknown',
    };
  }
  if (!codexVersionSupportsAutoReview(rawVersion)) {
    return {
      supported: false,
      installedVersion: rawVersion,
      minVersion: CODEX_AUTO_REVIEW_MIN_VERSION,
      reason: 'version_too_old',
    };
  }
  return {
    supported: true,
    installedVersion: rawVersion,
    minVersion: CODEX_AUTO_REVIEW_MIN_VERSION,
  };
}

/**
 * Locate the `codex` binary. Returns null when not found.
 *
 * Strategy:
 *   1. CODEX_DISABLED=1 hard-disables Codex (set in test harness so
 *      unit tests never spawn the subprocess or hit network).
 *   2. CODEX_BIN env var (test / CI override of the resolved path) —
 *      highest explicit priority.
 *   3. Collect candidates: PATH walk first, then the macOS ChatGPT.app and
 *      legacy Codex.app bundled binaries (system-wide + per-user installs).
 *   4. If more than one candidate exists, probe `--version` and pick the
 *      NEWEST (P0.1, 2026-06-01) so a stale Homebrew codex on PATH can't
 *      shadow a newer Codex.app build. Single candidate → use it as-is
 *      (no probe, keeps the common case spawn-free).
 *
 * The cheap candidate-existence scan runs on every idle availability query.
 * Version probes are reused while its fingerprint is unchanged; install,
 * uninstall, PATH and bundle-name changes invalidate resolution + version +
 * stale failure availability together. A healthy running app-server remains
 * pinned until it exits or is disposed — discovery never hot-kills it.
 */
export function findCodexBinary(): string | null {
  // Phase 5b (2026-05-15) — hard disable for tests. The wider Codex
  // surface (account, models, runtime) all funnel through this lookup,
  // so a single guard here keeps unit tests off the subprocess and off
  // the ChatGPT plugin-sync network call. CI sets it implicitly via
  // `npm run test:unit`; an interactive developer running tests
  // through their IDE picks it up the same way.
  if (process.env.CODEX_DISABLED === '1') return null;

  // Do not switch a healthy in-use app-server underneath active chats. Any
  // candidate changes are picked up after the process exits/is disposed.
  if (cached && lastAvailability.kind === 'ready') return lastAvailability.binary;

  const fromEnv = process.env.CODEX_BIN;
  const explicitCandidate = fromEnv && existsSync(fromEnv) ? fromEnv : null;
  const candidatePaths = explicitCandidate
    ? [explicitCandidate]
    : collectCodexCandidatePaths();
  const fingerprint = fingerprintCodexCandidates(candidatePaths)
    + (explicitCandidate ? ':CODEX_BIN' : ':AUTO');

  if (resolvedBinaryCache?.fingerprint === fingerprint) return resolvedBinaryCache.value;

  // Candidate existence changed (or an explicit refresh cleared the cache):
  // drop both the selected-version probe and any idle failure derived from the
  // previous binary. Never disturb an active/pending app-server promise.
  const hadResolution = resolvedBinaryCache !== null;
  versionProbeCache = null;
  if (hadResolution && !cached) lastAvailability = { kind: 'unknown' };

  let selected: string | null;
  if (candidatePaths.length <= 1) {
    selected = candidatePaths[0] ?? null;
    if (selected) console.info('[codex] selected binary', { binary: selected, reason: 'sole candidate' });
  } else {
    // Multiple codex installs (e.g. old /opt/homebrew/bin/codex alongside a
    // newer /Applications/Codex.app build) — probe versions and pick newest
    // so a stale PATH binary can't shadow Codex.app (packaged P0 2026-06-01).
    const probed: CodexBinaryCandidate[] = candidatePaths.map((p) => ({ path: p, version: probeCodexVersion(p) }));
    selected = selectBestCodexCandidate(probed);
    const selectedProbe = selected ? probed.find((candidate) => candidate.path === selected) : null;
    if (selected && selectedProbe) {
      versionProbeCache = { binary: selected, value: selectedProbe.version };
    }
    console.info('[codex] selected binary', {
      binary: selected,
      reason: 'highest version among multiple candidates',
      candidates: probed.map((c) => ({ path: c.path, version: c.version })),
    });
  }

  resolvedBinaryCache = { fingerprint, value: selected };
  return selected;
}

interface ManagedAppServer {
  readonly client: CodexAppServerClient;
  readonly transport: SpawnedTransport;
  readonly availability: CodexAvailability;
}

let cached: Promise<ManagedAppServer> | null = null;
let lastAvailability: CodexAvailability = { kind: 'unknown' };

/**
 * Resolve (or create) the shared app-server connection.
 *
 * Returns the managed instance OR throws when the binary isn't
 * available. Callers should check `getCodexAvailability()` first when
 * they want a non-throwing path.
 */
export async function getCodexAppServer(): Promise<ManagedAppServer> {
  if (cached) return cached;

  const binary = findCodexBinary();
  if (!binary) {
    lastAvailability = { kind: 'not_installed' };
    throw new Error('Codex binary not found on PATH (set CODEX_BIN to override)');
  }

  cached = (async (): Promise<ManagedAppServer> => {
    let proc: ChildProcessWithoutNullStreams;
    try {
      // Windows `.cmd`/`.bat` shims can't be spawned directly (EINVAL) — run
      // them through cmd.exe. Real .exe / macOS / Linux paths spawn directly.
      const launch = buildCodexLaunch(binary, ['app-server']);
      console.info('[codex.app-server] spawning', { binary, command: launch.command, args: launch.args });
      proc = spawn(launch.command, launch.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        env: {
          ...process.env,
          // B-025: default to 'warn' to avoid the Codex INFO tracing flood
          // (codex_core::tasks enter/exit spans) bloating the persistent main
          // log + main-process memory. Explicit RUST_LOG wins; opt into full
          // 'info' tracing with CODEPILOT_CODEX_TRACE=1.
          RUST_LOG: resolveCodexRustLog(process.env),
        },
      });
    } catch (err) {
      cached = null;
      const reason = err instanceof Error ? err.message : String(err);
      lastAvailability = { kind: 'spawn_failed', reason, binary };
      throw new Error(`Codex app-server spawn failed: ${reason}`);
    }

    const transport = makeStdioTransport(proc);
    const version = await readCodePilotVersion();
    const client = new CodexAppServerClient(transport, {
      version,
      title: 'CodePilot',
    });

    // Listen for unexpected exit so the cache stays accurate.
    proc.once('exit', (code, signal) => {
      console.warn('[codex.app-server] exited', { code, signal });
      if (cached) {
        // Invalidate the cache so the next caller respawns.
        cached = null;
      }
      lastAvailability = {
        kind: 'spawn_failed',
        reason: `exited with code=${code} signal=${signal}`,
        binary,
      };
    });

    try {
      const init = await client.initialize();
      lastAvailability = {
        kind: 'ready',
        version: init.userAgent,
        codexHome: init.codexHome,
        binary,
      };
      return { client, transport, availability: lastAvailability };
    } catch (err) {
      cached = null;
      await transport.close().catch(() => undefined);
      const reason = err instanceof Error ? err.message : String(err);
      lastAvailability = { kind: 'spawn_failed', reason, binary };
      throw new Error(`Codex app-server initialize failed: ${reason}`);
    }
  })();

  return cached;
}

/**
 * Non-throwing availability query for Settings status card.
 * Doesn't spawn — just inspects the binary and the cached state.
 */
export async function getCodexAvailability(): Promise<CodexAvailability> {
  if (lastAvailability.kind === 'ready') return lastAvailability;
  const binary = findCodexBinary();
  if (!binary) {
    lastAvailability = { kind: 'not_installed' };
    return lastAvailability;
  }
  if (lastAvailability.kind === 'unknown' || lastAvailability.kind === 'not_installed') {
    lastAvailability = { kind: 'installed_idle', binary };
    return lastAvailability;
  }
  return lastAvailability;
}

/**
 * Explicit user-requested rescan. This also catches an in-place CLI upgrade
 * whose path/existence fingerprint did not change. A healthy or initializing
 * app-server is deliberately left untouched and remains the source of truth.
 */
export async function refreshCodexAvailability(): Promise<CodexAvailability> {
  if (cached) return getCodexAvailability();
  resolvedBinaryCache = null;
  versionProbeCache = null;
  lastAvailability = { kind: 'unknown' };
  return getCodexAvailability();
}

/**
 * Tear down the cached app-server. Used on app exit (Electron main
 * 'before-quit' / dev-server SIGTERM) so we don't leave orphan
 * processes per plan §硬约束.
 */
export async function disposeCodexAppServer(): Promise<void> {
  const current = cached;
  if (!current) {
    lastAvailability = { kind: 'unknown' };
    return;
  }
  cached = null;
  try {
    const { client } = await current;
    await client.dispose();
  } catch {
    // If init failed and cached resolved with an error, the dispose
    // path may itself throw — ignore, the goal is just to free.
  }
  lastAvailability = { kind: 'unknown' };
}

/**
 * Read CodePilot's package.json version. Async wrapper around the
 * filesystem read so it's testable / can be mocked.
 */
async function readCodePilotVersion(): Promise<string> {
  // Walk up from this module until we find a package.json with name
  // "codepilot". Falls back to '0.0.0' if the lookup fails.
  let dir = __dirname;
  for (let depth = 0; depth < 10; depth++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const fs = await import('node:fs/promises');
        const pkg = JSON.parse(await fs.readFile(candidate, 'utf8'));
        if (pkg?.name === 'codepilot' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      } catch {
        // ignore, keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

// Test-only: reset module state. Not exported via the package index.
export function __resetForTest(): void {
  cached = null;
  lastAvailability = { kind: 'unknown' };
  resolvedBinaryCache = null;
  versionProbeCache = null;
}
