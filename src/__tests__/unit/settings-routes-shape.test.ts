/**
 * Settings route-level split — memory guardrail.
 *
 * The hash-tab Settings shell pulled every section (Models, Runtime, Bridge,
 * Usage/Recharts, Appearance/Shiki) into a single dev compile graph and
 * pushed Next dev RSS above 3GB on first /settings load. The fix is a
 * route-level split: each /settings/<section>/page.tsx imports exactly the
 * section it owns, and the shared layout imports zero sections.
 *
 * These tests are static contract checks — they don't mount React, they just
 * grep the route source files. If a future change adds a static or dynamic
 * section import to the shared shell, these fail loudly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SETTINGS_APP = path.resolve(__dirname, '../../app/settings');

function read(rel: string): string {
  return readFileSync(path.join(SETTINGS_APP, rel), 'utf-8');
}

const SECTION_TO_IMPORT: Record<string, RegExp> = {
  overview: /from\s+["']@\/components\/settings\/OverviewSection["']/,
  general: /from\s+["']@\/components\/settings\/GeneralSection["']/,
  appearance: /from\s+["']@\/components\/settings\/AppearanceSection["']/,
  providers: /from\s+["']@\/components\/settings\/ProviderManager["']/,
  models: /from\s+["']@\/components\/settings\/ModelsSection["']/,
  runtime: /from\s+["']@\/components\/settings\/RuntimePanel["']/,
  health: /from\s+["']@\/components\/settings\/HealthSection["']/,
  usage: /from\s+["']@\/components\/settings\/UsageStatsSection["']/,
  assistant: /from\s+["']@\/components\/settings\/AssistantWorkspaceSection["']/,
  bridge: /from\s+["']@\/components\/bridge\/BridgeLayout["']/,
  about: /from\s+["']@\/components\/settings\/AboutSection["']/,
};

const SECTION_FOLDERS = Object.keys(SECTION_TO_IMPORT);

describe('Settings route-level split', () => {
  it('every section has its own /settings/<section>/page.tsx', () => {
    const dirs = readdirSync(SETTINGS_APP, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const section of SECTION_FOLDERS) {
      assert.ok(
        dirs.includes(section),
        `expected /settings/${section}/ folder to exist`,
      );
      // page.tsx must exist inside it
      const file = path.join(SETTINGS_APP, section, 'page.tsx');
      assert.ok(
        readFileSync(file, 'utf-8').length > 0,
        `expected /settings/${section}/page.tsx to exist and be non-empty`,
      );
    }
  });

  it('each section page imports ONLY its own section', () => {
    for (const [section, ownImport] of Object.entries(SECTION_TO_IMPORT)) {
      const src = read(`${section}/page.tsx`);
      assert.match(src, ownImport, `${section}/page.tsx must import its own section`);
      // It must not pull in any OTHER section's component (static or
      // dynamic). Memory contract: the route's compile graph is one
      // section, not the union.
      for (const [other, otherImport] of Object.entries(SECTION_TO_IMPORT)) {
        if (other === section) continue;
        assert.doesNotMatch(
          src,
          otherImport,
          `${section}/page.tsx must not import ${other}`,
        );
      }
    }
  });

  it('the shared /settings layout imports zero section components', () => {
    const layout = read('layout.tsx');
    for (const [section, sectionImport] of Object.entries(SECTION_TO_IMPORT)) {
      assert.doesNotMatch(
        layout,
        sectionImport,
        `/settings/layout.tsx must not import ${section} (defeats the route split)`,
      );
    }
    // No dynamic() calls either — the shell must stay a pure shell.
    assert.doesNotMatch(
      layout,
      /\bdynamic\s*\(/,
      "/settings/layout.tsx must not use next/dynamic for sections",
    );
  });

  it('the /settings root page is a pure redirect — imports ZERO sections', () => {
    const root = read('page.tsx');
    // Memory contract: /settings is the landing for legacy /settings#hash
    // deep links, so it must not pull in any section component (not even
    // Overview). Overview now lives at /settings/overview/page.tsx; bare
    // /settings bounces there only if no hash is present.
    for (const [section, sectionImport] of Object.entries(SECTION_TO_IMPORT)) {
      assert.doesNotMatch(
        root,
        sectionImport,
        `/settings/page.tsx must not import ${section} — it is a redirect-only page`,
      );
    }
    // Server redirect — no client empty-tick (`return null` + router.replace).
    assert.match(root, /from\s+["']next\/navigation["']/);
    assert.match(root, /\bredirect\s*\(/);
    assert.match(root, /\/settings\/overview/);
    assert.doesNotMatch(root, /["']use client["']/);
  });

  it('SettingsSidebar uses pathname + Link (not hash + history.replaceState)', () => {
    const sidebar = readFileSync(
      path.resolve(__dirname, '../../components/layout/SettingsSidebar.tsx'),
      'utf-8',
    );
    assert.match(sidebar, /usePathname\(\)/);
    assert.match(sidebar, /from\s+["']next\/link["']/);
    // The old hash-bridging window.history.replaceState path must be gone.
    assert.doesNotMatch(sidebar, /history\.replaceState\(null,\s*["']{2}\s*,\s*`\/settings#\$\{section\}`/);
  });
});
