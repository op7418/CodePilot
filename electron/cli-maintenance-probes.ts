import { normalizeCliVersion } from '../src/lib/cli-maintenance-contract';

export interface CliProbeCommandResult {
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  cleanupIncomplete: boolean;
  stdout: string;
}

/**
 * Homebrew intentionally exits 1 when a named cask is outdated, while still
 * writing valid JSON to stdout. Treat only parseable exit-0/exit-1 JSON as a
 * source fact; transport/process failures remain unknown instead of being
 * relabelled as the installed version.
 */
export function resolveHomebrewOutdatedLatest(
  result: CliProbeCommandResult,
  cask: string,
  currentVersion: string,
): string | null {
  if (
    result.timedOut
    || result.cancelled
    || result.cleanupIncomplete
    || (result.code !== 0 && result.code !== 1)
  ) {
    return null;
  }

  try {
    const body = JSON.parse(result.stdout) as {
      casks?: Array<{ name?: unknown; current_version?: unknown }>;
    };
    if (!Array.isArray(body.casks)) return null;
    const entry = body.casks.find((candidate) => candidate.name === cask);
    if (entry) {
      return typeof entry.current_version === 'string'
        ? normalizeCliVersion(entry.current_version)
        : null;
    }
    return result.code === 0 && body.casks.length === 0 ? currentVersion : null;
  } catch {
    return null;
  }
}
