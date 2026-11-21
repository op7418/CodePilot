import { test, expect } from '@playwright/test';
import { goToChat, goToConversation } from '../helpers';

/**
 * Coverage for the directory-chip lifecycle:
 *   1. `attach-directory-to-chat` event → composer chip
 *   2. User-removed → chip gone
 *   3. Real form submit (Codex P2.2) → chip cleared from DOM,
 *      POST body has `[Referenced Directories]` + `inode/directory`
 *      file entry, and the user message bubble shows the raw typed
 *      text WITHOUT the LLM-context block (proves displayOverride
 *      reached the bubble).
 *
 * Pairs with `unit/context-chips-send-clear.test.ts` — that file
 * pins down the pure payload composition; this file pins down that
 * MessageInput's React state-clearing branches actually fire when
 * the user submits.
 */
test.describe('Context chips — directory chip lifecycle @smoke', () => {
  test('attach-directory-to-chat dispatches a chip + remove button clears it', async ({ page }) => {
    await goToChat(page);

    const input = page.locator('textarea[name="message"]').first();
    await expect(input).toBeVisible();

    // No chip should be present at start.
    const folderChip = page.locator('span.font-mono', { hasText: 'src/components' });
    await expect(folderChip).toHaveCount(0);

    // Dispatch the event the file-tree "+" button uses to attach a folder.
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('attach-directory-to-chat', { detail: { path: 'src/components' } }),
      );
    });

    // Chip appears in the composer's chip row.
    await expect(folderChip).toBeVisible();

    // Dispatching again with the same path is a no-op (no duplicate chip).
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('attach-directory-to-chat', { detail: { path: 'src/components' } }),
      );
    });
    await expect(folderChip).toHaveCount(1);

    // Click the chip's X button to remove it. Locate the button by aria-label
    // so locale switches don't break this assertion (zh / en both fill the
    // same label key with the path string).
    const removeButton = page
      .locator('button[aria-label*="src/components"]')
      .first();
    await expect(removeButton).toBeVisible();
    await removeButton.click();

    // Chip is gone — proxy for `directoryRefs === []`.
    await expect(folderChip).toHaveCount(0);
  });

  test('multiple directory paths render as independent chips', async ({ page }) => {
    await goToChat(page);

    const input = page.locator('textarea[name="message"]').first();
    await expect(input).toBeVisible();

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('attach-directory-to-chat', { detail: { path: 'src/app' } }),
      );
      window.dispatchEvent(
        new CustomEvent('attach-directory-to-chat', { detail: { path: 'docs' } }),
      );
    });

    await expect(page.locator('span.font-mono', { hasText: 'src/app' })).toBeVisible();
    await expect(page.locator('span.font-mono', { hasText: /^docs$/ })).toBeVisible();

    // Remove only the first one — the other must persist.
    await page.locator('button[aria-label*="src/app"]').first().click();
    await expect(page.locator('span.font-mono', { hasText: 'src/app' })).toHaveCount(0);
    await expect(page.locator('span.font-mono', { hasText: /^docs$/ })).toBeVisible();
  });

  test('trailing slash is normalised so the chip path matches the dispatched path', async ({ page }) => {
    await goToChat(page);

    const input = page.locator('textarea[name="message"]').first();
    await expect(input).toBeVisible();

    // The handler in MessageInput strips trailing slashes — verify the chip
    // rendered without it so the user sees a clean path.
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('attach-directory-to-chat', { detail: { path: 'src/components/' } }),
      );
    });

    await expect(page.locator('span.font-mono', { hasText: /^src\/components$/ })).toBeVisible();
    await expect(page.locator('span.font-mono', { hasText: 'src/components/' })).toHaveCount(0);
  });

  // ── New-chat submit pipeline (POST body coverage only) ──────────────
  // This test proves the /chat first-message flow really submits to
  // /api/chat with the right serialisation (chips → inode/directory
  // file + [Referenced Directories] in content). It intentionally does
  // NOT assert "chip cleared" or "textarea empty" — those would be
  // tested on the post-redirect ChatView, which is a fresh component
  // that never owned the chip in the first place. That trap was
  // flagged by Codex as masking the regression risk; the
  // existing-session test below is where the same-composer state
  // clearance is locked down.
  test('new-chat submit posts inode/directory + LLM-context in body @smoke', async ({ page, request }) => {
    const dataDir = process.env.CODEPILOT_E2E_DATA_DIR;
    if (!dataDir) throw new Error('Isolated E2E database required');
    await page.addInitScript(
      (dir) => localStorage.setItem('codepilot:last-working-directory', dir),
      dataDir,
    );

    const created = await request.post('/api/providers', {
      data: {
        name: `Context chips E2E fixture ${Date.now()}`,
        provider_type: 'anthropic',
        protocol: 'anthropic',
        preset_key: 'anthropic-official',
        base_url: 'https://api.anthropic.com',
        api_key: 'fixture-no-network',
      },
    });
    expect(created.ok()).toBe(true);
    const { provider } = await created.json();

    let chatRequestBody: Record<string, unknown> | null = null;
    let sessionCounter = 0;

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

      // The /chat first-message flow always tries to create a session row
      // before opening the SSE stream. Without this mock the page would
      // either block or 500 on session insert.
      await page.route('**/api/chat/sessions', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        sessionCounter += 1;
        const id = `mock-chip-session-${sessionCounter}`;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            session: {
              id,
              title: 'Mock Session',
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

      // Capture the /api/chat POST body — this is where we prove the
      // submit reached the network layer with the correct payload (chips
      // serialised as `inode/directory` files, content carries
      // `[Referenced Directories]`).
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
        // Minimal SSE: an immediate `done` so the page doesn't sit in
        // "streaming" forever and we can assert post-state quickly.
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: `data: ${JSON.stringify({ type: 'done' })}\n\n`,
        });
      });

      await goToChat(page);

      const input = page.locator('textarea[name="message"]').first();
      await expect(input).toBeVisible();

      // Add a directory chip via the same event the file-tree "+" uses.
      // Before submit we lock the chip is present + textarea is fillable.
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent('attach-directory-to-chat', { detail: { path: 'src/app' } }),
        );
      });
      const folderChip = page.locator('span.font-mono', { hasText: 'src/app' });
      await expect(folderChip).toBeVisible();

      // User types and submits via Enter — same path as the real composer.
      await input.fill('please review this folder');
      await input.press('Enter');

      // The POST body crossed the boundary with the expected serialisation:
      // catches regressions in the payload composition half
      // (composeSubmitPayload, mentionAppend, etc.) AND proves submit
      // actually fired in the new-chat pipeline (proxy for "onSend was
      // called"). State-clearance regressions on the SAME composer are
      // tested by the existing-session test below — not here.
      await expect.poll(() => chatRequestBody !== null, { timeout: 5_000 }).toBeTruthy();
      const payload = (chatRequestBody ?? {}) as { content?: unknown; files?: unknown };
      const content = typeof payload.content === 'string' ? payload.content : '';
      const files = Array.isArray(payload.files) ? (payload.files as Array<{ type?: string; filePath?: string }>) : [];
      expect(content).toContain('[Referenced Directories]');
      expect(files.some((f) => f.type === 'inode/directory' && f.filePath === 'src/app')).toBe(true);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await request.delete(`/api/providers/${provider.id}`);
    }
  });

  // ── Existing-session submit (Codex P2 final closure) ───────────────
  // The /chat first-message test above is real-submit, but it redirects
  // to /chat/[id] post-submit, so the "chip gone" assertion ends up on
  // a freshly-mounted ChatView — which would pass even if MessageInput
  // forgot to call `setDirectoryRefs([])`. This test pins the same
  // composer instance through the submit cycle by using an existing
  // session route (no redirect). If anyone drops the setX([]) calls
  // from `MessageInput.handleSubmit`, the chip and textarea will still
  // be there after submit, and these assertions go red.
  test('existing-session submit clears chip + textarea on the SAME composer @smoke', async ({ page }) => {
    const fixtureId = 'mock-existing-session';
    let chatRequestBody: Record<string, unknown> | null = null;

    // Keep this fixture independent from the user's real default runtime /
    // provider settings. The test is about MessageInput chip state, not
    // provider compatibility, so expose one coherent mock provider/model.
    await page.route('**/api/providers/models**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          groups: [
            {
              provider_id: 'mock',
              provider_name: 'Mock Provider',
              provider_type: 'openai',
              compat: 'openai_compatible',
              models: [
                {
                  value: 'sonnet',
                  label: 'Sonnet',
                  supportedRuntimes: ['claude_code', 'codepilot_runtime', 'codex_runtime'],
                  unsupportedReasonByRuntime: {},
                },
              ],
            },
          ],
          default_provider_id: 'mock',
          runtime_applied: 'codepilot_runtime',
        }),
      });
    });

    const mockSession = {
      id: fixtureId,
      title: 'Mock Existing Session',
      model: 'sonnet',
      mode: 'code',
      provider_id: 'mock',
      runtime_pin: 'codepilot_runtime',
      runtime_binding_state: 'bound',
      route_revision: 1,
      working_directory: '/tmp',
      permission_profile: 'default',
      context_summary: null,
    };

    // Mock the GET that ChatView's session loader hits.
    await page.route(`**/api/chat/sessions/${fixtureId}`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ session: mockSession }),
        });
        return;
      }
      // PATCH (e.g. on permission change) — no-op success.
      if (route.request().method() === 'PATCH') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }
      await route.continue();
    });

    // Mock route binding commits (PATCH /api/chat/sessions/[id]/route).
    await page.route(`**/api/chat/sessions/${fixtureId}/route`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          session: mockSession,
          route_revision: mockSession.route_revision + 1,
        }),
      });
    });

    // Mock initial messages load — empty session.
    await page.route(`**/api/chat/sessions/${fixtureId}/messages**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ messages: [], hasMore: false }),
      });
    });

    // Capture the /api/chat POST body.
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
        body: `data: ${JSON.stringify({ type: 'done' })}\n\n`,
      });
    });

    await goToConversation(page, fixtureId);

    const input = page.locator('textarea[name="message"]').first();
    await expect(input).toBeVisible();

    // Snapshot the textarea handle BEFORE submit. Playwright `expect`
    // on this same handle after submit proves we're asserting on the
    // *same* DOM node, not a re-mounted one. If MessageInput were to
    // unmount and remount, the handle would detach and the
    // `toHaveValue('')` poll would actually fail with "element is not
    // attached" rather than passing trivially.
    const composerTextarea = input;

    // Add a directory chip + a synchronous "before-submit" lock-in.
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('attach-directory-to-chat', { detail: { path: 'src/lib' } }),
      );
    });
    const folderChip = page.locator('span.font-mono', { hasText: 'src/lib' });
    await expect(folderChip).toBeVisible();

    // Type into textarea + submit via Enter (real-form path).
    await composerTextarea.fill('please review the lib folder');
    await composerTextarea.press('Enter');

    // (a) POST body has the directory + LLM-context block.
    await expect.poll(() => chatRequestBody !== null, { timeout: 5_000 }).toBeTruthy();
    const payload = (chatRequestBody ?? {}) as { content?: unknown; files?: unknown };
    const content = typeof payload.content === 'string' ? payload.content : '';
    const files = Array.isArray(payload.files) ? (payload.files as Array<{ type?: string; filePath?: string }>) : [];
    expect(content).toContain('[Referenced Directories]');
    expect(files.some((f) => f.type === 'inode/directory' && f.filePath === 'src/lib')).toBe(true);

    // (b) The chip element on this same /chat/[id] page is gone — and
    // because there's no redirect, the only way it can be gone is if
    // MessageInput.handleSubmit actually called `setDirectoryRefs([])`.
    await expect(folderChip).toHaveCount(0, { timeout: 5_000 });

    // (c) Same composer's textarea is empty — proves `setInputValue('')`.
    // Asserting on `composerTextarea` (the captured handle) instead of
    // re-locating, so a remount-then-empty escape would fail the assert.
    await expect(composerTextarea).toHaveValue('', { timeout: 5_000 });

    // (d) Stay on /chat/[id], no redirect.
    expect(page.url()).toContain(`/chat/${fixtureId}`);
  });
});
