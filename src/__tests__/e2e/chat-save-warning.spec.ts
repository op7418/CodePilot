import { test, expect } from '@playwright/test';
import { goToChat, goToConversation } from '../helpers';
import { CHAT_SAVE_UNCONFIRMED } from '../../lib/chat-collection-response';
import { translate } from '../../i18n';

for (const entry of ['new', 'existing', 'trimmed-existing', 'detached-existing', 'healthy-new'] as const) {
  test(`${entry} chat retains the reply and shows save failure honestly @smoke`, async ({ page, request }) => {
    test.setTimeout(90_000);
    const dataDir = process.env.CODEPILOT_E2E_DATA_DIR;
    if (!dataDir) throw new Error('Isolated E2E database required');
    const existing = entry.endsWith('existing');
    const locale = existing ? 'en' : 'zh';
    await page.addInitScript((dir) => localStorage.setItem('codepilot:last-working-directory', dir), dataDir);
    const created = await request.post('/api/providers', { data: {
      name: 'Save warning fixture', provider_type: 'anthropic', protocol: 'anthropic',
      preset_key: 'anthropic-official', base_url: 'https://api.anthropic.com', api_key: 'fixture-no-network',
    } });
    expect(created.ok()).toBe(true);
    const { provider } = await created.json();
    const sessions: string[] = [];
    let finishDetached!: () => void;
    const detachedGate = new Promise<void>(resolve => { finishDetached = resolve; });
    try {
      expect((await request.put('/api/settings/app', { data: { settings: {
        locale, agent_runtime: 'codepilot_runtime', default_provider_id: provider.id, default_model: 'sonnet',
      } } })).ok()).toBe(true);
      await page.route('**/api/chat/sessions', async (route) => {
        const response = await route.fetch();
        if (route.request().method() === 'POST' && response.ok()) {
          const data = await response.json();
          sessions.push(data.session.id);
        }
        await route.fulfill({ response });
      });
      const submitted: string[] = [];
      await page.route('**/api/chat', async (route) => {
        submitted.push(route.request().postDataJSON().session_id);
        if (entry === 'detached-existing' && submitted.length === 1) await detachedGate;
        const frames = [
          { type: 'text', data: submitted.length === 1 ? 'Reply available to copy before refresh.' : 'Second reply in the same chat.' },
          { type: 'done', data: '' },
          ...(entry === 'healthy-new' || submitted.length > 1 ? [] : [{ type: 'error', data: CHAT_SAVE_UNCONFIRMED }]),
        ];
        await route.fulfill({ status: 200, contentType: 'text/event-stream',
          body: frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''),
        });
      });
      let historyReads = 0;
      if (entry === 'trimmed-existing' || entry === 'detached-existing') {
        await page.route('**/api/chat/sessions/*/messages?*', async route => {
          historyReads++;
          const url = new URL(route.request().url());
          const end = Number(url.searchParams.get('before') || 401);
          const count = entry === 'detached-existing' ? 1 : Number(url.searchParams.get('limit') || 30);
          const sessionId = url.pathname.split('/')[4];
          const messages = Array.from({ length: count }, (_, i) => ({
            id: `history-${end - count + i}`, _rowid: end - count + i, session_id: sessionId,
            role: 'user', content: `Earlier message ${end - count + i}`,
            created_at: new Date(2026, 0, 1, 0, end - count + i).toISOString(), token_usage: null,
          }));
          await route.fulfill({ json: { messages, hasMore: entry === 'trimmed-existing' } });
        });
      }
      if (existing) {
        const response = await request.post('/api/chat/sessions', { data: {
          working_directory: dataDir, runtime_id: 'codepilot_runtime', provider_id: provider.id, model: 'sonnet',
        } });
        expect(response.status()).toBe(201);
        const { session } = await response.json();
        sessions.push(session.id);
        await goToConversation(page, session.id);
      } else {
        await goToChat(page);
        await page.getByRole('button', { name: /Choose runtime and model|选择 Runtime 和模型/ }).click();
        await page.locator(`[data-model-provider-section="${provider.id}"]`).getByRole('button', { name: /^Sonnet 4\.6 sonnet/ }).click();
      }
      const input = page.locator('textarea[name="message"]').first();
      await expect(input).toBeVisible();
      if (entry === 'trimmed-existing') {
        // 30 initial + 3 * 100 older rows crosses the real 300-row window cap.
        for (let i = 0; i < 3; i++) {
          const reads = historyReads;
          await page.getByRole('button', { name: 'Load earlier messages' }).click();
          await expect.poll(() => historyReads).toBeGreaterThan(reads);
        }
      }
      await input.fill('Check save warning');
      await input.press('Enter');
      await expect.poll(() => submitted.length).toBe(1);
      if (entry === 'detached-existing') {
        await page.evaluate(() => {
          window.addEventListener('stream-session-event', (event) => {
            const detail = (event as CustomEvent).detail;
            if (detail.type === 'completed' && detail.snapshot.saveUnconfirmed) {
              document.documentElement.dataset.saveWarningCompleted = 'true';
            }
          });
        });
        // SPA navigation preserves the manager-owned reader while ChatView unmounts.
        await page.locator('a[href="/settings"]').first().click();
        await expect(page).toHaveURL(/\/settings/);
        finishDetached();
        await expect(page.locator('html')).toHaveAttribute('data-save-warning-completed', 'true');
        await page.goBack();
        await expect(page).toHaveURL(new RegExp(`/chat/${sessions[0]}$`));
      }
      if (entry === 'healthy-new') {
        await expect(page).toHaveURL(/\/chat\/[^/?#]+$/);
        await expect(page.getByText(translate(locale, 'chat.error.saveUnconfirmed'), { exact: false })).toHaveCount(0);
      } else {
        await expect(page.getByText(translate(locale, 'chat.error.saveUnconfirmed'), { exact: false }).first()).toBeVisible();
        await expect(page.getByText('Reply available to copy before refresh.', { exact: false }).first()).toBeVisible();
        await expect(page.getByText(CHAT_SAVE_UNCONFIRMED, { exact: false })).toHaveCount(0);
        if (entry === 'new') await expect(page).toHaveURL(/\/chat$/);
        if (entry === 'trimmed-existing') {
          await expect.poll(() => historyReads).toBeGreaterThanOrEqual(5);
        }
        // The warning can render in the last streaming frame. Wait for the
        // first turn (and the new-entry handoff) to finish before sending again.
        await expect(page.getByRole('button', { name: /^(Stop|停止)/ })).toHaveCount(0);
        await input.fill('Continue in this chat');
        await input.press('Enter');
        await expect.poll(() => submitted.length).toBe(2);
        await expect(page.getByText('Second reply in the same chat.', { exact: false }).first()).toBeVisible();
        await expect(page.getByText('Reply available to copy before refresh.', { exact: false }).first()).toBeVisible();
        await expect(page.getByText(translate(locale, 'chat.error.saveUnconfirmed'), { exact: false }).first()).toBeVisible();
        expect(sessions).toHaveLength(1);
        expect(submitted).toEqual([sessions[0], sessions[0]]);
        if (entry === 'new') await expect(page).toHaveURL(/\/chat$/);
        await page.screenshot({ path: `/tmp/codepilot-save-warning-${entry}.png` });
      }
    } finally {
      finishDetached();
      for (const id of sessions) await request.delete(`/api/chat/sessions/${id}`);
      await request.delete(`/api/providers/${provider.id}`);
    }
  });
}
