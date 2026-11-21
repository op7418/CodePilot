/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * electron-builder afterPack hook.
 *
 * The standard @electron/rebuild step only rebuilds native modules found
 * in the `files` config. Since better-sqlite3 enters the app through
 * extraResources (via .next/standalone/), it gets skipped.
 *
 * This hook:
 * 1. Prunes better-sqlite3 v13+ N-API prebuilds inside Next standalone to the
 *    target platform so macOS codesign/notarization never encounters foreign
 *    ELF/PE binaries (macOS retains both darwin-arm64.node and darwin-x64.node
 *    for @electron/universal merging).
 * 2. Explicitly rebuilds V8/NAN native modules (zlib-sync) for the target
 *    Electron ABI and copies the rebuilt .node files into standalone resources.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

module.exports = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const arch = context.arch;
  // electron-builder arch enum: 1=x64, 3=arm64, etc.
  const archName = arch === 3 ? 'arm64' : arch === 1 ? 'x64' : arch === 0 ? 'ia32' : String(arch);
  const platform = context.packager.platform.name; // 'mac', 'windows', 'linux'

  // Arch.universal is 4. At this point @electron/universal has already lipoed
  // the x64/arm64 app trees. Rebuilding again would interpret "4" as an
  // unsupported target and overwrite the freshly merged native modules with a
  // single-host slice.
  if (arch === 4) {
    console.log('[afterPack] Universal app already merged; preserving native slices');
    return;
  }

  // Get Electron version from packager config or from installed package
  const electronVersion =
    context.electronVersion ||
    context.packager?.config?.electronVersion ||
    require(path.join(process.cwd(), 'node_modules', 'electron', 'package.json')).version;

  console.log(`[afterPack] Electron ${electronVersion}, arch=${archName}, platform=${platform}`);

  // Step 1: Prune better-sqlite3 v13+ N-API prebuilds in standalone resources
  // to the target platform. Keeping Linux/Windows .node binaries inside a macOS
  // bundle breaks codesign/notarization, while retaining both Darwin slices
  // keeps arm64 and x64 app trees structurally identical for @electron/universal.
  const searchRoots = [
    path.join(appOutDir, 'CodePilot.app', 'Contents', 'Resources', 'standalone'),
    path.join(appOutDir, 'Contents', 'Resources', 'standalone'),
    path.join(appOutDir, 'resources', 'standalone'),
  ];

  const allowedSqlitePrebuilds = platform === 'mac'
    ? new Set(['darwin-arm64.node', 'darwin-x64.node'])
    : platform === 'windows'
      ? new Set([`win32-${archName}.node`])
      : platform === 'linux'
        ? new Set([`linux-${archName}.node`, `linuxmusl-${archName}.node`])
        : null;
  const requiredSqlitePrebuild = platform === 'mac'
    ? `darwin-${archName}.node`
    : platform === 'windows'
      ? `win32-${archName}.node`
      : platform === 'linux'
        ? `linux-${archName}.node`
        : null;

  let prunedSqliteDirs = 0;
  function pruneBetterSqlitePrebuilds(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.name === 'prebuilds' && path.basename(dir) === 'better-sqlite3') {
        prunedSqliteDirs++;
        if (!allowedSqlitePrebuilds) continue;
        const files = fs.readdirSync(fullPath, { withFileTypes: true });
        let removed = 0;
        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith('.node')) continue;
          if (!allowedSqlitePrebuilds.has(file.name)) {
            fs.rmSync(path.join(fullPath, file.name), { force: true });
            removed++;
          }
        }
        if (requiredSqlitePrebuild && !fs.existsSync(path.join(fullPath, requiredSqlitePrebuild))) {
          throw new Error(
            `[afterPack] Required better-sqlite3 prebuild missing: ${path.join(fullPath, requiredSqlitePrebuild)}`,
          );
        }
        console.log(
          `[afterPack] Pruned better-sqlite3 prebuilds at ${fullPath}: removed ${removed}, kept ${[...allowedSqlitePrebuilds].join(', ')}`,
        );
        continue;
      }
      pruneBetterSqlitePrebuilds(fullPath);
    }
  }

  for (const root of searchRoots) {
    pruneBetterSqlitePrebuilds(root);
  }
  if (prunedSqliteDirs === 0) {
    throw new Error('[afterPack] No better-sqlite3/prebuilds directory found in standalone resources');
  }

  // Step 2: Explicitly rebuild non-N-API standalone native modules (zlib-sync)
  // for the target Electron version. electron-builder rebuilds root node_modules,
  // but Next's prebuilt standalone tree otherwise keeps the host ABI.
  const projectDir = process.cwd();
  const nativeModules = [
    {
      packageName: 'zlib-sync',
      outputName: 'zlib_sync.node',
      source: path.join(projectDir, 'node_modules', 'zlib-sync', 'build', 'Release', 'zlib_sync.node'),
    },
  ];
  console.log('[afterPack] Rebuilding standalone native modules for Electron ABI...');

  try {
    // Use @electron/rebuild via npx (it's a dependency of electron-builder)
    const moduleNames = nativeModules.map((item) => item.packageName).join(',');
    const rebuildCmd = `npx electron-rebuild -f -o ${moduleNames} -v ${electronVersion} -a ${archName}`;
    console.log(`[afterPack] Running: ${rebuildCmd}`);
    execSync(rebuildCmd, {
      cwd: projectDir,
      stdio: 'inherit',
      timeout: 120000,
    });
    console.log('[afterPack] Rebuild completed successfully');
  } catch (err) {
    console.error('[afterPack] Failed to rebuild zlib-sync:', err.message);
    // Try alternative: use @electron/rebuild programmatically
    try {
      const { rebuild } = require('@electron/rebuild');
      await rebuild({
        buildPath: projectDir,
        electronVersion: electronVersion,
        arch: archName,
        onlyModules: nativeModules.map((item) => item.packageName),
        force: true,
      });
      console.log('[afterPack] Rebuild via @electron/rebuild API succeeded');
    } catch (err2) {
      console.error('[afterPack] @electron/rebuild API also failed:', err2.message);
      throw new Error('Cannot rebuild standalone native modules for Electron ABI');
    }
  }

  // Step 3: Verify every rebuilt .node file.
  for (const item of nativeModules) {
    if (!fs.existsSync(item.source)) {
      throw new Error(`[afterPack] Rebuilt ${item.outputName} not found at ${item.source}`);
    }
    const sourceStats = fs.statSync(item.source);
    console.log(`[afterPack] Rebuilt .node file: ${item.source} (${sourceStats.size} bytes, mtime: ${sourceStats.mtime.toISOString()})`);
  }

  // Step 4: Find and replace all target .node files in standalone resources.
  // macOS: <appOutDir>/CodePilot.app/Contents/Resources/standalone/...
  // Windows/Linux: <appOutDir>/resources/standalone/...

  const replaced = new Map(nativeModules.map((item) => [item.outputName, 0]));

  function walkAndReplace(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkAndReplace(fullPath);
      } else {
        const item = nativeModules.find((candidate) => candidate.outputName === entry.name);
        if (!item) continue;
        const beforeSize = fs.statSync(fullPath).size;
        fs.copyFileSync(item.source, fullPath);
        const afterSize = fs.statSync(fullPath).size;
        console.log(`[afterPack] Replaced ${fullPath} (${beforeSize} -> ${afterSize} bytes)`);
        replaced.set(item.outputName, replaced.get(item.outputName) + 1);
      }
    }
  }

  for (const root of searchRoots) {
    walkAndReplace(root);
  }

  for (const item of nativeModules) {
    const count = replaced.get(item.outputName);
    if (count > 0) {
      console.log(`[afterPack] Successfully replaced ${count} ${item.outputName} file(s) with Electron ABI build`);
      continue;
    }
    console.warn(`[afterPack] WARNING: No ${item.outputName} files found in standalone resources!`);
    for (const root of searchRoots) {
      if (fs.existsSync(root)) {
        console.log(`[afterPack] Contents of ${root}:`, fs.readdirSync(root).slice(0, 20));
      } else {
        console.log(`[afterPack] Path does not exist: ${root}`);
      }
    }
  }

  // Note: Ad-hoc code signing moved to scripts/after-sign.js (afterSign hook).
  // Certificate-backed workflows let electron-builder discover the identity
  // imported from CSC_LINK. Isolated local packages explicitly disable that
  // discovery and use the afterSign ad-hoc fallback instead.
};
