import { test, expect } from '@playwright/test';
import {
  goToChat,
  goToPlugins,
  goToSettingsTab,
  sidebar,
  sidebarToggle,
  navLink,
  newChatButton,
  chatInput,
  waitForPageReady,
} from '../helpers';

test.describe('Layout', () => {
  test.describe('Sidebar', () => {
    test('sidebar is visible on desktop', async ({ page }) => {
      await goToChat(page);
      await expect(sidebar(page)).toBeVisible();
      const box = await sidebar(page).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(180);
      expect(box!.width).toBeLessThanOrEqual(400);
    });

    test('sidebar has navigation items', async ({ page }) => {
      await goToChat(page);
      await expect(navLink(page, '/plugins')).toBeVisible();
      await expect(navLink(page, '/gallery')).toBeVisible();
      await expect(navLink(page, '/settings')).toBeVisible();
    });

    test('sidebar has New Chat button', async ({ page }) => {
      await goToChat(page);
      await expect(newChatButton(page)).toBeVisible();
    });

    test('sidebar has chat list section', async ({ page }) => {
      await goToChat(page);
      await expect(
        sidebar(page).filter({ hasText: /(Projects|Assistant|项目|助理|New Conversation|新对话)/i }).first(),
      ).toBeVisible();
    });
  });

  test.describe('Sidebar Collapse/Expand', () => {
    test('toggle button is in the top bar', async ({ page }) => {
      await goToChat(page);
      await expect(sidebarToggle(page)).toBeVisible();
    });

    test('clicking toggle collapses sidebar', async ({ page }) => {
      await goToChat(page);
      await expect(sidebar(page)).toBeVisible();

      await sidebarToggle(page).click();
      await expect(sidebar(page)).toBeHidden();
    });

    test('clicking toggle again expands sidebar', async ({ page }) => {
      await goToChat(page);

      await sidebarToggle(page).click();
      await expect(sidebar(page)).toBeHidden();

      await sidebarToggle(page).click();
      await expect(sidebar(page)).toBeVisible();
      const box = await sidebar(page).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(180);
      expect(box!.width).toBeLessThanOrEqual(400);
    });

    test('main content expands when sidebar collapses', async ({ page }) => {
      await goToChat(page);

      const mainBefore = await page.locator('main').boundingBox();
      expect(mainBefore).not.toBeNull();

      await sidebarToggle(page).click();
      await expect(sidebar(page)).toBeHidden();

      const mainAfter = await page.locator('main').boundingBox();
      expect(mainAfter).not.toBeNull();
      expect(mainAfter!.width).toBeGreaterThan(mainBefore!.width);
    });
  });

  test.describe('Theme Switch', () => {
    test('appearance settings switches between dark and light mode', async ({ page }) => {
      await goToSettingsTab(page, 'appearance');

      const radioGroup = page.getByRole('radiogroup').first();
      await expect(radioGroup).toBeVisible();

      const darkBtn = radioGroup.getByRole('radio', { name: /Dark|深色/i });
      const lightBtn = radioGroup.getByRole('radio', { name: /Light|浅色/i });

      await darkBtn.click();
      await expect(page.locator('html')).toHaveClass(/dark/);
      await expect(darkBtn).toHaveAttribute('aria-checked', 'true');

      await lightBtn.click();
      await expect(page.locator('html')).toHaveClass(/light/);
      await expect(lightBtn).toHaveAttribute('aria-checked', 'true');
    });
  });

  test.describe('Navigation Menu Highlight', () => {
    test('Plugins nav is highlighted on /plugins', async ({ page }) => {
      await goToPlugins(page);
      const pluginsBtn = navLink(page, '/plugins').locator('button');
      await expect(pluginsBtn).toHaveClass(/bg-sidebar-accent/);
      await expect(pluginsBtn).toHaveClass(/text-sidebar-accent-foreground/);
    });

    test('Gallery nav is highlighted on /gallery', async ({ page }) => {
      await page.goto('/gallery');
      await waitForPageReady(page);
      const galleryBtn = navLink(page, '/gallery').locator('button');
      await expect(galleryBtn).toHaveClass(/bg-sidebar-accent/);
      await expect(galleryBtn).toHaveClass(/text-sidebar-accent-foreground/);
    });

    test('Settings sidebar highlights active section', async ({ page }) => {
      await goToSettingsTab(page, 'overview');
      const overviewLink = navLink(page, '/settings/overview');
      await expect(overviewLink).toHaveClass(/bg-sidebar-accent/);

      await navLink(page, '/settings/general').click();
      await page.waitForURL('**/settings/general');
      await expect(navLink(page, '/settings/general')).toHaveClass(/text-sidebar-accent-foreground/);
      await expect(overviewLink).not.toHaveClass(/text-sidebar-accent-foreground/);
    });

    test('navigating via sidebar updates highlight', async ({ page }) => {
      await goToChat(page);

      await navLink(page, '/plugins').click();
      await page.waitForURL('**/plugins');
      await expect(navLink(page, '/plugins').locator('button')).toHaveClass(/text-sidebar-accent-foreground/);
      await expect(navLink(page, '/gallery').locator('button')).not.toHaveClass(/text-sidebar-accent-foreground/);
    });
  });

  test.describe('Mobile Responsive', () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test('sidebar can be toggled on mobile viewport', async ({ page }) => {
      await goToChat(page);

      const toggle = sidebarToggle(page);
      await expect(toggle).toBeVisible();

      const initiallyVisible = await sidebar(page).isVisible().catch(() => false);
      await toggle.click();
      if (initiallyVisible) {
        await expect(sidebar(page)).toBeHidden();
        await toggle.click();
        await expect(sidebar(page)).toBeVisible();
      } else {
        await expect(sidebar(page)).toBeVisible();
        await toggle.click();
        await expect(sidebar(page)).toBeHidden();
      }
    });

    test('chat page renders correctly on mobile', async ({ page }) => {
      await goToChat(page);
      if (await sidebar(page).isVisible().catch(() => false)) {
        await sidebarToggle(page).click();
        await expect(sidebar(page)).toBeHidden();
      }
      await expect(chatInput(page)).toBeVisible();
      await expect(sidebarToggle(page)).toBeVisible();
    });
  });
});
