import { expect, test, type Page } from '@playwright/test';
import { goToChat, goToSettings } from '../helpers';

type AppSettingsStore = Record<string, string>;

function sseBody(events: Array<{ type: string; data: string }>): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function composerInput(page: Page) {
  return page.locator(
    'textarea[placeholder*="Message"], textarea[placeholder*="消息"], textarea[placeholder*="Claude"], textarea[placeholder*="Send"]'
  ).first();
}

async function installSessionDetailMocks(page: Page, assistantContent: string) {
  await page.route('**/api/chat/sessions/sess-e2e-network', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session: {
          id: 'sess-e2e-network',
          title: 'E2E Network Session',
          working_directory: '/tmp/codepilot-e2e',
          model: 'gpt-5.3-codex-spark',
          provider_id: 'openai-oauth',
          permission_profile: 'default',
          mode: 'code',
          context_summary: '',
        },
      }),
    });
  });

  await page.route('**/api/chat/sessions/sess-e2e-network/messages*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messages: [
          {
            id: 'msg-user-e2e',
            session_id: 'sess-e2e-network',
            role: 'user',
            content: 'network acceptance message',
            created_at: new Date().toISOString(),
            token_usage: null,
          },
          {
            id: 'msg-assistant-e2e',
            session_id: 'sess-e2e-network',
            role: 'assistant',
            content: assistantContent,
            created_at: new Date().toISOString(),
            token_usage: null,
          },
        ],
        hasMore: false,
      }),
    });
  });
}

async function dismissBlockingDialogOverlay(page: Page) {
  const overlay = page.locator('[data-slot="dialog-overlay"][data-state="open"]');
  if (await overlay.count()) {
    await page.keyboard.press('Escape');
    await overlay.first().waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});
  }
}

async function installCommonChatMocks(page: Page) {
  await page.route('**/api/setup/recent-projects*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ projects: [] }),
    });
  });

  await page.route('**/api/setup*', async (route) => {
    const method = route.request().method();
    if (method !== 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        completed: true,
        claude: 'completed',
        provider: 'completed',
        project: 'completed',
        defaultProject: '/tmp/codepilot-e2e',
      }),
    });
  });

  await page.route('**/api/files/browse?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ files: [], directories: [] }),
    });
  });

  await page.route('**/api/settings/workspace', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ path: '', valid: false, state: {} }),
    });
  });

  await page.route('**/api/providers/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        groups: [
          {
            provider_id: 'openai-oauth',
            provider_name: 'OpenAI OAuth',
            models: [{ value: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark' }],
          },
        ],
      }),
    });
  });

  await page.route('**/api/providers/options?providerId=__global__', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        options: {
          default_model: 'gpt-5.3-codex-spark',
          default_model_provider: 'openai-oauth',
        },
      }),
    });
  });

  await page.route('**/api/chat/sessions', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessions: [] }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session: { id: 'sess-e2e-network', title: 'E2E Network Session' },
      }),
    });
  });
}

async function installSettingsAndProviderMocks(page: Page) {
  const appSettings: AppSettingsStore = {
    network_proxy_enabled: '',
    network_proxy_url: '',
    network_no_proxy: '',
    network_proxy_ca_path: '',
  };
  const settingsWrites: Array<Record<string, unknown>> = [];

  await page.route('**/api/setup/recent-projects*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ projects: [] }),
    });
  });

  await page.route('**/api/setup*', async (route) => {
    const method = route.request().method();
    if (method !== 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        completed: true,
        claude: 'completed',
        provider: 'completed',
        project: 'completed',
        defaultProject: '/tmp/codepilot-e2e',
      }),
    });
  });

  await page.route('**/api/files/browse?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ files: [], directories: [] }),
    });
  });

  await page.route('**/api/settings/workspace', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ path: '', valid: false, state: {} }),
    });
  });

  await page.route('**/api/settings/app', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ settings: appSettings }),
      });
      return;
    }

    let body: Record<string, unknown> = {};
    try {
      body = route.request().postDataJSON() as Record<string, unknown>;
    } catch {
      body = {};
    }

    settingsWrites.push(body);
    const settings = (body.settings as Record<string, unknown>) || {};
    for (const [key, value] of Object.entries(settings)) {
      appSettings[key] = String(value ?? '');
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ providers: [], env_detected: {} }),
    });
  });

  await page.route('**/api/openai-oauth/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, email: 'network-e2e@example.com', plan: 'Plus' }),
    });
  });

  await page.route('**/api/providers/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        groups: [
          {
            provider_id: 'openai-oauth',
            provider_name: 'OpenAI OAuth',
            models: [{ value: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark' }],
          },
        ],
      }),
    });
  });

  await page.route('**/api/providers/options?providerId=__global__', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ options: {} }),
    });
  });

  await page.route('**/api/providers/test', async (route) => {
    if (appSettings.network_proxy_enabled === 'true') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: {
          code: 'NETWORK_UNREACHABLE',
          message: 'AI_RetryError: Failed after 3 attempts. Last error: Cannot connect to API: Connect Timeout Error (attempted address: chatgpt.com:443, timeout: 10000ms)',
          suggestion: 'Enable proxy and retry.',
        },
      }),
    });
  });

  return { appSettings, settingsWrites };
}

