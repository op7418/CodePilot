/**
 * MCP Server Loader — shared module for loading MCP server configurations.
 *
 * The SDK auto-loads MCP servers from settingSources (['user', 'project', 'local']).
 * We only manually pass servers that need CodePilot-specific processing:
 * ${...} env placeholder resolution from the CodePilot DB.
 *
 * This eliminates redundant config passing and reduces initialization overhead.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { MCPServerConfig } from '@/types';
import { getSetting } from '@/lib/db';

// ── Cache ────────────────────────────────────────────────────────────

interface CachedMcpConfig {
  allServers: Record<string, MCPServerConfig>;
  codepilotServers: Record<string, MCPServerConfig>; // Only servers with resolved ${...} placeholders
  timestamp: number;
}

const CACHE_TTL_MS = 30_000; // 30 seconds
let _cache: CachedMcpConfig | null = null;

/** Invalidate the cache (e.g., after adding/removing a server via UI). */
export function invalidateMcpCache(): void {
  _cache = null;
}

// ── Internal helpers ─────────────────────────────────────────────────

function readJson(p: string): Record<string, unknown> {
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return {}; }
}

function loadAndMerge(): CachedMcpConfig {
  // Check cache
  if (_cache && Date.now() - _cache.timestamp < CACHE_TTL_MS) {
    return _cache;
  }

  const userConfig = readJson(path.join(os.homedir(), '.claude.json'));
  const settings = readJson(path.join(os.homedir(), '.claude', 'settings.json'));
  const projectMcp = readJson(path.join(process.cwd(), '.mcp.json'));

  const merged: Record<string, MCPServerConfig> = {
    ...((userConfig.mcpServers || {}) as Record<string, MCPServerConfig>),
    ...((settings.mcpServers || {}) as Record<string, MCPServerConfig>),
    ...((projectMcp.mcpServers || {}) as Record<string, MCPServerConfig>),
  };

  // Apply persistent enabled overrides for project-level servers
  const settingsOverrides = (settings.mcpServerOverrides || {}) as Record<string, { enabled?: boolean }>;
  for (const [name, override] of Object.entries(settingsOverrides)) {
    if (merged[name] && override.enabled !== undefined) {
      merged[name] = { ...merged[name], enabled: override.enabled };
    }
  }

  // Resolve ${...} placeholders and track which servers needed resolution
  const codepilotServers: Record<string, MCPServerConfig> = {};

  for (const [name, server] of Object.entries(merged)) {
    if (server.env) {
      let hasPlaceholder = false;
      for (const [key, value] of Object.entries(server.env)) {
        if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
          hasPlaceholder = true;
          const settingKey = value.slice(2, -1);
          const resolved = getSetting(settingKey);
          server.env[key] = resolved || '';
        }
      }
      // Only include in codepilotServers if it had placeholders
      if (hasPlaceholder && server.enabled !== false) {
        codepilotServers[name] = server;
      }
    }
  }

  // Filter out persistently disabled servers from allServers
  for (const [name, server] of Object.entries(merged)) {
    if (server.enabled === false) {
      delete merged[name];
    }
  }

  _cache = {
    allServers: merged,
    codepilotServers,
    timestamp: Date.now(),
  };

  return _cache;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Load MCP servers that need CodePilot-specific processing.
 *
 * Returns only servers with ${...} env placeholders that were resolved
 * against the CodePilot DB. Returns undefined when no such servers exist
 * (the common case), letting the SDK load everything natively.
 *
 * Used by: route.ts, conversation-engine.ts — passed to streamClaude().
 */
export function loadCodePilotMcpServers(): Record<string, MCPServerConfig> | undefined {
  try {
    const { codepilotServers } = loadAndMerge();
    return Object.keys(codepilotServers).length > 0 ? codepilotServers : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load ALL MCP servers (for UI display in MCP Manager).
 *
 * Returns the full merged config from all sources with overrides applied.
 * NOT intended for passing to the SDK — use loadCodePilotMcpServers() instead.
 *
 * Used by: MCP Manager UI, diagnostics.
 */
export function loadAllMcpServers(): Record<string, MCPServerConfig> | undefined {
  try {
    const { allServers } = loadAndMerge();
    return Object.keys(allServers).length > 0 ? allServers : undefined;
  } catch {
    return undefined;
  }
}
