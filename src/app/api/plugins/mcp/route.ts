import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type {
  MCPServerConfig,
  MCPConfigResponse,
  ErrorResponse,
  SuccessResponse,
} from '@/types';
import { discoverCliMcpServers, invalidateCliMcpCache } from '@/lib/mcp-config';

function getSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readSettings(): Record<string, unknown> {
  const settingsPath = getSettingsPath();
  if (!fs.existsSync(settingsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, unknown>): void {
  const settingsPath = getSettingsPath();
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

function stripServerSource(server: MCPServerConfig): MCPServerConfig {
  const persisted = { ...server };
  delete persisted.source;
  return persisted;
}

function normalizeSettingsServers(raw: unknown): Record<string, MCPServerConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const result: Record<string, MCPServerConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    result[name] = stripServerSource(value as MCPServerConfig);
  }
  return result;
}

function extractPersistedServers(raw: unknown): Record<string, MCPServerConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const result: Record<string, MCPServerConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

    const server = value as MCPServerConfig;
    if (server.source === 'cli') continue;

    result[name] = stripServerSource(server);
  }
  return result;
}

function validateServerConfig(server: MCPServerConfig): string | null {
  const type = server.type || 'stdio';

  if (type === 'stdio') {
    if (!server.command?.trim()) {
      return 'Server command is required for stdio servers';
    }
    return null;
  }

  if (!server.url?.trim()) {
    return 'Server URL is required for SSE/HTTP servers';
  }

  return null;
}

export async function GET(request: NextRequest): Promise<NextResponse<MCPConfigResponse | ErrorResponse>> {
  try {
    const forceRefresh = request.nextUrl.searchParams.get('refresh') === 'true';
    if (forceRefresh) {
      invalidateCliMcpCache();
    }

    const settings = readSettings();
    const settingsServers = normalizeSettingsServers(settings.mcpServers);
    const cliServers = await discoverCliMcpServers(forceRefresh);

    // CLI-discovered servers are read-only in UI; settings servers override same-name CLI entries.
    const mcpServers: Record<string, MCPServerConfig> = {};
    for (const [name, config] of Object.entries(cliServers)) {
      mcpServers[name] = { ...config, source: 'cli' };
    }
    for (const [name, config] of Object.entries(settingsServers)) {
      mcpServers[name] = { ...config, source: 'settings' };
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
    const mcpServers = (body as { mcpServers?: unknown }).mcpServers;

    if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
      return NextResponse.json(
        { error: 'Invalid MCP config payload' },
        { status: 400 }
      );
    }

    const settings = readSettings();
    settings.mcpServers = extractPersistedServers(mcpServers);
    writeSettings(settings);

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

    if (!name || typeof name !== 'string') {
      return NextResponse.json(
        { error: 'Server name is required' },
        { status: 400 }
      );
    }

    if (!server || typeof server !== 'object') {
      return NextResponse.json(
        { error: 'Server config is required' },
        { status: 400 }
      );
    }

    const normalizedServer = stripServerSource(server);
    const validationError = validateServerConfig(normalizedServer);
    if (validationError) {
      return NextResponse.json(
        { error: validationError },
        { status: 400 }
      );
    }

    const settings = readSettings();
    const mcpServers = normalizeSettingsServers(settings.mcpServers);

    if (mcpServers[name]) {
      return NextResponse.json(
        { error: `MCP server "${name}" already exists` },
        { status: 409 }
      );
    }

    mcpServers[name] = normalizedServer;
    settings.mcpServers = mcpServers;
    writeSettings(settings);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add MCP server' },
      { status: 500 }
    );
  }
}
