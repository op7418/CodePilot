import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  findClaudeBinary,
  getClaudeVersion,
  getExpandedPath,
  invalidateClaudePathCache,
  invalidateWingetCache,
} from '../src/lib/platform';
import {
  initialCliMaintenanceSnapshot,
  isCliProvider,
  normalizeCliVersion,
  resolveCliUpdateAvailability,
  compareCliVersions,
  type CliInstallChannel,
  type CliMaintenanceErrorCode,
  type CliMaintenanceSnapshot,
  type CliMaintenanceSnapshots,
  type CliProvider,
} from '../src/lib/cli-maintenance-contract';
import { classifyCliInstallPath, pathIsInside } from '../src/lib/cli-install-channel';
import {
  getInstallLifecycleOwner,
  releaseInstallLifecycle,
  tryAcquireInstallLifecycle,
} from './install-lifecycle-coordinator';
import {
  runCliMaintenanceCommand,
  type CliCommandResult as CommandResult,
  type CliCommandSpec as CommandSpec,
} from './cli-maintenance-runner';
import { resolveHomebrewOutdatedLatest } from './cli-maintenance-probes';

const CHECK_SUCCESS_TTL_MS = 60 * 60_000;
const CHECK_FAILURE_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_CAP_BYTES = 64 * 1024;
const LEASE_HEARTBEAT_MS = 5_000;

interface CliMaintenanceOptions {
  win: BrowserWindow;
  platform: NodeJS.Platform;
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
  getServerBaseUrl: () => string | null;
  getActiveWork: () => Promise<Array<'chat' | 'bridge' | 'task'>>;
  isAppQuitting: () => boolean;
}

interface ResolvedCliTarget {
  provider: CliProvider;
  binaryPath: string;
  binaryIdentity: string;
  versionCommand: CommandSpec;
  currentVersion: string;
  channel: CliInstallChannel;
  confidence: 'proven' | 'ambiguous' | 'unknown';
  canUpdate: boolean;
  updateCommand: CommandSpec | null;
  packageName: string | null;
  minimumVersion: string | null;
  compatibility: CliMaintenanceSnapshot['compatibility'];
}

interface ActiveOperation {
  provider: CliProvider;
  leaseId: string;
  cancel: () => Promise<void>;
  reconcileLease: () => Promise<boolean>;
  done: Promise<void>;
}

interface StartingOperation {
  provider: CliProvider;
  cancelled: boolean;
  done: Promise<void>;
}

let maintenanceWindow: BrowserWindow | null = null;
let initialized = false;
let platform: NodeJS.Platform = process.platform;
let trustedSender: CliMaintenanceOptions['isTrustedSender'] = () => false;
let getServerBaseUrl: CliMaintenanceOptions['getServerBaseUrl'] = () => null;
let getActiveWork: CliMaintenanceOptions['getActiveWork'] = async () => [];
let isAppQuitting: CliMaintenanceOptions['isAppQuitting'] = () => false;
let activeOperation: ActiveOperation | null = null;
let startingOperation: StartingOperation | null = null;
let snapshots: CliMaintenanceSnapshots = {
  claude: initialCliMaintenanceSnapshot('claude'),
  codex: initialCliMaintenanceSnapshot('codex'),
};
const resolvedTargets = new Map<CliProvider, ResolvedCliTarget>();
const checkInFlight = new Map<CliProvider, Promise<CliMaintenanceSnapshot>>();
const cacheState = new Map<CliProvider, { at: number; failed: boolean }>();

function publicSnapshots(): CliMaintenanceSnapshots {
  return {
    claude: { ...snapshots.claude },
    codex: { ...snapshots.codex },
  };
}

function updateSnapshot(provider: CliProvider, next: Partial<CliMaintenanceSnapshot>): CliMaintenanceSnapshot {
  snapshots = {
    ...snapshots,
    [provider]: { ...snapshots[provider], ...next },
  };
  if (maintenanceWindow && !maintenanceWindow.isDestroyed()) {
    maintenanceWindow.webContents.send('cli-maintenance:status', publicSnapshots());
  }
  return { ...snapshots[provider] };
}

function realPathOrSelf(binaryPath: string): string {
  try { return realpathSync.native(binaryPath); } catch { return binaryPath; }
}

