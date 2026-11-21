#!/usr/bin/env node
/**
 * Electron main+preload dev build for `npm run electron:dev`.
 *
 * Two modes:
 *   - default (one-shot): emit `dist-electron/main.js` and
 *     `dist-electron/preload.js` once and exit. Used by electron:dev
 *     to guarantee the compiled artifacts are fresh **before** the
 *     Electron app boots.
 *   - --watch: rebuild on every change to `electron/**`. Long-running.
 *
 * Why this script (not scripts/build-electron.mjs):
 *   - The production build also runs `next build` and shuffles
 *     `.next/standalone/*` symlinks; we want neither during dev.
 *   - `electron:dev` used to skip the Electron compile step entirely
 *     (`concurrently -k "next dev" "wait-on http://localhost:3000 &&
 *     electron ."`), which meant `electron/main.ts` edits never made
 *     it into `dist-electron/main.js` — Electron would boot the
 *     stale .js sitting on disk from the last production build. This
 *     bit Phase 7b Phase 2 hard: hours of "vibrancy still not
 *     visible" debugging traced back to a 14-day-old main.js.
 *
 * Re-entrancy: the watch worker keeps the previous output on disk
 * during incremental rebuilds (esbuild handles that). Electron itself
 * does NOT auto-restart on main.js change — restart it manually after
 * editing electron/**.
 */

import { context, build } from "esbuild";

const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  platform: "node",
  target: "node24",
  external: ["electron"],
  sourcemap: true,
  minify: false,
  logLevel: watch ? "info" : "warning",
};

const targets = [
  { entryPoints: ["electron/main.ts"], outfile: "dist-electron/main.js" },
  { entryPoints: ["electron/preload.ts"], outfile: "dist-electron/preload.js" },
];

if (watch) {
  const ctxs = await Promise.all(
    targets.map((t) => context({ ...shared, ...t })),
  );
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("[electron-dev-build] watching electron/**.ts → dist-electron/*.js");
  // Don't return — keep the process alive for the watcher.
} else {
  for (const t of targets) {
    await build({ ...shared, ...t });
  }
  console.log("[electron-dev-build] one-shot build complete");
}
