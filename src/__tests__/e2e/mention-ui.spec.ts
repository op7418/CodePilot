import { test, expect } from '@playwright/test';
import { goToChat, deleteTestSession } from '../helpers';

test.describe('@mention UI/UX', () => {
  test('typing @ keeps input shadow consistent with slash mode', async ({ page }) => {
    await goToChat(page);

    const input = page.locator('textarea[name="message"]').first();
    await expect(input).toBeVisible();

    await input.fill('@');
    await expect(input).not.toHaveClass(/bg-primary\/5/);
    await expect(input).not.toHaveClass(/border-primary\/20/);
  });

  test('@mentions send structured files/mentions without dumping directory contents', async ({ page, request }) => {
    const dataDir = process.env.CODEPILOT_E2E_DATA_DIR;
    if (!dataDir) throw new Error('Isolated E2E database required');
    await page.addInitScript(
      (dir) => localStorage.setItem('codepilot:last-working-directory', dir),
      dataDir,
    );

    const created = await request.post('/api/providers', {
      data: {
        name: `Mention E2E fixture ${Date.now()}`,
        provider_type: 'anthropic',
        protocol: 'anthropic',
        preset_key: 'anthropic-official',
        base_url: 'https://api.anthropic.com',
        api_key: 'fixture-no-network',
      },
    });
    expect(created.ok()).toBe(true);
    const { provider } = await created.json();
    const sessionIds: string[] = [];

    let chatRequestBody: Record<string, unknown> | null = null;

    await page.route('**/api/settings/app', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({
        response,
        json: {
          ...data,
          settings: {
            ...data.settings,
            agent_runtime: 'codepilot_runtime',
            default_provider_id: provider.id,
            default_model: 'sonnet',
          },
        },
      });
    });

    await page.route('**/api/files/suggest**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            { path: 'src/components', display: 'src/components/', type: 'directory' },
            { path: 'src/app/page.tsx', display: 'src/app/page.tsx', type: 'file' },
          ],
        }),
      });
    });

    await page.route('**/api/files/serve**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-length': '38' },
        body: 'export const page = () => "hello mention";\n',
      });
    });

    await page.route('**/api/files/raw**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-length': '38' },
        body: 'export const page = () => "hello mention";\n',
      });
    });

    await page.route('**/api/files?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tree: [
            { name: 'Button.tsx', path: '/tmp/src/components/Button.tsx', type: 'file' },
            { name: 'Dialog.tsx', path: '/tmp/src/components/Dialog.tsx', type: 'file' },
            { name: 'forms', path: '/tmp/src/components/forms', type: 'directory', children: [] },
          ],
        }),
      });
    });

    await page.route('**/api/chat/sessions', async (route) => {
      const response = await route.fetch();
      if (route.request().method() === 'POST' && response.ok()) {
        const data = await response.json();
        if (data?.session?.id) sessionIds.push(data.session.id);
      }
      await route.fulfill({ response });
    });

    await page.route('**/api/chat', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') {
        await route.continue();
        return;
      }
      try {
        chatRequestBody = req.postDataJSON() as Record<string, unknown>;
      } catch {
        chatRequestBody = null;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'text', data: 'ok' })}\n\ndata: ${JSON.stringify({ type: 'done', data: '' })}\n\n`,
      });
    });

    try {
      await goToChat(page);
      await page.getByRole('button', { name: /Choose runtime and model|选择 Runtime 和模型/ }).click();
      await page
        .locator(`[data-model-provider-section="${provider.id}"]`)
        .getByRole('button', { name: /^Sonnet 4\.6 sonnet/ })
        .click();

      const input = page.locator('textarea[name="message"]').first();
      await expect(input).toBeVisible();

      await input.fill('@src/com');
      const dirOption = page.locator('button', { hasText: 'src/components/' }).first();
      await expect(dirOption).toBeVisible({ timeout: 5_000 });
      await dirOption.click();

      await input.pressSequentially(' and @src/app/page.tsx');
      const fileOption = page.locator('button', { hasText: 'src/app/page.tsx' }).first();
      await expect(fileOption).toBeVisible({ timeout: 5_000 });
      await fileOption.click();
      await input.press('Enter');

      await expect.poll(() => chatRequestBody !== null, { timeout: 10_000 }).toBeTruthy();

      const payload = (chatRequestBody ?? {}) as { files?: unknown; mentions?: unknown; content?: unknown };
      const files = Array.isArray(payload.files) ? payload.files : [];
      const mentions = Array.isArray(payload.mentions) ? payload.mentions : [];
      const content = typeof payload.content === 'string' ? payload.content : '';

      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(mentions.length).toBeGreaterThanOrEqual(2);
      expect(content).toContain('[Referenced Directories]');
      expect(content).toContain('Directory reference @src/components/');
      expect(content).toContain('- Button.tsx');
      expect(content).not.toContain('export const page = () => "hello mention"');
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      for (const id of sessionIds) {
        await deleteTestSession(page, id);
      }
      await request.delete(`/api/providers/${encodeURIComponent(provider.id)}`).catch(() => {});
    }
  });

  test('removing one mention keeps others and chip order follows selection order', async ({ page }) => {
    await page.route('**/api/files/suggest**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            { path: 'src/alpha.ts', display: 'src/alpha.ts', type: 'file' },
            { path: 'src/beta.ts', display: 'src/beta.ts', type: 'file' },
          ],
        }),
      });
    });

    await goToChat(page);

    const input = page.locator('textarea[name="message"]').first();
    await expect(input).toBeVisible();

    // Insert two file mentions in order: alpha then beta.
    await input.fill('@src/al');
    const alphaOption = page.locator('button', { hasText: 'src/alpha.ts' }).first();
    await expect(alphaOption).toBeVisible({ timeout: 5_000 });
    await alphaOption.click();

    await input.pressSequentially('@src/be');
    const betaOption = page.locator('button', { hasText: 'src/beta.ts' }).first();
    await expect(betaOption).toBeVisible({ timeout: 5_000 });
    await betaOption.click();

    // Selection order should be preserved in chip row: @alpha -> @beta.
    const alphaChip = page.locator('span.font-mono', { hasText: '@src/alpha.ts' }).first();
    const betaChip = page.locator('span.font-mono', { hasText: '@src/beta.ts' }).first();
    await expect(alphaChip).toBeVisible();
    await expect(betaChip).toBeVisible();

    const chipsBefore = (await page.locator('span.font-mono').allTextContents()).map((t) => t.trim()).filter(Boolean);
    const alphaIdx = chipsBefore.findIndex((t) => t.includes('@src/alpha.ts'));
    const betaIdx = chipsBefore.findIndex((t) => t.includes('@src/beta.ts'));
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThan(alphaIdx);

    // Remove one mention chip explicitly; the other mention should remain.
    const removeAlphaBtn = page.locator('button[aria-label*="src/alpha.ts"]').first();
    await expect(removeAlphaBtn).toBeVisible();
    await removeAlphaBtn.click();

    await expect(alphaChip).toHaveCount(0);
    await expect(betaChip).toBeVisible();

    const after = await input.inputValue();
    expect(after).not.toContain('@src/alpha.ts');
    expect(after).toContain('@src/beta.ts');

    // Backspace at the end clears the remaining @file token as one unit.
    await input.evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      const len = ta.value.length;
      ta.focus();
      ta.setSelectionRange(len, len);
    });
    await input.press('Backspace');
    await expect.poll(async () => input.inputValue()).not.toContain('@src/beta.ts');
  });
});
