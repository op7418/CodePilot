import path from 'node:path';
import type { CodexAvailability } from '@/lib/codex/types';
import {
  getCodexSandboxReadiness,
  type CodexSandboxReadiness,
} from '@/lib/codex/sandbox-readiness';
import { resolvePathIdentity, type PathIdentity } from '@/lib/path-identity';
import { isCodexDesktopManagedPath } from '@/lib/cli-install-channel';

export type RuntimeProbeState = 'not_run' | 'passed' | 'failed';
export type RuntimeCandidateSource =
  | 'override'
  | 'path'
  | 'standalone'
  | 'desktop_bundle'
  | 'alias'
  | 'builtin'
  | 'unknown';

export interface RuntimeProbeSnapshot {
  runtime: 'native' | 'claude_code' | 'codex';
  platform: NodeJS.Platform;
  candidateSource: RuntimeCandidateSource;
  installChannel?: string;
  binary: {
    displayPath?: string;
    identity?: PathIdentity;
    exists: boolean;
    version?: string;
    probe: RuntimeProbeState;
  };
  cwd: {
    requested?: string;
    resolved: string;
    source: string;
    identity: PathIdentity;
  };
  shell?: { kind: string; executable?: string; probe: RuntimeProbeState };
  appServer?: { probe: RuntimeProbeState; detail?: string };
  sandbox?: CodexSandboxReadiness;
  lastError?: { stage: string; code?: string; message: string };
  logLocation?: string;
}

export interface ClaudeRuntimeStatusInput {
  connected: boolean;
  version: string | null;
  binaryPath?: string | null;
  installType?: string | null;
  missingGit?: boolean;
}

function identityForOptionalPath(value?: string | null): PathIdentity | undefined {
  if (!value) return undefined;
  try { return resolvePathIdentity(value); } catch { return undefined; }
}

function defaultCwd(requested?: string, source = 'server_process') {
  const value = requested || process.cwd();
  return {
    ...(requested ? { requested } : {}),
    resolved: value,
    source,
    identity: resolvePathIdentity(value),
  };
}

