import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

function getDbPath() {
  const dataDir = process.env.CLAUDE_GUI_DATA_DIR || path.join(os.homedir(), '.codepilot');
  return path.join(dataDir, 'codepilot.db');
}

function addMessage(sessionId: string, role: 'user' | 'assistant', content: string) {
  const db = new Database(getDbPath());
  try {
    const id = crypto.randomBytes(16).toString('hex');
    const now = new Date().toISOString().replace('T', ' ').split('.')[0];
    db.prepare(
      'INSERT INTO messages (id, session_id, role, content, created_at, token_usage) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, sessionId, role, content, now, null);
    db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
  } finally {
    db.close();
  }
}

async function createSession(page: Page, title: string, workingDirectory: string) {
  const res = await page.request.post('/api/chat/sessions', {
    data: { title, working_directory: workingDirectory },
  });
  expect(res.ok()).toBeTruthy();
  const data = await res.json();
  return data.session.id as string;
}

test.describe('Global Search modes UX', () => {
  test.setTimeout(60_000);

  test('supports all/session/message/file modes and keyboard open', async ({ page }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rootA = path.join(os.tmpdir(), `codepilot-search-modes-a-${suffix}`);
    const rootB = path.join(os.tmpdir(), `codepilot-search-modes-b-${suffix}`);
    const fileNameA = `alpha-${suffix}.ts`;
    const filePathA = path.join(rootA, 'src', fileNameA);
    const sessionTitleA = `Search Session Alpha ${suffix}`;
    const sessionTitleB = `Search Session Beta ${suffix}`;
    const messageTokenA = `message-token-alpha-${suffix}`;
    const messageTokenB = `message-token-beta-${suffix}`;

    await fs.mkdir(path.dirname(filePathA), { recursive: true });
    await fs.mkdir(rootB, { recursive: true });
    await fs.writeFile(filePathA, 'export const alpha = true;\n', 'utf8');

    const sessionA = await createSession(page, sessionTitleA, rootA);
    const sessionB = await createSession(page, sessionTitleB, rootB);
    addMessage(sessionA, 'user', `User says ${messageTokenA}`);
    addMessage(sessionB, 'assistant', `Assistant says ${messageTokenB}`);

    const searchInput = page.locator('input[data-slot="command-input"]').first();
    const searchSurface = page.getByTestId('global-search-surface');
    const openSearch = async () => {
      await expect(page.getByRole('button', { name: /^(搜索|Search)$/ }).first()).toBeVisible({
        timeout: 10_000,
      });
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('open-global-search'));
      });
      await expect(searchInput).toBeVisible({ timeout: 10_000 });
      await expect(searchSurface).toBeVisible({ timeout: 10_000 });
    };

    try {
      await page.goto(`/chat/${sessionA}`);

      await openSearch();

      // All-mode returns all three result types.
      await searchInput.fill(suffix);
      await expect(page.getByTestId('global-search-section-sessions')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('global-search-section-files')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('global-search-section-messages')).toBeVisible({ timeout: 10_000 });
      await expect(
        page.getByTestId('global-search-section-sessions').getByTestId('global-search-item')
      ).toHaveCount(2, { timeout: 10_000 });
      await expect(
        page.getByTestId('global-search-section-files').getByTestId('global-search-item')
      ).toHaveCount(1, { timeout: 10_000 });
      await expect(
        page.getByTestId('global-search-section-messages').getByTestId('global-search-item')
      ).toHaveCount(2, { timeout: 10_000 });

      // Clicking a scope chip rewrites the prefix and narrows the result set.
      await page.getByTestId('global-search-scope-sessions').click();
      await expect(searchInput).toHaveValue(`session:${suffix}`);
      await expect(page.getByTestId('global-search-section-sessions')).toBeVisible({ timeout: 10_000 });
      await expect(
        page.getByTestId('global-search-section-sessions').getByTestId('global-search-item')
      ).toHaveCount(2, { timeout: 10_000 });
      await expect(page.getByTestId('global-search-section-files')).toHaveCount(0);

      // message: prefix narrows to message snippets and supports navigation to target session.
      await searchInput.fill(`message:${messageTokenB}`);
      await expect(page.getByTestId('global-search-scope-messages')).toHaveAttribute('aria-pressed', 'true');
      await expect(
        page.getByTestId('global-search-section-messages').getByTestId('global-search-item')
      ).toHaveCount(1, { timeout: 10_000 });
      await expect(
        page.getByTestId('global-search-section-messages').getByText(messageTokenB).first()
      ).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('global-search-section-messages').getByText(messageTokenB).first().click();
      await expect(page).toHaveURL(new RegExp(`/chat/${sessionB}\\?message=`), { timeout: 10_000 });

      // Re-open and verify file scope still works in the same UX flow.
      await openSearch();
      await searchInput.fill('');
      await page.getByTestId('global-search-scope-files').click();
      await expect(searchInput).toHaveValue('file:');
      await searchInput.fill(`file:${fileNameA}`);
      await expect(page.getByTestId('global-search-scope-files')).toHaveAttribute('aria-pressed', 'true');
      await expect(
        page.getByTestId('global-search-section-files').getByTestId('global-search-item')
      ).toHaveCount(1, { timeout: 10_000 });
      await expect(
        page.getByTestId('global-search-section-files').getByText(fileNameA).first()
      ).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('global-search-section-files').getByText(fileNameA).first().click();
      await expect(page).toHaveURL(new RegExp(`/chat/${sessionA}\\?file=`), { timeout: 10_000 });
    } finally {
      await page.request.delete(`/api/chat/sessions/${sessionA}`, { timeout: 5_000 }).catch(() => {});
      await page.request.delete(`/api/chat/sessions/${sessionB}`, { timeout: 5_000 }).catch(() => {});
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });
});
