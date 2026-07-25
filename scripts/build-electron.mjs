import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { sanitizeStandaloneOutput } from './clean-electron-build.mjs';

// Replace symlinks in standalone with real copies so electron-builder can package them
function resolveStandaloneSymlinks() {
  const standaloneModules = '.next/standalone/.next/node_modules';
  if (!fs.existsSync(standaloneModules)) return;

  const entries = fs.readdirSync(standaloneModules);
  for (const entry of entries) {
    const fullPath = path.join(standaloneModules, entry);
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(fullPath);
      const resolved = path.resolve(standaloneModules, target);
      if (fs.existsSync(resolved)) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        fs.cpSync(resolved, fullPath, { recursive: true });
        console.log(`Resolved symlink: ${entry} -> ${target}`);
      }
    }
  }
}

async function buildElectron() {
  // Fail before electron-builder sees the standalone tree. Dynamic filesystem
  // tracing must never pull local agent/worktree state or stale release apps
  // into a distributable artifact.
  sanitizeStandaloneOutput(process.cwd());

  // Clean dist-electron/ before every build to prevent stale artifacts
  // from leaking into app.asar (caused v0.34 crash on upgrade).
  if (fs.existsSync('dist-electron')) {
    fs.rmSync('dist-electron', { recursive: true });
    console.log('Cleaned dist-electron/');
  }
  fs.mkdirSync('dist-electron', { recursive: true });

  const shared = {
    bundle: true,
    platform: 'node',
    target: 'node18',
    external: ['electron'],
    sourcemap: true,
    minify: false,
  };

  await build({
    ...shared,
    entryPoints: ['electron/main.ts'],
    outfile: 'dist-electron/main.js',
  });

  await build({
    ...shared,
    entryPoints: ['electron/preload.ts'],
    outfile: 'dist-electron/preload.js',
  });

  console.log('Electron build complete');

  // Fix standalone symlinks after next build
  resolveStandaloneSymlinks();
}

buildElectron().catch((err) => {
  console.error(err);
  process.exit(1);
});
