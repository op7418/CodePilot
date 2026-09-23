import type { CliProvider } from './cli-maintenance-contract';

export const CLI_MAINTENANCE_LEASE_TTL_MS = 15_000;

interface LeaseRecord {
  provider: CliProvider;
  leaseId: string;
  expiresAt: number;
}

const leases = new Map<CliProvider, LeaseRecord>();

function liveLease(provider: CliProvider, now: number): LeaseRecord | null {
  const current = leases.get(provider);
  if (!current) return null;
  if (current.expiresAt <= now) {
    leases.delete(provider);
    return null;
  }
  return current;
}

export function acquireCliMaintenanceLease(
  provider: CliProvider,
  leaseId: string,
  now = Date.now(),
): boolean {
  const current = liveLease(provider, now);
  if (current && current.leaseId !== leaseId) return false;
  leases.set(provider, {
    provider,
    leaseId,
    expiresAt: now + CLI_MAINTENANCE_LEASE_TTL_MS,
  });
  return true;
}

export function heartbeatCliMaintenanceLease(
  provider: CliProvider,
  leaseId: string,
  now = Date.now(),
): boolean {
  const current = liveLease(provider, now);
  if (!current || current.leaseId !== leaseId) return false;
  current.expiresAt = now + CLI_MAINTENANCE_LEASE_TTL_MS;
  return true;
}

export function releaseCliMaintenanceLease(provider: CliProvider, leaseId: string): boolean {
  const current = leases.get(provider);
  if (!current || current.leaseId !== leaseId) return false;
  leases.delete(provider);
  return true;
}

export function isCliMaintenanceActive(provider: CliProvider, now = Date.now()): boolean {
  return liveLease(provider, now) !== null;
}

export class CliMaintenanceInProgressError extends Error {
  readonly code = 'maintenance_in_progress' as const;

  constructor(readonly provider: CliProvider) {
    super(`${provider} CLI maintenance is in progress`);
    this.name = 'CliMaintenanceInProgressError';
  }
}

export function assertCliProviderLaunchAllowed(provider: CliProvider): void {
  if (isCliMaintenanceActive(provider)) throw new CliMaintenanceInProgressError(provider);
}

export function __resetCliMaintenanceLeasesForTest(): void {
  leases.clear();
}

export function hydrateCliMaintenanceLeaseFromEnvironment(
  env: {
    CODEPILOT_CLI_MAINTENANCE_PROVIDER?: string;
    CODEPILOT_CLI_MAINTENANCE_LEASE_ID?: string;
  },
  now = Date.now(),
): boolean {
  const provider = env.CODEPILOT_CLI_MAINTENANCE_PROVIDER;
  const leaseId = env.CODEPILOT_CLI_MAINTENANCE_LEASE_ID;
  if ((provider !== 'claude' && provider !== 'codex') || !leaseId) return false;
  return acquireCliMaintenanceLease(provider, leaseId, now);
}

// A recovered packaged utility is born while Main may still own an update
// child. Main injects this opaque pair before fork so the first provider
// module import is gated even before the loopback heartbeat endpoint is ready.
hydrateCliMaintenanceLeaseFromEnvironment({
  CODEPILOT_CLI_MAINTENANCE_PROVIDER: process.env.CODEPILOT_CLI_MAINTENANCE_PROVIDER,
  CODEPILOT_CLI_MAINTENANCE_LEASE_ID: process.env.CODEPILOT_CLI_MAINTENANCE_LEASE_ID,
});
