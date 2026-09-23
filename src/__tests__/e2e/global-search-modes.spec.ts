import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { deleteTestSession } from '../helpers';

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

    let sessionA: string | undefined;
    let sessionB: string | undefined;

    const searchInput = page.locator(
      'input[data-slot="command-input"], input[placeholder*="Search"], input[placeholder*="搜索"]'
    ).first();

    try {
      sessionA = await createSession(page, sessionTitleA, rootA);
      sessionB = await createSession(page, sessionTitleB, rootB);
      addMessage(sessionA, 'user', `User says ${messageTokenA}`);
      addMessage(sessionB, 'assistant', `Assistant says ${messageTokenB}`);
      await page.goto(`/chat/${sessionA}`);

      // Open global search from the sidebar trigger (language-agnostic fallback).
      await page.getByRole('button', { name: /(搜索会话|Search sessions|Search)/i }).first().click();
      await expect(searchInput).toBeVisible({ timeout: 10_000 });

      // Default all-mode caps its file-branch scan at the N most-recent
      // workspaces (see ALL_MODE_FILE_SESSION_LIMIT in /api/search) so the
      // POST stays under ~1s even on a populated DB — the earlier 30s
      // timeout was masking the unbounded-scan latency that Codex flagged.
      await searchInput.fill(suffix);
      await expect(page.getByText(sessionTitleA).first()).toBeVisible();
      await expect(page.getByText(fileNameA).first()).toBeVisible();
      await expect(page.getByText(messageTokenA).first()).toBeVisible();

      // session: prefix narrows to session result.
      await searchInput.fill(`session:${sessionTitleA}`);
      await expect(page.getByText(sessionTitleA).first()).toBeVisible();
      await expect(page.getByText(fileNameA)).toHaveCount(0);

      // message: prefix narrows to message snippets and supports navigation to target session.
      await searchInput.fill(`message:${messageTokenB}`);
      await expect(page.getByText(messageTokenB)).toBeVisible({ timeout: 10_000 });
      await page.getByText(messageTokenB).first().click();
      await expect(page).toHaveURL(new RegExp(`/chat/${sessionB}\\?message=`), { timeout: 10_000 });

      // Re-open and verify file: prefix still works in the same UX flow.
      await page.getByRole('button', { name: /(搜索会话|Search sessions|Search)/i }).first().click();
      await expect(searchInput).toBeVisible({ timeout: 10_000 });
      await searchInput.fill(`file:${fileNameA}`);
      await expect(page.getByText(/(Searching in|当前搜索范围)/)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('file:')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(fileNameA)).toBeVisible({ timeout: 10_000 });
      await page.getByText(fileNameA).first().click();
      await expect(page).toHaveURL(new RegExp(`/chat/${sessionA}\\?file=`), { timeout: 10_000 });
    } finally {
      await deleteTestSession(page, sessionA);
      await deleteTestSession(page, sessionB);
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });
});
