export type CliProvider = 'claude' | 'codex';

export type CliInstallChannel =
  | 'native'
  | 'standalone'
  | 'desktop_bundle'
  | 'homebrew'
  | 'npm'
  | 'bun'
  | 'pnpm'
  | 'winget'
  | 'unknown';

export type CliUpdateAvailability =
  | 'current'
  | 'update_available'
  | 'managed_auto'
  | 'manual_check'
  | 'unknown'
  | 'unsupported';

export type CliCompatibility = 'compatible' | 'below_minimum' | 'unknown';

export type CliUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'unchanged'
  | 'error';

export type CliMaintenanceErrorCode =
  | 'active_work'
  | 'activity_unavailable'
  | 'maintenance_in_progress'
  | 'cli_update_running'
  | 'app_update_installing'
  | 'app_quitting'
  | 'install_channel_unknown'
  | 'update_target_mismatch'
  | 'package_manager_missing'
  | 'permission_denied'
  | 'executable_locked'
  | 'network_unavailable'
  | 'timed_out'
  | 'cancelled'
  | 'cleanup_incomplete'
  | 'command_failed'
  | 'version_unverified'
  | 'version_unchanged'
  | 'internal';

export interface CliMaintenanceSnapshot {
  provider: CliProvider;
  installed: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  installChannel: CliInstallChannel;
  channelConfidence: 'proven' | 'ambiguous' | 'unknown';
  updateAvailability: CliUpdateAvailability;
  compatibility: CliCompatibility;
  minimumVersion: string | null;
  canOneClickUpdate: boolean;
  phase: CliUpdatePhase;
  errorCode: CliMaintenanceErrorCode | null;
  checkedAt: string | null;
}

export type CliMaintenanceSnapshots = Record<CliProvider, CliMaintenanceSnapshot>;

export function initialCliMaintenanceSnapshot(provider: CliProvider): CliMaintenanceSnapshot {
  return {
    provider,
    installed: false,
    currentVersion: null,
    latestVersion: null,
    installChannel: 'unknown',
    channelConfidence: 'unknown',
    updateAvailability: 'unknown',
    compatibility: 'unknown',
    minimumVersion: null,
    canOneClickUpdate: false,
    phase: 'idle',
    errorCode: null,
    checkedAt: null,
  };
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
  normalized: string;
}

/** Parse the first CLI-style semver while remaining prerelease-aware. */
export function parseCliSemver(value: string | null | undefined): ParsedSemver | null {
  if (!value) return null;
  const match = value.trim().match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?=$|\s|\))/);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4]
    ? match[4].split('.').map((entry) => (/^\d+$/.test(entry) ? Number.parseInt(entry, 10) : entry))
    : [];
  return {
    major,
    minor,
    patch,
    prerelease,
    normalized: `${major}.${minor}.${patch}${match[4] ? `-${match[4]}` : ''}`,
  };
}

function comparePrerelease(left: ParsedSemver['prerelease'], right: ParsedSemver['prerelease']): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'string') return -1;
    if (typeof a === 'string' && typeof b === 'number') return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function compareCliVersions(left: string, right: string): number | null {
  const a = parseCliSemver(left);
  const b = parseCliSemver(right);
  if (!a || !b) return null;
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function normalizeCliVersion(value: string | null | undefined): string | null {
  return parseCliSemver(value)?.normalized ?? null;
}

export function resolveCliUpdateAvailability(
  currentVersion: string | null,
  latestVersion: string | null,
): CliUpdateAvailability {
  if (!currentVersion || !latestVersion) return 'unknown';
  const comparison = compareCliVersions(currentVersion, latestVersion);
  if (comparison === null) return 'unknown';
  return comparison < 0 ? 'update_available' : 'current';
}

export function isCliProvider(value: unknown): value is CliProvider {
  return value === 'claude' || value === 'codex';
}
