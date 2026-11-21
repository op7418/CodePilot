import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { sanitizeStandaloneOutput } from './clean-electron-build.mjs';
import pkg from '../package.json' with { type: 'json' };

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

// Next's standalone tracer copies server JavaScript but omits its adjacent
// source maps. Copy only maps whose deployed JS sibling is present so the
// Sentry upload operates on the exact packaged server graph. electron-builder
// excludes these temporary files from the final application.
function copyStandaloneServerSourceMaps() {
  if (process.env.CODEPILOT_SOURCE_MAPS !== '1') return;
  const builtServer = '.next/server';
  const standaloneServer = '.next/standalone/.next/server';
  if (!fs.existsSync(builtServer) || !fs.existsSync(standaloneServer)) {
    throw new Error('Source-map build is missing a Next server artifact root');
  }

  let copied = 0;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const relative = path.relative(standaloneServer, full);
      const sourceMap = path.join(builtServer, `${relative}.map`);
      if (!fs.existsSync(sourceMap) || fs.statSync(sourceMap).size <= 128) continue;
      fs.copyFileSync(sourceMap, `${full}.map`);
      copied++;
    }
  };
  visit(standaloneServer);
  if (copied === 0) throw new Error('No deployable Next server source maps were copied');
  console.log(`Copied ${copied} deployable Next server source maps`);
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

  // Native updates are an official-release capability, not a consequence of
  // someone setting CODEPILOT_APP_CHANNEL locally. Fork CI has a different
  // GITHUB_REPOSITORY and local builds have none, so both compile to no-op
  // unless they deliberately change this trust contract in their own source.
  const officialUpdateBuild = process.env.CODEPILOT_OFFICIAL_UPDATE_BUILD === '1'
    && process.env.GITHUB_REPOSITORY === 'op7418/CodePilot';

  const shared = {
    bundle: true,
    platform: 'node',
    target: 'node24',
    external: ['electron'],
    sourcemap: true,
    minify: false,
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'process.env.CODEPILOT_APP_VERSION': JSON.stringify(pkg.version),
      'process.env.CODEPILOT_APP_CHANNEL': JSON.stringify(process.env.CODEPILOT_APP_CHANNEL || 'local'),
      'process.env.CODEPILOT_OFFICIAL_UPDATE_BUILD': JSON.stringify(officialUpdateBuild ? '1' : '0'),
      'process.env.CODEPILOT_SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN || ''),
      'process.env.CODEPILOT_TELEMETRY_SMOKE': JSON.stringify(process.env.CODEPILOT_TELEMETRY_SMOKE === '1' ? '1' : '0'),
    },
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

  copyStandaloneServerSourceMaps();

  // Fix standalone symlinks after next build
  resolveStandaloneSymlinks();
}

buildElectron().catch((err) => {
  console.error(err);
  process.exit(1);
});
