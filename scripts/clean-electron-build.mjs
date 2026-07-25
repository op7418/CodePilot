import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ELECTRON_BUILD_ARTIFACT_DIRS = ['release', '.next', 'dist-electron'];
export const STANDALONE_ROOT_ALLOWLIST = new Set([
  '.next',
  'node_modules',
  'server.js',
  'package.json',
  'cache-handler.js',
]);

function assertCodePilotProject(projectDir) {
  const root = path.resolve(projectDir);
  const packagePath = path.join(root, 'package.json');

  if (root === path.parse(root).root || !fs.existsSync(packagePath)) {
    throw new Error(`[electron-build] Refusing unsafe project root: ${root}`);
  }

  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (pkg.name !== 'codepilot') {
    throw new Error(`[electron-build] Refusing non-CodePilot project root: ${root}`);
  }

  return root;
}

export function cleanElectronBuildArtifacts(projectDir = process.cwd()) {
  const root = assertCodePilotProject(projectDir);

  for (const relativeDir of ELECTRON_BUILD_ARTIFACT_DIRS) {
    const target = path.resolve(root, relativeDir);
    if (path.dirname(target) !== root) {
      throw new Error(`[electron-build] Refusing unsafe artifact path: ${target}`);
    }
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      console.log(`[electron-build] Cleaned ${relativeDir}/`);
    }
  }
}

export function assertStandaloneHygiene(projectDir = process.cwd()) {
  const root = assertCodePilotProject(projectDir);
  const standaloneRoot = path.join(root, '.next', 'standalone');

  if (!fs.existsSync(standaloneRoot)) {
    throw new Error(`[electron-build] Standalone output missing: ${standaloneRoot}`);
  }

  const leakedRoots = fs.readdirSync(standaloneRoot)
    .filter((name) => !STANDALONE_ROOT_ALLOWLIST.has(name))
    .sort();

  if (leakedRoots.length > 0) {
    throw new Error(
      `[electron-build] Standalone output contains forbidden roots: ${leakedRoots.join(', ')}`,
    );
  }

  const missingRoots = [...STANDALONE_ROOT_ALLOWLIST]
    .filter((name) => !fs.existsSync(path.join(standaloneRoot, name)))
    .sort();
  if (missingRoots.length > 0) {
    throw new Error(
      `[electron-build] Standalone output is missing required roots: ${missingRoots.join(', ')}`,
    );
  }
}

export function sanitizeStandaloneOutput(projectDir = process.cwd()) {
  const root = assertCodePilotProject(projectDir);
  const standaloneRoot = path.join(root, '.next', 'standalone');

  if (!fs.existsSync(standaloneRoot)) {
    throw new Error(`[electron-build] Standalone output missing: ${standaloneRoot}`);
  }

  const removed = [];
  for (const name of fs.readdirSync(standaloneRoot)) {
    if (STANDALONE_ROOT_ALLOWLIST.has(name)) continue;
    const target = path.resolve(standaloneRoot, name);
    if (path.dirname(target) !== standaloneRoot) {
      throw new Error(`[electron-build] Refusing unsafe standalone path: ${target}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }

  if (removed.length > 0) {
    console.log(`[electron-build] Removed traced standalone roots: ${removed.sort().join(', ')}`);
  }
  assertStandaloneHygiene(root);
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  if (process.argv.includes('--assert-standalone')) {
    assertStandaloneHygiene();
  } else if (process.argv.includes('--sanitize-standalone')) {
    sanitizeStandaloneOutput();
  } else {
    cleanElectronBuildArtifacts();
  }
}
