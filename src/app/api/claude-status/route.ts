import { NextResponse } from 'next/server';
import { findClaudeBinary, getClaudeVersion, findAllClaudeBinaries, classifyClaudePath, isWindows, findGitBash, isWingetInstall } from '@/lib/platform';
import type { ClaudeInstallInfo, ClaudeInstallType } from '@/lib/platform';
import { getJson } from '@/lib/http/client';

/** Latest version cache */
let cachedLatestVersion: string | null = null;
let cachedLatestVersionTimestamp = 0;
let lastFetchFailed = false;
const LATEST_VERSION_TTL = 60 * 60 * 1000; // 60 minutes on success
const LATEST_VERSION_FAIL_TTL = 5 * 60 * 1000; // 5 minutes on failure (backoff)

async function fetchLatestVersion(): Promise<string | null> {
  const now = Date.now();
  const ttl = lastFetchFailed ? LATEST_VERSION_FAIL_TTL : LATEST_VERSION_TTL;
  if (cachedLatestVersionTimestamp > 0 && now - cachedLatestVersionTimestamp < ttl) {
    return cachedLatestVersion;
  }
  try {
    const { data } = await getJson<{ version?: string }>('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', {
      timeoutMs: 5000,
      retries: 1,
      retryDelayMs: 250,
      retryJitterMs: 50,
      next: { revalidate: 3600 },
    });
    const version = data.version as string | undefined;
    if (version) {
      cachedLatestVersion = version;
      lastFetchFailed = false;
    }
    cachedLatestVersionTimestamp = now;
    return cachedLatestVersion;
  } catch {
    lastFetchFailed = true;
    cachedLatestVersionTimestamp = now;
    return cachedLatestVersion;
  }
}

/** Minimum CLI versions for optional features */
const FEATURE_MIN_VERSIONS: Record<string, string> = {
  thinking: '1.0.10',
  context1m: '1.0.20',
  effort: '1.0.15',
};

/** Extract pure semver from strings like "2.1.90 (Claude Code)" → "2.1.90" */
function extractVersion(v: string): string {
  const match = v.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : v;
}

/** Compare two semver-like version strings. Returns true if a >= b */
function versionGte(a: string, b: string): boolean {
  const pa = extractVersion(a).split('.').map(Number);
  const pb = extractVersion(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return true;
}

export async function GET() {
  try {
    const claudePath = findClaudeBinary();

    // On Windows, check for Git Bash (bash.exe) using the same detection as the SDK runtime.
    // This avoids false negatives when Git is installed but git.exe isn't on PATH.
    const missingGit = isWindows && findGitBash() === null;

    if (!claudePath) {
      const w: string[] = [];
      if (missingGit) w.push('Git Bash not found — some features may not work');
      return NextResponse.json({ connected: false, version: null, binaryPath: null, installType: null, otherInstalls: [], missingGit, warnings: w, features: {} });
    }
    const version = await getClaudeVersion(claudePath);
    let installType: ClaudeInstallType = classifyClaudePath(claudePath);

    // On Windows, native and WinGet install to the same path.
    // Check WinGet's package list to distinguish them (cached).
    if (isWindows && (installType === 'native' || installType === 'unknown')) {
      if (await isWingetInstall()) {
        installType = 'winget';
      }
    }

    // Detect other installations for conflict warning
    let otherInstalls: ClaudeInstallInfo[] = [];
    try {
      const all = findAllClaudeBinaries();
      otherInstalls = all.filter(i => i.path !== claudePath);
    } catch {
      // non-critical — don't fail the status check
    }

    // Detect supported features based on CLI version
    const features: Record<string, boolean> = {};
    if (version) {
      for (const [feature, minVersion] of Object.entries(FEATURE_MIN_VERSIONS)) {
        features[feature] = versionGte(version, minVersion);
      }
    }

    // Fetch latest version from npm registry (non-blocking).
    // Only npm/bun channels can be reliably compared against the npm registry.
    // Native auto-updates in background; Homebrew and WinGet are independent
    // distribution channels whose versions may lag behind npm, causing false
    // positives if we compare them against the npm registry version.
    const latestVersion = await fetchLatestVersion();
    const npmTrackedChannels = new Set<string>(['npm', 'bun']);
    const updateAvailable = !!(npmTrackedChannels.has(installType) && version && latestVersion && !versionGte(version, latestVersion));
    // Homebrew/WinGet need manual updates but we can't reliably detect if
    // an update exists. Flag them so the UI can show an upgrade entry point.
    const manualUpdateChannels = new Set<string>(['homebrew', 'winget']);
    const manualUpdateChannel = manualUpdateChannels.has(installType);

    // Build warnings array for non-blocking issues
    const warnings: string[] = [];
    if (missingGit) {
      warnings.push('Git Bash not found — some features may not work');
    }
    if (otherInstalls.length > 0) {
      warnings.push(`${otherInstalls.length} other Claude CLI installation(s) detected`);
    }

    return NextResponse.json({
      // connected = CLI found and returns a version. Git Bash missing is a
      // warning, not a blocker — the CLI itself is still usable for basic ops.
      connected: !!version,
      version,
      latestVersion,
      updateAvailable,
      manualUpdateChannel,
      binaryPath: claudePath,
      installType,
      otherInstalls,
      missingGit,
      warnings,
      features,
    });
  } catch {
    return NextResponse.json({ connected: false, version: null, binaryPath: null, installType: null, otherInstalls: [], missingGit: false, warnings: [], features: {} });
  }
}
