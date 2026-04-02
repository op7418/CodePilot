import { execFile } from 'child_process';
import { promisify } from 'util';
import { isWindows, getExpandedPath } from './platform';
import { CLI_TOOLS_CATALOG, EXTRA_WELL_KNOWN_BINS } from './cli-tools-catalog';
import type { CliToolRuntimeInfo, CliToolDefinition } from '@/types';

const execFileAsync = promisify(execFile);

// Module-level cache with TTL
let _cache: { catalog: CliToolRuntimeInfo[]; extra: CliToolRuntimeInfo[]; timestamp: number } | null = null;
const CACHE_TTL = 120_000; // 2 minutes

/**
 * Detect a single CLI tool — checks binNames with which/where, then runs --version
 */
export async function detectCliTool(tool: CliToolDefinition): Promise<CliToolRuntimeInfo> {
  const expandedPath = getExpandedPath();
  const env = { ...process.env, PATH: expandedPath };

  for (const bin of tool.binNames) {
    try {
      // Find binary path
      const whichCmd = isWindows ? 'where' : '/usr/bin/which';
      const { stdout: binPath } = await execFileAsync(whichCmd, [bin], {
        timeout: 5000,
        env,
        shell: isWindows,
      });
      const resolvedPath = binPath.trim().split(/\r?\n/)[0]?.trim();
      if (!resolvedPath) continue;

      // Get version
      let version: string | null = null;
      try {
        const { stdout: versionOut, stderr: versionErr } = await execFileAsync(resolvedPath, ['--version'], {
          timeout: 5000,
          env,
        });
        const versionText = (versionOut || versionErr).trim();
        // Try semver pattern from first line
        const match = versionText.split('\n')[0]?.match(/(\d+\.\d+[\w.-]*)/);
        if (match) {
          version = match[1];
        } else {
          // Try JSON format (e.g. dreamina outputs {"version": "xxx", ...})
          try {
            const json = JSON.parse(versionText);
            if (json.version) version = String(json.version);
          } catch {
            // Not JSON — skip, leave version null rather than showing garbage
          }
        }
      } catch {
        // Binary exists but --version failed — still mark as installed
      }

      return {
        id: tool.id,
        status: 'installed',
        version,
        binPath: resolvedPath,
      };
    } catch {
      // bin not found, try next
    }
  }

  return {
    id: tool.id,
    status: 'not_installed',
    version: null,
    binPath: null,
  };
}

/**
 * Detect a single binary by name (for extra well-known tools outside catalog)
 */
async function detectBinary(id: string, bin: string): Promise<CliToolRuntimeInfo> {
  const expandedPath = getExpandedPath();
  const env = { ...process.env, PATH: expandedPath };

  try {
    const whichCmd = isWindows ? 'where' : '/usr/bin/which';
    const { stdout: binPath } = await execFileAsync(whichCmd, [bin], {
      timeout: 3000,
      env,
      shell: isWindows,
    });
    const resolvedPath = binPath.trim().split(/\r?\n/)[0]?.trim();
    if (!resolvedPath) {
      return { id, status: 'not_installed', version: null, binPath: null };
    }

    let version: string | null = null;
    try {
      const { stdout: vOut, stderr: vErr } = await execFileAsync(resolvedPath, ['--version'], {
        timeout: 3000,
        env,
      });
      const vText = (vOut || vErr).trim();
      const match = vText.split('\n')[0]?.match(/(\d+\.\d+[\w.-]*)/);
      if (match) {
        version = match[1];
      } else {
        try { const j = JSON.parse(vText); if (j.version) version = String(j.version); } catch { /* not JSON */ }
      }
    } catch { /* version extraction optional */ }

    return { id, status: 'installed', version, binPath: resolvedPath };
  } catch {
    return { id, status: 'not_installed', version: null, binPath: null };
  }
}

export interface DetectAllResult {
  catalog: CliToolRuntimeInfo[];
  extra: CliToolRuntimeInfo[];
}

/**
 * Detect all catalog tools + extra well-known binaries in parallel, with 2-minute cache.
 * Returns separate arrays so the UI can distinguish catalog vs system-detected tools.
 */
export async function detectAllCliTools(forceRefresh = false): Promise<DetectAllResult> {
  const now = Date.now();
  if (!forceRefresh && _cache && now - _cache.timestamp < CACHE_TTL) {
    return { catalog: _cache.catalog, extra: _cache.extra };
  }

  // Collect catalog tool IDs so we skip duplicates from the extra list
  const catalogBins = new Set(CLI_TOOLS_CATALOG.flatMap(t => t.binNames));

  const [catalogResults, extraResults] = await Promise.all([
    Promise.all(CLI_TOOLS_CATALOG.map(tool => detectCliTool(tool))),
    Promise.all(
      EXTRA_WELL_KNOWN_BINS
        .filter(([, , bin]) => !catalogBins.has(bin))
        .map(([id, , bin]) => detectBinary(id, bin))
    ),
  ]);

  // Only keep extra tools that are actually installed
  const extraInstalled = extraResults.filter(t => t.status === 'installed');

  _cache = { catalog: catalogResults, extra: extraInstalled, timestamp: now };
  return { catalog: catalogResults, extra: extraInstalled };
}

/**
 * Invalidate the detection cache
 */
export function invalidateDetectCache(): void {
  _cache = null;
}
