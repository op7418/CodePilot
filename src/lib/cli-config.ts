/**
 * Centralized Claude CLI configuration.
 *
 * All references to the Claude config directory (~/.claude or ~/.claude-internal)
 * and CLI binary name should go through this module. When `claude_config_dir`
 * is set in CodePilot app settings, that value is used; otherwise defaults to
 * `~/.claude`.
 */
import path from 'path';
import os from 'os';
import { getSetting } from './db';

const DEFAULT_CONFIG_DIR_NAME = '.claude';

/**
 * Expand leading `~` or `~user` to the actual home directory.
 * Handles `~/...`, `~\...` (Windows), and bare `~`.
 */
export function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Get the Claude configuration directory (e.g. ~/.claude or ~/.claude-internal).
 * Reads the `claude_config_dir` app setting; falls back to ~/.claude.
 */
export function getClaudeConfigDir(): string {
  const custom = getSetting('claude_config_dir');
  if (custom) return expandTilde(custom);
  return path.join(os.homedir(), DEFAULT_CONFIG_DIR_NAME);
}

/**
 * Get the Claude CLI binary name to search for in PATH.
 * Derives from `claude_cli_path` setting (basename) or defaults to "claude".
 */
export function getClaudeBinaryName(): string {
  const customPath = getSetting('claude_cli_path');
  if (customPath) {
    const base = path.basename(expandTilde(customPath));
    return base.replace(/\.(cmd|exe|bat)$/i, '') || 'claude';
  }
  return 'claude';
}

/**
 * Get the full resolved CLI path from settings (with ~ expanded).
 * Returns undefined if not configured.
 */
export function getCustomCliPath(): string | undefined {
  const customPath = getSetting('claude_cli_path');
  if (customPath) return expandTilde(customPath);
  return undefined;
}

// Convenience helpers for common subdirectories

export function getClaudeCommandsDir(): string {
  return path.join(getClaudeConfigDir(), 'commands');
}

export function getClaudeSkillsDir(): string {
  return path.join(getClaudeConfigDir(), 'skills');
}

export function getClaudeProjectsDir(): string {
  return path.join(getClaudeConfigDir(), 'projects');
}

export function getClaudeSettingsPath(): string {
  return path.join(getClaudeConfigDir(), 'settings.json');
}

export function getClaudeBinDir(): string {
  return path.join(getClaudeConfigDir(), 'bin');
}

export function getClaudePluginsDir(): string {
  return path.join(getClaudeConfigDir(), 'plugins');
}

/**
 * Get the user-level config file path (~/.claude.json or ~/.claude-internal.json).
 * This is separate from the config directory — it's the CLI's root config.
 */
export function getClaudeUserConfigPath(): string {
  const configDir = getClaudeConfigDir();
  const dirName = path.basename(configDir);
  return path.join(os.homedir(), `${dirName}.json`);
}