export function inferRuntimeCandidateSource(
  binary: string | undefined,
  runtime: RuntimeProbeSnapshot['runtime'],
  platform: NodeJS.Platform = process.platform,
): RuntimeCandidateSource {
  if (runtime === 'native') return 'builtin';
  if (!binary) return 'unknown';
  const normalized = binary.replace(/\//g, '\\').toLocaleLowerCase('en-US');
  if (runtime === 'codex' && process.env.CODEX_BIN && path.resolve(process.env.CODEX_BIN) === path.resolve(binary)) {
    return 'override';
  }
  if (normalized.includes('\\microsoft\\windowsapps\\')) return 'alias';
  if (runtime === 'codex' && isCodexDesktopManagedPath(binary, platform)) return 'desktop_bundle';
  if (/\\programs\\openai\\codex\\bin\\|\\\.codex\\bin\\|\\\.local\\bin\\/.test(normalized)) return 'standalone';
  if (/\.app\\contents\\resources\\claude$/.test(normalized)) return 'desktop_bundle';
  return 'path';
}

export function buildNativeRuntimeProbe(options: { cwd?: string; logLocation?: string } = {}): RuntimeProbeSnapshot {
  return {
    runtime: 'native',
    platform: process.platform,
    candidateSource: 'builtin',
    installChannel: 'bundled',
    // Native runs in-process; there is no separate executable probe. Keep the
    // bundled source and live appServer fact, but do not manufacture a passed
    // binary check that never ran.
    binary: { exists: true, version: process.version, probe: 'not_run' },
    cwd: defaultCwd(options.cwd),
    appServer: { probe: 'passed', detail: 'In-process CodePilot Runtime' },
    ...(options.logLocation ? { logLocation: options.logLocation } : {}),
  };
}

export function buildClaudeRuntimeProbe(
  status: ClaudeRuntimeStatusInput,
  options: { cwd?: string; gitBashPath?: string | null; logLocation?: string } = {},
): RuntimeProbeSnapshot {
  const identity = identityForOptionalPath(status.binaryPath);
  const snapshot: RuntimeProbeSnapshot = {
    runtime: 'claude_code',
    platform: process.platform,
    candidateSource: inferRuntimeCandidateSource(status.binaryPath ?? undefined, 'claude_code'),
    ...(status.installType ? { installChannel: status.installType } : {}),
    binary: {
      ...(status.binaryPath ? { displayPath: status.binaryPath } : {}),
      ...(identity ? { identity } : {}),
      exists: identity?.exists ?? !!status.binaryPath,
      ...(status.version ? { version: status.version } : {}),
      probe: status.connected ? 'passed' : status.binaryPath ? 'failed' : 'not_run',
    },
    cwd: defaultCwd(options.cwd),
    shell: {
      kind: process.platform === 'win32' ? 'git-bash' : 'user-shell',
      ...(options.gitBashPath ? { executable: options.gitBashPath } : {}),
      probe: process.platform === 'win32' ? options.gitBashPath ? 'passed' : 'failed' : 'not_run',
    },
    appServer: {
      probe: status.connected ? 'passed' : 'not_run',
      detail: status.connected ? 'Claude Code CLI version probe passed' : 'CLI runtime not initialized',
    },
    ...(options.logLocation ? { logLocation: options.logLocation } : {}),
  };
  if (!status.connected) {
    snapshot.lastError = {
      stage: status.binaryPath ? 'binary_probe' : 'binary_discovery',
      message: status.binaryPath
        ? 'Claude Code binary was found but did not return a usable version'
        : 'Claude Code binary was not found',
    };
  } else if (status.missingGit) {
    snapshot.lastError = {
      stage: 'shell_probe',
      code: 'git_bash_missing',
      message: 'Git Bash was not found; Claude Code shell tools may be limited on Windows',
    };
  }
  return snapshot;
}

export function buildCodexRuntimeProbe(
  availability: CodexAvailability,
  options: { cwd?: string; logLocation?: string } = {},
): RuntimeProbeSnapshot {
  const binary = 'binary' in availability ? availability.binary : undefined;
  const identity = identityForOptionalPath(binary);
  const binaryPassed = ['installed_idle', 'ready', 'spawn_failed', 'too_old'].includes(availability.kind);
  const sandbox: CodexSandboxReadiness = availability.kind === 'not_installed' || availability.kind === 'desktop_only'
    ? {
        state: 'not_applicable',
        probe: 'not_run',
        source: 'not_observed',
        detail: 'Sandbox cannot be probed until an executable standalone CLI is available',
      }
    : getCodexSandboxReadiness();
  const snapshot: RuntimeProbeSnapshot = {
    runtime: 'codex',
    platform: process.platform,
    candidateSource: availability.kind === 'desktop_only'
      ? 'desktop_bundle'
      : inferRuntimeCandidateSource(binary, 'codex'),
    ...(availability.kind === 'desktop_only' ? { installChannel: 'desktop' } : {}),
    binary: {
      ...(binary ? { displayPath: binary } : {}),
      ...(identity ? { identity } : {}),
      exists: identity?.exists ?? !!binary,
      ...(availability.kind === 'ready' || availability.kind === 'too_old' ? { version: availability.version } : {}),
      probe: binaryPassed ? 'passed' : availability.kind === 'desktop_only' ? 'failed' : 'not_run',
    },
    cwd: defaultCwd(options.cwd),
    appServer: {
      probe: availability.kind === 'ready' ? 'passed' : availability.kind === 'spawn_failed' ? 'failed' : 'not_run',
      detail: availability.kind === 'installed_idle'
        ? 'Installed; app-server has not been initialized in this process'
        : availability.kind,
    },
    sandbox,
    ...(options.logLocation ? { logLocation: options.logLocation } : {}),
  };
  if (availability.kind === 'desktop_only') {
    snapshot.lastError = {
      stage: 'binary_probe', code: availability.reason,
      message: 'Desktop-managed Codex bundle did not pass the standalone CLI version probe',
    };
  } else if (availability.kind === 'not_installed') {
    snapshot.lastError = {
      stage: 'binary_discovery', code: 'not_installed', message: 'No executable Codex CLI candidate was found',
    };
  } else if (availability.kind === 'spawn_failed') {
    snapshot.lastError = {
      stage: 'app_server_initialize', code: 'spawn_failed', message: availability.reason,
    };
  } else if (availability.kind === 'too_old') {
    snapshot.lastError = {
      stage: 'binary_version', code: 'too_old',
      message: `Codex ${availability.version} is below minimum ${availability.minimum}`,
    };
  }
  return snapshot;
}
