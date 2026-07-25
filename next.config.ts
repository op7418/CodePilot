import type { NextConfig } from "next";
import path from "node:path";
import pkg from "./package.json" with { type: "json" };

const nextConfig: NextConfig = {
  output: 'standalone',
  // Packaged CodePilot runs the Next standalone server with its cwd inside the
  // read-only install dir (e.g. C:\Program Files\CodePilot\resources\standalone).
  // Next's default FileSystemCache mkdir's `.next/cache` there on the first
  // ISR/fetch cache write and dies with EPERM. A desktop app's per-session
  // server gains nothing from a persistent on-disk cache, so we keep it fully
  // in memory — nothing is written under the install dir. (next/image is unused,
  // so there's no separate `.next/cache/images` writer.) See cache-handler.js.
  cacheHandler: path.join(import.meta.dirname, 'cache-handler.js'),
  cacheMaxMemorySize: 0, // our handler owns memory; disable Next's extra LRU layer
  // Pin Turbopack's workspace root to THIS directory.
  //
  // Without this, Next walks upward looking for the nearest lockfile
  // and lands on the parent repo when we're running from a worktree
  // under `.claude/worktrees/<name>/`. The symptom: dev server prints
  // "Next.js inferred your workspace root … selected
  // …/opus-4.6-test/package-lock.json" and serves the *parent's*
  // src/ for any file the worktree hasn't touched, so smoke tests
  // fail against stale code (directory chip / data-message-input-submit
  // mismatches that aren't real regressions). `import.meta.dirname` is
  // available on Node ≥ 20.11 and is the worktree-correct anchor —
  // resolves to the actual config file's directory regardless of cwd.
  turbopack: {
    root: import.meta.dirname,
  },
  // Electron dev loads the renderer from 127.0.0.1 while Next's dev
  // server advertises localhost. Next 16 blocks cross-origin dev
  // resources (HMR, fonts) unless the host is explicitly allowed.
  allowedDevOrigins: ['127.0.0.1'],
  experimental: {
    // Next 16 enables Turbopack's dev filesystem cache by default. In nested
    // worktrees this cache can grow to multi-GB under `.next/dev/cache` and
    // cause severe memory pressure when `next dev` restores it. Production
    // builds keep their default behavior; this only disables the dev cache.
    turbopackFileSystemCacheForDev: false,
    // Keep local dev from taking down the machine when compiling the large
    // Settings route graph. Dev source maps are useful but expensive here;
    // production builds still emit their normal artifacts.
    turbopackMemoryLimit: 1536 * 1024 * 1024,
    turbopackSourceMaps: false,
    turbopackInputSourceMaps: false,
  },
  // serverExternalPackages: keep these in node_modules at runtime instead of bundling.
  // - better-sqlite3 / zlib-sync: native modules, can't be bundled
  // - discord.js / @discordjs/ws: dynamic require chain
  // - @anthropic-ai/claude-agent-sdk: ships its own `cli.js` that the SDK spawns
  //   as a child process. When Next.js bundles the SDK, the standalone build
  //   omits cli.js, so the SDK fails with "Claude Code executable not found at
  //   .../node_modules/@anthropic-ai/claude-agent-sdk/cli.js" in production.
  //   Sentry recorded ~247 events in 14d before this was added.
  serverExternalPackages: ['better-sqlite3', 'discord.js', '@discordjs/ws', 'zlib-sync', '@anthropic-ai/claude-agent-sdk'],
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_SENTRY_DSN: 'https://245dc3525425bcd8eb99dd4b9a2ca5cd@o4511161899548672.ingest.us.sentry.io/4511161904791552',
  },
  // outputFileTracingExcludes: strip non-code dirs out of every route's NFT.
  // Turbopack sees the recursive fs.readdir() in src/lib/files#scanDirectory
  // (used by /api/files/suggest) and conservatively marks the whole project
  // as reachable — dumping README / RELEASE_NOTES / docs / .codepilot cache
  // / apps/site content into every route's .nft.json and surfacing it as
  // "next.config.ts was unexpectedly traced" warnings on `npm run build`.
  // Runtime still reads those paths — exclusion only removes them from the
  // static NFT manifest, which CodePilot doesn't consume for deployment
  // (Electron ships the whole project regardless).
  outputFileTracingExcludes: {
    // Key matches both app-router routes and instrumentation.js entry.
    '**/*': [
      'next.config.ts',
      'AGENTS.md',
      'ARCHITECTURE.md',
      'CHANGELOG.md',
      'CLAUDE.md',
      'LICENSE',
      'README.md',
      'README_CN.md',
      'README_JA.md',
      'RELEASE_NOTES.md',
      '.agents/**',
      '.claude/**',
      '.codex/**',
      '.codepilot/**',
      '.git/**',
      'apps/**',
      'docs/**',
      'release/**',
      'scripts/**',
      'test-results/**',
      'playwright-report/**',
      '**/*.md',
      '**/*.mdx',
      '**/*.png',
      '**/*.jpg',
      '**/*.jpeg',
      '**/*.gif',
    ],
  },
};

export default nextConfig;
