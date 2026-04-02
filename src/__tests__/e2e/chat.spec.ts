import { test, expect } from '@playwright/test';
import {
  goToChat,
  sendMessage,
  waitForStreamingStart,
  waitForStreamingEnd,
  chatInput,
  sendButton,
  stopButton,
  newChatButton,
  sidebar,
  sessionLinks,
  collectConsoleErrors,
  filterCriticalErrors,
  expectPageLoadTime,
  waitForPageReady,
} from '../helpers';

test.describe('Chat Page', () => {
  test.describe('Page Rendering', () => {
    test('home page redirects to /chat', async ({ page }) => {
      await page.goto('/');
      await page.waitForURL('**/chat');
      expect(page.url()).toContain('/chat');
    });

    test('chat page loads within 3 seconds', async ({ page }) => {
      await expectPageLoadTime(page, '/chat');
    });

    test('chat page has no console errors', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await goToChat(page);
      const critical = filterCriticalErrors(errors);
      expect(critical).toHaveLength(0);
    });

    test('chat page shows empty state when no messages', async ({ page }) => {
      await goToChat(page);
      await expect(page.locator('h2:has-text("CodePilot Chat")')).toBeVisible();
      await expect(
        page.locator('text=Start a conversation with CodePilot')
      ).toBeVisible();
    });
  });

  test.describe('Chat UI Elements', () => {
    test('New Chat button is visible in sidebar', async ({ page }) => {
      await goToChat(page);
      await expect(newChatButton(page)).toBeVisible();
    });

    test('chat textarea is visible with correct placeholder', async ({ page }) => {
      await goToChat(page);
      const input = chatInput(page);
      await expect(input).toBeVisible();
      await expect(input).toHaveAttribute(
        'placeholder',
        'Send a message... (@ for files, / for commands)'
      );
    });

    test('send button is visible', async ({ page }) => {
      await goToChat(page);
      await expect(sendButton(page)).toBeVisible();
    });

    test('helper text is displayed below input', async ({ page }) => {
      await goToChat(page);
      await expect(
        page.locator('text=Enter to send, Shift+Enter for new line')
      ).toBeVisible();
    });
  });

  test.describe('Send Message', () => {
    test('can type in chat input', async ({ page }) => {
      await goToChat(page);
      const input = chatInput(page);
      await input.fill('Hello, this is a test');
      await expect(input).toHaveValue('Hello, this is a test');
    });

    test('send a message and see it in the conversation', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Test message from Playwright');

      // User message should appear in the main content area (V2: bubble style)
      await expect(page.locator('main >> text=Test message from Playwright').first()).toBeVisible({
        timeout: 5000,
      });

      // V2: User message renders as right-aligned bubble with bg-primary
      await expect(page.locator('.justify-end .bg-primary')).toBeVisible();
    });

    test('input is disabled during streaming', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Hello');

      // Textarea should be disabled while streaming
      await expect(chatInput(page)).toBeDisabled({ timeout: 5000 });
    });
  });

  test.describe('Streaming Response', () => {
    test('stop button appears during streaming', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Hi');

      // Stop button (destructive variant with square icon) should appear
      await expect(stopButton(page)).toBeVisible({ timeout: 10_000 });
    });

    test('assistant avatar appears for assistant response', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Say hello');

      // Wait for assistant response
      await expect(
        page.locator('[data-role="assistant"]')
      ).toBeVisible({ timeout: 10_000 });
    });

    test('URL updates to session ID after response completes', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Hi there');

      // Wait for URL to change to /chat/[session-id]
      await page.waitForURL('**/chat/*', { timeout: 120_000 });
      expect(page.url()).toMatch(/\/chat\/.+/);
    });

    test('conversation appears in sidebar after response', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Sidebar test');

      // Wait for response to complete and URL to update
      await page.waitForURL('**/chat/*', { timeout: 120_000 });
      await page.waitForTimeout(1000);

      // Session should appear in sidebar
      const links = sessionLinks(page);
      await expect(links.first()).toBeVisible();
    });
  });

  test.describe('Abort Generation', () => {
    test('clicking stop button halts streaming', async ({ page }) => {
      await goToChat(page);
      await sendMessage(page, 'Write a very long essay about the universe');

      // Wait for streaming to start
      await expect(stopButton(page)).toBeVisible({ timeout: 10_000 });

      // Click stop
      await stopButton(page).click();

      // Send button should return (streaming ended)
      await expect(sendButton(page)).toBeVisible({ timeout: 10_000 });
    });
  });

  test.describe('Chat History', () => {
    test('sidebar has Recent Chats section', async ({ page }) => {
      await goToChat(page);
      await expect(page.locator('text=Recent Chats')).toBeVisible();
    });

    test('empty state or session list is shown in sidebar', async ({ page }) => {
      await goToChat(page);
      // Either "No conversations yet" or session links should be visible
      const emptyState = page.locator('text=No conversations yet');
      const sessions = sessionLinks(page);
      const hasEmpty = await emptyState.isVisible().catch(() => false);
      const hasLinks = (await sessions.count()) > 0;
      expect(hasEmpty || hasLinks).toBeTruthy();
    });
  });
});
