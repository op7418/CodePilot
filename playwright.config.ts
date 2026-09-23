import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// Automated browser tests must never reuse a developer's everyday server:
// mutating E2E routes create real sessions and would otherwise write them to
// ~/.codepilot/codepilot.db. Launch a dedicated server with a fresh temp DB.
// PLAYWRIGHT_BASE_URL may select another loopback port for a worktree, but it
// still describes the isolated server Playwright owns; it is not a reuse hook.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3100';
const serverUrl = new URL(baseURL);
const serverPort = Number(serverUrl.port);
if (
  serverUrl.protocol !== 'http:'
  || !['127.0.0.1', 'localhost'].includes(serverUrl.hostname)
  || serverUrl.pathname !== '/'
  || !Number.isInteger(serverPort)
  || serverPort < 1024
  || serverPort > 65_535
) {
  throw new Error('PLAYWRIGHT_BASE_URL must be a loopback http URL with an explicit unprivileged port');
}

const e2eDataDir = process.env.CODEPILOT_E2E_DATA_DIR;
const e2eDistDir = process.env.CODEPILOT_NEXT_DIST_DIR;
if (
  !e2eDataDir
  || path.dirname(path.resolve(e2eDataDir)) !== path.resolve(os.tmpdir())
  || !path.basename(e2eDataDir).startsWith('codepilot-playwright-db-')
  || !e2eDistDir?.startsWith('.next-e2e-')
) {
  throw new Error('Run Playwright through npm run test:e2e/test:smoke/test:visual so its database is isolated');
}
process.env.CLAUDE_GUI_DATA_DIR = e2eDataDir;
process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS = '1';

export default defineConfig({
  testDir: './src/__tests__/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  globalSetup: './src/__tests__/e2e/global-setup.ts',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
    },
  },
  webServer: {
    command: `npm run dev -- --hostname ${serverUrl.hostname} --port ${serverPort}`,
    url: baseURL,
    reuseExistingServer: false,
    env: {
      CLAUDE_GUI_DATA_DIR: e2eDataDir,
      CODEPILOT_NEXT_DIST_DIR: e2eDistDir,
      CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS: '1',
      CODEX_DISABLED: '1',
    },
  },
});
