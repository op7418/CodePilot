import { test, expect } from '@playwright/test';
import {
  goToSettings,
  goToSettingsTab,
  navLink,
  collectConsoleErrors,
  filterCriticalErrors,
} from '../helpers';

test.describe('Settings Page', () => {
  test.describe('Page Rendering & Navigation', () => {
    test('/settings redirects to /settings/overview with no console errors', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await goToSettings(page);
      await page.waitForURL('**/settings/overview');
      await expect(navLink(page, '/settings/overview')).toBeVisible();
      const critical = filterCriticalErrors(errors);
      expect(critical).toHaveLength(0);
    });

    test('settings sidebar links navigate across sections', async ({ page }) => {
      await goToSettingsTab(page, 'overview');

      for (const section of ['general', 'appearance', 'providers', 'models', 'runtime', 'about']) {
        const link = navLink(page, `/settings/${section}`);
        await expect(link).toBeVisible();
      }

      await navLink(page, '/settings/general').click();
      await page.waitForURL('**/settings/general');
      await expect(navLink(page, '/settings/general')).toHaveClass(/bg-sidebar-accent/);
    });
  });

  test.describe('Claude CLI Settings Editor (/settings/runtime)', () => {
    const mockSettings = {
      permissions: { allow: ['Read'] },
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
    };

    test.beforeEach(async ({ page }) => {
      await page.route('**/api/settings', async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ settings: mockSettings }),
          });
          return;
        }
        await route.continue();
      });
    });

    test('form and JSON tabs render inside collapsed settings.json section', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await goToSettingsTab(page, 'runtime');

      const details = page.locator('details').filter({ hasText: /settings\.json|CLI/i }).first();
      await expect(details).toBeVisible();
      await details.locator('summary').click();

      const formTab = details.getByRole('tab', { name: /Visual|Form|表单/i });
      const jsonTab = details.getByRole('tab', { name: /JSON/i });
      await expect(formTab).toBeVisible();
      await expect(jsonTab).toBeVisible();

      const textareas = details.locator('textarea');
      await expect(textareas.first()).toBeVisible();
      await expect(textareas.first()).toBeEditable();
      await expect(textareas.nth(1)).toHaveValue(/CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS/);

      // Save and Reset stay disabled until a field changes
      const resetBtn = details.getByRole('button', { name: /Reset|重置/i });
      await expect(resetBtn).toBeDisabled();

      await textareas.first().fill('{"allow": ["Read", "Write"]}');
      await expect(resetBtn).toBeEnabled();

      // Switch to JSON mode and verify valid JSON + Format button
      await jsonTab.click();
      const jsonTextarea = details.locator('textarea').first();
      await expect(jsonTextarea).toBeVisible();
      const parsed = JSON.parse(await jsonTextarea.inputValue());
      expect(parsed).toHaveProperty('env');
      await expect(details.getByRole('button', { name: /Format|格式化/i })).toBeVisible();

      const critical = filterCriticalErrors(errors);
      expect(critical).toHaveLength(0);
    });
  });
});
