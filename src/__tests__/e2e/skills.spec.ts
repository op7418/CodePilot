import { test, expect } from '@playwright/test';
import {
  skillsSearchInput,
  skillListItems,
  createSkillButton,
  collectConsoleErrors,
  filterCriticalErrors,
  waitForPageReady,
} from '../helpers';

async function goToSkills(page: Parameters<typeof waitForPageReady>[0]) {
  await page.route('**/api/app/updates**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        latestVersion: '0.0.0',
        currentVersion: '0.0.0',
        updateAvailable: false,
        releaseName: '',
        releaseNotes: '',
        publishedAt: '',
        releaseUrl: '',
        downloadUrl: '',
        downloadAssetName: '',
      }),
    });
  });
  await page.goto('/plugins#skills');
  await waitForPageReady(page);
}

test.describe('Skills Management (/plugins#skills)', () => {
  test('legacy /skills route redirects to /plugins#skills with no console errors', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/skills');
    await page.waitForURL('**/plugins#skills');
    await waitForPageReady(page);
    await expect(createSkillButton(page)).toBeVisible();
    const critical = filterCriticalErrors(errors);
    expect(critical).toHaveLength(0);
  });

  test('skills list or empty state renders cleanly', async ({ page }) => {
    await goToSkills(page);
    const items = skillListItems(page);
    const count = await items.count();
    if (count > 0) {
      await expect(items.first()).toBeVisible();
    } else {
      await expect(
        page.locator('main').filter({ hasText: /(No skills|暂无技能|New skill|新建技能)/i }).first(),
      ).toBeVisible();
    }
  });

  test('search input accepts and clears text', async ({ page }) => {
    await goToSkills(page);
    const search = skillsSearchInput(page);
    await expect(search).toBeVisible();
    await search.fill('nonexistent-skill');
    await expect(search).toHaveValue('nonexistent-skill');
    await search.clear();
    await expect(search).toHaveValue('');
  });

  test('New skill button opens CreateSkillDialog and Cancel dismisses it', async ({ page }) => {
    await goToSkills(page);
    const createBtn = createSkillButton(page);
    await expect(createBtn).toBeVisible();
    await createBtn.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#skill-name')).toBeVisible();

    await dialog.getByRole('button', { name: /Cancel|取消/i }).click();
    await expect(dialog).toBeHidden();
  });

  test('Marketplace button opens MarketplaceDialog', async ({ page }) => {
    await goToSkills(page);
    const marketplaceBtn = page.getByRole('button', { name: /Marketplace|技能商店|市场/i }).first();
    await expect(marketplaceBtn).toBeVisible();
    await marketplaceBtn.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
  });
});
