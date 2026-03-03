/**
 * Command Loader — scans custom slash commands from Claude Code command directories.
 *
 * Loads commands from:
 * 1. ~/.claude/commands/*.md (global user commands)
 * 2. <project>/.claude/commands/*.md (project-level commands)
 *
 * These are the same directories that Claude Code CLI uses for custom slash commands.
 * Commands are loaded as prompt templates that get forwarded to the conversation engine.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

/** A loaded custom command definition (immutable). */
export interface CustomCommand {
  /** Command name without leading slash (e.g. "commit", "review:pr") */
  readonly name: string;
  /** Short description extracted from the first line of the .md file */
  readonly description: string;
  /** Full prompt template content */
  readonly content: string;
  /** Where this command was loaded from */
  readonly source: 'global' | 'project';
  /** Absolute path to the .md file */
  readonly filePath: string;
}

/**
 * Built-in bridge commands that should never be overridden by custom commands.
 */
const RESERVED_COMMANDS = new Set([
  'start', 'new', 'bind', 'cwd', 'mode',
  'status', 'sessions', 'stop', 'help',
]);

/**
 * Get the global commands directory path.
 */
function getGlobalCommandsDir(): string {
  return path.join(os.homedir(), '.claude', 'commands');
}

/**
 * Get the project-level commands directory path.
 */
function getProjectCommandsDir(workingDirectory?: string): string {
  return path.join(workingDirectory || process.cwd(), '.claude', 'commands');
}

/**
 * Recursively scan a directory for .md command files.
 * Subdirectories create colon-separated command names (e.g. review/pr.md → "review:pr").
 */
function scanDirectory(
  dir: string,
  source: 'global' | 'project',
  prefix = '',
): readonly CustomCommand[] {
  if (!fs.existsSync(dir)) return [];

  const commands: CustomCommand[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const subPrefix = prefix ? `${prefix}:${entry.name}` : entry.name;
        commands.push(...scanDirectory(fullPath, source, subPrefix));
        continue;
      }

      if (!entry.name.endsWith('.md')) continue;

      const baseName = entry.name.replace(/\.md$/, '');
      const name = prefix ? `${prefix}:${baseName}` : baseName;

      // Skip reserved bridge commands
      if (RESERVED_COMMANDS.has(name)) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');
      const firstLine = content.split('\n')[0]?.trim() || '';
      const description = firstLine.startsWith('#')
        ? firstLine.replace(/^#+\s*/, '')
        : firstLine || `Custom command: /${name}`;

      commands.push({
        name,
        description: description.slice(0, 256),
        content,
        source,
        filePath: fullPath,
      });
    }
  } catch {
    // Silently ignore read errors (directory might not exist or be inaccessible)
  }

  return commands;
}

/**
 * Load all custom commands from global and project directories.
 *
 * Project commands take priority over global commands with the same name.
 * Returns an immutable array of commands.
 */
export function loadCustomCommands(workingDirectory?: string): readonly CustomCommand[] {
  const globalDir = getGlobalCommandsDir();
  const projectDir = getProjectCommandsDir(workingDirectory);

  const globalCommands = scanDirectory(globalDir, 'global');
  const projectCommands = scanDirectory(projectDir, 'project');

  // Project commands override global ones with the same name
  const projectNames = new Set(projectCommands.map(c => c.name));
  const dedupedGlobal = globalCommands.filter(c => !projectNames.has(c.name));

  return [...projectCommands, ...dedupedGlobal];
}

/**
 * Find a specific custom command by name.
 * Searches project commands first, then global commands.
 */
export function findCustomCommand(
  name: string,
  workingDirectory?: string,
): CustomCommand | null {
  const commands = loadCustomCommands(workingDirectory);
  return commands.find(c => c.name === name) ?? null;
}

/**
 * Check if a command name is a reserved bridge command.
 */
export function isReservedCommand(name: string): boolean {
  return RESERVED_COMMANDS.has(name);
}
