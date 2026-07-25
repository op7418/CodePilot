import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

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

  it('release build runs cleanup before Next and excludes private agent roots', () => {
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
      /^node scripts\/clean-electron-build\.mjs && next build && node scripts\/build-electron\.mjs$/,
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

    assert.match(releaseWorkflow, /node scripts\/verify-packaged-server\.mjs/);
    assert.match(packagedSmoke, /\/api\/health/);
    assert.match(packagedSmoke, /ELECTRON_RUN_AS_NODE/);
  });
});
