import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { invalidateMcpCache } from '@/lib/mcp-loader';
import type {
  MCPServerConfig,
  MCPConfigResponse,
  ErrorResponse,
  SuccessResponse,
} from '@/types';

function getSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

// ~/.claude.json — Claude CLI stores user-scoped MCP servers here
function getUserConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

function readJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function readSettings(): Record<string, unknown> {
  return readJsonFile(getSettingsPath());
}

function writeSettings(settings: Record<string, unknown>): void {
  const settingsPath = getSettingsPath();
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

export async function GET(): Promise<NextResponse<MCPConfigResponse | ErrorResponse>> {
  try {
    const settings = readSettings();
    const userConfig = readJsonFile(getUserConfigPath());
    const settingsServers = (settings.mcpServers || {}) as Record<string, MCPServerConfig>;
    const userConfigServers = (userConfig.mcpServers || {}) as Record<string, MCPServerConfig>;

    // Also read project-level .mcp.json so the UI can display and toggle project servers
    const projectMcp = readJsonFile(path.join(process.cwd(), '.mcp.json'));
    const projectServers = (projectMcp.mcpServers || {}) as Record<string, MCPServerConfig>;

    // Merge: settings.json > claude.json > project .mcp.json
    // Tag each server with _source so UI knows where it came from
    const mcpServers: Record<string, MCPServerConfig & { _source?: string }> = {};
    for (const [name, server] of Object.entries(projectServers)) {
      mcpServers[name] = { ...server, _source: 'project' };
    }
    for (const [name, server] of Object.entries(userConfigServers)) {
      mcpServers[name] = { ...server, _source: 'claude.json' };
    }
    for (const [name, server] of Object.entries(settingsServers)) {
      mcpServers[name] = { ...server, _source: 'settings.json' };
    }

    // For project-source servers, check if settings.json has an enabled override
    // (project .mcp.json is read-only; we persist enabled state to settings.json)
    const settingsOverrides = (settings.mcpServerOverrides || {}) as Record<string, { enabled?: boolean }>;
    for (const [name, server] of Object.entries(mcpServers)) {
      if (server._source === 'project' && settingsOverrides[name]?.enabled !== undefined) {
        mcpServers[name] = { ...server, enabled: settingsOverrides[name].enabled };
      }
    }

    return NextResponse.json({ mcpServers });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read MCP config' },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest
): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
  try {
    const body = await request.json();
    const incoming = body.mcpServers as Record<string, MCPServerConfig & { _source?: string }>;

    // Split incoming servers by source and write to the correct file.
    // Servers without _source or with _source='settings.json' → settings.json
    // Servers with _source='claude.json' → ~/.claude.json
    const forSettings: Record<string, MCPServerConfig> = {};
    const forUserConfig: Record<string, MCPServerConfig> = {};
    let forProjectOverrides: Record<string, { enabled?: boolean }> | undefined;

    for (const [name, server] of Object.entries(incoming)) {
      const { _source, ...cleanServer } = server;
      if (_source === 'project') {
        // Project servers are read-only — only persist enabled override to settings.json
        if (cleanServer.enabled !== undefined) {
          if (!forProjectOverrides) forProjectOverrides = {};
          forProjectOverrides[name] = { enabled: cleanServer.enabled };
        }
      } else if (_source === 'claude.json') {
        forUserConfig[name] = cleanServer;
      } else {
        forSettings[name] = cleanServer;
      }
    }

    // Write settings.json
    const settings = readSettings();
    settings.mcpServers = forSettings;
    if (forProjectOverrides) {
      settings.mcpServerOverrides = forProjectOverrides;
    }
    writeSettings(settings);

    // Write ~/.claude.json (only the mcpServers key, preserve other fields)
    const userConfig = readJsonFile(getUserConfigPath());
    userConfig.mcpServers = forUserConfig;
    const userConfigPath = getUserConfigPath();
    const dir = path.dirname(userConfigPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(userConfigPath, JSON.stringify(userConfig, null, 2), 'utf-8');

    invalidateMcpCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update MCP config' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest
): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
  try {
    const body = await request.json();
    const { name, server } = body as { name: string; server: MCPServerConfig };

    // stdio servers require command; sse/http servers require url
    const isRemote = server?.type === 'sse' || server?.type === 'http';
    if (!name || !server || (!isRemote && !server.command) || (isRemote && !server.url)) {
      return NextResponse.json(
        { error: isRemote ? 'Name and server URL are required' : 'Name and server command are required' },
        { status: 400 }
      );
    }

    // Check both config files for name collision (merged namespace)
    const settings = readSettings();
    const userConfig = readJsonFile(getUserConfigPath());
    if (!settings.mcpServers) {
      settings.mcpServers = {};
    }

    const settingsServers = settings.mcpServers as Record<string, MCPServerConfig>;
    const userConfigServers = (userConfig.mcpServers || {}) as Record<string, MCPServerConfig>;
    if (settingsServers[name] || userConfigServers[name]) {
      return NextResponse.json(
        { error: `MCP server "${name}" already exists` },
        { status: 409 }
      );
    }

    const mcpServers = settingsServers;

    mcpServers[name] = server;
    writeSettings(settings);

    invalidateMcpCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add MCP server' },
      { status: 500 }
    );
  }
}
