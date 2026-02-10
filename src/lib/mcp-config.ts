/**
 * Shared MCP configuration reader.
 * Reads MCP server configs from:
 *   1. CLI discovery: `claude mcp list` (cached 60s)
 *   2. User-level: ~/.claude/settings.json → mcpServers
 *   3. Project-level: <workDir>/.mcp.json → mcpServers
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

/**
 * Discover MCP servers by calling `claude mcp list` (async).
 * Parses output lines like: `name: command args - ✓ Connected`
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

    // Parse lines like:
    //   reactbits: cmd /c npx reactbits-dev-mcp-server - ✓ Connected
    //   shadcn: cmd /c npx shadcn@latest mcp - ✗ Failed
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const match = line.match(/^(\S+):\s+(.+?)\s+-\s+[✓✗]/);
        if (!match) continue;
        const [, name, fullCommand] = match;
        const parts = fullCommand.trim().split(/\s+/);
        const command = parts[0];
        const args = parts.slice(1);
        servers[name] = { command, ...(args.length > 0 ? { args } : {}) };
      } catch {
        // Single line parse failure — skip and continue with other lines
      }
    }
  } catch {
    // CLI not available or timed out — return empty
  }

  cliCache = { servers, timestamp: Date.now() };
  return servers;
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
 * Merge CLI-discovered, user-level, and project-level MCP servers.
 * Priority (highest wins): project-level > user-level > CLI-discovered.
 */
export async function getMergedMcpServers(
  workDir?: string
): Promise<Record<string, MCPServerConfig>> {
  const cliServers = await discoverCliMcpServers();
  const userServers = readUserMcpServers();
  const projectServers = readProjectMcpServers(workDir);
  return { ...cliServers, ...userServers, ...projectServers };
}
