#!/usr/bin/env node

/**
 * Ensure a macOS build tree contains both Sharp Darwin runtimes before
 * `next build` traces standalone dependencies. npm intentionally installs
 * only the host architecture's optional packages, while electron-builder's
 * universal build needs both trees in the same workspace.
 *
 * The package names and versions come from package-lock.json. `npm pack`
 * downloads only the missing exact package, and the tarball must match the
 * lockfile's sha512 integrity before it is extracted into node_modules.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');

// Lockfile keys, not bare names: Next ships its own nested Sharp major, and
// both the hoisted copy and Next's copy are traced into the standalone output.
const REQUIRED_PACKAGES = [
  ['node_modules/@img/sharp-darwin-arm64', 'lib/sharp-darwin-arm64.node'],
  ['node_modules/@img/sharp-darwin-x64', 'lib/sharp-darwin-x64.node'],
  ['node_modules/@img/sharp-libvips-darwin-arm64', 'lib/libvips-cpp.8.17.3.dylib'],
  ['node_modules/@img/sharp-libvips-darwin-x64', 'lib/libvips-cpp.8.17.3.dylib'],
  ['node_modules/next/node_modules/@img/sharp-darwin-arm64', 'lib/sharp-darwin-arm64-0.35.5.node'],
  ['node_modules/next/node_modules/@img/sharp-darwin-x64', 'lib/sharp-darwin-x64-0.35.5.node'],
  ['node_modules/next/node_modules/@img/sharp-libvips-darwin-arm64', 'lib/libvips-cpp.8.18.7.dylib'],
  ['node_modules/next/node_modules/@img/sharp-libvips-darwin-x64', 'lib/libvips-cpp.8.18.7.dylib'],
];

function fail(message) {
  throw new Error(`[prepare-macos-universal-runtime] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
  return result.stdout;
}

function verifyIntegrity(file, integrity) {
  const match = /^sha512-(.+)$/.exec(integrity || '');
  if (!match) fail(`unsupported or missing lockfile integrity for ${path.basename(file)}`);
  const actual = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
  if (actual !== match[1]) fail(`lockfile integrity mismatch for ${path.basename(file)}`);
}

function installedPackageIsUsable(destination, version, requiredFile) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
    return manifest.version === version && fs.existsSync(path.join(destination, requiredFile));
  } catch {
    return false;
  }
}

function installLockedPackage(lockKey, requiredFile, lockfile, tempRoot) {
  const packageName = lockKey.slice(lockKey.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const locked = lockfile.packages?.[lockKey];
  if (!locked?.version || !locked?.integrity) fail(`missing exact lock entry for ${lockKey}`);

  const destination = path.join(projectDir, ...lockKey.split('/'));
  if (installedPackageIsUsable(destination, locked.version, requiredFile)) {
    console.log(`[prepare-macos-universal-runtime] ready: ${lockKey}@${locked.version}`);
    return;
  }

  const packDir = fs.mkdtempSync(path.join(tempRoot, 'pack-'));
  const stdout = run('npm', [
    'pack',
    `${packageName}@${locked.version}`,
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    packDir,
  ]);
  let packed;
  try {
    packed = JSON.parse(stdout);
  } catch {
    fail(`npm pack returned invalid JSON for ${packageName}`);
  }
  if (!Array.isArray(packed) || packed.length !== 1 || !packed[0]?.filename) {
    fail(`npm pack returned an unexpected file set for ${packageName}`);
  }

  const tarball = path.join(packDir, packed[0].filename);
  verifyIntegrity(tarball, locked.integrity);
  const extractDir = fs.mkdtempSync(path.join(tempRoot, 'extract-'));
  run('tar', ['-xzf', tarball, '-C', extractDir]);
  const extractedPackage = path.join(extractDir, 'package');
  if (!installedPackageIsUsable(extractedPackage, locked.version, requiredFile)) {
    fail(`extracted package is incomplete for ${packageName}`);
  }

  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(extractedPackage, destination, { recursive: true, dereference: false });
  console.log(`[prepare-macos-universal-runtime] installed: ${lockKey}@${locked.version}`);
}

if (process.platform !== 'darwin') {
  console.log('[prepare-macos-universal-runtime] non-macOS host; no-op');
  process.exit(0);
}

const lockfile = JSON.parse(fs.readFileSync(path.join(projectDir, 'package-lock.json'), 'utf8'));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-macos-universal-runtime-'));
try {
  for (const [lockKey, requiredFile] of REQUIRED_PACKAGES) {
    installLockedPackage(lockKey, requiredFile, lockfile, tempRoot);
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
