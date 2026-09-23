import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';

test.describe('Model identity conflict recovery @smoke', () => {
  test.use({ locale: 'zh-CN' });
  for (const hidden of [true, false]) {
    test(`review reveals the ${hidden ? 'hidden' : 'renamed'} legacy row without changing it`, async ({ page, request }, testInfo) => {
      const created = await request.post('/api/providers', {
        data: {
          name: `GLM conflict ${hidden ? 'hidden' : 'renamed'}`,
          provider_type: 'anthropic',
          protocol: 'anthropic',
          preset_key: 'glm-cn',
          base_url: 'https://open.bigmodel.cn/api/anthropic',
          role_models_json: '{}',
        },
      });
      expect(created.ok()).toBe(true);
      const { provider } = await created.json();
      const modelUrl = `/api/providers/${provider.id}/models`;
      expect((await request.get(`${modelUrl}?all=1`)).ok()).toBe(true);

      // The runner owns this temporary DB. Seed an old user-owned row that
      // cannot be created through today's catalog-only Add Model endpoint.
      const dataDir = process.env.CODEPILOT_E2E_DATA_DIR;
      if (!dataDir || !path.basename(dataDir).startsWith('codepilot-playwright-db-')) {
        throw new Error('Conflict fixture requires the isolated Playwright database');
      }
      const db = new Database(path.join(dataDir, 'codepilot.db'));
      try {
        expect(db.prepare(`UPDATE provider_models
          SET upstream_model_id = 'haiku', display_name = ?, enabled = ?,
              user_edited = 1, enable_source = ?, capabilities_json = '{}'
          WHERE provider_id = ? AND model_id = 'haiku'`).run(
          hidden ? 'GLM-4.5-Air' : 'My legacy model',
          hidden ? 0 : 1,
          hidden ? 'manual_hidden' : 'catalog',
          provider.id,
        ).changes).toBe(1);
      } finally {
        db.close();
      }

      try {
        const before = await (await request.get(`${modelUrl}?all=1`)).json();
        const modelWrites: string[] = [];
        page.on('request', r => {
          if (new URL(r.url()).pathname === modelUrl && r.method() !== 'GET') {
            modelWrites.push(r.method());
          }
        });
        await page.goto('/settings/models');
        const section = page.locator(`[id="provider-section-${provider.id}"]`);
        const row = page.locator(`[data-model-row="${provider.id}::haiku"]`);
        await expect(section).toBeVisible();
        const channelFilter = page.getByRole('combobox', { name: /按接入渠道筛选服务商|Filter providers by access channel/ });
        await channelFilter.click();
        await page.getByRole('option', { name: /^Claude Code (compat|兼容)$/ }).click();
        const search = page.locator('#models-search');
        await search.fill('GLM-5.3');
        await expect(row).toHaveCount(0);

        const addButton = section.getByRole('button', { name: /^(Add model|添加模型)$/ });
        await addButton.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByText(/(model rows haiku|模型记录 haiku)/)).toBeVisible();

        // Ordinary close must not reset the page's filters.
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(search).toHaveValue('GLM-5.3');
        await expect(channelFilter).toContainText(/Claude Code (compat|兼容)/);
        await expect(row).toHaveCount(0);
        await addButton.click();
        await dialog.getByRole('button', { name: /^(Review models|查看模型列表)$/ }).click();

        await expect(dialog).toHaveCount(0);
        await expect(row).toBeVisible();
        await expect(search).toHaveValue('');
        await expect(channelFilter).toContainText(/All channels|全部渠道/);
        await expect(page.getByRole('tab', { name: /^(All|全部)\s*\d+$/ })).toHaveAttribute('aria-selected', 'true');
        await expect(row).toBeFocused();
        await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', hidden ? 'false' : 'true');
        await expect(row).toContainText(hidden ? 'GLM-4.5-Air' : 'My legacy model');
        await page.screenshot({ path: testInfo.outputPath('conflict-review.png') });

        const after = await (await request.get(`${modelUrl}?all=1`)).json();
        expect(after).toEqual(before);
        expect(modelWrites).toEqual([]);
      } finally {
        await request.delete(`/api/providers/${provider.id}`);
      }
    });
  }
});
