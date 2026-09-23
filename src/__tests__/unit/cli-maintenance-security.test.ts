import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = path.resolve(__dirname, '../../..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

describe('CLI maintenance trust and lifecycle wiring', () => {
  it('keeps Renderer IPC provider-only and retires the old HTTP executor', () => {
    const preload = read('electron/preload.ts');
    const service = read('electron/cli-maintenance.ts');
    const runner = read('electron/cli-maintenance-runner.ts');
    const tombstone = read('src/app/api/claude-upgrade/route.ts');
    const connection = read('src/components/layout/ConnectionStatus.tsx');
    const runtime = read('src/components/settings/RuntimePanel.tsx');

    assert.match(preload, /update:\s*\(provider:\s*CliProvider\)\s*=>\s*ipcRenderer\.invoke\('cli-maintenance:update', provider\)/);
    assert.match(preload, /cancel:\s*\(provider:\s*CliProvider\)\s*=>\s*ipcRenderer\.invoke\('cli-maintenance:cancel', provider\)/);
    assert.doesNotMatch(preload, /cliMaintenance[\s\S]{0,900}(installType|binaryPath|executable|command:|args:|shell:|registry)/);
    assert.match(service, /trustedSender\(event\)[\s\S]*isCliProvider\(providerValue\)/);
    assert.match(runner, /shell:\s*false/);
    assert.doesNotMatch(connection, /claude-upgrade|upgradeResult\.output|<pre/);
    assert.doesNotMatch(runtime, /claude-upgrade/);
    assert.match(tombstone, /status:\s*410/);
    assert.doesNotMatch(tombstone, /request\.json|execFile|spawn|getUpgradeCommand|stdout|stderr/);
  });

  it('holds one install lifecycle latch and gates Runtime launches for the lease window', () => {
    const main = read('electron/main.ts');
    const updater = read('electron/updater.ts');
    const service = read('electron/cli-maintenance.ts');
    const leaseRoute = read('src/app/api/cli-maintenance/lease/route.ts');
    const claude = read('src/lib/claude-client.ts');
    const codex = read('src/lib/codex/app-server-manager.ts');

    assert.match(updater, /tryAcquireInstallLifecycle\('app-updater'\)/);
    assert.match(updater, /snapshot\.phase !== 'downloaded'[\s\S]*getInstallLifecycleOwner\(\) !== 'cli-maintenance'/);
    assert.match(updater, /cli_update_running/);
    assert.match(service, /tryAcquireInstallLifecycle\('cli-maintenance'\)/);
    assert.match(service, /releaseInstallLifecycle\('cli-maintenance'\)/);
    assert.match(service, /activeOperation !== null \|\| startingOperation !== null/);
    assert.match(service, /if \(pending\) pending\.cancelled = true/);
    assert.match(service, /if \(pending\.cancelled \|\| isAppQuitting\(\)\)/);
    assert.match(main, /isCliMaintenanceRunning\(\)[\s\S]*coordinateQuitDuringCliMaintenance/);
    assert.match(main, /cancelCliMaintenanceAndWait/);
    assert.match(leaseRoute, /acquireCliMaintenanceLease[\s\S]*hasActiveWork\(\)/);
    assert.match(leaseRoute, /quiesceCodexForCliMaintenance/);
    assert.match(claude, /assertCliProviderLaunchAllowed\('claude'\)/);
    assert.match(codex, /assertCliProviderLaunchAllowed\('codex'\)/);
    assert.match(service, /postLease\('heartbeat'/);
    assert.match(service, /postLease\('release'/);
    assert.match(main, /CODEPILOT_CLI_MAINTENANCE_PROVIDER/);
    assert.match(main, /reconcileCliMaintenanceAfterServerReady\(\)/);

    const performUpdate = service.slice(
      service.indexOf('async function performUpdate'),
      service.indexOf('function registerIpc'),
    );
    const firstAwait = performUpdate.indexOf('await ');
    assert.ok(firstAwait > 0);
    assert.ok(performUpdate.indexOf("tryAcquireInstallLifecycle('cli-maintenance')") < firstAwait);
    assert.ok(performUpdate.indexOf('startingOperation = pending') < firstAwait);
  });

  it('does not expose raw command output or absolute target paths in the public contract', () => {
    const contract = read('src/lib/cli-maintenance-contract.ts');
    const snapshotStart = contract.indexOf('export interface CliMaintenanceSnapshot');
    const snapshotEnd = contract.indexOf('\n}', snapshotStart);
    const snapshot = contract.slice(snapshotStart, snapshotEnd);
    assert.doesNotMatch(snapshot, /path|command|args|shell|stdout|stderr|output/i);
    assert.match(snapshot, /errorCode/);
    assert.match(snapshot, /currentVersion/);
    assert.match(snapshot, /installChannel/);
  });

  it('treats desktop-bundled Codex as app-managed instead of self-updatable standalone', () => {
    const classifier = read('src/lib/cli-install-channel.ts');
    const service = read('electron/cli-maintenance.ts');
    const row = read('src/components/settings/CliMaintenanceRow.tsx');

    assert.match(classifier, /\.app\\\/contents\\\//);
    assert.match(classifier, /program files\/windowsapps/);
    assert.match(classifier, /appdata\\\/local\\\/programs/);
    assert.match(classifier, /microsoft\/windowsapps\/codex/);
    assert.match(classifier, /channel: 'desktop_bundle', confidence: 'proven'/);
    assert.match(service, /target\.channel === 'desktop_bundle'[\s\S]{0,240}latestVersion: null, availability: 'managed_auto'/);
    assert.doesNotMatch(service, /channel === 'desktop_bundle'[\s\S]{0,240}updateCommand\s*=/);
    assert.match(row, /installChannel === "desktop_bundle"[\s\S]{0,160}managedByDesktopApp/);
  });

  it('keeps the update card persistent at bottom-left and only auto-dismisses success', () => {
    const maintenance = read('src/hooks/useCliMaintenance.ts');
    const row = read('src/components/settings/CliMaintenanceRow.tsx');
    const main = read('electron/main.ts');
    const toastState = read('src/hooks/useToast.ts');
    const toaster = read('src/components/ui/toast.tsx');
    const service = read('electron/cli-maintenance.ts');

    assert.match(maintenance, /placement:\s*'bottom-left'/);
    assert.match(maintenance, /variant:\s*'card'/);
    assert.match(maintenance, /brand:\s*cardBrand/);
    assert.match(maintenance, /t\('cliMaintenance\.card\.stayCurrent'\)/);
    assert.match(maintenance, /remainingCliUpdateEntries\(updatable, completedProviders\)/);
    assert.match(maintenance, /duration:\s*0,[\s\S]{0,100}persistent:\s*true/);
    assert.match(maintenance, /type:\s*'loading'[\s\S]{0,700}duration:\s*0/);
    assert.match(maintenance, /type:\s*'loading'[\s\S]{0,700}dismissible:\s*false[\s\S]{0,80}onDismiss:\s*undefined/);
    assert.match(maintenance, /type:\s*'success'[\s\S]{0,700}duration:\s*2_500/);
    assert.match(maintenance, /notificationToastIdRef\.current = '';\s*notificationKeyRef\.current = '';/);
    assert.match(maintenance, /const keys: Record<[\s\S]*cliMaintenance\.error\.active_work/);
    assert.doesNotMatch(maintenance, /const copies: Record|另一个 CLI 更新正在运行/);
    assert.match(row, /useTranslation\(\)/);
    assert.doesNotMatch(row, /isZh\s*\?|"CLI 维护"|"CLI maintenance"/);
    assert.match(main, /translate\(locale, 'cliMaintenance\.quit\.title'\)/);
    assert.doesNotMatch(maintenance, /duration:\s*12_000/);
    assert.match(toastState, /findIndex\(item => !item\.persistent\)/);
    assert.match(toaster, /@lobehub\/icons\/es\/Anthropic/);
    assert.match(toaster, /@lobehub\/icons\/es\/OpenAI/);
    assert.match(toaster, /variant="default"/);
    assert.match(toaster, /size-7[\s\S]{0,160}hover:bg-accent/);
    assert.match(toaster, /className="mt-2 flex justify-start"/);
    assert.match(toaster, /className="absolute right-2 top-2 grid size-7/);
    assert.doesNotMatch(toaster, /mt-2 flex justify-end/);
    assert.match(toaster, /w-\[min\(18rem,calc\(100vw-1\.5rem\)\)\]/);
    assert.match(service, /version === '0\.0\.0' \? null : version/);
    assert.match(service, /await readVersion\(versionCommand\) \?\? codex\?\.version/);
    assert.match(service, /resolveHomebrewOutdatedLatest\(result, cask, target\.currentVersion\)/);
  });
});
