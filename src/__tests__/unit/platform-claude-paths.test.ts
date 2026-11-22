import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getClaudeCandidatePathsFor, getExtraPathDirsFor } from '../../lib/platform';

describe('Claude path discovery helpers', () => {
  it('darwin search dirs include pnpm, yarn, and claude local compatibility paths', () => {
    const home = '/Users/tester';
    const dirs = getExtraPathDirsFor('darwin', home, {
      PNPM_HOME: '/Users/tester/Library/pnpm',
    } as unknown as NodeJS.ProcessEnv);

    assert.ok(dirs.includes('/Users/tester/Library/pnpm'));
    assert.ok(dirs.includes('/Users/tester/.claude/local'));
    assert.ok(dirs.includes('/Users/tester/.yarn/bin'));
  });

  it('darwin candidates include executable paths for pnpm and claude local wrappers', () => {
    const home = '/Users/tester';
    const candidates = getClaudeCandidatePathsFor('darwin', home, {
      PNPM_HOME: '/Users/tester/Library/pnpm',
    } as unknown as NodeJS.ProcessEnv);

    assert.ok(candidates.includes('/Users/tester/Library/pnpm/claude'));
    assert.ok(candidates.includes('/Users/tester/.claude/local/claude'));
    assert.ok(
      candidates.indexOf('/opt/homebrew/bin/claude') < candidates.indexOf('/Users/tester/Library/pnpm/claude'),
      'homebrew candidates should stay ahead of npm-family shims',
    );
    assert.ok(
      candidates.indexOf('/Users/tester/.claude/local/claude') < candidates.indexOf('/Users/tester/Library/pnpm/claude'),
      'native compatibility wrappers should stay ahead of pnpm shims',
    );
  });

  it('win32 search dirs include pnpm and claude local compatibility paths', () => {
    const home = 'C:\\Users\\tester';
    const dirs = getExtraPathDirsFor('win32', home, {
      APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      PNPM_HOME: 'C:\\Users\\tester\\AppData\\Local\\pnpm',
    } as unknown as NodeJS.ProcessEnv);

    assert.ok(dirs.includes('C:\\Users\\tester\\AppData\\Local\\pnpm'));
    assert.ok(dirs.includes('C:\\Users\\tester\\.claude\\local'));
  });

  it('win32 candidates include pnpm cmd wrappers', () => {
    const home = 'C:\\Users\\tester';
    const candidates = getClaudeCandidatePathsFor('win32', home, {
      APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      PNPM_HOME: 'C:\\Users\\tester\\AppData\\Local\\pnpm',
    } as unknown as NodeJS.ProcessEnv);

    assert.ok(candidates.includes('C:\\Users\\tester\\AppData\\Local\\pnpm\\claude.cmd'));
    assert.ok(candidates.includes('C:\\Users\\tester\\.claude\\local\\claude.cmd'));
    assert.ok(
      candidates.indexOf('C:\\Users\\tester\\.claude\\local\\claude.cmd') <
        candidates.indexOf('C:\\Users\\tester\\AppData\\Local\\pnpm\\claude.cmd'),
      'native compatibility wrappers should stay ahead of pnpm shims on Windows',
    );
  });
});
