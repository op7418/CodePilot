import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  compareCliVersions,
  normalizeCliVersion,
  resolveCliUpdateAvailability,
} from '../../lib/cli-maintenance-contract';
import { remainingCliUpdateEntries } from '../../lib/cli-maintenance-card';
import { resolveHomebrewOutdatedLatest } from '../../../electron/cli-maintenance-probes';
import {
  __resetCliMaintenanceLeasesForTest,
  acquireCliMaintenanceLease,
  assertCliProviderLaunchAllowed,
  heartbeatCliMaintenanceLease,
  hydrateCliMaintenanceLeaseFromEnvironment,
  isCliMaintenanceActive,
  releaseCliMaintenanceLease,
} from '../../lib/cli-maintenance-lease';
import {
  __resetInstallLifecycleForTest,
  getInstallLifecycleOwner,
  releaseInstallLifecycle,
  tryAcquireInstallLifecycle,
} from '../../../electron/install-lifecycle-coordinator';

describe('CLI maintenance pure contracts', () => {
  beforeEach(() => {
    __resetCliMaintenanceLeasesForTest();
    __resetInstallLifecycleForTest();
  });

  it('normalizes CLI output and compares stable/prerelease versions', () => {
    assert.equal(normalizeCliVersion('2.1.246 (Claude Code)'), '2.1.246');
    assert.equal(normalizeCliVersion('codex-cli 0.144.2-alpha.3'), '0.144.2-alpha.3');
    assert.equal(normalizeCliVersion('agent build 12'), null);
    assert.equal(compareCliVersions('0.144.2-alpha.3', '0.144.2'), -1);
    assert.equal(compareCliVersions('2.1.246', '2.1.245'), 1);
    assert.equal(resolveCliUpdateAvailability('2.1.245', '2.1.246'), 'update_available');
    assert.equal(resolveCliUpdateAvailability('garbage', '2.1.246'), 'unknown');
  });

  it('leases gate a provider, reject a competing owner and expire without residue', () => {
    const now = Date.now();
    assert.equal(acquireCliMaintenanceLease('codex', 'lease-a', now), true);
    assert.equal(isCliMaintenanceActive('codex', now + 1), true);
    assert.throws(() => assertCliProviderLaunchAllowed('codex'), /maintenance is in progress/);
    assert.equal(acquireCliMaintenanceLease('codex', 'lease-b', now + 2), false);
    assert.equal(heartbeatCliMaintenanceLease('codex', 'lease-a', now + 5_000), true);
    assert.equal(releaseCliMaintenanceLease('codex', 'lease-b'), false);
    assert.equal(isCliMaintenanceActive('codex', now + 20_001), false);
    assert.doesNotThrow(() => assertCliProviderLaunchAllowed('codex'));
  });

  it('hydrates a recovered utility gate before Runtime launch and still expires', () => {
    const now = Date.now();
    assert.equal(hydrateCliMaintenanceLeaseFromEnvironment({
      CODEPILOT_CLI_MAINTENANCE_PROVIDER: 'claude',
      CODEPILOT_CLI_MAINTENANCE_LEASE_ID: 'recovery-lease',
    }, now), true);
    assert.throws(() => assertCliProviderLaunchAllowed('claude'), /maintenance is in progress/);
    assert.equal(isCliMaintenanceActive('claude', now + 15_001), false);
  });

  it('global install lifecycle only admits one owner and releases by identity', () => {
    assert.equal(tryAcquireInstallLifecycle('cli-maintenance'), true);
    assert.equal(tryAcquireInstallLifecycle('cli-maintenance'), false);
    assert.equal(tryAcquireInstallLifecycle('app-updater'), false);
    assert.equal(getInstallLifecycleOwner(), 'cli-maintenance');
    assert.equal(releaseInstallLifecycle('app-updater'), false);
    assert.equal(releaseInstallLifecycle('cli-maintenance'), true);
    assert.equal(tryAcquireInstallLifecycle('app-updater'), true);
  });

  it('accepts Homebrew named-cask exit 1 JSON without hiding real probe failures', () => {
    const outdated = resolveHomebrewOutdatedLatest({
      code: 1,
      timedOut: false,
      cancelled: false,
      cleanupIncomplete: false,
      stdout: JSON.stringify({ casks: [{ name: 'codex', current_version: '0.151.0' }] }),
    }, 'codex', '0.150.0');
    assert.equal(outdated, '0.151.0');
    assert.equal(resolveCliUpdateAvailability('0.150.0', outdated), 'update_available');

    const failed = resolveHomebrewOutdatedLatest({
      code: 2,
      timedOut: false,
      cancelled: false,
      cleanupIncomplete: false,
      stdout: JSON.stringify({ casks: [] }),
    }, 'codex', '0.150.0');
    assert.equal(failed, null);
    assert.equal(resolveCliUpdateAvailability('0.150.0', failed), 'unknown');
  });

  it('treats parseable Homebrew exit 0 with no named cask as current', () => {
    assert.equal(resolveHomebrewOutdatedLatest({
      code: 0,
      timedOut: false,
      cancelled: false,
      cleanupIncomplete: false,
      stdout: JSON.stringify({ casks: [] }),
    }, 'claude-code', '2.1.246'), '2.1.246');
    assert.equal(resolveHomebrewOutdatedLatest({
      code: 1,
      timedOut: false,
      cancelled: false,
      cleanupIncomplete: false,
      stdout: 'not-json',
    }, 'claude-code', '2.1.246'), null);
  });

  it('retries only providers that have not already succeeded', () => {
    const entries = [
      { provider: 'claude' as const, version: '2.1.247' },
      { provider: 'codex' as const, version: '0.151.0' },
    ];
    assert.deepEqual(
      remainingCliUpdateEntries(entries, new Set(['claude'])),
      [{ provider: 'codex', version: '0.151.0' }],
    );
  });
});