async function openThirdPartyProviderDialog(page: Page) {
  await goToSettings(page);
  await dismissBlockingDialogOverlay(page);

  const providersTab = page.locator('nav button').filter({ hasText: /Providers|提供商|服务商/ }).first();
  await expect(providersTab).toBeVisible();
  await providersTab.click({ force: true });
  await expect(page.locator('text=/Add Provider|添加提供商/')).toBeVisible();

  const presetName = page.getByText(/^Anthropic Third-party API$/).first();
  await expect(presetName).toBeVisible();

  const row = presetName.locator('xpath=ancestor::div[contains(@class,"flex") and .//button][1]');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /\+\s*(Connect|连接)/ }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.locator('input[placeholder="https://api.example.com"]').fill('https://chatgpt.com');
  await dialog.locator('input[type="password"]').fill('sk-e2e-network');

  return dialog;
}

async function setNetworkProxy(page: Page, enabled: boolean) {
  await goToSettings(page);
  await dismissBlockingDialogOverlay(page);

  const proxyUrlInput = page.locator('input[placeholder*="127.0.0.1:7890"]').first();
  await expect(proxyUrlInput).toBeVisible();

  if (enabled) {
    await proxyUrlInput.fill('http://127.0.0.1:7890');
  } else {
    await proxyUrlInput.fill('');
  }

  const proxyBlock = proxyUrlInput.locator('xpath=ancestor::div[contains(@class,"max-w-md")][1]');
  const switchButton = proxyBlock.locator('[role="switch"]').first();
  await expect(switchButton).toBeVisible();

  const state = await switchButton.getAttribute('data-state');
  const isChecked = state === 'checked';
  if (isChecked !== enabled) {
    await switchButton.click();
  }

  await dismissBlockingDialogOverlay(page);
}

test.describe('Network Acceptance', () => {
  test('chat surfaces AI_RetryError timeout details', async ({ page }) => {
    await installCommonChatMocks(page);
    await installSessionDetailMocks(
      page,
      '**Error:** AI_RetryError: Failed after 3 attempts. Last error: Cannot connect to API: Connect Timeout Error (attempted address: chatgpt.com:443, timeout: 10000ms)'
    );
    await page.route('**/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody([
          {
            type: 'error',
            data: JSON.stringify({
              category: 'NETWORK_UNREACHABLE',
              userMessage: 'AI_RetryError: Failed after 3 attempts. Last error: Cannot connect to API: Connect Timeout Error (attempted address: chatgpt.com:443, timeout: 10000ms)',
              actionHint: 'Check proxy settings and endpoint availability.',
            }),
          },
          { type: 'done', data: '' },
        ]),
      });
    });

    await goToChat(page);
    await expect(composerInput(page)).toBeVisible();
    await expect(composerInput(page)).toBeEnabled({ timeout: 10_000 });
    await composerInput(page).fill('network timeout acceptance check');
    await composerInput(page).press('Enter');

    await page.waitForURL('**/chat/*', { timeout: 15_000 });
    await expect(page.locator('text=AI_RetryError: Failed after 3 attempts')).toBeVisible();
    await expect(page.locator('text=Connect Timeout Error')).toBeVisible();
  });

  test('chat surfaces no-output stream error', async ({ page }) => {
    await installCommonChatMocks(page);
    await installSessionDetailMocks(page, '**Error:** No output generated. Check the stream for errors.');
    await page.route('**/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody([
          { type: 'error', data: 'No output generated. Check the stream for errors.' },
          { type: 'done', data: '' },
        ]),
      });
    });

    await goToChat(page);
    await expect(composerInput(page)).toBeVisible();
    await expect(composerInput(page)).toBeEnabled({ timeout: 10_000 });
    await composerInput(page).fill('no output acceptance check');
    await composerInput(page).press('Enter');

    await page.waitForURL('**/chat/*', { timeout: 15_000 });
    await expect(page.locator('text=No output generated. Check the stream for errors.')).toBeVisible();
  });

  test('provider connectivity reflects proxy off/on states (Codex-style endpoint)', async ({ page }) => {
    const { settingsWrites } = await installSettingsAndProviderMocks(page);

    await setNetworkProxy(page, false);
    const dialogWhenOff = await openThirdPartyProviderDialog(page);
    await dialogWhenOff.locator('button').filter({ hasText: /Test|测试连接/ }).click();
    await expect(dialogWhenOff.locator('text=AI_RetryError: Failed after 3 attempts')).toBeVisible();
    await expect(dialogWhenOff.locator('text=Connect Timeout Error')).toBeVisible();
    await dialogWhenOff.locator('button').filter({ hasText: /Cancel|取消/ }).click();

    await setNetworkProxy(page, true);
    const dialogWhenOn = await openThirdPartyProviderDialog(page);
    await dialogWhenOn.locator('button').filter({ hasText: /Test|测试连接/ }).click();
    await expect(dialogWhenOn.locator('text=/Connection successful|连接成功/')).toBeVisible();

    const wroteProxyOn = settingsWrites.some((body) => {
      const settings = (body.settings as Record<string, unknown>) || {};
      return settings.network_proxy_enabled === 'true';
    });

    expect(settingsWrites.length).toBeGreaterThan(0);
    expect(wroteProxyOn).toBe(true);
  });
});
