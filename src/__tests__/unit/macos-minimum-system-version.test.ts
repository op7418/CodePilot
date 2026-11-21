import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { infoPlist, writeAppZip } from './_macos-app-zip';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(text: string): unknown };
const repoRoot = path.resolve(__dirname, '../../..');
const stampScript = path.join(repoRoot, 'scripts/stamp-macos-minimum-system-version.mjs');
const assetVerifier = path.join(repoRoot, 'scripts/verify-update-assets.mjs');
const { AppUpdater } = require('electron-updater/out/AppUpdater') as {
  AppUpdater: { prototype: { checkIfUpdateSupported(this: unknown, info: unknown): boolean } };
};
const nodeOs = require('node:os') as { release: () => string };

const VERSION = '1.2.7';
const UNIVERSAL_ZIP = `CodePilot-${VERSION}-universal.zip`;
let fixture = '';

afterEach(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
  fixture = '';
});

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function hash(file: string, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): string {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
}

/** Same shape as electron-builder's native latest-mac.yml before stamping. */
function writeBuilderMetadata(root: string, name: string): string {
  const zip = path.join(root, UNIVERSAL_ZIP);
  const sha512 = hash(zip, 'sha512', 'base64');
  const metadataPath = path.join(root, name);
  fs.writeFileSync(metadataPath, [
    `version: ${VERSION}`,
    'files:',
    `  - url: ${UNIVERSAL_ZIP}`,
    `    sha512: ${sha512}`,
    `    size: ${fs.statSync(zip).size}`,
    `path: ${UNIVERSAL_ZIP}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-11-21T04:12:03.363Z'",
    '',
  ].join('\n'));
  return metadataPath;
}

function makeMacRelease(lsMinimumSystemVersion: string | null = '13.0', metadataName = 'latest-mac.yml'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-min-os-'));
  for (const arch of ['arm64', 'x64', 'universal']) {
    fs.writeFileSync(path.join(root, `CodePilot-${VERSION}-${arch}.dmg`), `dmg:${arch}`);
    const zip = path.join(root, `CodePilot-${VERSION}-${arch}.zip`);
    if (arch === 'universal') writeAppZip(zip, infoPlist(lsMinimumSystemVersion));
    else fs.writeFileSync(zip, `zip:${arch}`);
    fs.writeFileSync(`${zip}.blockmap`, `blockmap:${arch}`);
  }
  writeBuilderMetadata(root, metadataName);
  return root;
}

/** Mirrors the workflow Checksums step: `shasum -a 256` over ./ paths. */
function writeChecksums(root: string): void {
  const names = fs.readdirSync(root).filter((name) => !name.endsWith('.sha256')).sort();
  fs.writeFileSync(
    path.join(root, 'checksums-macos.sha256'),
    `${names.map((name) => `${hash(path.join(root, name), 'sha256', 'hex')}  ./${name}`).join('\n')}\n`,
  );
}

function setMinimum(metadataPath: string, rawValue: string | null): void {
  const lines = fs.readFileSync(metadataPath, 'utf8').split('\n').filter((line) => !line.startsWith('minimumSystemVersion:'));
  if (rawValue !== null) lines.splice(lines.length - 1, 0, `minimumSystemVersion: ${rawValue}`);
  fs.writeFileSync(metadataPath, lines.join('\n'));
}

function updaterAllows(osRelease: string, updateInfo: unknown): boolean {
  const original = nodeOs.release;
  nodeOs.release = () => osRelease;
  try {
    return AppUpdater.prototype.checkIfUpdateSupported.call({ _logger: { info() {}, warn() {} } }, updateInfo);
  } finally {
    nodeOs.release = original;
  }
}

describe('macOS minimum system version in updater metadata', () => {
  it('stamps the Darwin version that electron-updater uses to block macOS 12', () => {
    fixture = makeMacRelease('13.0');
    const stamped = run(stampScript, [fixture, 'latest-mac.yml']);
    assert.equal(stamped.status, 0, stamped.stderr);

    const metadata = yaml.load(fs.readFileSync(path.join(fixture, 'latest-mac.yml'), 'utf8')) as Record<string, unknown>;
    assert.equal(metadata.minimumSystemVersion, '22.0.0');
    assert.equal(metadata.version, VERSION);

    // electron-updater's own check, fed os.release()-style kernel versions.
    assert.equal(updaterAllows('21.6.0', metadata), false, 'macOS 12 (Darwin 21) must not be offered the update');
    assert.equal(updaterAllows('22.0.0', metadata), true, 'macOS 13 (Darwin 22) must be offered the update');
    assert.equal(updaterAllows('25.0.0', metadata), true, 'macOS 26 (Darwin 25) must be offered the update');

    // The marketing version is not a usable value: semver throws and the updater allows it.
    assert.equal(updaterAllows('21.6.0', { ...metadata, minimumSystemVersion: '13.0' }), true);

    const again = run(stampScript, [fixture, 'latest-mac.yml']);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(
      fs.readFileSync(path.join(fixture, 'latest-mac.yml'), 'utf8').match(/^minimumSystemVersion:/gm)?.length,
      1,
    );
  });

  it('maps only the explicitly verified macOS versions', () => {
    for (const [macos, darwin] of [['13.0', '22.0.0'], ['14.0', '23.0.0'], ['15.0', '24.0.0'], ['26.0', '25.0.0']]) {
      fixture = makeMacRelease(macos, 'preview-mac.yml');
      const result = run(stampScript, [fixture, 'preview-mac.yml']);
      assert.equal(result.status, 0, result.stderr);
      const metadata = yaml.load(fs.readFileSync(path.join(fixture, 'preview-mac.yml'), 'utf8')) as Record<string, unknown>;
      assert.equal(metadata.minimumSystemVersion, darwin, `macOS ${macos}`);
      fs.rmSync(fixture, { recursive: true, force: true });
    }

    for (const unmapped of ['12.0', '13.3', '16.0', '27.0', '13']) {
      fixture = makeMacRelease(unmapped);
      const before = fs.readFileSync(path.join(fixture, 'latest-mac.yml'), 'utf8');
      const result = run(stampScript, [fixture, 'latest-mac.yml']);
      assert.notEqual(result.status, 0, `LSMinimumSystemVersion ${unmapped} must fail`);
      assert.match(result.stderr, /no verified Darwin mapping/);
      assert.equal(fs.readFileSync(path.join(fixture, 'latest-mac.yml'), 'utf8'), before);
      fs.rmSync(fixture, { recursive: true, force: true });
    }

    fixture = makeMacRelease(null);
    const missing = run(stampScript, [fixture, 'latest-mac.yml']);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /LSMinimumSystemVersion exactly once, found 0/);
  });

  it('refuses Windows metadata and a conflicting existing value', () => {
    fixture = makeMacRelease('13.0');
    fs.copyFileSync(path.join(fixture, 'latest-mac.yml'), path.join(fixture, 'latest.yml'));
    const windows = run(stampScript, [fixture, 'latest.yml']);
    assert.notEqual(windows.status, 0);
    assert.match(windows.stderr, /Usage/);

    setMinimum(path.join(fixture, 'latest-mac.yml'), '21.0.0');
    const conflicting = run(stampScript, [fixture, 'latest-mac.yml']);
    assert.notEqual(conflicting.status, 0);
    assert.match(conflicting.stderr, /already declares minimumSystemVersion "21\.0\.0", expected 22\.0\.0/);
  });

  it('audits the declared value against the Info.plist inside the shipped ZIP', () => {
    fixture = makeMacRelease('13.0');
    const metadataPath = path.join(fixture, 'latest-mac.yml');
    const audit = () => {
      writeChecksums(fixture);
      return run(assetVerifier, [fixture, VERSION, 'stable', 'macos']);
    };

    const unstamped = audit();
    assert.notEqual(unstamped.status, 0);
    assert.match(unstamped.stderr, /minimumSystemVersion must be a three-part Darwin version string, found undefined/);

    for (const [raw, message] of [
      ['13.0', /three-part Darwin version string, found 13/],
      ["'13.0'", /three-part Darwin version string, found "13\.0"/],
      ["'22.0'", /three-part Darwin version string, found "22\.0"/],
      ['22.0.0.1', /three-part Darwin version string/],
      ['21.0.0', /21\.0\.0 is below the app's LSMinimumSystemVersion 13\.0 \(Darwin 22\.0\.0\)/],
      ['23.0.0', /23\.0\.0 is above the app's LSMinimumSystemVersion 13\.0/],
    ] as const) {
      setMinimum(metadataPath, raw);
      const result = audit();
      assert.notEqual(result.status, 0, `minimumSystemVersion: ${raw} must be rejected`);
      assert.match(result.stderr, message);
    }

    setMinimum(metadataPath, null);
    assert.equal(run(stampScript, [fixture, 'latest-mac.yml']).status, 0);
    const valid = audit();
    assert.equal(valid.status, 0, valid.stderr);

    writeAppZip(path.join(fixture, UNIVERSAL_ZIP), infoPlist('14.0'));
    writeBuilderMetadata(fixture, 'latest-mac.yml');
    setMinimum(metadataPath, '22.0.0');
    const staleForNewerApp = audit();
    assert.notEqual(staleForNewerApp.status, 0);
    assert.match(staleForNewerApp.stderr, /below the app's LSMinimumSystemVersion 14\.0 \(Darwin 23\.0\.0\)/);
  });

  it('only accepts checksums computed after the metadata was stamped', () => {
    fixture = makeMacRelease('13.0');
    writeChecksums(fixture);
    assert.equal(run(stampScript, [fixture, 'latest-mac.yml']).status, 0);
    const stale = run(assetVerifier, [fixture, VERSION, 'stable', 'macos']);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /checksums-macos\.sha256 SHA-256 mismatch for latest-mac\.yml/);

    writeChecksums(fixture);
    const fresh = run(assetVerifier, [fixture, VERSION, 'stable', 'macos']);
    assert.equal(fresh.status, 0, fresh.stderr);
    const recorded = fs.readFileSync(path.join(fixture, 'checksums-macos.sha256'), 'utf8');
    assert.ok(recorded.includes(`${hash(path.join(fixture, 'latest-mac.yml'), 'sha256', 'hex')}  ./latest-mac.yml`));
  });

  it('stamps mac metadata after the universal package step and before checksums in every workflow', () => {
    for (const [relative, metadataName] of [
      ['.github/workflows/build.yml', 'latest-mac.yml'],
      ['.github/workflows/preview-build.yml', 'preview-mac.yml'],
      ['.github/workflows/preview-release.yml', 'preview-mac.yml'],
    ] as const) {
      const workflow = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
      const stampCommand = `node scripts/stamp-macos-minimum-system-version.mjs release ${metadataName}`;
      assert.equal(workflow.split(stampCommand).length, 2, `${relative} must stamp ${metadataName} exactly once`);
      const universal = workflow.indexOf('electron-builder --mac --universal');
      const stamp = workflow.indexOf(stampCommand);
      const checksums = workflow.indexOf('- name: Checksums', stamp);
      const macChecksumFind = workflow.indexOf(`-name '${metadataName}'`, stamp);
      assert.ok(universal > 0 && universal < stamp, `${relative}: stamp must follow the universal build`);
      assert.ok(checksums > stamp && macChecksumFind > checksums, `${relative}: mac Checksums must follow the stamp`);
      assert.equal(workflow.lastIndexOf('- name: Checksums', stamp), workflow.lastIndexOf('- name: Checksums', universal));
      assert.doesNotMatch(workflow, /stamp-macos-minimum-system-version\.mjs release (?:latest|preview)\.yml/);
    }

    const stable = fs.readFileSync(path.join(repoRoot, '.github/workflows/build.yml'), 'utf8');
    const audit = stable.slice(stable.indexOf('Audit immutable update graph and prepare checksums'));
    assert.ok(
      audit.indexOf('cat "$cs" >> artifacts/SHA256SUMS.txt') < audit.indexOf('verify-update-assets.mjs artifacts'),
      'SHA256SUMS.txt must be the concatenation of the audited platform checksum files',
    );
  });
});
