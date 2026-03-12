import { test, expect } from '@playwright/test';

/**
 * Visual regression tests for the design system and key pages.
 * Run with: npm run test:visual
 *
 * Baseline snapshots are generated on first run.
 * Update baselines with: npx playwright test --grep @visual --update-snapshots
 */

test.describe('Visual Regression @visual', () => {
  test('design system page', async ({ page }) => {
    await page.goto('/design-system');
    await page.waitForLoadState('networkidle');

    // Full page screenshot
    await expect(page).toHaveScreenshot('design-system-full.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.01,
    });
  });

  test('design system - buttons section', async ({ page }) => {
    await page.goto('/design-system');
    await page.waitForLoadState('networkidle');

    const section = page.locator('[data-section="Buttons"]');
    await expect(section).toHaveScreenshot('design-system-buttons.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('design system - status banners section', async ({ page }) => {
    await page.goto('/design-system');
    await page.waitForLoadState('networkidle');

    const section = page.locator('[data-section="Status Banner"]');
    await expect(section).toHaveScreenshot('design-system-status-banners.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('design system - settings card section', async ({ page }) => {
    await page.goto('/design-system');
    await page.waitForLoadState('networkidle');

    const section = page.locator('[data-section="Settings Card"]');
    await expect(section).toHaveScreenshot('design-system-settings-cards.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('design system - field row section', async ({ page }) => {
    await page.goto('/design-system');
    await page.waitForLoadState('networkidle');

    const section = page.locator('[data-section="Field Row"]');
    await expect(section).toHaveScreenshot('design-system-field-rows.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('settings page', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    // Wait for dynamic content to load
    await page.waitForTimeout(1000);

    await expect(page).toHaveScreenshot('settings-page.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.01,
    });
  });
});
