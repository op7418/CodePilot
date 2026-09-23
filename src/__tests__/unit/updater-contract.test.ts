import '../db-isolation.setup';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  acquireSessionLock,
  createSession,
  deleteSession,
  getDb,
  hasActiveSessionWork,
  releaseSessionLock,
  setSessionRuntimeStatus,
} from '../../lib/db';
import {
  boundedUpdateText,
  classifyUpdaterError,
  consumeUpdaterDownloadPromise,
  createUpdaterFailureReporter,
  resolveUpdaterFeedChannel,
  resolveUpdaterPublisherVerification,
  resolveUpdaterSupport,
  updaterInitialDelay,
  updaterRetryDelay,
} from '../../lib/updater-contract';

describe('Main-owned updater contract', () => {
  it('supports isolated stable/preview feeds on packaged macOS/Windows and leaves Linux honest', () => {
    assert.equal(resolveUpdaterSupport({ isPackaged: true, officialBuild: true, channel: 'stable', platform: 'darwin' }).supported, true);
    assert.equal(resolveUpdaterSupport({ isPackaged: true, officialBuild: true, channel: 'stable', platform: 'win32' }).supported, true);
    assert.equal(resolveUpdaterSupport({ isPackaged: true, officialBuild: true, channel: 'preview', platform: 'darwin' }).supported, true);
    assert.equal(resolveUpdaterSupport({ isPackaged: true, officialBuild: true, channel: 'fork', platform: 'darwin' }).supported, false);
    assert.equal(
      resolveUpdaterSupport({ isPackaged: true, officialBuild: false, channel: 'stable', platform: 'darwin' }).unsupportedReason,
      'unofficial_build',
    );
    assert.equal(resolveUpdaterFeedChannel('stable'), 'latest');
    assert.equal(resolveUpdaterFeedChannel('preview'), 'preview');
    assert.equal(resolveUpdaterFeedChannel('local'), null);
    assert.equal(
      resolveUpdaterSupport({ isPackaged: false, officialBuild: true, channel: 'stable', platform: 'win32' }).unsupportedReason,
      'not_packaged',
    );
    assert.equal(
      resolveUpdaterSupport({ isPackaged: true, officialBuild: true, channel: 'stable', platform: 'linux', appImagePath: '/app' }).unsupportedReason,
      'linux_trust_not_enabled',
    );
  });

  it('maps raw updater failures to bounded user-action codes', () => {
    assert.equal(classifyUpdaterError(new Error('getaddrinfo ENOTFOUND api.github.com')), 'offline');
    assert.equal(classifyUpdaterError(new Error('publisher signature invalid')), 'signature_invalid');
    assert.equal(classifyUpdaterError(new Error('latest.yml sha512 checksum mismatch')), 'metadata_invalid');
    assert.equal(classifyUpdaterError(new Error('differential download failed')), 'download_failed');
    assert.equal(classifyUpdaterError(new Error('/Users/alice/private/cache')), 'internal');
  });

  it('derives Windows publisher verification from packaged update metadata', () => {
    assert.equal(resolveUpdaterPublisherVerification('win32', {}), 'none');
    assert.equal(
      resolveUpdaterPublisherVerification('win32', { publisherName: ['CN=CodePilot'] }),
      'authenticode',
    );
    assert.equal(resolveUpdaterPublisherVerification('win32', { publisherName: [] }), 'unknown');
    assert.equal(resolveUpdaterPublisherVerification('win32', null), 'unknown');
    assert.equal(resolveUpdaterPublisherVerification('darwin', null), 'not_applicable');
  });

  it('bounds startup jitter, retry backoff and untrusted release notes', () => {
    assert.equal(updaterInitialDelay(0), 30_000);
    assert.equal(updaterInitialDelay(1), 120_000);
    assert.equal(updaterRetryDelay(1), 300_000);
    assert.equal(updaterRetryDelay(10), 3_600_000);
    assert.equal(boundedUpdateText('abcdef', 3), 'abc');
    assert.equal(boundedUpdateText([{ note: 'one' }, { note: 'two' }]), 'one\n\ntwo');
  });

  it('owns nested download rejection and deduplicates Promise/emitter arrival order', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      for (const emitterFirst of [true, false]) {
        let phase: import('../../lib/updater-contract').UpdaterPhase = 'downloading';
        let failures = 0;
        const report = createUpdaterFailureReporter(
          () => phase,
          () => {
            failures += 1;
            phase = 'error';
          },
        );
        let rejectDownload!: (error: unknown) => void;
        const nestedDownload = new Promise<void>((_resolve, reject) => {
          rejectDownload = reject;
        });
        const owned = consumeUpdaterDownloadPromise(nestedDownload, report);
        const failure = new Error(`download failed (${emitterFirst ? 'emitter-first' : 'promise-first'})`);

        if (emitterFirst) report(failure);
        rejectDownload(failure);
        await owned;
        if (!emitterFirst) report(failure);

        assert.equal(failures, 1);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps feed trust and install eligibility in Main behind narrow IPC', () => {
    const root = path.resolve(__dirname, '../../..');
    const main = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
    const updater = fs.readFileSync(path.join(root, 'electron/updater.ts'), 'utf8');
    const preload = fs.readFileSync(path.join(root, 'electron/preload.ts'), 'utf8');
    const activity = fs.readFileSync(path.join(root, 'src/app/api/app/activity/route.ts'), 'utf8');

    assert.match(main, /isTrustedUpdaterSender/);
    assert.match(main, /before-quit-for-update/);
    assert.match(main, /isQuitting = true/);
    assert.match(main, /CODEPILOT_OFFICIAL_UPDATE_BUILD === '1'/);
    assert.match(main, /getActiveUpdateWork/);
    assert.match(updater, /allowPrerelease = options\.channel === 'preview'/);
    assert.match(updater, /autoUpdater\.channel = feedChannel/);
    assert.match(updater, /allowDowngrade = false/);
    assert.match(updater, /autoDownload = true/);
    assert.match(updater, /autoInstallOnAppQuit = true/);
    assert.match(updater, /disableDifferentialDownload = false/);
    assert.match(updater, /disableWebInstaller = true/);
    assert.match(updater, /trustedSender\(event\)/);
    assert.match(updater, /activity_unavailable/);
    assert.match(updater, /downloadInFlight/);
    assert.match(updater, /const result = await autoUpdater\.checkForUpdates\(\)/);
    assert.match(updater, /result\?\.downloadPromise/);
    assert.match(updater, /consumeUpdaterDownloadPromise\(autoDownloadPromise, recordUpdaterErrorOnce\)/);
    assert.match(updater, /autoUpdater\.on\('error',[\s\S]*recordUpdaterErrorOnce\(error\)/);
    assert.match(updater, /snapshot\.phase === 'downloading'/);
    assert.match(updater, /INSTALL_HANDOFF_TIMEOUT_MS/);
    assert.match(updater, /onInstallLifecycleChange\(false\)/);
    assert.match(updater, /phase: 'downloaded', errorCode: 'install_failed'/);
    assert.match(main, /appQuitTeardownStarted/);
    assert.match(main, /updaterInstallLifecycleArmed/);
    assert.doesNotMatch(updater, /setFeedURL/);
    assert.doesNotMatch(preload, /feedURL|channel:|filePath|updaterOptions/);
    assert.match(preload, /updater:get-status/);
    assert.match(preload, /updater:install/);
    assert.match(activity, /hasActiveSessionWork/);
    assert.doesNotMatch(activity, /stream-session-manager/);
    assert.match(activity, /bridgeStatus\.running/);
    assert.match(activity, /last_status === 'running'/);
    const notAvailableStart = updater.indexOf("autoUpdater.on('update-not-available'");
    const progressStart = updater.indexOf("autoUpdater.on('download-progress'", notAvailableStart);
    const notAvailable = updater.slice(notAvailableStart, progressStart);
    assert.match(notAvailable, /releaseName: ''/);
    assert.match(notAvailable, /releaseNotes: ''/);
    assert.match(notAvailable, /progressPercent: null/);
    assert.doesNotMatch(notAvailable, /applyUpdateInfo/);
  });

  it('keeps manual update availability honest and explains check suppression during download', () => {
    const root = path.resolve(__dirname, '../../..');
    const route = fs.readFileSync(path.join(root, 'src/app/api/app/updates/route.ts'), 'utf8');
    const dialog = fs.readFileSync(path.join(root, 'src/components/layout/UpdateDialog.tsx'), 'utf8');
    const updateChecker = fs.readFileSync(path.join(root, 'src/hooks/useUpdateChecker.ts'), 'utf8');
    const about = fs.readFileSync(path.join(root, 'src/components/settings/AboutSection.tsx'), 'utf8');
    const overview = fs.readFileSync(path.join(root, 'src/components/settings/OverviewSection.tsx'), 'utf8');

    assert.match(route, /resolveReleaseAssetAvailability/);
    assert.match(route, /platformAssetMissing/);
    assert.match(route, /downloadUrl:\s*recommendedAsset\?\.browser_download_url\s*\|\|\s*""/);
    assert.doesNotMatch(route, /downloadUrl:\s*recommendedAsset\?\.browser_download_url\s*\|\|\s*release\.html_url/);

    for (const surface of [dialog, about, overview]) {
      assert.match(surface, /update\.platformAssetMissing/);
    }
    assert.match(dialog, /update\.viewReleaseDetails/);
    assert.match(updateChecker, /nativePackageType: snapshot\.packageType/);
    assert.match(updateChecker, /nativePublisherVerification: snapshot\.publisherVerification/);
    assert.match(dialog, /nativePackageType === 'nsis'[\s\S]*?nativePublisherVerification === 'none'/);
    assert.match(dialog, /update\.windowsUnsignedTrustNotice/);
    for (const settingsSurface of [about, overview]) {
      assert.match(settingsSurface, /nativeUpdateBusy/);
      assert.match(settingsSurface, /update\.checkUnavailableDuringUpdate/);
    }
  });

  it('does not mistake stale runtime_status residue for live chat work', () => {
    const session = createSession(`updater-activity-${Date.now()}`);
    const lockId = `lock-${Date.now()}`;
    try {
      setSessionRuntimeStatus(session.id, 'running');
      assert.equal(hasActiveSessionWork(), false, 'status without an owner is crash residue');

      assert.equal(acquireSessionLock(session.id, lockId, 'updater-test', 600), true);
      assert.equal(hasActiveSessionWork(), true, 'active status plus a live owner blocks install');

      getDb().prepare(
        "UPDATE session_runtime_locks SET expires_at = '2000-01-01 00:00:00' WHERE session_id = ?",
      ).run(session.id);
      assert.equal(hasActiveSessionWork(), false, 'an expired owner cannot keep the updater blocked forever');
    } finally {
      releaseSessionLock(session.id, lockId);
      deleteSession(session.id);
    }
  });

  it('blocks install while a live-owned session is streaming output', () => {
    const session = createSession(`updater-streaming-${Date.now()}`);
    const lockId = `streaming-lock-${Date.now()}`;
    try {
      setSessionRuntimeStatus(session.id, 'streaming');
      assert.equal(acquireSessionLock(session.id, lockId, 'updater-streaming-test', 600), true);
      assert.equal(hasActiveSessionWork(), true, 'streaming output plus a live owner must block install');
    } finally {
      releaseSessionLock(session.id, lockId);
      deleteSession(session.id);
    }
  });
});
