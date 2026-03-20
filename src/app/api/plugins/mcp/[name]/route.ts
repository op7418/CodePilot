import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getClaudeSettingsPath, getClaudeUserConfigPath } from '@/lib/cli-config';
import type { MCPServerConfig, ErrorResponse, SuccessResponse } from '@/types';

function readJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
  try {
    const { name } = await params;
    const serverName = decodeURIComponent(name);

    let deleted = false;

    // Try deleting from ~/.claude/settings.json
    const settingsPath = getClaudeSettingsPath();
    const settings = readJsonFile(settingsPath);
    const settingsServers = (settings.mcpServers || {}) as Record<string, MCPServerConfig>;
    if (settingsServers[serverName]) {
      delete settingsServers[serverName];
      settings.mcpServers = settingsServers;
      writeJsonFile(settingsPath, settings);
      deleted = true;
    }

    // Also try deleting from ~/.claude.json
    const userConfigPath = getClaudeUserConfigPath();
    const userConfig = readJsonFile(userConfigPath);
    const userServers = (userConfig.mcpServers || {}) as Record<string, MCPServerConfig>;
    if (userServers[serverName]) {
      delete userServers[serverName];
      userConfig.mcpServers = userServers;
      writeJsonFile(userConfigPath, userConfig);
      deleted = true;
    }

    if (!deleted) {
      return NextResponse.json(
        { error: `MCP server "${serverName}" not found` },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete MCP server' },
      { status: 500 }
    );
  }
}
