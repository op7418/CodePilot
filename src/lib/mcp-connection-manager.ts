/**
 * mcp-connection-manager.ts — MCP server connection pool for the Native Runtime.
 *
 * Manages connections to external MCP servers (stdio/sse/http).
 * Discovers their tools via listTools() and exposes them as callable.
 * The SDK Runtime doesn't use this — it passes mcpServers to the SDK Options.
 */

import type { MCPServerConfig } from '@/types';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

// Lazy-load MCP SDK to avoid import errors when not used
let Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
let StdioClientTransport: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport;

type McpClient = InstanceType<typeof Client>;

/**
 * agent-loop syncs on every turn; without a cooldown a broken server would be
 * respawned once per message.
 */
export const MCP_FAILED_RETRY_COOLDOWN_MS = 60_000;

interface McpConnection {
  name: string;
  config: MCPServerConfig;
  configKey: string;
  client: McpClient | null;
  tools: McpToolDefinition[];
  status: 'connected' | 'connecting' | 'failed' | 'disabled';
  error?: string;
  failedAt?: number;
}

interface McpTestOverrides {
  createClient?: (name: string) => McpClient;
  createTransport?: (config: MCPServerConfig) => Promise<Transport>;
  now?: () => number;
}

let testOverrides: McpTestOverrides = {};

export function __setMcpConnectionTestOverridesForTests(overrides: McpTestOverrides): void {
  testOverrides = overrides;
}

function now(): number {
  return testOverrides.now ? testOverrides.now() : Date.now();
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface McpToolDefinition {
  /** Fully qualified name: mcp__{serverName}__{toolName} */
  qualifiedName: string;
  /** Original tool name from the MCP server */
  originalName: string;
  /** Server this tool belongs to */
  serverName: string;
  /** Tool description */
  description: string;
  /** JSON Schema for the tool's input */
  inputSchema: Record<string, unknown>;
}

// ── Singleton pool ──────────────────────────────────────────────

const connections = new Map<string, McpConnection>();

/**
 * Sync the connection pool with desired configurations.
 * Connects new servers, disconnects removed ones, reconnects servers whose
 * config changed, and retries failed servers only after the cooldown.
 */
export async function syncMcpConnections(
  desiredConfigs: Record<string, MCPServerConfig>,
): Promise<void> {
  const desiredNames = new Set(Object.keys(desiredConfigs));

  for (const name of [...connections.keys()]) {
    if (!desiredNames.has(name)) {
      await disconnectServer(name);
    }
  }

  for (const [name, config] of Object.entries(desiredConfigs)) {
    const existing = connections.get(name);
    if (!existing) {
      await connectServer(name, config);
      continue;
    }
    if (existing.configKey !== stableSerialize(config)) {
      await disconnectServer(name);
      await connectServer(name, config);
      continue;
    }
    if (
      existing.status === 'failed'
      && now() - (existing.failedAt ?? 0) >= MCP_FAILED_RETRY_COOLDOWN_MS
    ) {
      await connectServer(name, config);
    }
  }
}

/**
 * Connect to a single MCP server. Not subject to the failure cooldown, so
 * user-initiated reconnects always attempt a fresh connection.
 */
export async function connectServer(name: string, config: MCPServerConfig): Promise<void> {
  const previous = connections.get(name);
  if (previous?.client) {
    try { await previous.client.close(); } catch { /* ignore */ }
  }

  const conn: McpConnection = {
    name,
    config,
    configKey: stableSerialize(config),
    client: null,
    tools: [],
    status: 'connecting',
  };
  connections.set(name, conn);

  let client: McpClient | null = null;
  let transport: Transport | null = null;
  try {
    if (testOverrides.createClient) {
      client = testOverrides.createClient(name);
    } else {
      if (!Client) {
        const clientModule = await import('@modelcontextprotocol/sdk/client/index.js');
        Client = clientModule.Client;
      }
      client = new Client({ name: `codepilot-${name}`, version: '1.0.0' });
    }
    transport = await (testOverrides.createTransport ?? createTransport)(config);

    await client.connect(transport);
    conn.client = client;

    // Discover tools
    const toolsResult = await client.listTools();
    conn.tools = (toolsResult.tools || []).map(t => ({
      qualifiedName: `mcp__${name}__${t.name}`,
      originalName: t.name,
      serverName: name,
      description: t.description || '',
      inputSchema: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
    }));

    conn.status = 'connected';
  } catch (err) {
    conn.client = null;
    conn.tools = [];
    conn.status = 'failed';
    conn.failedAt = now();
    conn.error = err instanceof Error ? err.message : String(err);
    console.warn(`[MCP] Failed to connect to ${name}:`, conn.error);
    // A stdio transport may already have spawned the server process.
    if (transport) {
      try { await transport.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Disconnect a server and remove it from the pool.
 */
export async function disconnectServer(name: string): Promise<void> {
  const conn = connections.get(name);
  if (conn?.client) {
    try { await conn.client.close(); } catch { /* ignore */ }
  }
  connections.delete(name);
}

/**
 * Call a tool on a connected MCP server.
 */
export async function callMcpTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const conn = connections.get(serverName);
  if (!conn?.client || conn.status !== 'connected') {
    throw new Error(`MCP server "${serverName}" is not connected`);
  }

  const result = await conn.client.callTool({
    name: toolName,
    arguments: args,
  });

  return result;
}

/**
 * Get all discovered tools from all connected servers.
 */
export function getAllMcpTools(): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [];
  for (const conn of connections.values()) {
    if (conn.status === 'connected') {
      tools.push(...conn.tools);
    }
  }
  return tools;
}

/**
 * Get the status of all configured servers.
 */
export function getMcpStatus(): Record<string, { status: string; tools: number; error?: string }> {
  const result: Record<string, { status: string; tools: number; error?: string }> = {};
  for (const [name, conn] of connections) {
    result[name] = {
      status: conn.status,
      tools: conn.tools.length,
      ...(conn.error ? { error: conn.error } : {}),
    };
  }
  return result;
}

/**
 * Reconnect a specific server.
 */
export async function reconnectServer(name: string): Promise<void> {
  const conn = connections.get(name);
  if (!conn) return;
  await disconnectServer(name);
  await connectServer(name, conn.config);
}

/**
 * Dispose all connections.
 */
export async function disposeAll(): Promise<void> {
  for (const name of [...connections.keys()]) {
    await disconnectServer(name);
  }
}

// ── Transport creation ──────────────────────────────────────────

async function createTransport(config: MCPServerConfig) {
  const transportType = config.type || 'stdio';

  switch (transportType) {
    case 'stdio': {
      if (!StdioClientTransport) {
        const mod = await import('@modelcontextprotocol/sdk/client/stdio.js');
        StdioClientTransport = mod.StdioClientTransport;
      }
      return new StdioClientTransport({
        command: config.command!,
        args: config.args || [],
        env: config.env as Record<string, string> | undefined,
      });
    }

    case 'sse': {
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
      return new SSEClientTransport(new URL(config.url!));
    }

    case 'http': {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      return new StreamableHTTPClientTransport(new URL(config.url!));
    }

    default:
      throw new Error(`Unsupported MCP transport type: ${transportType}`);
  }
}
