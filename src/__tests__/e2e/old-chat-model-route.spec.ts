import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';

test('existing chats can save another model through the HTTP route and picker', async ({ request, page }) => {
  test.setTimeout(90_000);
  const created = await request.post('/api/providers', { data: {
    name: 'Old chat route diagnostic', provider_type: 'anthropic', protocol: 'anthropic',
    preset_key: 'glm-cn', base_url: 'https://open.bigmodel.cn/api/anthropic',
    api_key: 'diagnosis-fixture-not-a-real-key',
  } });
  expect(created.ok()).toBe(true);
  const { provider } = await created.json();
  // Model management materializes the catalog rows; keep this HTTP control
  // separate from the independently reproduced catalog-only validation gap.
  expect((await request.get(`/api/providers/${provider.id}/models`)).ok()).toBe(true);
  const otherResponse = await request.post('/api/providers', { data: {
    name: 'Switch target DeepSeek', provider_type: 'anthropic', protocol: 'anthropic',
    preset_key: 'deepseek', base_url: 'https://api.deepseek.com/anthropic',
    api_key: 'diagnosis-fixture-not-a-real-key',
  } });
  expect(otherResponse.ok()).toBe(true);
  const { provider: other } = await otherResponse.json();
  // This provider intentionally has no materialized rows. Catalog models in
  // the picker must be selectable without visiting Settings first.
  const dataDir = process.env.CODEPILOT_E2E_DATA_DIR;
  if (!dataDir || !path.basename(dataDir).startsWith('codepilot-playwright-db-')) {
    throw new Error('Route fixture requires the isolated Playwright database');
  }
  const db = new Database(path.join(dataDir, 'codepilot.db'));
  const sessions: string[] = [];
  try {
    for (const runtime of ['claude_code', 'codepilot_runtime', 'codex_runtime']) {
      const response = await request.post('/api/chat/sessions', { data: {
        working_directory: dataDir, runtime_id: runtime, provider_id: provider.id, model: 'sonnet',
      } });
      expect(response.status(), await response.text()).toBe(201);
      const { session } = await response.json();
      sessions.push(session.id);
      db.prepare("UPDATE chat_sessions SET runtime_binding_state = 'bound', runtime_binding_source = 'legacy_pin' WHERE id = ?").run(session.id);
      const changed = await request.patch(`/api/chat/sessions/${session.id}/route`, { data: {
        runtime_id: runtime, provider_instance_id: provider.id, model_id: 'haiku', expected_route_revision: 0,
      } });
      expect(changed.status(), `${runtime}: ${await changed.text()}`).toBe(200);
      const result = await changed.json();
      expect(result.session.model).toBe('haiku');
      expect(result.session.runtime_binding_state).toBe('bound');
      expect(result.route_revision).toBe(1);
      db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run(
        `diagnosis-${session.id}`, session.id, 'user', 'Historical fixture message',
      );
      await page.goto(`/chat/${session.id}`);
      await page.getByRole('button', { name: /Choose runtime and model|选择 Runtime 和模型/ }).click();
      const section = page.locator(`[data-model-provider-section="${provider.id}"]`);
      const saved = page.waitForResponse(r => r.url().endsWith(`/api/chat/sessions/${session.id}/route`) && r.request().method() === 'PATCH');
      await section.getByRole('button', { name: /^GLM-5.3 sonnet/ }).click();
      const savedResponse = await saved;
      expect(savedResponse.status(), `${runtime} picker: ${await savedResponse.text()}`).toBe(200);
      const savedBody = await savedResponse.json();
      expect(savedBody.session.model).toBe('sonnet');
      expect(savedBody.route_revision).toBe(2);
      const sessionCount = db.prepare('SELECT COUNT(*) AS n FROM chat_sessions').get();
      const messagesBefore = db.prepare('SELECT * FROM messages WHERE session_id = ?').all(session.id);
      await page.getByRole('button', { name: /Choose runtime and model|选择 Runtime 和模型/ }).click();
      const switched = page.waitForResponse(r => r.url().endsWith(`/api/chat/sessions/${session.id}/route`) && r.request().method() === 'PATCH');
      await page.locator(`[data-model-provider-section="${other.id}"]`)
        .getByRole('button', { name: /^DeepSeek V4 Flash deepseek-v4-flash/ }).click();
      const switchedResponse = await switched;
      expect(switchedResponse.status(), `${runtime} provider switch: ${await switchedResponse.text()}`).toBe(200);
      const switchedBody = await switchedResponse.json();
      expect(switchedBody.session.id).toBe(session.id);
      expect(switchedBody.session.provider_id).toBe(other.id);
      expect(switchedBody.session.model).toBe('deepseek-v4-flash');
      expect(switchedBody.session.runtime_pin).toBe(runtime);
      expect(switchedBody.route_revision).toBe(3);
      await expect(page).toHaveURL(new RegExp(`/chat/${session.id}$`));
      expect(db.prepare('SELECT COUNT(*) AS n FROM chat_sessions').get()).toEqual(sessionCount);
      expect(db.prepare('SELECT * FROM messages WHERE session_id = ?').all(session.id)).toEqual(messagesBefore);
      const crossRuntime = await request.patch(`/api/chat/sessions/${session.id}/route`, { data: {
        runtime_id: runtime === 'claude_code' ? 'codex_runtime' : 'claude_code',
        provider_instance_id: other.id, model_id: 'deepseek-v4-flash', expected_route_revision: 3,
      } });
      expect(crossRuntime.status()).toBe(409);
      expect((await crossRuntime.json()).code).toBe('RUNTIME_OWNERSHIP_CONFLICT');
    }
  } finally {
    db.close();
    for (const id of sessions) await request.delete(`/api/chat/sessions/${id}`);
    await request.delete(`/api/providers/${provider.id}`);
    await request.delete(`/api/providers/${other.id}`);
  }
});
