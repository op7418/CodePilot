/**
 * Settings link migration — memory + UX guardrail.
 *
 * The route-level split moved every section into its own page (`/settings/
 * providers`, `/settings/models`, …). For the split to actually save dev
 * memory AND for cross-section CTAs to actually switch pages, internal
 * navigation must stop using ANY hash form:
 *
 *   1. `/settings#providers` markdown / anchor links — they land on the
 *      redirect-only root page first, costing an extra compile pass.
 *   2. `navTo("#providers")` helpers writing to `window.location.hash` —
 *      under route-level split, mutating the hash on `/settings/<section>`
 *      no longer switches pages, so the click silently does nothing.
 *   3. `window.location.hash = "#models"` direct writes — same failure as
 *      (2). Bare `router.push("#models")` would have the same flaw.
 *
 * This test scans every active source file under src/ (skipping tests),
 * strips comments / JSDoc, and fails if any of the patterns survive in
 * runtime code. Comments / JSDoc / a few READ-only listeners are
 * explicitly allowlisted because they document or react to the legacy
 * compat that the redirect-only root page still honors for external
 * deep links.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue;
    if (entry === 'node_modules') continue;
    if (entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip TS / JSX line and block comments. The route-split contract only
 * cares about runtime strings, not historical notes in JSDoc.
 */
function stripComments(src: string): string {
  // Strip line comments first so embedded `/*` fragments inside `//`
  // prose don't leak into the block-stripper as fake start markers.
  return src
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

interface Pattern {
  /** Human-readable name for the failure message. */
  name: string;
  /** Per-line regex; first match becomes the offender. */
  re: RegExp;
  /** Specific files where this pattern is allowed (READ-only listeners,
   *  the root redirect page reading `window.location.hash`, etc.). */
  allowFiles?: string[];
}

const PATTERNS: Pattern[] = [
  {
    name: 'markdown / anchor href "/settings#…"',
    re: /\/settings#\w+/,
  },
  {
    name: 'navTo("#…") helper call (must use router.push("/settings/…"))',
    re: /\bnavTo\s*\(\s*["']#\w+["']/,
  },
  {
    name: 'window.location.hash = "#…" write (must use router.push("/settings/…"))',
    re: /window\.location\.hash\s*=\s*["']#\w+["']/,
    // The /settings root page READS window.location.hash and translates
    // legacy `#section` deep links into a router.replace to /settings/<section>.
    // It never writes the hash itself, but the regex above is a write-pattern
    // — keeping the allowlist for symmetry / future safety.
    allowFiles: [],
  },
  {
    name: 'router.push("#…") / router.replace("#…") (must point at "/settings/…")',
    re: /\brouter\s*\.\s*(?:push|replace)\s*\(\s*["']#\w+["']/,
  },
];

describe('Settings link migration — no bare hash navigation in active code', () => {
  it('flags every active hash-based Settings nav (anchor / navTo / location.hash / router)', () => {
    const offenders: { file: string; line: number; match: string; pattern: string }[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file);
      const raw = readFileSync(file, 'utf-8');
      const stripped = stripComments(raw);
      const rawLines = raw.split('\n');
      const strippedLines = stripped.split('\n');
      for (let i = 0; i < strippedLines.length; i++) {
        const line = strippedLines[i];
        for (const p of PATTERNS) {
          if (p.allowFiles?.includes(rel)) continue;
          const m = line.match(p.re);
          if (m) {
            offenders.push({
              file: rel,
              line: i + 1,
              match: rawLines[i]?.trim() ?? m[0],
              pattern: p.name,
            });
          }
        }
      }
    }
    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  [${o.pattern}]\n    ${o.file}:${o.line} → ${o.match}`)
        .join('\n');
      assert.fail(
        `Found ${offenders.length} bare-hash navigation site(s) under src/. ` +
          `Migrate to route-level paths via router.push("/settings/<section>"). ` +
          `Hash mentions in JSDoc / comments are tolerated; READ-only listeners ` +
          `(window.location.hash === "#…") are NOT flagged because they react to ` +
          `legacy entries arriving from outside.\nActive offenders:\n${detail}`,
      );
    }
  });

  it('the /settings root page server-redirects to overview', () => {
    // Server redirect removes the client empty-tick. Internal callers already
    // use /settings/<section>; this page must stay import-free.
    const root = readFileSync(
      path.resolve(__dirname, '../../app/settings/page.tsx'),
      'utf-8',
    );
    assert.match(root, /\bredirect\s*\(/);
    assert.match(root, /\/settings\/overview/);
    assert.doesNotMatch(root, /["']use client["']/);
  });
});
