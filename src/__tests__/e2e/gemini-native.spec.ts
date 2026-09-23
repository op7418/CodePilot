import { test, expect } from '@playwright/test';
import { goToChat, goToSettingsTab } from '../helpers';

test('connect AI Studio and select Gemini on Native @smoke', async ({ page, request }) => {
  test.setTimeout(90_000);
  // This browser needs English, not the shared E2E database. Restoring a
  // global setting afterwards still races with concurrently running specs.
  await page.route('**/api/settings/app', async route => {
    expect(route.request().method()).toBe('GET');
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, settings: { ...data.settings, locale: 'en' } } });
  });
  let tested = false;
  await page.route('**/api/providers/test', async route => {
    const body = route.request().postDataJSON();
    expect(body.protocol).toBe('google');
    expect(body.presetKey).toBe('google-ai-studio');
    tested = true;
    await route.fulfill({ json: { success: true, message: 'Connection successful' } });
  });
  await page.route('**/api/providers/*/discover-models', route => route.fulfill({ json: {
    ok: true, source: 'remote', modelCount: 1, sampleModelIds: ['gemini-3.8-flash'], fullModelIds: ['gemini-3.8-flash'],
  } }));
  await goToSettingsTab(page, 'providers');
  await page.getByRole('link', { name: 'Providers', exact: true }).click();
  await page.getByRole('button', { name: 'Add service', exact: true }).first().click();
  await page.getByRole('button', { name: /Google AI Studio/ }).click();
  const dialog = page.getByRole('dialog').last();
  await dialog.locator('input[type="password"]').fill('fixture-no-network');
  await dialog.getByRole('button', { name: 'Test', exact: true }).click();
  await expect.poll(() => tested).toBe(true);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/providers') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const { provider } = await response.json();
  try {
    await expect(page.getByRole('dialog')).toHaveCount(0);
    for (const runtime of ['codepilot_runtime', 'claude_code', 'codex_runtime']) {
      const models = await request.get(`/api/providers/models?runtime=${runtime}`);
      expect(models.ok()).toBe(true);
      const { groups } = await models.json();
      const group = groups.find((g: { provider_id: string }) => g.provider_id === provider.id);
      if (runtime === 'codepilot_runtime') {
        expect(group).toBeTruthy();
        expect(group.models.find((m: { value: string }) => m.value === 'gemini-3.8-flash').supportedEffortLevels).toEqual(['low', 'medium', 'high']);
      } else {
        expect(group).toBeUndefined();
      }
    }
    await goToChat(page);
    await page.getByRole('button', { name: 'Choose runtime and model' }).click();
    await page.getByRole('navigation', { name: 'Runtime', exact: true }).getByRole('button', { name: /CodePilot/ }).click();
    const section = page.locator(`[data-model-provider-section="${provider.id}"]`);
    await section.getByRole('button', { name: /Gemini 3.8 Flash/ }).click();
    await expect(page.getByRole('button', { name: 'Choose runtime and model' })).toContainText('Gemini 3.8 Flash');
    await page.screenshot({ path: '/tmp/gemini-native-composer.png', fullPage: true });
  } finally {
    await request.delete(`/api/providers/${provider.id}`).catch(() => {});
  }
});
