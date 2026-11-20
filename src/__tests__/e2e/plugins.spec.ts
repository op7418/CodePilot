import { test, expect } from '@playwright/test';
import {
  goToPlugins,
  goToMCP,
  pluginSearchInput,
  addServerButton,
  collectConsoleErrors,
  filterCriticalErrors,
  waitForPageReady,
} from '../helpers';

test.describe('Plugins Page', () => {
  test.describe('Page Rendering', () => {
    test('plugins page renders with no console errors', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await goToPlugins(page);
      await expect(page.getByRole('tablist').first()).toBeVisible();
      const critical = filterCriticalErrors(errors);
      expect(critical).toHaveLength(0);
    });

    test('legacy /plugins/mcp route redirects to /plugins#mcp with no console errors', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await page.goto('/plugins/mcp');
      await page.waitForURL('**/plugins#mcp');
      await waitForPageReady(page);
      await expect(addServerButton(page)).toBeVisible();
      const critical = filterCriticalErrors(errors);
      expect(critical).toHaveLength(0);
    });
  });

  test.describe('Unified Extensions Tabs', () => {
    test('shows Skills, MCP, and CLI tabs with search input', async ({ page }) => {
      await goToPlugins(page);
      const tabs = page.getByRole('tab');
      await expect(tabs).toHaveCount(3);
      await expect(pluginSearchInput(page)).toBeVisible();
    });

    test('switching to MCP tab shows MCP toolbar actions', async ({ page }) => {
      await goToPlugins(page);
      await page.getByRole('tab', { name: /MCP/i }).click();
      await expect(addServerButton(page)).toBeVisible();
      await expect(
        page.getByRole('button', { name: /MCP JSON/i }),
      ).toBeVisible();
    });
  });

  test.describe('Add MCP Server Dialog', () => {
    test('clicking Add MCP server opens dialog with Server Name, Type, Command, and Arguments', async ({ page }) => {
      await goToMCP(page);
      await addServerButton(page).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('#server-name')).toBeVisible();
      await expect(dialog.getByRole('tab', { name: 'stdio' })).toBeVisible();
      await expect(dialog.getByRole('tab', { name: 'SSE' })).toBeVisible();
      await expect(dialog.getByRole('tab', { name: 'HTTP' })).toBeVisible();
      await expect(dialog.locator('#server-command')).toBeVisible();
      await expect(dialog.locator('#server-args')).toBeVisible();
    });

    test('Cancel button closes Add MCP Server dialog', async ({ page }) => {
      await goToMCP(page);
      await addServerButton(page).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: /Cancel|取消/i }).click();
      await expect(dialog).toBeHidden();
    });
  });

  test.describe('MCP JSON Configuration Dialog', () => {
    test('clicking MCP JSON config opens editor dialog with Save and Format buttons', async ({ page }) => {
      await goToMCP(page);
      await page.getByRole('button', { name: /MCP JSON/i }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('textarea').first()).toBeVisible();
      await expect(dialog.getByRole('button', { name: /Save|保存/i }).first()).toBeVisible();
      await expect(dialog.getByRole('button', { name: /Format|格式化/i }).first()).toBeVisible();
    });
  });
});
