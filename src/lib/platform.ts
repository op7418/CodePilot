import { execFileSync, execFile } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

/**
 * Whether the given binary path requires shell execution.
 * On Windows, .cmd/.bat files cannot be executed directly by execFileSync.
 */
function needsShell(binPath: string): boolean {
  return isWindows && /\.(cmd|bat)$/i.test(binPath);
}

/**
 * Extra PATH directories to search for Claude CLI and other tools.
 */
export function getExtraPathDirs(): string[] {
  const home = os.homedir();
  if (isWindows) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(home, '.local', 'bin'),
      path.join(home, '.claude', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(appData, 'npm'),
      path.join(localAppData, 'npm'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.nvm', 'current', 'bin'),
    ];
  }
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.nvm', 'current', 'bin'),
  ];
}

/**
 * Classify a Claude CLI binary path by installation method.
 */
export type ClaudeInstallType = 'native' | 'homebrew' | 'npm' | 'bun' | 'unknown';

export function classifyClaudePath(binPath: string): ClaudeInstallType {
  const home = os.homedir();
  const normalized = binPath.replace(/\\/g, '/');
  // Native installer: ~/.local/bin/claude or ~/.claude/bin/claude
  if (normalized.includes('/.local/bin/')) return 'native';
  if (normalized.includes('/.claude/bin/')) return 'native';
  // Bun: ~/.bun/bin/claude
  if (normalized.includes('/.bun/bin/') || normalized.includes('/.bun/install/')) return 'bun';
  // Homebrew: /opt/homebrew/bin or /usr/local/Cellar or homebrew in path
  if (normalized.includes('/homebrew/') || normalized.includes('/Cellar/')) return 'homebrew';
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
    if (normalized.includes(home.replace(/\\/g, '/') + '/.local/bin')) return 'native';
  }
  return 'unknown';
}

/**
 * Claude CLI candidate installation paths.
 * Priority: native install > homebrew > npm (deprecated).
 */
export function getClaudeCandidatePaths(): string[] {
  const home = os.homedir();
  if (isWindows) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const exts = ['.cmd', '.exe', '.bat', ''];
    // Native first, then bun, then npm paths
    const baseDirs = [
      path.join(home, '.local', 'bin'),
      path.join(home, '.claude', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(appData, 'npm'),
      path.join(localAppData, 'npm'),
      path.join(home, '.npm-global', 'bin'),
    ];
    const candidates: string[] = [];
    for (const dir of baseDirs) {
      for (const ext of exts) {
        candidates.push(path.join(dir, 'claude' + ext));
      }
    }
    return candidates;
  }
  // macOS/Linux: native first, then bun, then homebrew, then npm paths
  return [
    path.join(home, '.local', 'bin', 'claude'),      // native installer
    path.join(home, '.claude', 'bin', 'claude'),      // native alt
    path.join(home, '.bun', 'bin', 'claude'),         // bun global
    '/opt/homebrew/bin/claude',                        // homebrew (Apple Silicon)
    '/usr/local/bin/claude',                           // homebrew (Intel) or npm global
    path.join(home, '.npm-global', 'bin', 'claude'),  // npm custom prefix
  ];
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
