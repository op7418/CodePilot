/**
 * Smoke test script -- run with: npx tsx src/__tests__/smoke-test.ts
 * Tests basic page rendering for all routes.
 */
import { chromium } from 'playwright';

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL';
  details: string;
  consoleErrors: string[];
  loadTimeMs: number;
}

async function runSmokeTests() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const results: TestResult[] = [];

  const routes = [
    { name: 'Home redirect', url: 'http://localhost:3000/', expectRedirectTo: '/chat' },
    { name: 'Chat page', url: 'http://localhost:3000/chat' },
    { name: 'Plugins page', url: 'http://localhost:3000/plugins' },
    { name: 'MCP page', url: 'http://localhost:3000/plugins/mcp' },
    { name: 'Settings page', url: 'http://localhost:3000/settings' },
  ];

  for (const route of routes) {
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const start = Date.now();
    try {
      const response = await page.goto(route.url, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(1000);
      const elapsed = Date.now() - start;
      const httpStatus = response?.status();
      const finalUrl = page.url();

      let details = `HTTP ${httpStatus}, loaded in ${elapsed}ms, final URL: ${finalUrl}`;

      if (route.expectRedirectTo) {
        if (finalUrl.includes(route.expectRedirectTo)) {
          details += ` (redirect OK)`;
        } else {
          results.push({ name: route.name, status: 'FAIL', details: `Expected redirect to ${route.expectRedirectTo}, got ${finalUrl}`, consoleErrors, loadTimeMs: elapsed });
          await page.close();
          continue;
        }
      }

      // Check for actual Next.js error pages
      const hasErrorOverlay = await page.locator('#__next-build-error, [data-nextjs-dialog]').count() > 0;
      const title = await page.title();
      const bodyVisible = await page.locator('body').innerText();

      if (hasErrorOverlay) {
        const errorText = await page.locator('#__next-build-error, [data-nextjs-dialog]').first().innerText();
        results.push({ name: route.name, status: 'FAIL', details: `Next.js error overlay: ${errorText.substring(0, 300)}`, consoleErrors, loadTimeMs: elapsed });
        await page.close();
        continue;
      }

      // Check for 404/500 in title
      if (title.includes('404') || title.includes('500') || title.includes('Error')) {
        results.push({ name: route.name, status: 'FAIL', details: `Error page title: "${title}"`, consoleErrors, loadTimeMs: elapsed });
        await page.close();
        continue;
      }

      details += `, title: "${title}", body length: ${bodyVisible.length} chars`;

      // Take screenshot
      const screenshotName = route.name.toLowerCase().replace(/\s+/g, '-');
      await page.screenshot({ path: `/Users/op7418/Documents/code/opus-4.6-test/src/__tests__/screenshots/${screenshotName}.png`, fullPage: true });

      results.push({ name: route.name, status: 'PASS', details, consoleErrors, loadTimeMs: elapsed });
    } catch (err: unknown) {
      const elapsed = Date.now() - start;
      results.push({ name: route.name, status: 'FAIL', details: err instanceof Error ? err.message : String(err), consoleErrors, loadTimeMs: elapsed });
    }
    await page.close();
  }

  // Print results
  console.log('\n========== SMOKE TEST RESULTS ==========\n');
  for (const r of results) {
    const icon = r.status === 'PASS' ? '[PASS]' : '[FAIL]';
    console.log(`${icon} ${r.name}`);
    console.log(`       ${r.details}`);
    if (r.consoleErrors.length > 0) {
      console.log(`       Console errors (${r.consoleErrors.length}):`);
      for (const e of r.consoleErrors) {
        console.log(`         - ${e.substring(0, 200)}`);
      }
    }
    console.log();
  }

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`========== ${passed} passed, ${failed} failed ==========\n`);

  await browser.close();
  return results;
}

runSmokeTests().catch(console.error);
