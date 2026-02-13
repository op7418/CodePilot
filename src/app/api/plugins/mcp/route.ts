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
    // Merge: ~/.claude/settings.json takes precedence over ~/.claude.json
    const mcpServers = {
      ...((userConfig.mcpServers || {}) as Record<string, MCPServerConfig>),
      ...((settings.mcpServers || {}) as Record<string, MCPServerConfig>),
    };
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
    const { mcpServers } = body as { mcpServers: Record<string, MCPServerConfig> };

    const settings = readSettings();
    settings.mcpServers = mcpServers;
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

    if (!name || !server || !server.command) {
      return NextResponse.json(
        { error: 'Name and server command are required' },
        { status: 400 }
      );
    }

    const settings = readSettings();
    if (!settings.mcpServers) {
      settings.mcpServers = {};
    }

    const mcpServers = settings.mcpServers as Record<string, MCPServerConfig>;
    if (mcpServers[name]) {
      return NextResponse.json(
        { error: `MCP server "${name}" already exists` },
        { status: 409 }
      );
    }

    mcpServers[name] = server;
    writeSettings(settings);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add MCP server' },
      { status: 500 }
    );
  }
}
