import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  goToChat,
  goToSettings,
  goToPlugins,
  waitForPageReady,
  deleteTestSession,
} from '../helpers';

/**
 * The v13 standalone Project/FileTree rail was retired by the T3 workspace
 * surface migration. These browser assertions pin the replacement contract:
 * one Workspace Sidebar shell, one entry point, and no duplicate file rail.
 */
test.describe('Workspace Sidebar — unified project surfaces', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('codepilot:e2e-sidebar-storage-reset') === '1') return;
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key?.startsWith('codepilot:workspace-sidebar')) localStorage.removeItem(key);
        if (key?.startsWith('codepilot:workspace-surfaces')) localStorage.removeItem(key);
      }
      sessionStorage.setItem('codepilot:e2e-sidebar-storage-reset', '1');
    });
  });

  test('opens one unified shell with contextual launcher cards', async ({ page }) => {
    await goToChat(page);
    await waitForPageReady(page);

    const toggle = page.getByRole('button', { name: /Workspace sidebar|工作区侧栏/i });
    await expect(toggle).toBeVisible();
    await toggle.click();

    const shell = page.locator('[data-workspace-sidebar]');
    await expect(shell).toBeVisible();
    await expect(shell).toHaveCount(1);
    // With no open Primary/Inspector tabs the tablist intentionally has no
    // visual footprint; the launcher, not an empty rail, owns the empty state.
    await expect(shell.getByRole('tablist')).toHaveCount(1);
    await expect(shell.getByText(/Open a surface|打开一个模块/i)).toBeVisible();
    await expect(shell.getByText(/Browser|浏览器/i).first()).toBeVisible();
    await expect(shell.getByText(/Files|文件/i).first()).toBeVisible();
    await expect(shell.getByText(/Git/i).first()).toBeVisible();

    const launcherCards = shell.locator('[data-launcher-card]');
    expect(await launcherCards.count()).toBeGreaterThanOrEqual(3);
    const firstCardBox = await launcherCards.first().boundingBox();
    expect(firstCardBox).not.toBeNull();
    for (let index = 0; index < await launcherCards.count(); index += 1) {
      const card = launcherCards.nth(index);
      const cardBox = await card.boundingBox();
      const copyBox = await card.locator('[data-launcher-card-copy]').boundingBox();
      const iconBox = await card.locator('[data-launcher-card-icon]').boundingBox();
      expect(cardBox).not.toBeNull();
      expect(copyBox).not.toBeNull();
      expect(iconBox).not.toBeNull();
      expect(Math.abs(cardBox!.x - firstCardBox!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(cardBox!.width - firstCardBox!.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(
        (copyBox!.y + copyBox!.height / 2) - (cardBox!.y + cardBox!.height / 2),
      )).toBeLessThanOrEqual(2);
      expect(iconBox!.x - cardBox!.x).toBeGreaterThanOrEqual(15);
      expect(iconBox!.x - cardBox!.x).toBeLessThanOrEqual(17);
      expect(iconBox!.y - cardBox!.y).toBeGreaterThanOrEqual(15);
      expect(iconBox!.y - cardBox!.y).toBeLessThanOrEqual(17);
      const description = await card.locator('[data-launcher-card-description]').innerText();
      expect(description.trim()).not.toMatch(/[。. ]$/);
    }

    await expect(page.locator('[data-platform-file-tree]')).toHaveCount(0);
    await expect(page.locator('[data-platform-card-frame="workspace"]')).toHaveCount(1);
  });

  test('is absent from settings and plugins routes', async ({ page }) => {
    await goToSettings(page);
    await expect(page.locator('[data-workspace-sidebar]')).toHaveCount(0);

    await goToPlugins(page);
    await expect(page.locator('[data-workspace-sidebar]')).toHaveCount(0);
  });

  test('plus menu opens any unopened available surface without pinning it', async ({ page }) => {
    await goToChat(page);
    await waitForPageReady(page);

    await page.getByRole('button', { name: /Workspace sidebar|工作区侧栏/i }).click();
    const shell = page.locator('[data-workspace-sidebar]');
    await shell.getByRole('button', { name: /Add surface|添加模块/i }).click();

    const browserItem = page.getByRole('menuitem', { name: /Browser|浏览器/i });
    await expect(browserItem).toBeVisible();
    await expect(browserItem).toBeDisabled();
    await expect(browserItem).toContainText(/desktop client|桌面客户端/i);

    await page.getByRole('menuitem', { name: /Files|文件/i }).click();
    await expect(shell.getByRole('tab', { name: /Files|文件/i })).toBeVisible();
    await expect(shell.getByRole('button', { name: /Pin this surface|固定此模块/i })).toBeVisible();
  });

  test('renders a standalone preview without a phantom divider or Git return row', async ({ page }) => {
    await goToChat(page);
    await waitForPageReady(page);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('workspace-tab-open-request', {
        detail: {
          source: {
            kind: 'inline-html',
            html: '<!doctype html><title>Standalone</title><h1>Preview only</h1>',
            virtualName: 'standalone.html',
          },
        },
      }));
    });

    const shell = page.locator('[data-workspace-sidebar]');
    await expect(shell).toBeVisible();
    await expect(shell.getByRole('tab', { name: 'standalone.html' })).toBeVisible();
    await expect(shell.locator('[data-tab-lane-divider]')).toHaveCount(0);
    await expect(shell.locator('[data-inspector-layout="standalone"]')).toBeVisible();
    await expect(shell.locator('[data-inspector-back]')).toHaveCount(0);
    await expect(shell.getByLabel('Primary workspace surface')).toHaveCount(0);
  });

  test('switches from a standalone preview to an added Widget and back', async ({ page }) => {
    await goToChat(page);
    await waitForPageReady(page);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('workspace-tab-open-request', {
        detail: {
          source: {
            kind: 'inline-html',
            html: '<!doctype html><title>Preview</title><h1>Preview</h1>',
            virtualName: 'preview.html',
          },
        },
      }));
    });

    const shell = page.locator('[data-workspace-sidebar]');
    const previewTab = shell.getByRole('tab', { name: 'preview.html' });
    await expect(previewTab).toHaveAttribute('aria-selected', 'true');

    await shell.getByRole('button', { name: /Add surface|添加模块/i }).click();
    await page.getByRole('menuitem', { name: /Dashboard|Widget|看板/i }).click();

    const widgetTab = shell.getByRole('tab', { name: /Dashboard|Widget|看板/i });
    await expect(widgetTab).toHaveAttribute('aria-selected', 'true');
    await expect(shell.locator('[data-primary-kind="widget"]')).toBeVisible();
    await expect(shell.getByLabel('Inspector')).toHaveCount(0);
    await expect(previewTab).toBeVisible();

    await previewTab.click();
    await expect(previewTab).toHaveAttribute('aria-selected', 'true');
    await expect(shell.getByLabel('Inspector')).toBeVisible();
    await expect(shell.locator('[data-inspector-back]')).toHaveCount(0);
    await expect(shell.getByText(/←\s*(Dashboard|Widget|看板)/i)).toHaveCount(0);

    await widgetTab.click();
    await expect(widgetTab).toHaveAttribute('aria-selected', 'true');
    await expect(shell.locator('[data-primary-kind="widget"]')).toBeVisible();
    await expect(shell.getByLabel('Inspector')).toHaveCount(0);
  });

  test('uses one sidebar Tab per browser page with no nested Tab bar or redundant shell close', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: {
          browser: {
            getConfig: async () => null,
            openExternal: async () => false,
            onNavigationBlocked: () => () => {},
            onOpenUrlRequested: () => () => {},
            onDownloadBlocked: () => () => {},
          },
        },
      });
    });
    await goToChat(page);
    await waitForPageReady(page);

    const toggle = page.getByRole('button', { name: /Workspace sidebar|工作区侧栏/i });
    await toggle.click();
    const shell = page.locator('[data-workspace-sidebar]');
    await shell.getByRole('button', { name: /Browser|浏览器/i }).first().click();
    await expect(shell.getByRole('tab', { name: /Browser|浏览器/i })).toHaveCount(1);
    await expect(shell.getByRole('tablist')).toHaveCount(1);

    await shell.getByRole('button', { name: /Add surface|添加模块/i }).click();
    await page.getByRole('menuitem', { name: /Browser|浏览器/i }).click();
    await expect(shell.getByRole('tab', { name: /Browser|浏览器/i })).toHaveCount(2);
    await expect(shell.getByRole('tablist')).toHaveCount(1);
    await expect(shell.getByRole('button', {
      name: /Collapse workspace sidebar|收起工作区侧栏/i,
    })).toHaveCount(0);
    await expect(toggle).toBeVisible();
  });

  test('offers explicit Git initialization only for a real non-repository workspace', async ({ page }) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'codepilot-sidebar-init-git-'));
    let sessionId: string | undefined;
    try {
      const response = await page.request.post('/api/chat/sessions', {
        data: { title: 'E2E Initialize Git', working_directory: workspace },
      });
      expect(response.ok()).toBeTruthy();
      const payload = await response.json() as { session: { id: string } };
      sessionId = payload.session.id;
      // Suppress the legacy default-panel one-shot so this workspace exercises
      // the no-pin launcher rather than auto-activating Files.
      await page.goto('/chat');
      await page.evaluate((sessionId) => {
        sessionStorage.setItem(`codepilot:panel-init:${sessionId}`, '1');
      }, payload.session.id);
      await page.goto(`/chat/${payload.session.id}`);
      await waitForPageReady(page);

      const shell = page.locator('[data-workspace-sidebar]');
      if (!(await shell.isVisible())) {
        await page.locator('button[aria-label="Workspace sidebar"], button[aria-label="工作区侧栏"]').click();
      }
      await expect(shell.getByRole('button', { name: /Initialize Git|初始化 Git/i }).first()).toBeVisible();
      await shell.getByRole('button', { name: /Initialize Git|初始化 Git/i }).first().click();

      await expect.poll(async () => {
        try {
          return (await fs.stat(path.join(workspace, '.git'))).isDirectory();
        } catch {
          return false;
        }
      }).toBe(true);
      await expect(shell.locator('[data-primary-kind="git"]')).toBeVisible();
    } finally {
      await deleteTestSession(page, sessionId);
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test('unpin keeps a module open, while its own tab close hides it without clearing the pin', async ({ page }) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'codepilot-sidebar-tab-close-'));
    let sessionId: string | undefined;
    try {
      const response = await page.request.post('/api/chat/sessions', {
        data: { title: 'E2E Sidebar Tab Close', working_directory: workspace },
      });
      expect(response.ok()).toBeTruthy();
      const payload = await response.json() as { session: { id: string } };
      sessionId = payload.session.id;
      const identityResponse = await page.request.get(
        `/api/workspace/identity?sessionId=${encodeURIComponent(payload.session.id)}`,
      );
      expect(identityResponse.ok()).toBeTruthy();
      const identityPayload = await identityResponse.json() as { identity: { id: string } };

      // Suppress the legacy first-open Files activation so this test starts
      // from the launcher's explicit transient-open path.
      await page.goto('/chat');
      await page.evaluate((sessionId) => {
        sessionStorage.setItem(`codepilot:panel-init:${sessionId}`, '1');
      }, payload.session.id);
      await page.goto(`/chat/${payload.session.id}`);
      await waitForPageReady(page);
      const shell = page.locator('[data-workspace-sidebar]');
      if (!(await shell.isVisible())) {
        await page.getByRole('button', { name: /Workspace sidebar|工作区侧栏/i }).click();
      }

      await shell.getByRole('button').filter({ hasText: /Files|文件/ }).first().click();
      const filesTab = shell.getByRole('tab', { name: /Files|文件/i });
      await expect(filesTab).toBeVisible();

      await shell.getByRole('button', { name: /Pin this surface|固定此模块/i }).click();
      await expect(shell.getByRole('button', { name: /Unpin this surface|取消固定此模块/i })).toBeVisible();
      await shell.getByRole('button', { name: /Unpin this surface|取消固定此模块/i }).click();
      await expect(filesTab).toBeVisible();
      await expect(shell.locator('[data-primary-kind="files"]')).toBeVisible();

      await shell.getByRole('button', { name: /Pin this surface|固定此模块/i }).click();
      await expect(shell.getByRole('button', { name: /Unpin this surface|取消固定此模块/i })).toBeVisible();
      await expect.poll(async () => page.evaluate((workspaceId) => {
        const raw = localStorage.getItem(`codepilot:workspace-surfaces:v1:${workspaceId}`);
        return raw ? (JSON.parse(raw).pinnedKinds as string[]) : [];
      }, identityPayload.identity.id)).toContain('files');
      await shell.getByRole('button', { name: /Close Files|关闭 文件/i }).click();
      await expect(filesTab).toHaveCount(0);
      await expect(shell.getByText(/Open a surface|打开一个模块/i)).toBeVisible();

      // Closing is transient. The still-pinned module returns when the project
      // is opened again, exactly like a browser tab restored by workspace prefs.
      await page.reload();
      await waitForPageReady(page);
      await expect(shell.getByRole('tab', { name: /Files|文件/i })).toBeVisible();
      await expect(shell.getByRole('button', { name: /Unpin this surface|取消固定此模块/i })).toBeVisible();
    } finally {
      await deleteTestSession(page, sessionId);
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test('reload preserves the collapsed shell and the thread active Primary', async ({ page }) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'codepilot-sidebar-hydrate-'));
    let sessionId: string | undefined;
    try {
      const response = await page.request.post('/api/chat/sessions', {
        data: { title: 'E2E Sidebar Hydration', working_directory: workspace },
      });
      expect(response.ok()).toBeTruthy();
      const payload = await response.json() as { session: { id: string } };
      sessionId = payload.session.id;
      const identityResponse = await page.request.get(
        `/api/workspace/identity?sessionId=${encodeURIComponent(payload.session.id)}`,
      );
      expect(identityResponse.ok()).toBeTruthy();
      const identityPayload = await identityResponse.json() as { identity: { id: string } };

      await page.goto('/chat');
      await page.evaluate(({ sessionId, workspaceId }) => {
        sessionStorage.setItem(`codepilot:panel-init:${sessionId}`, '1');
        localStorage.setItem(`codepilot:workspace-surfaces:v1:${workspaceId}`, JSON.stringify({
          version: 1,
          workspaceId,
          pinnedKinds: ['files', 'git'],
          order: ['files', 'git', 'widget', 'browser', 'agents'],
          defaultActiveKind: 'git',
          open: false,
          width: 620,
        }));
        localStorage.setItem(`codepilot:thread-surfaces:v1:${sessionId}`, JSON.stringify({
          version: 1,
          sessionId,
          activePrimary: 'files',
          inspectorTabs: [],
        }));
      }, { sessionId: payload.session.id, workspaceId: identityPayload.identity.id });

      await page.goto(`/chat/${payload.session.id}`);
      await waitForPageReady(page);
      const shell = page.locator('[data-workspace-sidebar]');
      await expect(shell).toBeHidden();

      await page.getByRole('button', { name: /Workspace sidebar|工作区侧栏/i }).click();
      await expect(shell).toBeVisible();
      await expect(shell.getByRole('tab', { name: /Files|文件/i })).toHaveAttribute('aria-selected', 'true');

      // The shell-level toggle lives in the unified top bar. Keeping another
      // close control inside the sidebar would duplicate the same action.
      await page.getByRole('button', { name: /Workspace sidebar|工作区侧栏/i }).click();
      await expect(shell).toBeHidden();
      await page.reload();
      await waitForPageReady(page);
      await expect(shell).toBeHidden();
    } finally {
      await deleteTestSession(page, sessionId);
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

test.describe('Composer — Runtime-first model picker', () => {
  test('uses Runtime on the left and compatible model routes on the right', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('codepilot:model-route-favorites:v1');
      localStorage.removeItem('codepilot:model-route-favorites:v2');
    });
    await goToChat(page);

    await page.getByRole('button', { name: /Choose runtime and model|选择 Runtime 和模型/i }).click();
    const runtimeLane = page.getByRole('navigation', { name: 'Runtime' });
    await expect(runtimeLane).toBeVisible();
    const favorites = runtimeLane.getByRole('button', { name: /Favorite model combinations|收藏的模型组合/i });
    await expect(favorites).toBeVisible();
    await expect(runtimeLane.getByRole('button', { name: /Claude Code/i })).toBeVisible();
    await expect(runtimeLane.getByRole('button', { name: /CodePilot/i })).toBeVisible();
    await expect(runtimeLane.getByRole('button', { name: /Codex/i })).toBeVisible();
    const modelList = page.getByRole('list', { name: /Available models|可用模型/i });
    await expect(modelList).toBeVisible();
    await expect(modelList.locator('[data-model-provider-section]').first()).toBeVisible();

    const codePilotRuntime = runtimeLane.getByRole('button', { name: /CodePilot/i });
    await codePilotRuntime.click();
    await expect(codePilotRuntime).toHaveAttribute('aria-pressed', 'true');
    await modelList.getByRole('button', { name: /Favorite model combination|收藏模型组合/i }).first().click();

    const claudeRuntime = runtimeLane.getByRole('button', { name: /Claude Code/i });
    await claudeRuntime.click();
    await favorites.click();
    const favoriteList = page.getByRole('list', { name: /Favorite model combinations|收藏的模型组合/i });
    await expect(favoriteList.getByRole('listitem')).toHaveCount(1);
    await favoriteList.getByRole('listitem').getByRole('button').first().click();

    // Selecting a favorite switches its Runtime + provider + model as one
    // combination. Reopening resets the left lane to the newly effective Runtime.
    await page.getByRole('button', { name: /Choose runtime and model|选择 Runtime 和模型/i }).click();
    await expect(page.getByRole('navigation', { name: 'Runtime' })
      .getByRole('button', { name: /CodePilot/i })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-runtime-selector]')).toHaveCount(0);
  });

  test('uses the requested approval copy and keeps context immediately left of Send', async ({ page }) => {
    await goToChat(page);
    await waitForPageReady(page);

    await expect(page.getByRole('button', { name: /Request approval|请求批准/i })).toBeVisible();
    const contextButton = page.getByRole('button', { name: /View this run|查看本次运行状态/i });
    const sendButton = page.locator('[data-message-input-submit]');
    await expect(contextButton).toBeVisible();
    await expect(sendButton).toBeVisible();

    const contextBox = await contextButton.boundingBox();
    const sendBox = await sendButton.boundingBox();
    expect(contextBox).not.toBeNull();
    expect(sendBox).not.toBeNull();
    expect(contextBox!.x + contextBox!.width).toBeLessThanOrEqual(sendBox!.x + 2);
  });

  test('keeps unavailable favorites visible and removable without lying in the badge', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('codepilot:model-route-favorites:v2', JSON.stringify({
        version: 2,
        favorites: [{
          runtimeId: 'codepilot_runtime',
          providerInstanceId: 'deleted-provider',
          modelId: 'deleted-model',
          providerNameSnapshot: 'Deleted Provider',
          modelNameSnapshot: 'Deleted Model',
          createdAt: 1,
        }],
      }));
    });
    await goToChat(page);

    await page.getByRole('button', { name: /Choose runtime and model|选择 Runtime 和模型/i }).click();
    const favoriteLane = page.getByRole('navigation', { name: 'Runtime' })
      .getByRole('button', { name: /Favorite model combinations|收藏的模型组合/i });
    await expect(favoriteLane).toContainText('1');
    await favoriteLane.click();

    const unavailable = page.getByRole('button', { name: /Deleted Model/i });
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toBeDisabled();
    await expect(unavailable).toContainText(/Provider unavailable|供应商不可用/i);
    await page.getByRole('button', { name: /Remove favorite combination|取消收藏模型组合/i }).click();

    await expect(page.getByRole('button', { name: /Deleted Model/i })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const raw = localStorage.getItem('codepilot:model-route-favorites:v2');
      return raw ? JSON.parse(raw).favorites.length : -1;
    })).toBe(0);
  });

  test('model normalization never writes through the shared provider 1M option', async ({ page }) => {
    let providerOptionPuts = 0;
    await page.addInitScript(() => {
      localStorage.setItem('codepilot:last-provider-id', 'context-provider');
      localStorage.setItem('codepilot:last-model', 'claude-sonnet-4-6');
    });
    await page.route('**/api/settings/app', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ settings: { agent_runtime: 'native', default_panel: 'none' } }),
      });
    });
    await page.route('**/api/providers/models**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          groups: [{
            provider_id: 'context-provider',
            provider_name: 'Context Provider',
            provider_type: 'anthropic',
            protocol: 'anthropic',
            models: [
              {
                value: 'claude-sonnet-4-6',
                label: 'Sonnet 4.6',
                upstreamModelId: 'claude-sonnet-4-6',
                contextWindow: 200_000,
                supportedRuntimes: ['claude_code', 'codepilot_runtime'],
              },
              {
                value: 'claude-haiku-4-5-20251001',
                label: 'Haiku 4.5',
                upstreamModelId: 'claude-haiku-4-5-20251001',
                contextWindow: 200_000,
                supportedRuntimes: ['claude_code', 'codepilot_runtime'],
              },
            ],
          }],
          default_provider_id: 'context-provider',
          runtime_applied: 'codepilot_runtime',
        }),
      });
    });
    await page.route('**/api/providers/options**', async (route) => {
      if (route.request().method() === 'PUT') {
        providerOptionPuts += 1;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ options: { context_1m: true, thinking_mode: 'adaptive' } }),
      });
    });

    await goToChat(page);
    await waitForPageReady(page);
    const announcementClose = page.getByRole('button', { name: /Got it|知道了|Close|关闭/i }).last();
    if (await announcementClose.isVisible()) await announcementClose.click();
    const picker = page.getByRole('button', { name: /Choose runtime and model|选择 Runtime 和模型/i });
    await picker.click();
    await page.getByRole('button', { name: /Haiku 4\.5/i }).click();
    await expect.poll(() => providerOptionPuts).toBe(0);

    await picker.click();
    await page.getByRole('button', { name: /Sonnet 4\.6/i }).click();
    await expect(page.getByRole('button', { name: /Model parameters|模型参数/i })).toContainText('1M');
    expect(providerOptionPuts).toBe(0);
  });
});