function executableCandidates(name: string): string[] {
  try {
    const command = platform === 'win32' ? 'where.exe' : '/usr/bin/which';
    const output = execFileSync(command, [name], {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
      env: { ...process.env, PATH: getExpandedPath() },
    });
    return output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function resolvePackageBin(packageRoot: string, binName: string): CommandSpec | null {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const relative = typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.[binName];
    if (!relative || path.isAbsolute(relative) || relative.includes('\0')) return null;
    const script = path.resolve(packageRoot, relative);
    if (!pathIsInside(script, packageRoot, platform) || !existsSync(script)) return null;
    const nodePath = executableCandidates('node')[0];
    if (!nodePath || /\.(cmd|bat)$/i.test(nodePath)) return null;
    return { command: nodePath, args: [script] };
  } catch {
    return null;
  }
}

function resolveManagerCommand(manager: 'npm' | 'bun' | 'pnpm'): CommandSpec | null {
  const executable = executableCandidates(manager)[0];
  if (!executable) return null;
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) {
    return { command: executable, args: [] };
  }
  const packageRoot = path.join(path.dirname(executable), 'node_modules', manager);
  return resolvePackageBin(packageRoot, manager);
}

async function runCommand(
  spec: CommandSpec,
  timeoutMs: number,
  onSpawn?: (cancel: () => Promise<void>) => void,
): Promise<CommandResult> {
  return runCliMaintenanceCommand({
    spec,
    timeoutMs,
    platform,
    expandedPath: getExpandedPath(),
    outputCapBytes: OUTPUT_CAP_BYTES,
    onSpawn,
  });
}

async function commandOutput(spec: CommandSpec, timeoutMs = PROBE_TIMEOUT_MS): Promise<string | null> {
  const result = await runCommand(spec, timeoutMs);
  if (result.code !== 0 || result.timedOut || result.cancelled || result.cleanupIncomplete) return null;
  return `${result.stdout}\n${result.stderr}`.trim() || null;
}

async function proveNpmTarget(
  binaryPath: string,
  realPath: string,
  packageName: string,
  binName: string,
): Promise<{ manager: CommandSpec; version: CommandSpec } | null> {
  const manager = resolveManagerCommand('npm');
  if (!manager) return null;
  const rootOutput = await commandOutput({ command: manager.command, args: [...manager.args, 'root', '-g'] });
  const root = rootOutput?.split(/\r?\n/)[0]?.trim();
  if (!root || !path.isAbsolute(root)) return null;
  const packageRoot = path.join(root, ...packageName.split('/'));
  const version = provePackageRoot(binaryPath, realPath, packageRoot, binName);
  if (!version) return null;
  return { manager, version };
}

function shimPointsAtPackage(binaryPath: string, packageRoot: string, binName: string): boolean {
  try {
    const info = statSync(binaryPath);
    if (!info.isFile() || info.size > 16 * 1024) return false;
    const base = path.basename(binaryPath).toLowerCase().replace(/\.(cmd|ps1|bat)$/i, '');
    if (base !== binName.toLowerCase()) return false;
    const contents = readFileSync(binaryPath, 'utf8').replace(/\\/g, '/').toLowerCase();
    const absoluteToken = packageRoot.replace(/\\/g, '/').toLowerCase();
    const relativeToken = path.relative(path.dirname(binaryPath), packageRoot).replace(/\\/g, '/').toLowerCase();
    return contents.includes(absoluteToken) || (relativeToken.length > 0 && contents.includes(relativeToken));
  } catch {
    return false;
  }
}

function provePackageRoot(
  binaryPath: string,
  realPath: string,
  packageRoot: string,
  binName: string,
): CommandSpec | null {
  if (!existsSync(path.join(packageRoot, 'package.json'))) return null;
  const owned = pathIsInside(realPath, packageRoot, platform)
    || shimPointsAtPackage(binaryPath, packageRoot, binName);
  if (!owned) return null;
  return resolvePackageBin(packageRoot, binName);
}

