import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-playwright-db-'));
const runId = path.basename(dataDir).slice('codepilot-playwright-db-'.length);
const distDirName = `.next-e2e-${runId}`;
const distDir = path.join(repositoryRoot, distDirName);
const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';

let result;
try {
  result = spawnSync(executable, ['playwright', 'test', ...process.argv.slice(2)], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CLAUDE_GUI_DATA_DIR: dataDir,
      CODEPILOT_E2E_DATA_DIR: dataDir,
      CODEPILOT_E2E_DIST_DIR: distDir,
      CODEPILOT_NEXT_DIST_DIR: distDirName,
      CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS: '1',
      CODEX_DISABLED: '1',
    },
    stdio: 'inherit',
    windowsHide: true,
  });
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(distDir, { recursive: true, force: true });
}

if (result?.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result?.status ?? 1);
