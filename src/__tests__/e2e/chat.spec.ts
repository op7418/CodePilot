import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import {
  goToChat,
  sendMessage,
  chatInput,
  sendButton,
  stopButton,
  newChatButton,
  sidebar,
  sessionLinks,
  assistantMessage,
  userMessage,
  deleteTestSession,
  collectConsoleErrors,
  filterCriticalErrors,
} from '../helpers';

interface MockChatFixture {
  providerId: string;
  sessionIds: string[];
  cleanup: () => Promise<void>;
}

async function setupMockedChat(
  page: Page,
  request: APIRequestContext,
  options: {
    responseText?: string;
    holdStream?: () => Promise<void>;
  } = {},
): Promise<MockChatFixture> {
  const dataDir = process.env.CODEPILOT_E2E_DATA_DIR;
  if (!dataDir) throw new Error('Isolated E2E database required');
  await page.addInitScript(
    (dir) => localStorage.setItem('codepilot:last-working-directory', dir),
    dataDir,
  );

  const created = await request.post('/api/providers', {
    data: {
      name: `Chat E2E fixture ${Date.now()}`,
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

  await page.route('**/api/chat/sessions/*/messages*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const url = new URL(route.request().url());
    const sessionId = url.pathname.split('/')[4] || 'mock-session';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messages: [
          {
            id: 'mock-user-1',
            session_id: sessionId,
            role: 'user',
            content: 'Test message from Playwright',
            created_at: new Date().toISOString(),
            token_usage: null,
          },
          {
            id: 'mock-assistant-1',
            session_id: sessionId,
            role: 'assistant',
            content: options.responseText ?? 'Hello from mocked E2E stream.',
            created_at: new Date().toISOString(),
            token_usage: null,
          },
        ],
        hasMore: false,
      }),
    });
  });

  await page.route('**/api/chat', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    if (options.holdStream) {
      await options.holdStream();
    }
    const frames = [
      { type: 'text', data: options.responseText ?? 'Hello from mocked E2E stream.' },
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

test.describe('Chat Page', () => {
  test.describe('Page Rendering', () => {
    test('home page redirects to /chat', async ({ page }) => {
      await page.goto('/');
      await page.waitForURL('**/chat');
      expect(page.url()).toContain('/chat');
    });

    test('chat page has no console errors', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await goToChat(page);
      const critical = filterCriticalErrors(errors);
      expect(critical).toHaveLength(0);
    });

    test('chat page shows welcome heading when no messages', async ({ page }) => {
      await goToChat(page);
      await expect(page.locator('main h1').first()).toBeVisible();
      await expect(chatInput(page)).toBeVisible();
    });
  });

  test.describe('Chat UI Elements', () => {
    test('New Chat button is visible in sidebar', async ({ page }) => {
      await goToChat(page);
      await expect(newChatButton(page)).toBeVisible();
    });

    test('chat textarea is visible with non-empty placeholder', async ({ page }) => {
      await goToChat(page);
      const input = chatInput(page);
      await expect(input).toBeVisible();
      const placeholder = await input.getAttribute('placeholder');
      expect(placeholder && placeholder.trim().length > 0).toBeTruthy();
    });

    test('send button is visible', async ({ page }) => {
      await goToChat(page);
      await expect(sendButton(page)).toBeVisible();
    });
  });

  test.describe('Send Message & Streaming', () => {
    test('can type in chat input', async ({ page }) => {
      await goToChat(page);
      const input = chatInput(page);
      await input.fill('Hello, this is a test');
      await expect(input).toHaveValue('Hello, this is a test');
    });

    test('send a message and see user message, assistant reply, URL update, and sidebar entry', async ({ page, request }) => {
      const fixture = await setupMockedChat(page, request, {
        responseText: 'Deterministic assistant reply for chat spec.',
      });
      try {
        await goToChat(page);
        await page.getByRole('button', { name: /Choose runtime and model|选择 Runtime 和模型/ }).click();
        await page
          .locator(`[data-model-provider-section="${fixture.providerId}"]`)
          .getByRole('button', { name: /^Sonnet 4\.6 sonnet/ })
          .click();
        await sendMessage(page, 'Test message from Playwright');

        await page.waitForURL('**/chat/*', { timeout: 15_000 });
        expect(page.url()).toMatch(/\/chat\/.+/);

        await expect(userMessage(page)).toBeVisible({ timeout: 10_000 });
        await expect(userMessage(page)).toContainText('Test message from Playwright');
        await expect(assistantMessage(page)).toBeVisible({ timeout: 10_000 });
        await expect(assistantMessage(page)).toContainText('Deterministic assistant reply');

        await expect(sessionLinks(page).first()).toBeVisible({ timeout: 10_000 });
      } finally {
        await fixture.cleanup();
      }
    });

    test('stop button appears during streaming and clicking it returns send button', async ({ page, request }) => {
      let releaseStream!: () => void;
      const streamHeld = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      const fixture = await setupMockedChat(page, request, {
        holdStream: () => streamHeld,
      });
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
        await sendMessage(page, 'Hold this stream open');

        await expect(stopButton(page)).toBeVisible({ timeout: 10_000 });
        await stopButton(page).click();
        releaseStream();

        await expect(sendButton(page)).toBeVisible({ timeout: 10_000 });
      } finally {
        releaseStream();
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await fixture.cleanup();
      }
    });
  });

  test.describe('Chat History', () => {
    test('sidebar renders chat list surface', async ({ page }) => {
      await goToChat(page);
      await expect(sidebar(page)).toBeVisible();
      await expect(newChatButton(page)).toBeVisible();
    });
  });
});
