import { test, expect } from '@playwright/test';

test('TokenDance setup supports cancellable PKCE and manual keys through one entry', async ({ page, request }) => {
  await request.put('/api/settings/app', { data: { settings: { locale: 'zh' } } });
  // Keep this UI test offline. Protocol filtering and actual key exchange are
  // exercised against captured upstream requests in tokendance.test.ts.
  await page.route('**/api/providers/*/discover-models', route => route.fulfill({
    json: { classification: 'api', protocol: 'openai-compatible', ok: true, modelCount: 2, diff: ['deepseek-v4-flash', 'glm-5.3'].map(modelId => ({ modelId, upstreamModelId: modelId, status: 'new' })) },
  }));
  await page.goto('/settings/providers');
  await page.getByRole('button', { name: '添加服务', exact: true }).first().click();
  await page.getByRole('button', { name: /^TokenDance TokenDance/ }).click();
  const dialog = page.getByRole('dialog').last();
  await expect(dialog.getByText('TokenDance 授权', { exact: true })).toBeVisible();
  await dialog.locator('input[type="password"]').fill('manual-fixture-key');
  const pendingStart = page.waitForResponse(r => r.url().endsWith('/api/tokendance/auth') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: '使用授权码', exact: true }).click();
  const start = await (await pendingStart).json();
  const link = dialog.getByRole('link', { name: '打开 TokenDance 授权页面' });
  const authUrl = new URL((await link.getAttribute('href'))!);
  expect(authUrl.searchParams.get('app_url')).toBe('https://www.codepilot.sh/');
  expect(authUrl.searchParams.get('key_name')).toBe('Codepilot');
  expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authUrl.searchParams.has('callback_url')).toBe(false);
  await expect(dialog.getByLabel('一次性授权码')).toBeVisible();
  // Even with a valid manual key, an in-flight authorization must prevent a
  // second save from creating a duplicate connection.
  await expect(dialog.getByRole('button', { name: '连接', exact: true })).toBeDisabled();
  const cancelled = page.waitForResponse(r => r.url().endsWith('/api/tokendance/auth') && r.request().postDataJSON()?.action === 'cancel');
  await dialog.getByRole('button', { name: '取消授权', exact: true }).click();
  await cancelled;
  expect((await (await request.get(`/api/tokendance/auth?flowId=${start.flowId}`)).json()).status).toBe('cancelled');
  await dialog.locator('input[type="password"]').fill('manual-fixture-key');
  const created = page.waitForResponse(r => r.url().endsWith('/api/providers') && r.request().method() === 'POST');
  const applied = page.waitForResponse(r => r.url().endsWith('/discover-models/apply'));
  await dialog.getByRole('button', { name: '连接', exact: true }).click();
  const response = await created; expect(response.status()).toBe(201);
  const { provider } = await response.json();
  try {
    expect((await applied).status()).toBe(200);
    const feed = await (await request.get('/api/providers/models')).json();
    const group = feed.groups.find((g: {provider_id: string}) => g.provider_id === provider.id);
    expect(group.models.map((m: {value: string}) => m.value).sort()).toEqual(['deepseek-v4-flash', 'glm-5.3']);
    for (const model of group.models) {
      expect(model.supportedRuntimes).toContain('codepilot_runtime');
      expect(model.supportedRuntimes).toContain('codex_runtime');
      expect(model.supportedRuntimes).toContain('claude_code');
    }
    expect(provider.preset_key).toBe('tokendance');
    expect(provider.protocol).toBe('openai-compatible');
    expect(provider.api_key).not.toBe('manual-fixture-key');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: '添加服务', exact: true }).first().click();
    await expect(page.getByRole('button', { name: /^TokenDance \(Anthropic\)/ })).toHaveCount(0);
  } finally { await request.delete(`/api/providers/${provider.id}`); }
});

