import { test, expect } from '@playwright/test';
import { goToChat } from '../helpers';

/**
 * UI polish smoke for the @ file/directory picker. Guards the style-unification
 * work done in 34c059d: the picker must match the slash / CLI / model selector
 * shell (CommandListGroup header, neutral icons) and must NOT revert to the old
 * primary-blue "Files" div.
 *
 * Kept deliberately light — the mention flow itself is covered by mention-ui.spec.ts.
 */
test.describe('@ picker style smoke', () => {
  test.beforeEach(async ({ page }) => {
    // Stub /api/files/suggest so the popover reliably renders both a file and
    // a directory — the two icon paths we want to lock down.
    await page.route('**/api/files/suggest**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            { path: 'src/components', display: 'src/components/', type: 'directory' },
            { path: 'src/index.ts', display: 'src/index.ts', type: 'file' },
          ],
        }),
      });
    });
  });

  test('@ opens a popover with search input, group header, and neutral icons @smoke', async ({ page }) => {
    await goToChat(page);

    const input = page.locator('textarea[name="message"]').first();
    await expect(input).toBeVisible();

    // Type a filter that the mock recognises — typing just `@` can leave the
    // popover empty until the debounce resolves, which makes first-frame
    // assertions racy.
    await input.fill('@src');

    // Wait for the popover to render with at least one item.
    await expect(
      page.locator('button', { hasText: 'src/components' }).first(),
    ).toBeVisible();

    // CommandListGroup header is still present. The exact micro-class set is
    // owned by the shared CommandList primitive and can evolve independently
    // of this smoke; the stale primary-tinted header is guarded below.
    const groupHeader = page.getByText(/^(Files|文件)$/).first();
    await expect(groupHeader).toBeVisible();

    const directoryItem = page.locator('button', { hasText: 'src/components' }).first();
    const fileItem = page.locator('button', { hasText: 'src/index.ts' }).first();
    await expect(directoryItem).toBeVisible();
    await expect(fileItem).toBeVisible();

    // Both icons must carry text-muted-foreground — the post-polish color.
    await expect(directoryItem.locator('svg.text-muted-foreground').first()).toBeVisible();
    await expect(fileItem.locator('svg.text-muted-foreground').first()).toBeVisible();

    // Regression guard: the stale primary-tinted icons must not reappear.
    await expect(directoryItem.locator('svg.text-primary')).toHaveCount(0);
    await expect(directoryItem.locator('svg[class*="text-primary/"]')).toHaveCount(0);
    await expect(fileItem.locator('svg.text-primary')).toHaveCount(0);

    // And the old static "Files" header (primary bg + border) is gone.
    await expect(
      page.locator('.bg-primary\\/5.text-primary.border-primary\\/20'),
    ).toHaveCount(0);
  });
});
