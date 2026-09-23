export type InstallLifecycleOwner = 'app-updater' | 'cli-maintenance';

let owner: InstallLifecycleOwner | null = null;

export function tryAcquireInstallLifecycle(nextOwner: InstallLifecycleOwner): boolean {
  // This latch is deliberately non-reentrant, including for the same owner.
  // Owner names identify subsystems, not individual operations; allowing a
  // second `cli-maintenance` acquire would let either operation release the
  // shared latch while the other installer is still running.
  if (owner !== null) return false;
  owner = nextOwner;
  return true;
}

export function releaseInstallLifecycle(currentOwner: InstallLifecycleOwner): boolean {
  if (owner !== currentOwner) return false;
  owner = null;
  return true;
}

export function getInstallLifecycleOwner(): InstallLifecycleOwner | null {
  return owner;
}

export function __resetInstallLifecycleForTest(): void {
  owner = null;
}