test('One TokenDance connection shows model-level compatibility in all three runtime pickers', async ({ page, request }) => {
  const created = await request.post('/api/providers', { data: {
    name: 'TokenDance picker fixture', preset_key: 'tokendance', protocol: 'openai-compatible', provider_type: 'openai-compatible',
    base_url: 'https://tokendance.space/gateway/v1', api_key: 'fixture-not-a-real-key',
  } });
  expect(created.status()).toBe(201);
  const { provider } = await created.json();
  const sessions: string[] = [];
  try {
    const apply = await request.post(`/api/providers/${provider.id}/discover-models/apply`, {
      data: { upstreamModels: ['glm-5.3', 'kimi-k3'].map(modelId => ({modelId, upstreamModelId: modelId})) },
    });
    expect(apply.status()).toBe(200);
    for (const runtime of ['claude_code', 'codepilot_runtime', 'codex_runtime']) {
      const response = await request.post('/api/chat/sessions', { data: {
        working_directory: process.env.CODEPILOT_E2E_DATA_DIR, runtime_id: runtime, provider_id: provider.id, model: 'glm-5.3',
      } });
      expect(response.status()).toBe(201);
      const { session } = await response.json(); sessions.push(session.id);
      await page.goto(`/chat/${session.id}`);
      await page.getByRole('button', { name: /Choose runtime and model|选择 Runtime 和模型/ }).click();
      const section = page.locator(`[data-model-provider-section="${provider.id}"]`);
      await expect(section).toBeVisible();
      await expect(section.getByRole('button', { name: /glm-5/ }).first()).toBeEnabled();
      await expect(section.getByRole('button', { name: /kimi-k3/ })).toHaveCount(runtime === 'claude_code' ? 0 : 1);
    }
  } finally {
    for (const id of sessions) await request.delete(`/api/chat/sessions/${id}`);
    await request.delete(`/api/providers/${provider.id}`);
  }
});


test('TokenDance provider copy and model filters reflect mixed protocols', async ({ page, request }) => {
  await request.put('/api/settings/app', {data: {settings: {locale: 'zh'}}});
  const created = await request.post('/api/providers', {data: {
    name: 'TokenDance review fixture', preset_key: 'tokendance', protocol: 'openai-compatible', provider_type: 'openai-compatible',
    base_url: 'https://tokendance.space/gateway/v1', api_key: 'fixture-not-a-real-key',
  }});
  expect(created.status()).toBe(201);
  const {provider} = await created.json();
  try {
    expect((await request.post(`/api/providers/${provider.id}/discover-models/apply`, {data: {
      upstreamModels: ['glm-5.3', 'kimi-k3'].map(modelId => ({modelId, upstreamModelId: modelId})),
    }})).status()).toBe(200);
    await page.goto('/settings/providers');
    const card = page.locator(`#provider-card-${provider.id}`);
    await expect(card.getByText('多协议 · 按模型支持', {exact: true})).toBeVisible();
    await card.getByText('多协议 · 按模型支持', {exact: true}).hover();
    await expect(page.getByRole('tooltip')).toContainText('Native/Codex 使用 Chat Completions');
    await page.goto('/settings/models');
    const section = page.locator(`#provider-section-${provider.id}`);
    await expect(section.getByText('多协议 · 按模型支持', {exact: true})).toBeVisible();
    const filter = page.locator('[title="按模型接入能力筛选"]');
    await filter.click();
    await page.getByRole('option', {name: 'CodePilot · Codex', exact: true}).click();
    await expect(page.locator(`[data-model-row="${provider.id}::kimi-k3"]`)).toBeVisible();
    await expect(page.locator(`[data-model-row="${provider.id}::glm-5.3"]`)).toHaveCount(0);
    await filter.click();
    await page.getByRole('option', {name: 'Claude Code 实验', exact: true}).click();
    await expect(page.locator(`[data-model-row="${provider.id}::glm-5.3"]`)).toBeVisible();
    await expect(page.locator(`[data-model-row="${provider.id}::kimi-k3"]`)).toHaveCount(0);
  } finally { await request.delete(`/api/providers/${provider.id}`); }
});
