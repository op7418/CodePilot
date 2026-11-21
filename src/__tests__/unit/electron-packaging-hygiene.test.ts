import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { describe, it } from 'node:test';
import { createPackage } from '@electron/asar';

const repoRoot = path.resolve(__dirname, '../../..');
const hygieneScript = path.join(repoRoot, 'scripts/clean-electron-build.mjs');

function makeFixture(): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-electron-hygiene-'));
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'codepilot' }));
  return fixture;
}

describe('Electron packaging hygiene', () => {
  it('cleans only generated Electron build roots', () => {
    const fixture = makeFixture();
    try {
      for (const dir of ['release', '.next', 'dist-electron']) {
        fs.mkdirSync(path.join(fixture, dir), { recursive: true });
        fs.writeFileSync(path.join(fixture, dir, 'stale.txt'), 'stale');
      }
      fs.writeFileSync(path.join(fixture, 'keep.txt'), 'keep');

      const result = spawnSync(process.execPath, [hygieneScript], {
        cwd: fixture,
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(path.join(fixture, 'release')), false);
      assert.equal(fs.existsSync(path.join(fixture, '.next')), false);
      assert.equal(fs.existsSync(path.join(fixture, 'dist-electron')), false);
      assert.equal(fs.readFileSync(path.join(fixture, 'keep.txt'), 'utf8'), 'keep');
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('refuses cleanup before touching a live Next dev output tree', () => {
    const fixture = makeFixture();
    try {
      fs.mkdirSync(path.join(fixture, '.next/dev'), { recursive: true });
      fs.writeFileSync(path.join(fixture, '.next/dev/lock'), 'locked');
      fs.mkdirSync(path.join(fixture, 'release'), { recursive: true });
      fs.writeFileSync(path.join(fixture, 'release/keep.txt'), 'keep');

      const result = spawnSync(process.execPath, [hygieneScript], {
        cwd: fixture,
        encoding: 'utf8',
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Refusing to build[\s\S]*next\/dev\/lock/);
      assert.equal(
        fs.readFileSync(path.join(fixture, 'release/keep.txt'), 'utf8'),
        'keep',
        'the guard must run before any build artifact is removed',
      );
      assert.equal(
        fs.existsSync(path.join(fixture, '.next/dev/lock')),
        true,
      );
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('fails closed when standalone contains local worktree state', () => {
    const fixture = makeFixture();
    try {
      fs.mkdirSync(path.join(fixture, '.next/standalone/.claude/worktrees'), { recursive: true });

      const result = spawnSync(process.execPath, [hygieneScript, '--assert-standalone'], {
        cwd: fixture,
        encoding: 'utf8',
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /forbidden roots: \.claude/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('fails closed when a required Next runtime root is missing', () => {
    const fixture = makeFixture();
    try {
      const standalone = path.join(fixture, '.next/standalone');
      fs.mkdirSync(path.join(standalone, '.next'), { recursive: true });
      fs.mkdirSync(path.join(standalone, 'node_modules'), { recursive: true });
      for (const name of ['server.js', 'package.json']) {
        fs.writeFileSync(path.join(standalone, name), name);
      }

      const result = spawnSync(process.execPath, [hygieneScript, '--assert-standalone'], {
        cwd: fixture,
        encoding: 'utf8',
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /missing required roots: cache-handler\.js/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('sanitizes standalone to the minimal Next runtime allowlist', () => {
    const fixture = makeFixture();
    try {
      const standalone = path.join(fixture, '.next/standalone');
      for (const name of ['.next', 'node_modules', 'data', '.codepilot', 'docs']) {
        fs.mkdirSync(path.join(standalone, name), { recursive: true });
        fs.writeFileSync(path.join(standalone, name, 'probe.txt'), name);
      }
      for (const name of ['server.js', 'package.json', 'cache-handler.js', '.mcp.json']) {
        fs.writeFileSync(path.join(standalone, name), name);
      }

      const result = spawnSync(process.execPath, [hygieneScript, '--sanitize-standalone'], {
        cwd: fixture,
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        fs.readdirSync(standalone).sort(),
        ['.next', 'cache-handler.js', 'node_modules', 'package.json', 'server.js'],
      );
      assert.match(result.stdout, /Removed traced standalone roots: .*\.codepilot/);
      assert.equal(fs.existsSync(path.join(standalone, 'data')), false);
      assert.equal(fs.existsSync(path.join(standalone, '.mcp.json')), false);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('release build prepares universal runtime, then cleans before Next and excludes private agent roots', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const nextConfig = fs.readFileSync(path.join(repoRoot, 'next.config.ts'), 'utf8');
    const claudeHomeShadow = fs.readFileSync(
      path.join(repoRoot, 'src/lib/claude-home-shadow.ts'),
      'utf8',
    );
    const externalFrameworkHarness = fs.readFileSync(
      path.join(repoRoot, 'src/lib/harness/external-framework-harness.ts'),
      'utf8',
    );

    assert.match(
      packageJson.scripts['electron:build'],
      /^node scripts\/prepare-macos-universal-runtime\.mjs && node scripts\/clean-electron-build\.mjs && next build && node scripts\/build-electron\.mjs$/,
    );
    assert.equal(
      packageJson.scripts.prebuild,
      'node scripts/assert-next-build-safe.mjs',
    );
    assert.match(
      fs.readFileSync(hygieneScript, 'utf8'),
      /assertNoActiveNextDev\(root\)[\s\S]*for \(const relativeDir/,
    );
    assert.match(
      fs.readFileSync(path.join(repoRoot, 'scripts/build-electron.mjs'), 'utf8'),
      /sanitizeStandaloneOutput\(process\.cwd\(\)\)/,
    );
    for (const pattern of ['.agents/**', '.claude/**', '.codex/**', '.git/**']) {
      assert.match(nextConfig, new RegExp(`['"]${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`));
    }
    assert.match(
      claudeHomeShadow,
      /path\.join\(\/\* turbopackIgnore: true \*\/ REAL_HOME\(\), '\.claude'\)/,
    );
    assert.match(
      externalFrameworkHarness,
      /path\.join\(\/\* turbopackIgnore: true \*\/ home, '\.claude'\)/,
    );
  });

  it('keeps Electron extraResources destinations disjoint for Windows packaging', () => {
    const builderConfig = fs.readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8');
    const rootRuntimeFileSet = builderConfig.match(
      /- from: \.next\/standalone\/[\s\S]*?(?=\n  - from: \.next\/standalone\/node_modules\/)/,
    )?.[0];

    assert.ok(rootRuntimeFileSet, 'standalone root FileSet must exist before node_modules FileSet');
    assert.match(rootRuntimeFileSet, /- "server\.js"/);
    assert.match(rootRuntimeFileSet, /- "package\.json"/);
    assert.match(rootRuntimeFileSet, /- "cache-handler\.js"/);
    assert.doesNotMatch(rootRuntimeFileSet, /- "\*\*\/\*"/);
    assert.doesNotMatch(rootRuntimeFileSet, /!node_modules/);
    assert.doesNotMatch(rootRuntimeFileSet, /!release/);
    assert.match(builderConfig, /- from: \.next\/standalone\/node_modules\//);
    assert.match(builderConfig, /!dist-electron\/\*\*\/\*\.map/);
    assert.ok(
      (builderConfig.match(/!\*\*\/\*\.map/g) ?? []).length >= 3,
      'no JavaScript source map may be copied into a packaged app',
    );

    const nextRuntimeFileSet = builderConfig.match(
      /- from: \.next\/standalone\/\.next\/[\s\S]*?(?=\n  - from: \.next\/standalone\/\.next\/node_modules\/)/,
    )?.[0];
    assert.ok(nextRuntimeFileSet, '.next FileSet must exist before its node_modules FileSet');
    assert.match(nextRuntimeFileSet, /- "\*\*\/\*"/);
    assert.match(nextRuntimeFileSet, /- "!node_modules\{,\/\*\*\/\*\}"/);
    assert.match(
      builderConfig,
      /- from: \.next\/standalone\/\.next\/node_modules\/[\s\S]*?to: standalone\/\.next\/node_modules\/[\s\S]*?filter: \["\*\*\/\*"\]/,
    );
    assert.match(
      builderConfig,
      /- from: resources\/macos-keychain-guard\/[\s\S]*?to: macos-keychain-guard\/[\s\S]*?filter: \["security"\]/,
      'the noninteractive macOS keychain guard must be present in packaged resources',
    );
  });

  it('boots the packaged standalone server in release CI instead of checking ABI only', () => {
    const releaseWorkflow = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/build.yml'),
      'utf8',
    );
    const packagedSmoke = fs.readFileSync(
      path.join(repoRoot, 'scripts/verify-packaged-server.mjs'),
      'utf8',
    );
    const mainHealthSmoke = fs.readFileSync(
      path.join(repoRoot, 'scripts/verify-electron-main-health.mjs'),
      'utf8',
    );

    assert.match(releaseWorkflow, /node scripts\/verify-packaged-server\.mjs/);
    assert.match(packagedSmoke, /\/api\/health/);
    assert.match(packagedSmoke, /ELECTRON_RUN_AS_NODE/);
    assert.match(packagedSmoke, /listPackage/);
    assert.match(packagedSmoke, /Packaged source maps are forbidden/);
    assert.match(releaseWorkflow, /node scripts\/verify-electron-main-health\.mjs/);
    assert.match(mainHealthSmoke, /electron\.launch/);
    assert.match(mainHealthSmoke, /\/api\/health/);
    assert.match(mainHealthSmoke, /codepilot-server/);
    assert.match(mainHealthSmoke, /database, 'healthy'/);
    assert.doesNotMatch(mainHealthSmoke, /ELECTRON_RUN_AS_NODE/);
  });

  it('publishes Linux x64/arm64 manual installers without Linux updater metadata', () => {
    const releaseWorkflow = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/build.yml'),
      'utf8',
    );
    const builderConfig = fs.readFileSync(
      path.join(repoRoot, 'electron-builder.yml'),
      'utf8',
    );
    const linuxJob = releaseWorkflow.match(
      /  build-linux:\n[\s\S]*?(?=\n  release:)/,
    )?.[0];
    const releaseJob = releaseWorkflow.slice(releaseWorkflow.indexOf('\n  release:\n'));

    assert.ok(linuxJob, 'stable workflow must define a Linux build job');
    assert.match(releaseWorkflow, /options:[\s\S]*?- linux/);
    assert.match(linuxJob, /fail-fast:\s*false/);
    assert.match(linuxJob, /arch:\s*x64[\s\S]*?runner:\s*ubuntu-22\.04/);
    assert.match(linuxJob, /arch:\s*arm64[\s\S]*?runner:\s*ubuntu-22\.04-arm/);
    assert.match(
      linuxJob,
      /electron-builder --linux --\$\{\{ matrix\.arch \}\}/,
    );
    assert.match(linuxJob, /apt-get install -y rpm clang-15/);
    assert.match(
      linuxJob,
      /Package Linux[\s\S]*?CC:\s*clang-15\s*\n\s*CXX:\s*clang\+\+-15[\s\S]*?electron-builder --linux/,
      'Jammy GCC cannot compile Electron 45 V8 headers; native rebuilds must use clang 15',
    );
    assert.match(linuxJob, /Upload Linux source maps to Sentry/);
    assert.match(linuxJob, /github\.event_name == 'push'/);
    assert.match(linuxJob, /CODEPILOT_OFFICIAL_UPDATE_BUILD:\s*"0"/);
    assert.match(linuxJob, /better-sqlite3 OK/);
    assert.match(linuxJob, /node scripts\/verify-packaged-server\.mjs/);
    assert.match(linuxJob, /xvfb-run -a node scripts\/verify-electron-main-health\.mjs/);
    for (const extension of ['AppImage', 'deb', 'rpm']) {
      assert.match(linuxJob, new RegExp(`release/CodePilot-\\*\\.${extension}`));
      assert.match(
        releaseJob,
        new RegExp(`-name "\\\*\\.${extension}"`),
      );
    }
    assert.match(
      releaseJob,
      /needs:\s*\[build-macos, verify-macos-intel-abi, build-windows, build-linux\]/,
    );
    assert.doesNotMatch(releaseJob, /latest-linux/);
    assert.doesNotMatch(linuxJob, /release\/latest-linux\*\.yml/);
    assert.match(builderConfig, /linux:[\s\S]*?target:[\s\S]*?- AppImage[\s\S]*?- deb[\s\S]*?- rpm/);
  });

  it('scans the real Resources tree and app.asar for source maps', async () => {
    const fixture = makeFixture();
    const resources = path.join(fixture, 'Resources');
    const appSource = path.join(fixture, 'app-source');
    const packagedSmoke = path.join(repoRoot, 'scripts/verify-packaged-server.mjs');
    try {
      fs.mkdirSync(resources, { recursive: true });
      fs.mkdirSync(appSource, { recursive: true });
      fs.writeFileSync(path.join(appSource, 'main.js'), 'console.log("ok")');
      await finished(await createPackage(appSource, path.join(resources, 'app.asar')));

      const clean = spawnSync(process.execPath, [packagedSmoke, '--source-maps-only', resources], {
        encoding: 'utf8',
      });
      assert.equal(clean.status, 0, clean.stderr);
      assert.match(clean.stdout, /Resources \+ app\.asar: 0 maps/);

      fs.writeFileSync(path.join(appSource, 'hidden.js.map'), '{}');
      fs.rmSync(path.join(resources, 'app.asar'));
      await finished(await createPackage(appSource, path.join(resources, 'app.asar')));
      const asarLeak = spawnSync(process.execPath, [packagedSmoke, '--source-maps-only', resources], {
        encoding: 'utf8',
      });
      assert.notEqual(asarLeak.status, 0);
      assert.match(asarLeak.stderr, /app\.asar:.*hidden\.js\.map/);

      fs.rmSync(path.join(appSource, 'hidden.js.map'));
      fs.rmSync(path.join(resources, 'app.asar'));
      await finished(await createPackage(appSource, path.join(resources, 'app.asar')));
      fs.mkdirSync(path.join(resources, 'standalone'), { recursive: true });
      fs.writeFileSync(path.join(resources, 'standalone', 'server.js.map'), '{}');
      const looseLeak = spawnSync(process.execPath, [packagedSmoke, '--source-maps-only', resources], {
        encoding: 'utf8',
      });
      assert.notEqual(looseLeak.status, 0);
      assert.match(looseLeak.stderr, /standalone.*server\.js\.map/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
