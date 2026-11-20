/**
 * Locks the dev-server memory guardrails for nested worktrees.
 *
 * This repository commonly runs feature branches from `.claude/worktrees/*`.
 * Next/Turbopack must stay rooted to the active worktree, and the persistent
 * dev filesystem cache must remain disabled because it has grown to multi-GB
 * `.next/dev/cache/turbopack` stores that trigger macOS memory pressure when
 * restored by `next dev`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const NEXT_CONFIG = readFileSync(
  path.resolve(__dirname, '../../../next.config.ts'),
  'utf-8',
);

describe('next.config.ts dev-server guardrails', () => {
  it('pins Turbopack root to the current worktree', () => {
    assert.match(NEXT_CONFIG, /turbopack:\s*\{[\s\S]*?root:\s*import\.meta\.dirname/);
  });

  it('disables Turbopack dev filesystem cache', () => {
    assert.match(NEXT_CONFIG, /experimental:\s*\{[\s\S]*?turbopackFileSystemCacheForDev:\s*false/);
  });

  it('keeps Turbopack source maps opt-in to limit dev memory pressure', () => {
    assert.match(NEXT_CONFIG, /turbopackSourceMaps:\s*process\.env\.CODEPILOT_SOURCE_MAPS\s*===\s*['"]1['"]/);
    assert.match(NEXT_CONFIG, /turbopackInputSourceMaps:\s*false/);
  });

  it('allows Electron dev renderer origin to load Next dev resources', () => {
    assert.match(NEXT_CONFIG, /allowedDevOrigins:\s*\[\s*['"]127\.0\.0\.1['"]\s*\]/);
  });
});