async function provePnpmTarget(
  binaryPath: string,
  realPath: string,
  packageName: string,
  binName: string,
): Promise<{ manager: CommandSpec; version: CommandSpec } | null> {
  const manager = resolveManagerCommand('pnpm');
  if (!manager) return null;
  const rootOutput = await commandOutput({ command: manager.command, args: [...manager.args, 'root', '-g'] });
  const root = rootOutput?.split(/\r?\n/)[0]?.trim();
  if (!root || !path.isAbsolute(root)) return null;
  const packageRoot = path.join(root, ...packageName.split('/'));
  const version = provePackageRoot(binaryPath, realPath, packageRoot, binName);
  return version ? { manager, version } : null;
}

async function proveBunTarget(
  binaryPath: string,
  realPath: string,
  packageName: string,
  binName: string,
): Promise<{ manager: CommandSpec; version: CommandSpec } | null> {
  const manager = resolveManagerCommand('bun');
  if (!manager) return null;
  const binOutput = await commandOutput({ command: manager.command, args: [...manager.args, 'pm', 'bin', '-g'] });
  const binRoot = binOutput?.split(/\r?\n/)[0]?.trim();
  if (!binRoot || !path.isAbsolute(binRoot)) return null;
  const packageRoot = path.resolve(binRoot, '..', 'install', 'global', 'node_modules', ...packageName.split('/'));
  const version = provePackageRoot(binaryPath, realPath, packageRoot, binName);
  return version ? { manager, version } : null;
}

async function proveHomebrewTarget(
  binaryPath: string,
  realPath: string,
  cask: string,
): Promise<{ brew: CommandSpec } | null> {
  const brewPath = executableCandidates('brew')[0];
  if (!brewPath) return null;
  const brew = { command: brewPath, args: [] };
  const prefix = await commandOutput({ command: brew.command, args: ['--prefix', '--cask', cask] });
  if (!prefix || !path.isAbsolute(prefix)) return null;
  if (!pathIsInside(realPath, prefix.trim(), platform)) return null;
  return { brew };
}

async function readVersion(spec: CommandSpec): Promise<string | null> {
  const version = normalizeCliVersion(await commandOutput({ command: spec.command, args: [...spec.args, '--version'] }));
  return version === '0.0.0' ? null : version;
}

