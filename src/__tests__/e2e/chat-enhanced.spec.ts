import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import {
  goToChat,
  sendMessage,
  chatInput,
  sendButton,
  stopButton,
  codeBlocks,
  codeBlockLanguageLabel,
  codeBlockCopyButton,
  toolBlocks,
  toolCallLabels,
  toolResultLabels,
  userMessage,
  assistantMessage,
  deleteTestSession,
  collectConsoleErrors,
  filterCriticalErrors,
} from '../helpers';

async function setupCodeBlockChat(
  page: Page,
  request: APIRequestContext,
  responseText: string,
  holdStream?: () => Promise<void>,
) {
  const dataDir = process.env.CODEPILOT_E2E_DATA_DIR;
  if (!dataDir) throw new Error('Isolated E2E database required');
  await page.addInitScript(
    (dir) => localStorage.setItem('codepilot:last-working-directory', dir),
    dataDir,
  );

  const created = await request.post('/api/providers', {
    data: {
      name: `Chat Enhanced fixture ${Date.now()}`,
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

  await page.route('**/api/chat/sessions', async (route) => {
    const response = await route.fetch();
    if (route.request().method() === 'POST' && response.ok()) {
      const data = await response.json();
      if (data?.session?.id) sessionIds.push(data.session.id);
    }
    await route.fulfill({ response });
  });

  await page.route('**/api/chat', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    if (holdStream) await holdStream();
    const frames = [
      { type: 'text', data: responseText },
      { type: 'done', data: '' },
    ];
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''),
    });
  });

  return {
    providerId: provider.id,
    sessionIds,
    cleanup: async () => {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      for (const id of sessionIds) {
        await deleteTestSession(page, id);
      }
      await request.delete(`/api/providers/${encodeURIComponent(provider.id)}`).catch(() => {});
    },
  };
}

test.describe('Chat UI Enhanced', () => {
  test.describe('Code Block Display', () => {
    test('code blocks render header bar, language label, and copy button', async ({ page, request }) => {
      const fixture = await setupCodeBlockChat(
        page,
        request,
        'Here is an example:\n\n```javascript\nfunction hello() {\n  return "world";\n}\n```\n',
      );
      try {
        await goToChat(page);
        await page.getByRole('button', { name: /Choose runtime and model|选择 Runtime 和模型/ }).click();
        await page
          .locator(`[data-model-provider-section="${fixture.providerId}"]`)
          .getByRole('button', { name: /^Sonnet 4\.6 sonnet/ })
          .click();
        await sendMessage(page, 'Write a hello world function in JavaScript');

        await expect(assistantMessage(page)).toBeVisible({ timeout: 10_000 });
        await expect(codeBlocks(page).first()).toBeVisible({ timeout: 10_000 });
        await expect(codeBlockLanguageLabel(page)).toContainText(/javascript/i);
        await expect(codeBlockCopyButton(page).first()).toBeVisible();
      } finally {
        await fixture.cleanup();
      }
    });
  });

  test.describe('Tool Call Display', () => {
    test('tool block locators do not throw on clean chat page', async ({ page }) => {
      await goToChat(page);
      expect(await toolBlocks(page).count()).toBeGreaterThanOrEqual(0);
      expect(await toolCallLabels(page).count()).toBeGreaterThanOrEqual(0);
      expect(await toolResultLabels(page).count()).toBeGreaterThanOrEqual(0);
    });
  });

  test.describe('Message Layout', () => {
    test('user and assistant messages render with distinct wrappers', async ({ page, request }) => {
      const fixture = await setupCodeBlockChat(page, request, 'Assistant layout test reply.');
      try {
        await goToChat(page);
        await page.getByRole('button', { name: /Choose runtime and model|选择 Runtime 和模型/ }).click();
        await page
          .locator(`[data-model-provider-section="${fixture.providerId}"]`)
          .getByRole('button', { name: /^Sonnet 4\.6 sonnet/ })
          .click();
        await sendMessage(page, 'Hello layout');

        await expect(userMessage(page)).toBeVisible({ timeout: 10_000 });
        await expect(assistantMessage(page)).toBeVisible({ timeout: 10_000 });
      } finally {
        await fixture.cleanup();
      }
    });
  });

  test.describe('Input Box Features', () => {
    test('textarea renders inside wrapper with send button', async ({ page }) => {
      await goToChat(page);
      const input = chatInput(page);
      await expect(input).toBeVisible();
      await expect(input.locator('..')).toBeVisible();
      await expect(sendButton(page)).toBeVisible();
    });

    test('stop button replaces send button during streaming and halts on click', async ({ page, request }) => {
      let releaseStream!: () => void;
      const streamHeld = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      const fixture = await setupCodeBlockChat(page, request, 'Long story', () => streamHeld);
      const dataDir = process.env.CODEPILOT_E2E_DATA_DIR!;
      const createdSession = await request.post('/api/chat/sessions', {
        data: {
          working_directory: dataDir,
          runtime_id: 'codepilot_runtime',
          provider_id: fixture.providerId,
          model: 'sonnet',
        },
      });
      expect(createdSession.status()).toBe(201);
      const { session } = await createdSession.json();
      fixture.sessionIds.push(session.id);

      try {
        await page.goto(`/chat/${session.id}`);
        await page.waitForLoadState('networkidle');
        await sendMessage(page, 'Tell me a long story');

        const stop = stopButton(page);
        await expect(stop).toBeVisible({ timeout: 10_000 });
        await stop.click();
        releaseStream();

        await expect(sendButton(page)).toBeVisible({ timeout: 10_000 });
      } finally {
        releaseStream();
        await fixture.cleanup();
      }
    });
  });

  test.describe('No Console Errors', () => {
    test('chat page has no console errors', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await goToChat(page);
      const critical = filterCriticalErrors(errors);
      expect(critical).toHaveLength(0);
    });
  });
});
