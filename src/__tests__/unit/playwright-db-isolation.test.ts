import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Playwright database isolation', () => {
  it('owns a fresh temp DB server and cannot reuse the everyday dev server', () => {
    const config = read('playwright.config.ts');
    const runner = read('scripts/run-playwright.mjs');
    assert.match(runner, /mkdtempSync\(path\.join\(os\.tmpdir\(\), 'codepilot-playwright-db-'\)\)/);
    assert.match(runner, /CLAUDE_GUI_DATA_DIR:\s*dataDir/);
    assert.match(runner, /CODEPILOT_NEXT_DIST_DIR:\s*distDirName/);
    assert.match(runner, /finally \{[\s\S]*fs\.rmSync\(dataDir,[\s\S]*fs\.rmSync\(distDir/);
    assert.match(config, /process\.env\.CLAUDE_GUI_DATA_DIR = e2eDataDir/);
    assert.match(config, /CODEPILOT_NEXT_DIST_DIR:\s*e2eDistDir/);
    assert.match(config, /CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS:\s*'1'/);
    assert.match(config, /reuseExistingServer:\s*false/);
    assert.match(config, /globalSetup:\s*'\.\/src\/__tests__\/e2e\/global-setup\.ts'/);
    assert.doesNotMatch(config, /reuseExistingServer:\s*!process\.env\.CI/);

    const nextConfig = read('next.config.ts');
    assert.match(nextConfig, /distDir:\s*process\.env\.CODEPILOT_NEXT_DIST_DIR \|\| '\.next'/);

    const packageJson = read('package.json');
    assert.match(packageJson, /"test:e2e":\s*"node scripts\/run-playwright\.mjs"/);
    assert.match(packageJson, /"test:smoke":\s*"node scripts\/run-playwright\.mjs --grep @smoke"/);
  });

  it('deletes every sidebar fixture session in finally blocks', () => {
    const projectPanel = read('src/__tests__/e2e/project-panel.spec.ts');
    const cleanupCalls = projectPanel.match(/await deleteTestSession\(page, sessionId\)/g) ?? [];
    assert.equal(cleanupCalls.length, 3);
    assert.match(projectPanel, /finally \{\s*await deleteTestSession\(page, sessionId\);/);
  });
});
