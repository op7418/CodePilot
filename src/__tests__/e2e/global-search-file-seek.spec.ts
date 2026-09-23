import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deleteTestSession } from '../helpers';

async function createSession(page: Page, title: string, workingDirectory: string) {
  const res = await page.request.post('/api/chat/sessions', {
    data: { title, working_directory: workingDirectory },
  });
  expect(res.ok()).toBeTruthy();
  const data = await res.json();
  return data.session.id as string;
}

test.describe('Global Search file deep-link seek UX', () => {
  test('same-session repeat seek and cross-session seek both locate target file', async ({ page }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rootA = path.join(os.tmpdir(), `codepilot-search-a-${suffix}`);
    const rootB = path.join(os.tmpdir(), `codepilot-search-b-${suffix}`);
    const fileA = path.join(rootA, 'src', 'feature-a', 'target-a.ts');
    const fileB = path.join(rootB, 'src', 'feature-b', 'target-b.ts');

    await fs.mkdir(path.dirname(fileA), { recursive: true });
    await fs.mkdir(path.dirname(fileB), { recursive: true });
    await fs.writeFile(fileA, 'export const targetA = 1;\n', 'utf8');
    await fs.writeFile(fileB, 'export const targetB = 2;\n', 'utf8');

    // Add filler files to make vertical scrolling observable.
    for (let i = 0; i < 120; i++) {
      const fillerA = path.join(rootA, 'src', `filler-a-${String(i).padStart(3, '0')}.ts`);
      const fillerB = path.join(rootB, 'src', `filler-b-${String(i).padStart(3, '0')}.ts`);
      await fs.writeFile(fillerA, `export const a${i} = ${i};\n`, 'utf8');
      await fs.writeFile(fillerB, `export const b${i} = ${i};\n`, 'utf8');
    }

    let sessionA: string | undefined;
    let sessionB: string | undefined;

    try {
      sessionA = await createSession(page, `E2E Search Session A ${suffix}`, rootA);
      sessionB = await createSession(page, `E2E Search Session B ${suffix}`, rootB);
      // 1) First locate in session A.
      await page.goto(`/chat/${sessionA}?file=${encodeURIComponent(fileA)}&seek=seek1`);
      // T3 migration: file-search deep links now open Files Primary inside the
      // unified Workspace Sidebar instead of the retired standalone 280px rail.
      const panel = page.locator('[data-workspace-sidebar]');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(panel.locator('[data-primary-kind="files"]')).toBeVisible();
      await expect(page.locator('#file-tree-highlight')).toContainText('target-a.ts', { timeout: 15_000 });

      // 2) Re-seek same file in same session; should remain stable and highlighted.
      await page.goto(`/chat/${sessionA}?file=${encodeURIComponent(fileA)}&seek=seek2`);
      await expect(page.locator('#file-tree-highlight')).toContainText('target-a.ts', { timeout: 15_000 });
      await expect(page).toHaveURL(new RegExp(`/chat/${sessionA}\\?`));
      await expect(page).toHaveURL(/seek=seek2/);

      // 3) Cross-session locate should still work after previous seeks.
      await page.goto(`/chat/${sessionB}?file=${encodeURIComponent(fileB)}&seek=seek3`);
      await expect(page.locator('#file-tree-highlight')).toContainText('target-b.ts', { timeout: 15_000 });
      await expect(page).toHaveURL(new RegExp(`/chat/${sessionB}\\?`));
    } finally {
      await deleteTestSession(page, sessionA);
      await deleteTestSession(page, sessionB);
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });
});