async function fetchCodexStatus(): Promise<{
  binary: string | null;
  version: string | null;
  minimum: string | null;
  compatibility: CliMaintenanceSnapshot['compatibility'];
}> {
  const baseUrl = getServerBaseUrl();
  if (!baseUrl) return { binary: null, version: null, minimum: null, compatibility: 'unknown' };
  try {
    const response = await fetch(`${baseUrl}/api/codex/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const data = await response.json() as {
      availability?: { kind?: string; binary?: string; version?: string; minimum?: string };
    };
    const availability = data.availability;
    return {
      binary: typeof availability?.binary === 'string' ? availability.binary : null,
      version: (() => {
        const version = normalizeCliVersion(availability?.version);
        return version === '0.0.0' ? null : version;
      })(),
      minimum: normalizeCliVersion(availability?.minimum),
      compatibility: availability?.kind === 'too_old'
        ? 'below_minimum'
        : availability?.kind === 'ready' || availability?.kind === 'installed_idle'
          ? 'compatible'
          : 'unknown',
    };
  } catch {
    return { binary: null, version: null, minimum: null, compatibility: 'unknown' };
  }
}

async function resolveTarget(provider: CliProvider): Promise<ResolvedCliTarget | null> {
  const packageName = provider === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
  const binName = provider === 'claude' ? 'claude' : 'codex';
  const codex = provider === 'codex' ? await fetchCodexStatus() : null;
  const binaryPath = provider === 'claude' ? findClaudeBinary() ?? null : codex?.binary ?? null;
  if (!binaryPath || !path.isAbsolute(binaryPath) || !existsSync(binaryPath)) return null;
  const realPath = realPathOrSelf(binaryPath);
  const pathClass = classifyCliInstallPath({
    provider,
    binaryPath,
    realPath,
    platform,
    homeDir: homedir(),
  });

  const channel = pathClass.channel;
  let confidence = pathClass.confidence;
  let updateCommand: CommandSpec | null = null;
  let versionCommand: CommandSpec = { command: binaryPath, args: [] };

  if (channel === 'npm') {
    const proof = await proveNpmTarget(binaryPath, realPath, packageName, binName);
    if (proof) {
      confidence = 'proven';
      versionCommand = proof.version;
      updateCommand = provider === 'codex'
        ? { command: proof.version.command, args: [...proof.version.args, 'update'] }
        : { command: proof.manager.command, args: [...proof.manager.args, 'install', '-g', `${packageName}@latest`] };
    }
  } else if (channel === 'homebrew') {
    const cask = provider === 'claude' ? 'claude-code' : 'codex';
    const proof = await proveHomebrewTarget(binaryPath, realPath, cask);
    if (proof) {
      confidence = 'proven';
      updateCommand = { command: proof.brew.command, args: ['upgrade', '--cask', cask] };
    }
  } else if (channel === 'native' && provider === 'claude') {
    updateCommand = { command: binaryPath, args: ['update'] };
  } else if (channel === 'standalone' && provider === 'codex') {
    updateCommand = { command: binaryPath, args: ['update'] };
  } else if (channel === 'bun') {
    const proof = await proveBunTarget(binaryPath, realPath, packageName, binName);
    if (proof) {
      confidence = 'proven';
      versionCommand = proof.version;
      updateCommand = provider === 'codex'
        ? { command: proof.version.command, args: [...proof.version.args, 'update'] }
        : { command: proof.manager.command, args: [...proof.manager.args, 'install', '-g', `${packageName}@latest`] };
    }
  } else if (channel === 'pnpm') {
    const proof = await provePnpmTarget(binaryPath, realPath, packageName, binName);
    if (proof) {
      confidence = 'proven';
      versionCommand = proof.version;
      updateCommand = provider === 'codex'
        ? { command: proof.version.command, args: [...proof.version.args, 'update'] }
        : { command: proof.manager.command, args: [...proof.manager.args, 'add', '-g', `${packageName}@latest`] };
    }
  }

  const claudeDetected = provider === 'claude'
    ? normalizeCliVersion(await getClaudeVersion(binaryPath))
    : null;
  const version = provider === 'claude'
    ? (claudeDetected === '0.0.0' ? null : claudeDetected) ?? await readVersion(versionCommand)
    : await readVersion(versionCommand) ?? codex?.version;
  if (!version) return null;
  return {
    provider,
    binaryPath,
    binaryIdentity: JSON.stringify({
      realPath,
      channel,
      packageName,
      versionCommand,
      updateCommand,
    }),
    versionCommand,
    currentVersion: version,
    channel,
    confidence,
    canUpdate: confidence === 'proven' && updateCommand !== null,
    updateCommand,
    packageName,
    minimumVersion: codex?.minimum ?? null,
    compatibility: codex?.compatibility ?? 'unknown',
  };
}

async function fetchRegistryLatest(packageName: string): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = await response.json() as { version?: unknown };
    return typeof body.version === 'string' ? normalizeCliVersion(body.version) : null;
  } catch {
    return null;
  }
}

async function fetchCodexStandaloneLatest(): Promise<string | null> {
  try {
    const response = await fetch('https://api.github.com/repos/openai/codex/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CodePilot-CLI-Maintenance' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = await response.json() as { tag_name?: unknown };
    return typeof body.tag_name === 'string' ? normalizeCliVersion(body.tag_name.replace(/^rust-v/, '')) : null;
  } catch {
    return null;
  }
}

async function probeHomebrewLatest(target: ResolvedCliTarget): Promise<string | null> {
  const brewPath = executableCandidates('brew')[0];
  if (!brewPath) return null;
  const cask = target.provider === 'claude' ? 'claude-code' : 'codex';
  const result = await runCommand({
    command: brewPath,
    args: ['outdated', '--cask', '--greedy', '--json=v2', cask],
  }, PROBE_TIMEOUT_MS);
  return resolveHomebrewOutdatedLatest(result, cask, target.currentVersion);
}

async function probeLatest(target: ResolvedCliTarget): Promise<{
  latestVersion: string | null;
  availability: CliMaintenanceSnapshot['updateAvailability'];
}> {
  if (target.channel === 'npm' || target.channel === 'bun' || target.channel === 'pnpm') {
    const latestVersion = target.packageName ? await fetchRegistryLatest(target.packageName) : null;
    return {
      latestVersion,
      availability: resolveCliUpdateAvailability(target.currentVersion, latestVersion),
    };
  }
  if (target.channel === 'homebrew') {
    const latestVersion = await probeHomebrewLatest(target);
    return {
      latestVersion,
      availability: resolveCliUpdateAvailability(target.currentVersion, latestVersion),
    };
  }
  if (target.channel === 'desktop_bundle') {
    // The selected Codex is shipped inside ChatGPT/Codex Desktop. Its owner
    // application, not CodePilot or the standalone feed, controls updates.
    return { latestVersion: null, availability: 'managed_auto' };
  }
  if (target.provider === 'codex' && target.channel === 'standalone') {
    const latestVersion = await fetchCodexStandaloneLatest();
    return {
      latestVersion,
      availability: resolveCliUpdateAvailability(target.currentVersion, latestVersion),
    };
  }
  if (target.provider === 'claude' && target.channel === 'native') {
    return { latestVersion: null, availability: 'managed_auto' };
  }
  if (target.confidence === 'ambiguous' || target.channel === 'winget') {
    return { latestVersion: null, availability: 'manual_check' };
  }
  return { latestVersion: null, availability: 'unknown' };
}

async function checkProvider(provider: CliProvider, force = false): Promise<CliMaintenanceSnapshot> {
  const cached = cacheState.get(provider);
  const ttl = cached?.failed ? CHECK_FAILURE_TTL_MS : CHECK_SUCCESS_TTL_MS;
  if (!force && cached && Date.now() - cached.at < ttl) return { ...snapshots[provider] };
  const existing = checkInFlight.get(provider);
  if (existing) return existing;
  const promise = (async () => {
    updateSnapshot(provider, { phase: 'checking', errorCode: null });
    const target = await resolveTarget(provider);
    if (!target) {
      resolvedTargets.delete(provider);
      cacheState.set(provider, { at: Date.now(), failed: false });
      return updateSnapshot(provider, {
        ...initialCliMaintenanceSnapshot(provider),
        phase: 'idle',
        checkedAt: new Date().toISOString(),
      });
    }
    resolvedTargets.set(provider, target);
    const latest = await probeLatest(target);
    const probeFailed = latest.availability === 'unknown';
    cacheState.set(provider, { at: Date.now(), failed: probeFailed });
    return updateSnapshot(provider, {
      installed: true,
      currentVersion: target.currentVersion,
      latestVersion: latest.latestVersion,
      installChannel: target.channel,
      channelConfidence: target.confidence,
      updateAvailability: latest.availability,
      compatibility: target.compatibility,
      minimumVersion: target.minimumVersion,
      canOneClickUpdate: target.canUpdate,
      phase: latest.availability === 'update_available' ? 'available' : 'idle',
      errorCode: null,
      checkedAt: new Date().toISOString(),
    });
  })().catch(() => {
    cacheState.set(provider, { at: Date.now(), failed: true });
    return updateSnapshot(provider, {
      phase: 'error',
      errorCode: 'internal',
      checkedAt: new Date().toISOString(),
    });
  }).finally(() => {
    checkInFlight.delete(provider);
  });
  checkInFlight.set(provider, promise);
  return promise;
}

async function postLease(
  action: 'acquire' | 'heartbeat' | 'release',
  provider: CliProvider,
  leaseId: string,
): Promise<{ ok: boolean; errorCode?: CliMaintenanceErrorCode }> {
  const baseUrl = getServerBaseUrl();
  if (!baseUrl) return { ok: false, errorCode: 'activity_unavailable' };
  try {
    const response = await fetch(`${baseUrl}/api/cli-maintenance/lease`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, provider, leaseId }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await response.json() as { ok?: boolean; errorCode?: CliMaintenanceErrorCode };
    return { ok: body.ok === true, errorCode: body.errorCode };
  } catch {
    return { ok: false, errorCode: 'activity_unavailable' };
  }
}

async function invalidateProvider(provider: CliProvider): Promise<void> {
  if (provider === 'claude') {
    invalidateClaudePathCache();
    invalidateWingetCache();
  }
  const baseUrl = getServerBaseUrl();
  if (!baseUrl) return;
  const endpoint = provider === 'claude' ? '/api/claude-status/invalidate' : '/api/codex/status';
  await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    cache: 'no-store',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  }).catch(() => undefined);
}

function classifyCommandFailure(result: CommandResult): CliMaintenanceErrorCode {
  if (result.cleanupIncomplete) return 'cleanup_incomplete';
  if (result.cancelled) return 'cancelled';
  if (result.timedOut) return 'timed_out';
  const text = `${result.stdout}\n${result.stderr}`;
  if (/EACCES|EPERM|permission|access is denied|administrator/i.test(text)) return 'permission_denied';
  if (/being used by another process|executable.*locked|0x80070020|sharing violation/i.test(text)) return 'executable_locked';
  if (/ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|network|offline/i.test(text)) return 'network_unavailable';
  return 'command_failed';
}

async function performUpdate(provider: CliProvider): Promise<CliMaintenanceSnapshot> {
  if (activeOperation || startingOperation) {
    // Do not overwrite the public `running` snapshot when the duplicate is for
    // the same provider. The invoke result still tells that caller why it lost.
    return {
      ...snapshots[provider],
      phase: 'error',
      errorCode: 'maintenance_in_progress',
    };
  }
  if (isAppQuitting()) {
    return updateSnapshot(provider, { phase: 'error', errorCode: 'app_quitting' });
  }

  // Admission is one synchronous critical section: reserve both the Main
  // operation slot and the cross-updater lifecycle latch before the first
  // await. No second Renderer surface can pass the guard while probes run.
  if (!tryAcquireInstallLifecycle('cli-maintenance')) {
    const lifecycleOwner = getInstallLifecycleOwner();
    return updateSnapshot(provider, {
      phase: 'error',
      errorCode: lifecycleOwner === 'cli-maintenance'
        ? 'maintenance_in_progress'
        : 'app_update_installing',
    });
  }

  let resolveStartingDone: () => void = () => {};
  const startingDone = new Promise<void>((resolve) => { resolveStartingDone = resolve; });
  const pending: StartingOperation = { provider, cancelled: false, done: startingDone };
  startingOperation = pending;
  const finishStarting = (): void => {
    if (startingOperation === pending) startingOperation = null;
    resolveStartingDone();
  };
  const rejectStarting = (
    errorCode: CliMaintenanceErrorCode,
    fields: Partial<CliMaintenanceSnapshot> = {},
  ): CliMaintenanceSnapshot => {
    releaseInstallLifecycle('cli-maintenance');
    finishStarting();
    return updateSnapshot(provider, { ...fields, phase: 'error', errorCode });
  };

  try {
    const blockers = await getActiveWork();
    if (blockers.length > 0) return rejectStarting('active_work');
  } catch {
    return rejectStarting('activity_unavailable');
  }

  let target: ResolvedCliTarget | null;
  let latest: Awaited<ReturnType<typeof probeLatest>>;
  try {
    target = await resolveTarget(provider);
    if (!target || !target.canUpdate || !target.updateCommand) {
      return rejectStarting(
        target?.confidence === 'ambiguous' ? 'update_target_mismatch' : 'install_channel_unknown',
      );
    }
    latest = await probeLatest(target);
  } catch {
    return rejectStarting('internal');
  }
  if (!target || !target.canUpdate || !target.updateCommand) {
    return rejectStarting('install_channel_unknown');
  }
  updateSnapshot(provider, {
    installed: true,
    currentVersion: target.currentVersion,
    latestVersion: latest.latestVersion,
    installChannel: target.channel,
    channelConfidence: target.confidence,
    updateAvailability: latest.availability,
    compatibility: target.compatibility,
    minimumVersion: target.minimumVersion,
    canOneClickUpdate: target.canUpdate,
    checkedAt: new Date().toISOString(),
  });

  const leaseId = randomUUID();
  const lease = await postLease('acquire', provider, leaseId);
  if (!lease.ok) {
    return rejectStarting(pending.cancelled ? 'cancelled' : (lease.errorCode ?? 'activity_unavailable'));
  }
  if (pending.cancelled || isAppQuitting()) {
    await postLease('release', provider, leaseId);
    return rejectStarting(isAppQuitting() ? 'app_quitting' : 'cancelled');
  }

  let cancelCommand: (() => Promise<void>) | null = null;
  let cancelRequested = false;
  let leaseLost = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const reconcileLease = async (): Promise<boolean> => {
    const heartbeatResult = await postLease('heartbeat', provider, leaseId);
    if (heartbeatResult.ok) return true;
    const recovered = await postLease('acquire', provider, leaseId);
    if (recovered.ok) return true;
    leaseLost = true;
    cancelRequested = true;
    if (cancelCommand) await cancelCommand();
    return false;
  };
  activeOperation = {
    provider,
    leaseId,
    cancel: async () => {
      cancelRequested = true;
      if (cancelCommand) await cancelCommand();
    },
    reconcileLease,
    done,
  };
  finishStarting();
  updateSnapshot(provider, { phase: 'running', errorCode: null });

  let finishing = false;
  let heartbeatBusy = false;
  let heartbeatInFlight: Promise<void> = Promise.resolve();
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || finishing) return;
    heartbeatBusy = true;
    heartbeatInFlight = (async () => {
      if (!finishing) await reconcileLease();
    })().finally(() => { heartbeatBusy = false; });
  }, LEASE_HEARTBEAT_MS);
  heartbeat.unref?.();

  let finalSnapshot: CliMaintenanceSnapshot;
  try {
    const refreshed = await resolveTarget(provider);
    if (
      !refreshed
      || !refreshed.canUpdate
      || !refreshed.updateCommand
      || refreshed.binaryIdentity !== target.binaryIdentity
    ) {
      finalSnapshot = updateSnapshot(provider, { phase: 'error', errorCode: 'update_target_mismatch' });
      return finalSnapshot;
    }
    if (cancelRequested) {
      await invalidateProvider(provider);
      const after = await resolveTarget(provider).catch(() => null);
      finalSnapshot = updateSnapshot(provider, {
        installed: after !== null,
        currentVersion: after?.currentVersion ?? null,
        phase: 'error',
        errorCode: leaseLost ? 'activity_unavailable' : 'cancelled',
      });
      return finalSnapshot;
    }
    const result = await runCommand(refreshed.updateCommand!, UPDATE_TIMEOUT_MS, (cancel) => {
      cancelCommand = cancel;
      if (cancelRequested) void cancel();
    });

    await invalidateProvider(provider);
    const after = await resolveTarget(provider);
    if (!after) {
      finalSnapshot = updateSnapshot(provider, {
        installed: false,
        currentVersion: null,
        phase: 'error',
        errorCode: 'version_unverified',
      });
      return finalSnapshot;
    }
    const comparison = compareCliVersions(after.currentVersion, target.currentVersion);
    const targetReached = snapshots[provider].latestVersion
      ? (compareCliVersions(after.currentVersion, snapshots[provider].latestVersion!) ?? -1) >= 0
      : comparison !== null && comparison > 0;
    const refreshedFields: Partial<CliMaintenanceSnapshot> = {
      installed: true,
      currentVersion: after.currentVersion,
      installChannel: after.channel,
      channelConfidence: after.confidence,
      checkedAt: new Date().toISOString(),
    };
    if (result.code !== 0 || result.timedOut || result.cancelled || result.cleanupIncomplete) {
      finalSnapshot = updateSnapshot(provider, {
        ...refreshedFields,
        phase: 'error',
        errorCode: leaseLost ? 'activity_unavailable' : classifyCommandFailure(result),
      });
      return finalSnapshot;
    }
    if (!targetReached) {
      finalSnapshot = updateSnapshot(provider, {
        ...refreshedFields,
        phase: 'unchanged',
        errorCode: 'version_unchanged',
      });
      return finalSnapshot;
    }
    cacheState.delete(provider);
    finalSnapshot = updateSnapshot(provider, {
      ...refreshedFields,
      latestVersion: snapshots[provider].latestVersion ?? after.currentVersion,
      updateAvailability: 'current',
      phase: 'succeeded',
      errorCode: null,
    });
    return finalSnapshot;
  } catch {
    await invalidateProvider(provider);
    const after = await resolveTarget(provider).catch(() => null);
    finalSnapshot = updateSnapshot(provider, {
      currentVersion: after?.currentVersion ?? null,
      phase: 'error',
      errorCode: after ? 'command_failed' : 'version_unverified',
    });
    return finalSnapshot;
  } finally {
    finishing = true;
    clearInterval(heartbeat);
    await heartbeatInFlight.catch(() => undefined);
    await postLease('release', provider, leaseId);
    releaseInstallLifecycle('cli-maintenance');
    activeOperation = null;
    resolveDone();
  }
}

function registerIpc(): void {
  ipcMain.handle('cli-maintenance:get-status', (event) => (
    trustedSender(event) ? publicSnapshots() : null
  ));
  ipcMain.handle('cli-maintenance:check', async (event, providerValue?: unknown) => {
    if (!trustedSender(event)) return publicSnapshots();
    if (isCliProvider(providerValue)) await checkProvider(providerValue, true);
    else await Promise.all([checkProvider('claude'), checkProvider('codex')]);
    return publicSnapshots();
  });
  ipcMain.handle('cli-maintenance:update', async (event, providerValue: unknown) => {
    if (!trustedSender(event) || !isCliProvider(providerValue)) return null;
    return performUpdate(providerValue);
  });
  ipcMain.handle('cli-maintenance:cancel', async (event, providerValue: unknown) => {
    if (!trustedSender(event) || !isCliProvider(providerValue)) return false;
    if (activeOperation?.provider === providerValue) {
      await activeOperation.cancel();
      return true;
    }
    if (startingOperation?.provider === providerValue) {
      startingOperation.cancelled = true;
      return true;
    }
    return false;
  });
}

export function initCliMaintenance(options: CliMaintenanceOptions): CliMaintenanceSnapshots {
  maintenanceWindow = options.win;
  platform = options.platform;
  trustedSender = options.isTrustedSender;
  getServerBaseUrl = options.getServerBaseUrl;
  getActiveWork = options.getActiveWork;
  isAppQuitting = options.isAppQuitting;
  if (!initialized) {
    initialized = true;
    registerIpc();
  }
  return publicSnapshots();
}

export function setCliMaintenanceWindow(win: BrowserWindow): void {
  maintenanceWindow = win;
  if (!win.isDestroyed()) win.webContents.send('cli-maintenance:status', publicSnapshots());
}

export function isCliMaintenanceRunning(): boolean {
  return activeOperation !== null || startingOperation !== null;
}

/** Seed a recovered utility before its first Runtime import, then confirm the
 * lease endpoint as soon as the local server becomes healthy. */
export function getCliMaintenanceBootstrapLease(): { provider: CliProvider; leaseId: string } | null {
  return activeOperation
    ? { provider: activeOperation.provider, leaseId: activeOperation.leaseId }
    : null;
}

export async function reconcileCliMaintenanceAfterServerReady(): Promise<boolean> {
  const operation = activeOperation;
  if (!operation) return true;
  return operation.reconcileLease();
}

export async function cancelCliMaintenanceAndWait(timeoutMs = 10_000): Promise<boolean> {
  const operation = activeOperation;
  const pending = startingOperation;
  if (!operation && !pending) return true;
  if (operation) await operation.cancel();
  if (pending) pending.cancelled = true;
  const done = operation?.done ?? pending!.done;
  return Promise.race([
    done.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

export function __resetCliMaintenanceForTest(): void {
  activeOperation = null;
  startingOperation = null;
  getActiveWork = async () => [];
  isAppQuitting = () => false;
  resolvedTargets.clear();
  checkInFlight.clear();
  cacheState.clear();
  snapshots = {
    claude: initialCliMaintenanceSnapshot('claude'),
    codex: initialCliMaintenanceSnapshot('codex'),
  };
}

export function __setCliMaintenanceTestDependencies(options: {
  activeWork: CliMaintenanceOptions['getActiveWork'];
  appQuitting?: CliMaintenanceOptions['isAppQuitting'];
}): void {
  getActiveWork = options.activeWork;
  isAppQuitting = options.appQuitting ?? (() => false);
}

export const __performCliMaintenanceUpdateForTest = performUpdate;
