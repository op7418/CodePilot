import { test, expect } from '@playwright/test';
import { goToChat } from '../helpers';

/**
 * First-message composer clear — the lingering-text bug (behavioral lock).
 *
 * The /chat new-chat composer is a single stable-keyed MessageInput that no
 * longer remounts at the isStreaming flip (#615), and `sendFirstMessage` does
 * not resolve until the whole stream ends. So MessageInput clears the composer
 * OPTIMISTICALLY at submit (before `await onSend`), not after delivery — without
 * that, the just-sent text sat in the box for the entire turn.
 *
 * Why a dedicated e2e: the "new-chat submit" test in
 * context-chips-send-clear.spec.ts deliberately can NOT assert this — it lets
 * /api/chat finish, which redirects to a fresh ChatView that masks whether the
 * original composer cleared (Codex flagged that trap). Here we HOLD the
 * /api/chat response open so the page stays on /chat (no redirect) and assert
 * the SAME composer empties right after submit. A regression to "clear after
 * await onSend" leaves the text in the box → this goes red.
 *
 * Pairs with unit/composer-first-message-clear.test.ts (source-pin).
 */
test.describe('First-message composer clears optimistically @smoke', () => {
  test('typed first message clears the composer at submit, before any redirect', async ({ page, request }) => {
    const dataDir = process.env.CODEPILOT_E2E_DATA_DIR;
    if (!dataDir) throw new Error('Isolated E2E database required');
    await page.addInitScript(
      (dir) => localStorage.setItem('codepilot:last-working-directory', dir),
      dataDir,
    );

    const created = await request.post('/api/providers', {
      data: {
        name: `First-message E2E fixture ${Date.now()}`,
        provider_type: 'anthropic',
        protocol: 'anthropic',
        preset_key: 'anthropic-official',
        base_url: 'https://api.anthropic.com',
        api_key: 'fixture-no-network',
      },
    });
    expect(created.ok()).toBe(true);
    const { provider } = await created.json();

    try {
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

      // Session insert the first-message flow does before opening the stream.
      await page.route('**/api/chat/sessions', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            session: {
              id: 'mock-first-msg-session',
              title: 'Mock',
              model: 'sonnet',
              mode: 'code',
              provider_id: provider.id,
              runtime_pin: 'codepilot_runtime',
              runtime_binding_state: 'bound',
              route_revision: 1,
              working_directory: dataDir,
            },
          }),
        });
      });

      // HOLD the /api/chat response so sendFirstMessage stays mid-"stream" (no
      // router.push), keeping us on the SAME /chat composer to assert on.
      let chatHit = false;
      await page.route('**/api/chat', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        chatHit = true;
        await new Promise((r) => setTimeout(r, 4000));
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: `data: ${JSON.stringify({ type: 'done' })}\n\n`,
        });
      });

      await goToChat(page);

      const input = page.locator('textarea[name="message"]').first();
      await expect(input).toBeVisible();

      await input.fill('hello first message');
      await expect(input).toHaveValue('hello first message');
      await input.press('Enter');

      await expect.poll(() => chatHit, { timeout: 5_000 }).toBeTruthy();

      // Optimistic clear: the SAME composer empties immediately, while /api/chat
      // is still "streaming" (held) and BEFORE any redirect to /chat/[id].
      await expect(input).toHaveValue('', { timeout: 2_000 });

      // Proves we asserted on the new-chat composer, not a post-redirect ChatView.
      expect(page.url()).not.toMatch(/\/chat\/[^/?#]+/);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await request.delete(`/api/providers/${provider.id}`);
    }
  });
});
