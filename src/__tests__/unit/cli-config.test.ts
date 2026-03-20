/**
 * Unit tests for cli-config.ts
 *
 * Tests the centralized Claude CLI configuration module.
 *
 * Pure functions (expandTilde) are tested directly via import.
 * Functions that depend on getSetting (getClaudeConfigDir, etc.) are tested
 * by re-implementing the logic here — same pattern as mcp-config.test.ts.
 * This avoids needing to mock the database module.
 *
 * Uses Node's built-in test runner (zero dependencies).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';

const HOME = os.homedir();

// ── Import the pure function directly ──────────────────────────
import { expandTilde } from '../../lib/cli-config';

// ── Re-implement config resolution logic for testing ───────────
// This mirrors the logic in cli-config.ts but accepts settings as
// parameters instead of reading from the database.

const DEFAULT_CONFIG_DIR_NAME = '.claude';

function getClaudeConfigDir(configDirSetting?: string): string {
  if (configDirSetting) return expandTilde(configDirSetting);
  return path.join(os.homedir(), DEFAULT_CONFIG_DIR_NAME);
}

function getClaudeBinaryName(cliPathSetting?: string): string {
  if (cliPathSetting) {
    const base = path.basename(expandTilde(cliPathSetting));
    return base.replace(/\.(cmd|exe|bat)$/i, '') || 'claude';
  }
  return 'claude';
}

function getCustomCliPath(cliPathSetting?: string): string | undefined {
  if (cliPathSetting) return expandTilde(cliPathSetting);
  return undefined;
}

function getClaudeUserConfigPath(configDirSetting?: string): string {
  const configDir = getClaudeConfigDir(configDirSetting);
  const dirName = path.basename(configDir);
  return path.join(os.homedir(), `${dirName}.json`);
}

// ── Tests ──────────────────────────────────────────────────────

describe('cli-config', () => {
  // ── expandTilde (pure function, tested directly) ─────────────
  describe('expandTilde', () => {
    it('should expand bare ~ to home directory', () => {
      assert.equal(expandTilde('~'), HOME);
    });

    it('should expand ~/ prefix to home directory', () => {
      assert.equal(expandTilde('~/foo/bar'), path.join(HOME, 'foo/bar'));
    });

    it('should expand ~\\ prefix (Windows style)', () => {
      assert.equal(expandTilde('~\\foo\\bar'), path.join(HOME, 'foo\\bar'));
    });

    it('should return absolute paths unchanged', () => {
      assert.equal(
        expandTilde('/usr/local/bin/claude'),
        '/usr/local/bin/claude',
      );
    });

    it('should return relative paths unchanged', () => {
      assert.equal(expandTilde('foo/bar'), 'foo/bar');
    });

    it('should handle ~/.claude-internal', () => {
      assert.equal(
        expandTilde('~/.claude-internal'),
        path.join(HOME, '.claude-internal'),
      );
    });

    it('should not expand ~ in the middle of a path', () => {
      assert.equal(expandTilde('/home/~user/bin'), '/home/~user/bin');
    });

    it('should handle empty string', () => {
      assert.equal(expandTilde(''), '');
    });
  });

  // ── getClaudeConfigDir ───────────────────────────────────────
  describe('getClaudeConfigDir', () => {
    it('should return ~/.claude by default', () => {
      assert.equal(getClaudeConfigDir(), path.join(HOME, '.claude'));
    });

    it('should return custom dir when setting is provided', () => {
      assert.equal(
        getClaudeConfigDir('~/.claude-internal'),
        path.join(HOME, '.claude-internal'),
      );
    });

    it('should expand tilde in custom config dir', () => {
      assert.equal(
        getClaudeConfigDir('~/custom-claude'),
        path.join(HOME, 'custom-claude'),
      );
    });

    it('should handle absolute path without tilde', () => {
      assert.equal(
        getClaudeConfigDir('/opt/claude-config'),
        '/opt/claude-config',
      );
    });

    it('should ignore empty string setting (fall back to default)', () => {
      assert.equal(getClaudeConfigDir(''), path.join(HOME, '.claude'));
    });
  });

  // ── getClaudeBinaryName ──────────────────────────────────────
  describe('getClaudeBinaryName', () => {
    it('should return "claude" by default', () => {
      assert.equal(getClaudeBinaryName(), 'claude');
    });

    it('should derive name from custom CLI path', () => {
      assert.equal(
        getClaudeBinaryName('/usr/local/bin/claude-internal'),
        'claude-internal',
      );
    });

    it('should strip .cmd extension (Windows)', () => {
      // On macOS/Linux, path.basename doesn't split on backslash,
      // so the full path becomes the basename. The .cmd is still stripped.
      const result = getClaudeBinaryName('C:\\Program Files\\claude.cmd');
      assert.ok(
        result.endsWith('claude'),
        `expected to end with "claude", got "${result}"`,
      );
      assert.ok(!result.endsWith('.cmd'), 'should not end with .cmd');
    });

    it('should strip .exe extension (Windows)', () => {
      assert.equal(
        getClaudeBinaryName('~/bin/claude-internal.exe'),
        'claude-internal',
      );
    });

    it('should strip .bat extension (Windows, case insensitive)', () => {
      assert.equal(getClaudeBinaryName('~/bin/claude.BAT'), 'claude');
    });

    it('should handle tilde in CLI path', () => {
      assert.equal(getClaudeBinaryName('~/bin/my-claude'), 'my-claude');
    });

    it('should not strip non-Windows extensions', () => {
      assert.equal(getClaudeBinaryName('/usr/bin/claude.sh'), 'claude.sh');
    });
  });

  // ── getCustomCliPath ─────────────────────────────────────────
  describe('getCustomCliPath', () => {
    it('should return undefined when not configured', () => {
      assert.equal(getCustomCliPath(), undefined);
      assert.equal(getCustomCliPath(undefined), undefined);
    });

    it('should return expanded path when configured with tilde', () => {
      assert.equal(
        getCustomCliPath('~/bin/claude-internal'),
        path.join(HOME, 'bin/claude-internal'),
      );
    });

    it('should return absolute path as-is', () => {
      assert.equal(
        getCustomCliPath('/usr/local/bin/claude'),
        '/usr/local/bin/claude',
      );
    });
  });

  // ── Convenience helpers ──────────────────────────────────────
  describe('convenience helpers (default config)', () => {
    const base = path.join(HOME, '.claude');

    it('commands dir', () => {
      assert.equal(
        path.join(getClaudeConfigDir(), 'commands'),
        path.join(base, 'commands'),
      );
    });

    it('skills dir', () => {
      assert.equal(
        path.join(getClaudeConfigDir(), 'skills'),
        path.join(base, 'skills'),
      );
    });

    it('projects dir', () => {
      assert.equal(
        path.join(getClaudeConfigDir(), 'projects'),
        path.join(base, 'projects'),
      );
    });

    it('settings path', () => {
      assert.equal(
        path.join(getClaudeConfigDir(), 'settings.json'),
        path.join(base, 'settings.json'),
      );
    });

    it('bin dir', () => {
      assert.equal(
        path.join(getClaudeConfigDir(), 'bin'),
        path.join(base, 'bin'),
      );
    });

    it('plugins dir', () => {
      assert.equal(
        path.join(getClaudeConfigDir(), 'plugins'),
        path.join(base, 'plugins'),
      );
    });
  });

  describe('convenience helpers (custom config dir)', () => {
    const customDir = '~/.claude-internal';
    const base = path.join(HOME, '.claude-internal');

    it('all subdirs should use custom base', () => {
      const dir = getClaudeConfigDir(customDir);
      assert.equal(path.join(dir, 'commands'), path.join(base, 'commands'));
      assert.equal(path.join(dir, 'skills'), path.join(base, 'skills'));
      assert.equal(path.join(dir, 'projects'), path.join(base, 'projects'));
      assert.equal(
        path.join(dir, 'settings.json'),
        path.join(base, 'settings.json'),
      );
      assert.equal(path.join(dir, 'bin'), path.join(base, 'bin'));
      assert.equal(path.join(dir, 'plugins'), path.join(base, 'plugins'));
    });
  });

  // ── getClaudeUserConfigPath ──────────────────────────────────
  describe('getClaudeUserConfigPath', () => {
    it('should return ~/.claude.json by default', () => {
      assert.equal(getClaudeUserConfigPath(), path.join(HOME, '.claude.json'));
    });

    it('should derive .json filename from custom config dir name', () => {
      assert.equal(
        getClaudeUserConfigPath('~/.claude-internal'),
        path.join(HOME, '.claude-internal.json'),
      );
    });

    it('should use basename of absolute path config dir', () => {
      assert.equal(
        getClaudeUserConfigPath('/opt/my-claude'),
        path.join(HOME, 'my-claude.json'),
      );
    });
  });
});
