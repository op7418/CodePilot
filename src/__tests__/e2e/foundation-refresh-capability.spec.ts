import { expect, test } from '@playwright/test';

test.describe('Foundation refresh production-route contracts @smoke', () => {
  test('U5 — compiled Claude capability route recognizes the installed Agent SDK @smoke', async ({ request }) => {
    const response = await request.get('/api/chat/permission-capability?runtime=claude_code');
    expect(response.ok()).toBe(true);
    const body = await response.json() as {
      autoReview?: {
        supported?: boolean;
        unavailableReason?: string;
        installedVersion?: string | null;
      };
    };

    expect(body.autoReview).toBeTruthy();
    expect(
      body.autoReview?.unavailableReason,
      'Direct helper tests can pass while Next bundles __filename differently. The compiled route must not report a supported installed SDK as unreadable.',
    ).not.toBe('sdk_version');
  });

  test('U6 — Codex capability route exposes its native auto reviewer @smoke', async ({ request }) => {
    const response = await request.get('/api/chat/permission-capability?runtime=codex_runtime');
    expect(response.ok()).toBe(true);
    const body = await response.json() as {
      autoReview?: {
        supported?: boolean;
        source?: string;
        runtime?: string;
        minVersion?: string;
        installedVersion?: string | null;
        unavailableReason?: string;
      };
    };
    expect(body.autoReview?.runtime).toBe('codex_runtime');
    expect(body.autoReview?.source).toMatch(/codex --version.*approvalsReviewer echo/i);
    expect(body.autoReview?.minVersion).toBeTruthy();
    // Codex uses its own version-gated reviewer axis, never the non-Claude
    // `runtime` refusal. Under `run-playwright.mjs` (CODEX_DISABLED=1), the
    // binary lookup is intentionally disabled, so the route must honestly
    // report unsupported (`codex_version`, `installedVersion: null`).
    expect(body.autoReview?.unavailableReason).not.toBe('runtime');
    if (process.env.CODEX_DISABLED === '1') {
      expect(body.autoReview?.supported).toBe(false);
      expect(body.autoReview?.installedVersion).toBeNull();
      expect(body.autoReview?.unavailableReason).toBe('codex_version');
    } else {
      expect(body.autoReview?.supported).toBe(true);
      expect(body.autoReview?.unavailableReason).toBeUndefined();
    }
  });
});
