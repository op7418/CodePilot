/**
 * Shared MCP configuration reader.
 * Reads MCP server configs from:
 *   1. CLI discovery: `claude mcp list` (cached 60s)
 *   2. Claude config: ~/.claude.json -> mcpServers (fallback for CLI discovery)
 *   3. User-level: ~/.claude/settings.json -> mcpServers
 *   4. Project-level: <workDir>/.mcp.json -> mcpServers
 * Later sources override earlier ones for the same server name.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { MCPServerConfig } from '@/types';
import { findClaudeBinary, findGitBash, getExpandedPath, isWindows } from './platform';

const execFileAsync = promisify(execFile);

// Cache for CLI-discovered MCP servers
let cliCache: { servers: Record<string, MCPServerConfig>; timestamp: number } | null = null;
const CLI_CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Invalidate the CLI MCP server cache, forcing the next call to re-discover.
 */
export function invalidateCliMcpCache(): void {
  cliCache = null;
}

type QuoteChar = '"' | "'";

/**
 * Split a CLI command string into argv tokens while preserving quoted sections.
 */
function splitCommandLine(commandLine: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: QuoteChar | null = null;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }

      // Handle escaped quotes/backslashes inside double-quoted strings.
      if (ch === '\\' && quote === '"' && i + 1 < commandLine.length) {
        const next = commandLine[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i++;
          continue;
        }
      }

      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

/**
 * Parse one line from `claude mcp list` output.
 * Expected shape: `<name>: <command> - [status]`.
 */
export function parseCliMcpListLine(
  line: string
): { name: string; config: MCPServerConfig } | null {
  const colonIndex = line.indexOf(':');
  if (colonIndex <= 0) return null;

  const name = line.slice(0, colonIndex).trim();
  if (!name) return null;

  const commandAndStatus = line.slice(colonIndex + 1).trim();
  const statusSeparator = commandAndStatus.lastIndexOf(' - ');
  if (statusSeparator <= 0) return null;

  const fullCommand = commandAndStatus.slice(0, statusSeparator).trim();
  const statusText = commandAndStatus.slice(statusSeparator + 3).trim();
  if (!fullCommand || !/^[\u2713\u2717]/.test(statusText)) return null;

  const argv = splitCommandLine(fullCommand);
  if (argv.length === 0) return null;

  const [command, ...args] = argv;
  return {
    name,
    config: {
      command,
      ...(args.length > 0 ? { args } : {}),
    },
  };
}

/**
 * Discover MCP servers by calling `claude mcp list` (async).
 * Results are cached for 60 seconds to avoid frequent CLI calls.
 *
 * NOTE: This relies on the human-readable output format of `claude mcp list`.
 * `claude mcp list --json` is not currently available (verified as of 2025-05).
 * If a JSON flag becomes available in the future, prefer using it for robustness.
 *
 * @param forceRefresh - If true, bypass the cache and re-discover from CLI.
 */
export async function discoverCliMcpServers(
  forceRefresh?: boolean
): Promise<Record<string, MCPServerConfig>> {
  if (!forceRefresh && cliCache && Date.now() - cliCache.timestamp < CLI_CACHE_TTL_MS) {
    return cliCache.servers;
  }

  const servers: Record<string, MCPServerConfig> = {};

  try {
    const claudePath = findClaudeBinary();
    if (!claudePath) return servers;

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: getExpandedPath(),
    };

    // On Windows, ensure Git Bash is available for Claude CLI
    if (isWindows && !env.CLAUDE_CODE_GIT_BASH_PATH) {
      const gitBash = findGitBash();
      if (gitBash) {
        env.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
      }
    }

    const needsShell = isWindows && /\.(cmd|bat)$/i.test(claudePath);
    const { stdout } = await execFileAsync(claudePath, ['mcp', 'list'], {
      timeout: 10_000,
      env: env as NodeJS.ProcessEnv,
      shell: needsShell,
    });

    for (const line of stdout.split(/\r?\n/)) {
      try {
        const parsed = parseCliMcpListLine(line);
        if (!parsed) continue;
        servers[parsed.name] = parsed.config;
      } catch {
        // Single line parse failure - skip and continue with other lines
      }
    }
  } catch {
    // CLI not available or timed out - return empty
  }

  cliCache = { servers, timestamp: Date.now() };
  return servers;
}

/**
 * Read MCP servers from ~/.claude.json (Claude Code's main config file).
 * This is where `claude mcp add` stores server configs.
 * Used as a reliable fallback when `claude mcp list` fails (e.g. on Windows
 * where Git Bash detection can prevent the CLI from running).
 */
export function readClaudeConfigMcpServers(): Record<string, MCPServerConfig> {
  const configPath = path.join(os.homedir(), '.claude.json');
  try {
    if (!fs.existsSync(configPath)) return {};
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return (config.mcpServers || {}) as Record<string, MCPServerConfig>;
  } catch {
    return {};
  }
}

/**
 * Read MCP servers from ~/.claude/settings.json
 */
export function readUserMcpServers(): Record<string, MCPServerConfig> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    if (!fs.existsSync(settingsPath)) return {};
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return (settings.mcpServers || {}) as Record<string, MCPServerConfig>;
  } catch {
    return {};
  }
}

/**
 * Read MCP servers from <workDir>/.mcp.json
 */
export function readProjectMcpServers(
  workDir?: string
): Record<string, MCPServerConfig> {
  if (!workDir) return {};
  const mcpPath = path.join(workDir, '.mcp.json');
  try {
    if (!fs.existsSync(mcpPath)) return {};
    const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    return (config.mcpServers || {}) as Record<string, MCPServerConfig>;
  } catch {
    return {};
  }
}

/**
 * Merge CLI-discovered, claude config, user-level, and project-level MCP servers.
 * Priority (highest wins): project-level > user-level > claude config > CLI-discovered.
 */
export async function getMergedMcpServers(
  workDir?: string
): Promise<Record<string, MCPServerConfig>> {
  const cliServers = await discoverCliMcpServers();
  const claudeConfigServers = readClaudeConfigMcpServers();
  const userServers = readUserMcpServers();
  const projectServers = readProjectMcpServers(workDir);
  return { ...cliServers, ...claudeConfigServers, ...userServers, ...projectServers };
}
