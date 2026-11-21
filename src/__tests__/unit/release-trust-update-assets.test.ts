import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = path.resolve(__dirname, '../../..');
const assetVerifier = path.join(repoRoot, 'scripts/verify-update-assets.mjs');
const rulesetVerifier = path.join(repoRoot, 'scripts/verify-github-update-rulesets.mjs');
const immutableAckVerifier = path.join(repoRoot, 'scripts/verify-immutable-release-ack.mjs');

function read(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), 'utf8');
}

function sha512(file: string): string {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

function writeFile(root: string, name: string, body = `fixture:${name}`): string {
  const target = path.join(root, name);
  fs.writeFileSync(target, body);
  return target;
}

function writeMetadata(root: string, name: string, version: string, assetName: string): void {
  const asset = path.join(root, assetName);
  const item: Record<string, string | number> = {
    url: assetName,
    sha512: sha512(asset),
    size: fs.statSync(asset).size,
  };
  if (/\.AppImage$/i.test(assetName)) {
    item.blockMapSize = 64;
  }
  fs.writeFileSync(path.join(root, name), JSON.stringify({ version, files: [item] }, null, 2));
}

function makeStableFixture(version: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-stable-assets-'));
  for (const arch of ['arm64', 'x64', 'universal']) {
    writeFile(root, `CodePilot-${version}-${arch}.dmg`);
    const zip = writeFile(root, `CodePilot-${version}-${arch}.zip`);
    writeFile(root, `${path.basename(zip)}.blockmap`);
  }
  const windows = writeFile(root, `CodePilot.Setup.${version}.exe`);
  writeFile(root, `${path.basename(windows)}.blockmap`);
  for (const name of [
    `CodePilot-${version}-x86_64.AppImage`,
    `CodePilot-${version}-arm64.AppImage`,
    `CodePilot-${version}-amd64.deb`,
    `CodePilot-${version}-arm64.deb`,
    `CodePilot-${version}-x86_64.rpm`,
    `CodePilot-${version}-aarch64.rpm`,
  ]) writeFile(root, name);

  writeMetadata(root, 'latest-mac.yml', version, `CodePilot-${version}-universal.zip`);
  writeMetadata(root, 'latest.yml', version, `CodePilot.Setup.${version}.exe`);
  writeMetadata(root, 'latest-linux.yml', version, `CodePilot-${version}-x86_64.AppImage`);
  writeMetadata(root, 'latest-linux-arm64.yml', version, `CodePilot-${version}-arm64.AppImage`);

  const checksumNames = fs.readdirSync(root).sort();
  fs.writeFileSync(
    path.join(root, 'checksums-fixture.sha256'),
    checksumNames.map((name) => `fixture  ${name}`).join('\n'),
  );
  return root;
}

function makeMacOnlyFixture(version: string, channel: 'stable' | 'preview'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codepilot-${channel}-mac-assets-`));
  for (const arch of ['arm64', 'x64', 'universal']) {
    writeFile(root, `CodePilot-${version}-${arch}.dmg`);
    const zip = writeFile(root, `CodePilot-${version}-${arch}.zip`);
    writeFile(root, `${path.basename(zip)}.blockmap`);
  }
  const metadataName = channel === 'stable' ? 'latest-mac.yml' : 'preview-mac.yml';
  writeMetadata(root, metadataName, version, `CodePilot-${version}-universal.zip`);
  fs.writeFileSync(
    path.join(root, `checksums-${channel}-macos.sha256`),
    fs.readdirSync(root).sort().map((name) => `fixture  ${name}`).join('\n'),
  );
  return root;
}

function makeDistributionFixture(version: string): string {
  const root = makeStableFixture(version);
  for (const name of [
    'latest-linux.yml',
    'latest-linux-arm64.yml',
    'checksums-fixture.sha256',
  ]) fs.unlinkSync(path.join(root, name));
  fs.writeFileSync(
    path.join(root, 'checksums-distribution.sha256'),
    fs.readdirSync(root).sort().map((name) => `fixture  ${name}`).join('\n'),
  );
  return root;
}

describe('release signing and update asset contracts', () => {
  it('pins signing, notarization, channel separation and immutable release assets in CI', () => {
    const builder = read('electron-builder.yml');
    const stable = read('.github/workflows/build.yml');
    const previewBuild = read('.github/workflows/preview-build.yml');
    const previewRelease = read('.github/workflows/preview-release.yml');
    const packageJson = JSON.parse(read('package.json'));
    const universalRuntimePrep = read('scripts/prepare-macos-universal-runtime.mjs');

    assert.match(builder, /mac:[\s\S]*?notarize:\s*true/);
    const x64ArchFiles = /x64ArchFiles:\s*"([^"]+)"/.exec(builder)?.[1];
    assert.ok(x64ArchFiles, 'mac universal build must declare an exact x64ArchFiles allow-list');
    for (const expected of [
      '@anthropic-ai/claude-agent-sdk/vendor/',
      'audio-capture/{arm64,x64}-darwin/audio-capture.node',
      'ripgrep/{arm64,x64}-darwin/rg',
      '@img/{sharp-darwin-arm64/lib/sharp-darwin-arm64.node',
      'sharp-darwin-x64/lib/sharp-darwin-x64.node',
      'sharp-libvips-darwin-arm64/lib/libvips-cpp.8.17.3.dylib',
      'sharp-libvips-darwin-x64/lib/libvips-cpp.8.17.3.dylib',
      'better-sqlite3/prebuilds/{darwin-arm64.node,darwin-x64.node}',
      'next/node_modules/@img/{sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.5.node',
      'sharp-darwin-x64/lib/sharp-darwin-x64-0.35.5.node',
      'sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.7.dylib',
      'sharp-libvips-darwin-x64/lib/libvips-cpp.8.18.7.dylib',
      'trash/lib/macos-trash',
      '.next/server/assets/macos-trash.*',
    ]) assert.ok(x64ArchFiles.includes(expected), `x64ArchFiles must include ${expected}`);
    assert.doesNotMatch(x64ArchFiles, /\*\*|linux|win32|zlib-sync/);
    assert.match(packageJson.scripts['electron:build'], /^node scripts\/prepare-macos-universal-runtime\.mjs &&/);
    for (const packageName of [
      '@img/sharp-darwin-arm64',
      '@img/sharp-darwin-x64',
      '@img/sharp-libvips-darwin-arm64',
      '@img/sharp-libvips-darwin-x64',
      'node_modules/next/node_modules/@img/sharp-darwin-x64',
      'node_modules/next/node_modules/@img/sharp-libvips-darwin-x64',
    ]) assert.ok(universalRuntimePrep.includes(packageName), `runtime prep must include ${packageName}`);
    assert.match(universalRuntimePrep, /createHash\('sha512'\)/);
    assert.doesNotMatch(universalRuntimePrep, /npm['"], \['install|--force/);
    const afterPack = read('scripts/after-pack.js');
    assert.match(afterPack, /better-sqlite3[\s\S]*zlib-sync/);
    assert.match(afterPack, /if \(arch === 4\)[\s\S]*preserving native slices[\s\S]*return;/);
    assert.match(builder, /dmg:[\s\S]*?sign:\s*true[\s\S]*?writeUpdateInfo:\s*false/);
    assert.match(builder, /win:[\s\S]*?forceCodeSigning:\s*true/);
    assert.match(builder, /verifyUpdateCodeSignature:\s*true/);
    assert.match(builder, /rfc3161TimeStampServer:/);
    assert.match(builder, /nsis:[\s\S]*?differentialPackage:\s*true/);
    assert.equal(packageJson.dependencies['electron-updater'], '6.8.11');
    assert.equal(packageJson.devDependencies['electron-builder'], '26.18.0');

    for (const workflow of [stable, previewBuild, previewRelease]) {
      assert.match(workflow, /APPLE_NOTARIZATION_KEY_BASE64/);
      assert.match(workflow, /verify-macos-notarization\.mjs/);
    }
    for (const workflow of [stable, previewBuild]) {
      assert.match(workflow, /WINDOWS_CERT_PFX_BASE64/);
      assert.match(workflow, /WINDOWS_PUBLISHER_SUBJECT/);
      assert.match(workflow, /verify-windows-signing\.ps1/);
      assert.doesNotMatch(workflow, /WIN_CSC_KEY_PASSWORD=.*GITHUB_ENV/);
      assert.match(workflow, /WIN_CSC_KEY_PASSWORD:\s*\$\{\{ secrets\.WINDOWS_CERT_PASSWORD \}\}/);
    }

    for (const expected of [
      'release/latest-mac.yml',
      'release/latest.yml',
      'release/CodePilot-*.blockmap',
      'release/CodePilot.Setup.*.exe',
      'release/CodePilot.Setup.*.exe.blockmap',
      'release/CodePilot-*.AppImage',
      'release/CodePilot-*.deb',
      'release/CodePilot-*.rpm',
    ]) assert.ok(stable.includes(expected), `stable artifact allow-list must contain ${expected}`);
    assert.doesNotMatch(stable, /release\/latest-linux\*\.yml/);
    assert.match(stable, /verify-update-assets\.mjs artifacts "\$VERSION" stable distribution/);
    assert.match(stable, /-name "\*\.blockmap"/);
    assert.match(stable, /-name "latest-mac\.yml"/);
    assert.match(stable, /-name "latest\.yml"/);
    assert.match(stable, /uses:\s*actions\/attest@[0-9a-f]{40}/);
    assert.match(stable, /permissions:\s*\n\s*contents:\s*read/);
    assert.match(stable, /runs-on:\s*macos-15-intel/);
    assert.match(stable, /CodePilot-\*-universal\.zip/);

    const stableRelease = stable.slice(stable.indexOf('\n  release:\n'));
    assert.match(stableRelease, /permissions:[\s\S]*?contents:\s*write[\s\S]*?id-token:\s*write[\s\S]*?attestations:\s*write[\s\S]*?artifact-metadata:\s*write/);
    assert.match(stableRelease, /needs:\s*\[build-macos, verify-macos-intel-abi, build-windows, build-linux\]/);
    assert.match(stableRelease, /CodePilot\.Setup\.\*\.exe/);
    for (const extension of ['AppImage', 'deb', 'rpm']) assert.match(stableRelease, new RegExp(`-name "\\*\\.${extension}"`));
    assert.doesNotMatch(stableRelease, /latest-linux/);
    assert.match(stableRelease, /latest\.yml/);
    assert.match(stableRelease, /CodePilot\.Setup\.\*\.exe\.blockmap|"\*\.blockmap"/);
    assert.match(stable, /build-windows:[\s\S]*?if:\s*\$\{\{ github\.event_name == 'push'/);
    assert.match(stable, /build-linux:[\s\S]*?if:\s*\$\{\{ github\.event_name == 'push'/);
    assert.match(stable, /build-windows:[\s\S]*?CODEPILOT_OFFICIAL_UPDATE_BUILD:\s*"1"/);
    assert.match(stable, /build-linux:[\s\S]*?CODEPILOT_OFFICIAL_UPDATE_BUILD:\s*"0"/);
    assert.match(stable, /mode=unsigned[\s\S]*?--config\.win\.forceCodeSigning=false[\s\S]*?--config\.win\.verifyUpdateCodeSignature=false/);
    assert.match(stable, /partially configured/);
    assert.match(stable, /Get-AuthenticodeSignature[\s\S]*?NotSigned/);
    assert.match(stable, /app-update\.yml[\s\S]*?publisherName/);
    assert.match(stable, /Signed Windows app-update\.yml must expose publisherName/);
    assert.match(stable, /CODEPILOT_IMMUTABLE_RELEASES_CONFIRMED_AT/);
    assert.match(stable, /CODEPILOT_RULESETS_CONFIRMED_STATE/);
    assert.match(stable, /gh api --paginate --slurp/);
    assert.match(stable, /expected exactly one active main branch ruleset/);
    assert.match(stable, /expected exactly one active stable-release-tags ruleset/);
    assert.match(stable, /verify-immutable-release-ack\.mjs/);
    assert.match(stable, /verify-github-update-rulesets\.mjs/);
    assert.match(previewBuild, /build-windows-x64:[\s\S]*?CODEPILOT_OFFICIAL_UPDATE_BUILD:\s*"0"/);

    for (const preview of [previewBuild, previewRelease]) {
      assert.match(preview, /-c\.publish\.channel=preview/);
      assert.match(preview, /release\/preview-mac\.yml/);
      assert.doesNotMatch(preview, /release\/latest(?:-mac)?\.yml/);
      assert.match(preview, /--mac --arm64 --x64/);
      assert.match(preview, /--mac --universal/);
      assert.match(preview, /release\/CodePilot-\*\.dmg/);
      assert.match(preview, /release\/CodePilot-\*\.zip/);
    }
    assert.match(previewBuild, /release\/preview\.yml/);
    assert.doesNotMatch(previewRelease, /WINDOWS_CERT|WINDOWS_PUBLISHER|CodePilot\.Setup|release\/preview\.yml|artifacts\/\*\.exe/);
    assert.match(previewRelease, /verify-update-assets\.mjs artifacts "\$VERSION" preview macos/);
    assert.match(previewRelease, /needs:\s*\[verify-source, build-macos-arm64\]/);
    assert.match(previewRelease, /tags:\s*\n\s*- "\*-preview\.\*"/);
    assert.match(previewRelease, /VERSION="\$GITHUB_REF_NAME"/);
    assert.doesNotMatch(previewRelease, /GITHUB_REF_NAME#preview-/);
    assert.match(previewRelease, /permissions:\s*\n\s*contents:\s*read/);
    const previewPublish = previewRelease.slice(previewRelease.indexOf('\n  create-prerelease:\n'));
    assert.match(previewPublish, /permissions:[\s\S]*?contents:\s*write[\s\S]*?id-token:\s*write[\s\S]*?attestations:\s*write[\s\S]*?artifact-metadata:\s*write/);
    for (const publishJob of [stableRelease, previewPublish]) {
      assert.match(publishJob, /gh release create[\s\S]*?--draft/);
      assert.match(publishJob, /gh release upload[\s\S]*?--clobber/);
      assert.match(publishJob, /gh release edit[\s\S]*?--draft=false/);
    }
    assert.doesNotMatch(previewPublish, /softprops\/action-gh-release/);

    const windowsVerifier = read('scripts/verify-windows-signing.ps1');
    assert.match(windowsVerifier, /CodePilot\.Setup\.\*\.exe/);
    assert.match(windowsVerifier, /win-unpacked'\) 'CodePilot\.exe'/);
    assert.doesNotMatch(windowsVerifier, /-Recurse/);
    assert.doesNotMatch(windowsVerifier, /-Filter '\*\.exe'/);
  });

  it('pins every GitHub Action to a full commit SHA', () => {
    const workflowRoot = path.join(repoRoot, '.github/workflows');
    const workflows = fs.readdirSync(workflowRoot).filter((name) => /\.ya?ml$/i.test(name));
    assert.ok(workflows.length > 0);
    for (const workflow of workflows) {
      const source = fs.readFileSync(path.join(workflowRoot, workflow), 'utf8');
      for (const match of source.matchAll(/uses:\s*([^\s@]+)@([^\s#]+)/g)) {
        const [, action, ref] = match;
        if (action.startsWith('./')) continue;
        assert.match(ref, /^[0-9a-f]{40}$/, `${workflow}: ${action} must use a full commit SHA`);
      }
    }
  });

  it('requires active no-bypass default-branch and stable-tag rulesets', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-update-rulesets-'));
    const branchBase = {
      id: 101,
      updated_at: '2026-08-26T16:14:47.620Z',
      enforcement: 'active',
      bypass_actors: [],
      rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
    };
    const mainPath = path.join(fixture, 'main.json');
    const tagPath = path.join(fixture, 'tag.json');
    try {
      fs.writeFileSync(mainPath, JSON.stringify({
        ...branchBase,
        target: 'branch',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      }));
      fs.writeFileSync(tagPath, JSON.stringify({
        ...branchBase,
        id: 202,
        updated_at: '2026-08-26T16:14:59.152Z',
        target: 'tag',
        rules: [{ type: 'deletion' }, { type: 'update' }],
        conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
      }));
      const valid = spawnSync(process.execPath, [rulesetVerifier, mainPath, tagPath], { encoding: 'utf8' });
      assert.equal(valid.status, 0, valid.stderr);

      const emitted = spawnSync(
        process.execPath,
        [rulesetVerifier, mainPath, tagPath, '--emit-confirmed-state'],
        { encoding: 'utf8' },
      );
      assert.equal(emitted.status, 0, emitted.stderr);
      const confirmedState = emitted.stdout.trim();
      assert.deepEqual(JSON.parse(confirmedState), {
        version: 1,
        noBypass: true,
        main: { id: 101, updatedAt: '2026-08-26T16:14:47.620Z' },
        stableTags: { id: 202, updatedAt: '2026-08-26T16:14:59.152Z' },
      });

      const hiddenMain = JSON.parse(fs.readFileSync(mainPath, 'utf8'));
      const hiddenTag = JSON.parse(fs.readFileSync(tagPath, 'utf8'));
      delete hiddenMain.bypass_actors;
      delete hiddenTag.bypass_actors;
      fs.writeFileSync(mainPath, JSON.stringify(hiddenMain));
      fs.writeFileSync(tagPath, JSON.stringify(hiddenTag));
      const hiddenWithoutConfirmation = spawnSync(
        process.execPath,
        [rulesetVerifier, mainPath, tagPath],
        { encoding: 'utf8' },
      );
      assert.notEqual(hiddenWithoutConfirmation.status, 0);
      assert.match(hiddenWithoutConfirmation.stderr, /CODEPILOT_RULESETS_CONFIRMED_STATE is required/);

      const hiddenConfirmed = spawnSync(
        process.execPath,
        [rulesetVerifier, mainPath, tagPath, confirmedState],
        { encoding: 'utf8' },
      );
      assert.equal(hiddenConfirmed.status, 0, hiddenConfirmed.stderr);

      hiddenTag.updated_at = '2026-08-26T16:15:00.000Z';
      fs.writeFileSync(tagPath, JSON.stringify(hiddenTag));
      const drifted = spawnSync(
        process.execPath,
        [rulesetVerifier, mainPath, tagPath, confirmedState],
        { encoding: 'utf8' },
      );
      assert.notEqual(drifted.status, 0);
      assert.match(drifted.stderr, /administrator reconfirmation is required/);

      fs.writeFileSync(mainPath, JSON.stringify({ ...hiddenMain, bypass_actors: [] }));
      fs.writeFileSync(tagPath, JSON.stringify({
        ...hiddenTag,
        updated_at: '2026-08-26T16:14:59.152Z',
        bypass_actors: [],
      }));

      const invalidTag = JSON.parse(fs.readFileSync(tagPath, 'utf8'));
      invalidTag.enforcement = 'disabled';
      fs.writeFileSync(tagPath, JSON.stringify(invalidTag));
      const invalid = spawnSync(process.execPath, [rulesetVerifier, mainPath, tagPath], { encoding: 'utf8' });
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /must be active/);

      invalidTag.enforcement = 'active';
      invalidTag.conditions.ref_name.exclude = ['refs/tags/v0.*'];
      fs.writeFileSync(tagPath, JSON.stringify(invalidTag));
      const excluded = spawnSync(process.execPath, [rulesetVerifier, mainPath, tagPath], { encoding: 'utf8' });
      assert.notEqual(excluded.status, 0);
      assert.match(excluded.stderr, /must not exclude protected refs/);

      invalidTag.conditions.ref_name.exclude = [];
      invalidTag.bypass_actors = [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }];
      fs.writeFileSync(tagPath, JSON.stringify(invalidTag));
      const bypassed = spawnSync(process.execPath, [rulesetVerifier, mainPath, tagPath], { encoding: 'utf8' });
      assert.notEqual(bypassed.status, 0);
      assert.match(bypassed.stderr, /must not define bypass actors/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('requires a release-day Immutable Releases administrator acknowledgement', () => {
    const current = spawnSync(
      process.execPath,
      [immutableAckVerifier, '2026-08-26', '2026-08-27T23:59:59Z'],
      { encoding: 'utf8' },
    );
    assert.equal(current.status, 0, current.stderr);

    const stale = spawnSync(
      process.execPath,
      [immutableAckVerifier, '2026-08-25', '2026-08-27T00:00:00Z'],
      { encoding: 'utf8' },
    );
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /is stale/);

    const future = spawnSync(
      process.execPath,
      [immutableAckVerifier, '2026-08-28', '2026-08-27T00:00:00Z'],
      { encoding: 'utf8' },
    );
    assert.notEqual(future.status, 0);
    assert.match(future.stderr, /in the future/);
  });

  it('accepts a macOS-only stable graph and rejects non-macOS update assets', () => {
    const version = '1.2.5';
    const fixture = makeMacOnlyFixture(version, 'stable');
    try {
      const valid = spawnSync(
        process.execPath,
        [assetVerifier, fixture, version, 'stable', 'macos'],
        { encoding: 'utf8' },
      );
      assert.equal(valid.status, 0, valid.stderr);
      assert.match(valid.stdout, /channel=stable target=macos/);

      writeFile(fixture, `CodePilot.Setup.${version}.exe`);
      const mixed = spawnSync(
        process.execPath,
        [assetVerifier, fixture, version, 'stable', 'macos'],
        { encoding: 'utf8' },
      );
      assert.notEqual(mixed.status, 0);
      assert.match(mixed.stderr, /macOS-only release contains non-macOS update assets/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('accepts Mac and Windows updater assets with manual Linux packages and rejects Linux metadata', () => {
    const version = '1.2.6';
    const fixture = makeDistributionFixture(version);
    try {
      const valid = spawnSync(
        process.execPath,
        [assetVerifier, fixture, version, 'stable', 'distribution'],
        { encoding: 'utf8' },
      );
      assert.equal(valid.status, 0, valid.stderr);
      assert.match(valid.stdout, /channel=stable target=distribution/);

      const windowsMetadataPath = path.join(fixture, 'latest.yml');
      const windowsMetadata = JSON.parse(fs.readFileSync(windowsMetadataPath, 'utf8'));
      assert.equal(windowsMetadata.files[0].blockMapSize, undefined);

      const windowsBlockmapPath = path.join(fixture, `CodePilot.Setup.${version}.exe.blockmap`);
      fs.unlinkSync(windowsBlockmapPath);
      const missingExternalBlockmap = spawnSync(
        process.execPath,
        [assetVerifier, fixture, version, 'stable', 'distribution'],
        { encoding: 'utf8' },
      );
      assert.notEqual(missingExternalBlockmap.status, 0);
      assert.match(missingExternalBlockmap.stderr, /blockmap/i);
      writeFile(fixture, path.basename(windowsBlockmapPath));

      const oldVersion = '0.60.0';
      const oldInstallerName = `CodePilot.Setup.${oldVersion}.exe`;
      const oldInstaller = writeFile(fixture, oldInstallerName);
      writeFile(fixture, `${oldInstallerName}.blockmap`);
      writeMetadata(fixture, 'latest.yml', version, oldInstallerName);
      const wrongVersionPayload = spawnSync(
        process.execPath,
        [assetVerifier, fixture, version, 'stable', 'distribution'],
        { encoding: 'utf8' },
      );
      assert.notEqual(wrongVersionPayload.status, 0);
      assert.match(wrongVersionPayload.stderr, /unexpected or wrong-version payloads/);
      fs.unlinkSync(oldInstaller);
      fs.unlinkSync(path.join(fixture, `${oldInstallerName}.blockmap`));
      writeMetadata(fixture, 'latest.yml', version, `CodePilot.Setup.${version}.exe`);

      const externalUrlMetadata = JSON.parse(fs.readFileSync(windowsMetadataPath, 'utf8'));
      externalUrlMetadata.files[0].url = `https://mirror.example/CodePilot.Setup.${version}.exe`;
      fs.writeFileSync(windowsMetadataPath, JSON.stringify(externalUrlMetadata));
      const externalUrl = spawnSync(
        process.execPath,
        [assetVerifier, fixture, version, 'stable', 'distribution'],
        { encoding: 'utf8' },
      );
      assert.notEqual(externalUrl.status, 0);
      assert.match(externalUrl.stderr, /release-asset basename/);
      writeMetadata(fixture, 'latest.yml', version, `CodePilot.Setup.${version}.exe`);

      const checksumPath = path.join(fixture, 'checksums-distribution.sha256');
      const completeChecksums = fs.readFileSync(checksumPath, 'utf8');
      fs.writeFileSync(
        checksumPath,
        completeChecksums
          .split('\n')
          .filter((line) => !line.endsWith(`  CodePilot.Setup.${version}.exe`))
          .join('\n'),
      );
      const missingInstallerChecksum = spawnSync(
        process.execPath,
        [assetVerifier, fixture, version, 'stable', 'distribution'],
        { encoding: 'utf8' },
      );
      assert.notEqual(missingInstallerChecksum.status, 0);
      assert.match(missingInstallerChecksum.stderr, /installer|\.exe missing from platform checksums/i);
      fs.writeFileSync(checksumPath, completeChecksums);

      writeMetadata(fixture, 'latest-linux.yml', version, `CodePilot-${version}-x86_64.AppImage`);
      const leakedLinuxFeed = spawnSync(
        process.execPath,
        [assetVerifier, fixture, version, 'stable', 'distribution'],
        { encoding: 'utf8' },
      );
      assert.notEqual(leakedLinuxFeed.status, 0);
      assert.match(leakedLinuxFeed.stderr, /Linux or preview updater metadata/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('accepts a complete stable graph and rejects missing blockmaps or a metadata hash mismatch', () => {
    const version = '1.2.3';
    const fixture = makeStableFixture(version);
    try {
      const valid = spawnSync(process.execPath, [assetVerifier, fixture, version], { encoding: 'utf8' });
      assert.equal(valid.status, 0, valid.stderr);
      assert.match(valid.stdout, /channel=stable/);

      const zipBlockmap = path.join(fixture, `CodePilot-${version}-universal.zip.blockmap`);
      fs.unlinkSync(zipBlockmap);
      const missing = spawnSync(process.execPath, [assetVerifier, fixture, version], { encoding: 'utf8' });
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /blockmap/i);
      writeFile(fixture, path.basename(zipBlockmap));

      const metadataPath = path.join(fixture, 'latest-mac.yml');
      const metadataWithDmg = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      const dmgName = `CodePilot-${version}-universal.dmg`;
      metadataWithDmg.files.push({
        url: dmgName,
        sha512: sha512(path.join(fixture, dmgName)),
        size: fs.statSync(path.join(fixture, dmgName)).size,
      });
      fs.writeFileSync(metadataPath, JSON.stringify(metadataWithDmg));
      const staleDmgGraph = spawnSync(process.execPath, [assetVerifier, fixture, version], { encoding: 'utf8' });
      assert.notEqual(staleDmgGraph.status, 0);
      assert.match(staleDmgGraph.stderr, /ZIP entries only/);

      const metadata = metadataWithDmg;
      metadata.files = metadata.files.filter((item: { url: string }) => item.url !== dmgName);
      metadata.files[0].sha512 = 'wrong';
      fs.writeFileSync(metadataPath, JSON.stringify(metadata));
      const invalid = spawnSync(process.execPath, [assetVerifier, fixture, version], { encoding: 'utf8' });
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /sha512 mismatch/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('requires preview to carry Intel bootstrap assets and one universal updater feed', () => {
    const version = '1.2.4-preview.1';
    const fixture = makeMacOnlyFixture(version, 'preview');
    try {
      const valid = spawnSync(
        process.execPath,
        [assetVerifier, fixture, version, 'preview', 'macos'],
        { encoding: 'utf8' },
      );
      assert.equal(valid.status, 0, valid.stderr);
      assert.match(valid.stdout, /channel=preview target=macos/);

      fs.unlinkSync(path.join(fixture, `CodePilot-${version}-x64.dmg`));
      const missingIntel = spawnSync(
        process.execPath,
        [assetVerifier, fixture, version, 'preview', 'macos'],
        { encoding: 'utf8' },
      );
      assert.notEqual(missingIntel.status, 0);
      assert.match(missingIntel.stderr, /preview macOS DMG assets/);

      writeFile(fixture, `CodePilot-${version}-x64.dmg`);
      writeFile(fixture, `CodePilot-${version}-x86_64.AppImage`);
      const mixedLinux = spawnSync(
        process.execPath,
        [assetVerifier, fixture, version, 'preview', 'macos'],
        { encoding: 'utf8' },
      );
      assert.notEqual(mixedLinux.status, 0);
      assert.match(mixedLinux.stderr, /macOS-only release contains non-macOS update assets/);

      fs.unlinkSync(path.join(fixture, `CodePilot-${version}-x86_64.AppImage`));
      const metadataPath = path.join(fixture, 'preview-mac.yml');
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      const armZip = `CodePilot-${version}-arm64.zip`;
      metadata.files.push({
        url: armZip,
        sha512: sha512(path.join(fixture, armZip)),
        size: fs.statSync(path.join(fixture, armZip)).size,
        blockMapSize: fs.statSync(path.join(fixture, `${armZip}.blockmap`)).size,
      });
      fs.writeFileSync(metadataPath, JSON.stringify(metadata));
      const duplicateFeedEntry = spawnSync(
        process.execPath,
        [assetVerifier, fixture, version, 'preview', 'macos'],
        { encoding: 'utf8' },
      );
      assert.notEqual(duplicateFeedEntry.status, 0);
      assert.match(duplicateFeedEntry.stderr, /exactly the current-version universal ZIP/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
