import { execFileSync, execFile } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

export interface RuntimeArchitectureInfo {
  platform: NodeJS.Platform;
  processArch: string;
  hostArch: string;
  runningUnderRosetta: boolean;
}

/**
 * Whether the given binary path requires shell execution.
 * On Windows, .cmd/.bat files cannot be executed directly by execFileSync.
 */
function needsShell(binPath: string): boolean {
  return isWindows && /\.(cmd|bat)$/i.test(binPath);
}

function readSysctlValue(name: string): string | null {
  try {
    return execFileSync('/usr/sbin/sysctl', ['-in', name], {
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function getRuntimeArchitectureInfo(): RuntimeArchitectureInfo {
  const processArch = process.arch;
  let hostArch = processArch;
  let runningUnderRosetta = false;

  if (isMac) {
    const armCapable = readSysctlValue('hw.optional.arm64');
    if (armCapable === '1') {
      hostArch = 'arm64';
    }

    runningUnderRosetta = readSysctlValue('sysctl.proc_translated') === '1';
  }

  return {
    platform: process.platform,
    processArch,
    hostArch,
    runningUnderRosetta,
  };
}

/**
 * Extra PATH directories to search for Claude CLI and other tools.
 */
export function getExtraPathDirs(): string[] {
  return getExtraPathDirsFor(process.platform, os.homedir(), process.env);
}

export function getExtraPathDirsFor(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const pnpmHome = env.PNPM_HOME;
  const voltaHome = env.VOLTA_HOME ? pathApi.join(env.VOLTA_HOME, 'bin') : undefined;

  const extras = platform === 'win32'
    ? [
        pathApi.join(env.APPDATA || pathApi.join(home, 'AppData', 'Roaming'), 'npm'),
        pathApi.join(env.LOCALAPPDATA || pathApi.join(home, 'AppData', 'Local'), 'npm'),
        pathApi.join(env.APPDATA || pathApi.join(home, 'AppData', 'Roaming'), 'pnpm'),
        pathApi.join(env.LOCALAPPDATA || pathApi.join(home, 'AppData', 'Local'), 'pnpm'),
        pnpmHome,
        pathApi.join(home, '.npm-global', 'bin'),
        pathApi.join(home, '.local', 'bin'),
        pathApi.join(home, '.claude', 'bin'),
        pathApi.join(home, '.claude', 'local'),
        pathApi.join(home, '.bun', 'bin'),
        pathApi.join(home, '.yarn', 'bin'),
        pathApi.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin'),
        voltaHome,
        pathApi.join(home, '.fnm', 'current', 'bin'),
        pathApi.join(home, '.nvm', 'current', 'bin'),
        pathApi.join(home, '.asdf', 'shims'),
      ]
    : [
        pathApi.join(home, '.local', 'bin'),
        pathApi.join(home, '.claude', 'bin'),
        pathApi.join(home, '.claude', 'local'),
        pathApi.join(home, '.bun', 'bin'),
        pathApi.join(home, '.npm-global', 'bin'),
        pathApi.join(home, '.yarn', 'bin'),
        pathApi.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin'),
        pathApi.join(home, '.volta', 'bin'),
        pathApi.join(home, '.fnm', 'current', 'bin'),
        pathApi.join(home, '.nvm', 'current', 'bin'),
        pathApi.join(home, '.asdf', 'shims'),
        pnpmHome,
        pathApi.join(home, '.local', 'share', 'pnpm'),
        ...(platform === 'darwin' ? [pathApi.join(home, 'Library', 'pnpm')] : []),
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
        '/bin',
      ];

  return [...new Set(extras.filter((dir): dir is string => !!dir))];
}

export function getClaudeCandidatePathsFor(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const dirs = getExtraPathDirsFor(platform, home, env);
  if (platform === 'win32') {
    const exts = ['.cmd', '.exe', '.bat', ''];
    const candidates: string[] = [];
    for (const dir of dirs) {
      for (const ext of exts) {
        candidates.push(pathApi.join(dir, 'claude' + ext));
      }
    }
    return [...new Set(candidates)];
  }

  return [...new Set(dirs.map(dir => pathApi.join(dir, 'claude')))];
}

/**
 * Classify a Claude CLI binary path by installation method.
 */
export type ClaudeInstallType = 'native' | 'homebrew' | 'npm' | 'bun' | 'winget' | 'unknown';

export function classifyClaudePath(binPath: string): ClaudeInstallType {
  const home = os.homedir();
  const normalized = binPath.replace(/\\/g, '/');
  // Native installer: ~/.local/bin/claude or ~/.claude/bin/claude
  if (normalized.includes('/.local/bin/')) return 'native';
  if (normalized.includes('/.claude/bin/')) return 'native';
  if (normalized.includes('/.claude/local/')) return 'native';
  // Bun: ~/.bun/bin/claude
  if (normalized.includes('/.bun/bin/') || normalized.includes('/.bun/install/')) return 'bun';
  // Homebrew: /opt/homebrew/bin or /usr/local/Cellar or homebrew in path
  if (normalized.includes('/homebrew/') || normalized.includes('/Cellar/')) return 'homebrew';
  // npm-family: npm/pnpm/yarn/Node manager shims that resolve to the same package channel
  if (normalized.includes('/Library/pnpm/')
    || normalized.includes('/.local/share/pnpm/')
    || normalized.includes('/.config/yarn/')
    || normalized.includes('/.yarn/bin/')
    || normalized.includes('/.volta/bin/')
    || normalized.includes('/.fnm/current/bin/')
    || normalized.includes('/.asdf/shims/')
    || normalized.includes('/.nvm/current/bin/')) {
    return 'npm';
  }
  // npm: npm-global, .npm, AppData/npm
  if (normalized.includes('/npm') || normalized.includes('npm-global')) return 'npm';
  if (normalized === '/usr/local/bin/claude') {
    // /usr/local/bin could be npm or homebrew — check symlink target
    try {
      const real = fs.realpathSync(binPath);
      if (real.includes('node_modules')) return 'npm';
      if (real.includes('homebrew') || real.includes('Cellar')) return 'homebrew';
      if (real.includes('.bun')) return 'bun';
    } catch { /* ignore */ }
    return 'unknown';
  }
  if (isWindows) {
    const appData = (process.env.APPDATA || '').replace(/\\/g, '/');
    const localAppData = (process.env.LOCALAPPDATA || '').replace(/\\/g, '/');
    if (appData && normalized.startsWith(appData + '/npm')) return 'npm';
    if (localAppData && normalized.startsWith(localAppData + '/npm')) return 'npm';
    if (appData && normalized.startsWith(appData + '/pnpm')) return 'npm';
    if (localAppData && normalized.startsWith(localAppData + '/pnpm')) return 'npm';
    if (normalized.includes(home.replace(/\\/g, '/') + '/.local/bin')) return 'native';
  }
  return 'unknown';
}

/**
 * Claude CLI candidate installation paths.
 * Priority: native install > homebrew > npm (deprecated).
 */
export function getClaudeCandidatePaths(): string[] {
  return getClaudeCandidatePathsFor(process.platform, os.homedir(), process.env);
}

export interface ClaudeInstallInfo {
  path: string;
  version: string | null;
  type: ClaudeInstallType;
}

/**
 * Detect ALL Claude CLI installations on the system.
 * Used to warn about conflicts when multiple versions coexist.
 */
export function findAllClaudeBinaries(): ClaudeInstallInfo[] {
  const results: ClaudeInstallInfo[] = [];
  const seenReal = new Set<string>();

  function tryAdd(p: string) {
    try {
      let realPath: string;
      try { realPath = fs.realpathSync(p); } catch { realPath = p; }
      if (seenReal.has(realPath)) return;

      // On Windows, installers create multiple variants in the same directory:
      // native: claude.exe + claude (shell script), npm: claude.cmd + claude, etc.
      // Deduplicate by dir + base name stripped of all executable extensions.
      // Only record the dirKey AFTER --version succeeds, so a broken .cmd
      // wrapper doesn't hide a working .exe in the same directory.
      let winDirKey: string | undefined;
      if (isWindows) {
        winDirKey = path.join(path.dirname(realPath), path.basename(realPath).replace(/\.(exe|cmd|bat)$/i, '')).toLowerCase();
        if (seenReal.has(winDirKey)) return;
      }

      const out = execFileSync(p, ['--version'], {
        timeout: 3000,
        stdio: 'pipe',
        shell: needsShell(p),
        encoding: 'utf-8',
      });
      seenReal.add(realPath);
      if (winDirKey) seenReal.add(winDirKey);
      results.push({ path: p, version: out.trim() || null, type: classifyClaudePath(p) });
    } catch {
      // not found at this path
    }
  }

  // Check all known candidate paths
  for (const p of getClaudeCandidatePaths()) {
    tryAdd(p);
  }

  // Also scan PATH via which/where to catch bun, custom, or other non-standard installs
  try {
    const cmd = isWindows ? 'where' : '/usr/bin/which';
    const args = isWindows ? ['claude'] : ['-a', 'claude']; // -a = show ALL matches
    const result = execFileSync(cmd, args, {
      timeout: 3000,
      stdio: 'pipe',
      env: { ...process.env, PATH: getExpandedPath() },
      shell: isWindows,
      encoding: 'utf-8',
    });
    for (const line of result.trim().split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate) tryAdd(candidate);
    }
  } catch {
    // which/where failed
  }

  return results;
}

/**
 * Build an expanded PATH string with extra directories, deduped and filtered.
 */
export function getExpandedPath(): string {
  const current = process.env.PATH || '';
  const parts = current.split(path.delimiter).filter(Boolean);
  const seen = new Set(parts);
  for (const p of getExtraPathDirs()) {
    if (p && !seen.has(p)) {
      parts.push(p);
      seen.add(p);
    }
  }
  return parts.join(path.delimiter);
}

// TTL cache for findClaudeBinary to avoid repeated filesystem probes.
// Only caches "found" results; "not found" is never cached so a fresh
// install is detected immediately on the next check.
let _cachedBinaryPath: string | undefined | null = null; // null = not cached
let _cachedBinaryTimestamp = 0;
const BINARY_CACHE_TTL = 60_000; // 60 seconds

/**
 * Invalidate all cached binary paths.
 * Must be called after a new installation so that subsequent SDK calls
 * pick up the freshly-installed binary instead of a stale npm/bun path.
 */
export function invalidateClaudePathCache(): void {
  _cachedBinaryPath = null;
  _cachedBinaryTimestamp = 0;
}

/**
 * Find and validate the Claude CLI binary.
 * Positive results are cached for 60s; negative results are never cached.
 */
export function findClaudeBinary(): string | undefined {
  const now = Date.now();
  if (_cachedBinaryPath !== null && now - _cachedBinaryTimestamp < BINARY_CACHE_TTL) {
    return _cachedBinaryPath;
  }

  const found = _findClaudeBinaryUncached();
  if (found) {
    _cachedBinaryPath = found;
    _cachedBinaryTimestamp = now;
  } else {
    // Don't cache "not found" — user may install CLI any moment
    _cachedBinaryPath = null;
  }
  return found;
}

function _findClaudeBinaryUncached(): string | undefined {
  // Try known candidate paths first
  for (const p of getClaudeCandidatePaths()) {
    try {
      execFileSync(p, ['--version'], {
        timeout: 3000,
        stdio: 'pipe',
        shell: needsShell(p),
      });
      return p;
    } catch {
      // not found, try next
    }
  }

  // Fallback: use `where` (Windows) or `which` (Unix) with expanded PATH
  try {
    const cmd = isWindows ? 'where' : '/usr/bin/which';
    const args = isWindows ? ['claude'] : ['claude'];
    const result = execFileSync(cmd, args, {
      timeout: 3000,
      stdio: 'pipe',
      env: { ...process.env, PATH: getExpandedPath() },
      shell: isWindows,
    });
    // where.exe may return multiple lines; try each with --version validation
    const lines = result.toString().trim().split(/\r?\n/);
    for (const line of lines) {
      const candidate = line.trim();
      if (!candidate) continue;
      try {
        execFileSync(candidate, ['--version'], {
          timeout: 3000,
          stdio: 'pipe',
          shell: needsShell(candidate),
        });
        return candidate;
      } catch {
        continue;
      }
    }
  } catch {
    // not found
  }

  return undefined;
}

/**
 * Execute claude --version and return the version string.
 * Handles .cmd shell execution on Windows.
 */
export async function getClaudeVersion(claudePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(claudePath, ['--version'], {
      timeout: 5000,
      env: { ...process.env, PATH: getExpandedPath() },
      shell: needsShell(claudePath),
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Detect if Claude Code was installed via WinGet on Windows.
 * WinGet installs to the same path as native (~/.local/bin/), so path-based
 * classification can't distinguish them. This checks WinGet's package list.
 * Result is cached for the process lifetime.
 */
let _wingetDetectionResult: boolean | null = null;

export async function isWingetInstall(): Promise<boolean> {
  if (!isWindows) return false;
  if (_wingetDetectionResult !== null) return _wingetDetectionResult;
  try {
    const { stdout } = await execFileAsync('winget', ['list', 'Anthropic.ClaudeCode', '--accept-source-agreements'], {
      timeout: 5000,
      shell: true,
      env: { ...process.env, PATH: getExpandedPath() },
    });
    _wingetDetectionResult = stdout.includes('Anthropic.ClaudeCode');
  } catch {
    _wingetDetectionResult = false;
  }
  return _wingetDetectionResult;
}

/** Invalidate winget detection cache (e.g. after upgrade) */
export function invalidateWingetCache(): void {
  _wingetDetectionResult = null;
}

/**
 * Get the upgrade command for a given install type.
 */
export interface UpgradeCommand {
  command: string;
  args: string[];
  shell: boolean;
}

export function getUpgradeCommand(installType: ClaudeInstallType): UpgradeCommand {
  switch (installType) {
    case 'homebrew':
      return { command: 'brew', args: ['upgrade', 'claude-code'], shell: false };
    case 'npm':
      // On Windows, npm is a .cmd file that requires shell execution
      return { command: 'npm', args: ['update', '-g', '@anthropic-ai/claude-code'], shell: isWindows };
    case 'bun':
      return { command: 'bun', args: ['update', '-g', '@anthropic-ai/claude-code'], shell: false };
    case 'winget':
      return { command: 'winget', args: ['upgrade', 'Anthropic.ClaudeCode', '--accept-source-agreements'], shell: true };
    case 'native':
    case 'unknown':
    default:
      // `claude update` is the official manual update command for native installs.
      // It works cross-platform and is simpler than re-running the install script.
      return { command: 'claude', args: ['update'], shell: false };
  }
}

/**
 * Find Git Bash (bash.exe) on Windows.
 * Returns the path to bash.exe or null if not found.
 */
export function findGitBash(): string | null {
  // 1. Check user-specified environment variable
  const envPath = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  // 2. Check common installation paths
  const commonPaths = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // 3. Try to locate git.exe via `where git` and derive bash.exe path
  try {
    const result = execFileSync('where', ['git'], {
      timeout: 3000,
      stdio: 'pipe',
      shell: true,
    });
    const lines = result.toString().trim().split(/\r?\n/);
    for (const line of lines) {
      const gitExe = line.trim();
      if (!gitExe) continue;
      // git.exe is typically at <GitDir>\cmd\git.exe or <GitDir>\bin\git.exe
      const gitDir = path.dirname(path.dirname(gitExe));
      const bashPath = path.join(gitDir, 'bin', 'bash.exe');
      if (fs.existsSync(bashPath)) {
        return bashPath;
      }
    }
  } catch {
    // where git failed or timed out
  }

  return null;
}
