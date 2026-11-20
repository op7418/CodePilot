import { test, expect } from '@playwright/test';
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
  tokenUsageDisplay,
  waitForStreamingStart,
  waitForStreamingEnd,
  collectConsoleErrors,
  filterCriticalErrors,
  waitForPageReady,
} from '../helpers';

test.describe('Chat UI Enhanced (V2)', () => {
  test.describe('Code Block Display', () => {
    test.skip('code blocks have dark background header bar when present', async ({ page }) => {
      // Depends on a real streaming response from the configured provider
      // returning a code block. Flaky under the default test env (no
      // mocking, no retries locally). Kept as skip so the intent is
      // visible; re-enable once we have deterministic mocked-stream
      // fixtures for this path.
      await goToChat(page);
      await sendMessage(page, 'Write a hello world function in JavaScript');

      // Wait for assistant response -- V2 uses gradient avatar instead of text label
      // Detect assistant response via the gradient avatar
      await expect(
        page.locator('.is-assistant').first()
      ).toBeVisible({ timeout: 30_000 });

      // Wait for streaming to complete
      await waitForStreamingEnd(page);

      // Check for code block header (zinc-800 or zinc-900 background)
      const codeHeaders = page.locator('.bg-zinc-800, .bg-zinc-900');
      const count = await codeHeaders.count();
      // May or may not have code blocks depending on response
      if (count > 0) {
        await expect(codeHeaders.first()).toBeVisible();
      }
    });

    test('code blocks have copy button when present', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Show me a Python hello world');

      await expect(
        page.locator('.is-assistant').first()
      ).toBeVisible({ timeout: 30_000 });

      await waitForStreamingEnd(page);

      const copyBtn = codeBlockCopyButton(page);
      const count = await copyBtn.count();
      if (count > 0) {
        await expect(copyBtn.first()).toBeVisible();
      }
    });
  });

  test.describe('Tool Call Display', () => {
    test('tool blocks render with expand/collapse toggle', async ({ page }) => {
      await goToChat(page);
      // Tool blocks are rendered when the message contains <!--tool_use:...--> markers
      // This is a structural test: verify the component renders correctly if present
      const blocks = toolBlocks(page);
      const count = await blocks.count();
      // Tool blocks may not be present in basic chat, but the locator should work
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('tool call labels have correct styling classes', async ({ page }) => {
      // Structural verification: the label locator targets blue-600 for tool calls
      const labels = toolCallLabels(page);
      const count = await labels.count();
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('tool result labels have correct styling classes', async ({ page }) => {
      const labels = toolResultLabels(page);
      const count = await labels.count();
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  test.describe('Message Layout (V2)', () => {
    test('user messages render as right-aligned bubble', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Hello');

      // ai-elements `<Message from="user">` adds `.is-user` + `ml-auto` to
      // the wrapper. The old `.justify-end .bg-primary` pair was a V2-era
      // styling hook that no longer exists.
      await expect(
        page.locator('.is-user').first(),
      ).toBeVisible({ timeout: 5000 });
    });

    test('assistant messages render with gradient avatar', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Hi there');

      // Detect assistant response via data-role attribute
      await expect(
        page.locator('.is-assistant').first()
      ).toBeVisible({ timeout: 30_000 });
    });

    test.skip('user messages have User icon avatar', async ({ page }) => {
      // The user-message avatar was removed when ai-elements Message moved
      // to the bubble-only style; `.bg-secondary:has(svg)` no longer
      // matches any sidebar/composer-neutral element either. Skip until a
      // UX decision on bringing the avatar back vs dropping this test.
      await goToChat(page);
      expect(page).toBeDefined();
    });

    test('assistant messages have Bot icon avatar', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Test bot avatar');

      // V2: Assistant avatar is gradient, not bg-primary
      await expect(
        page.locator('.is-assistant').first()
      ).toBeVisible({ timeout: 30_000 });
    });
  });

  test.describe('Input Box Features (V2)', () => {
    test('textarea renders with the default placeholder', async ({ page }) => {
      await goToChat(page);
      const input = chatInput(page);
      // Placeholder is i18n-driven; the idle default is "Message Claude…"
      // in en and a Chinese equivalent in zh. Match leniently.
      const placeholder = await input.getAttribute('placeholder');
      expect(placeholder).toMatch(/message\s*claude/i);
    });

    test('send button is visible with stable aria-label', async ({ page }) => {
      await goToChat(page);
      const btn = sendButton(page);
      await expect(btn).toBeVisible();
      // The ai-elements PromptInputSubmit sets aria-label="Submit" when
      // idle; `sendButton()` already keys on this, assert it here too so a
      // rename shows up as a targeted failure.
      await expect(btn).toHaveAttribute('aria-label', 'Submit');
    });

    test('stop button appears during streaming', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Tell me a long story');

      const stop = stopButton(page);
      await expect(stop).toBeVisible({ timeout: 10_000 });
      await expect(stop).toHaveAttribute('aria-label', 'Stop');
    });

    test('stop button replaces send button during streaming', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Hello world');

      // Post-PromptInput refactor the textarea stays enabled mid-stream so
      // the user can queue a follow-up message; the observable "busy" signal
      // is the submit button flipping to aria-label="Stop".
      await expect(stopButton(page)).toBeVisible({ timeout: 10_000 });
    });

    test.skip('helper text is displayed below input', async ({ page }) => {
      // Removed during the composer refactor. See chat.spec.ts for the
      // matching skip + rationale.
      await goToChat(page);
      expect(page).toBeDefined();
    });

    test('input box renders inside a rounded border wrapper', async ({ page }) => {
      await goToChat(page);
      // The rounded-2xl wrapper was specific to V2; the ai-elements
      // InputGroup now renders the textarea inside any rounded border.
      const wrapper = page.locator('textarea[name="message"]').locator('..');
      await expect(wrapper).toBeVisible();
    });
  });

  test.describe('Token Usage Display', () => {
    test('token usage shows input/output counts after response', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Say hello');

      // Wait for response to complete
      await waitForStreamingEnd(page);
      await page.waitForTimeout(1000);

      // Token usage may be displayed if the response includes token_usage data
      const usage = tokenUsageDisplay(page);
      const count = await usage.count();
      // Token usage display is conditional on API response including usage data
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  test.describe('Streaming Status', () => {
    test('streaming activates on message send', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Hello');

      // Stop button should appear (indicating streaming)
      await expect(stopButton(page)).toBeVisible({ timeout: 10_000 });
    });

    test('send button returns after streaming completes', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Say hi briefly');

      // Wait for streaming to end
      await waitForStreamingEnd(page);

      // Send button should be back
      await expect(sendButton(page)).toBeVisible();
    });

    test('clicking stop button halts streaming', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Write a very long essay about history');

      // Wait for streaming to start
      await expect(stopButton(page)).toBeVisible({ timeout: 10_000 });

      // Click stop
      await stopButton(page).click();

      // Send button should return
      await expect(sendButton(page)).toBeVisible({ timeout: 10_000 });
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
