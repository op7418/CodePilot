/**
 * mcp-connection-manager sync semantics: config-change reconnect, failure
 * cooldown, and transport cleanup on failed connects.
 *
 * Run: CODEX_DISABLED=1 npx tsx --test src/__tests__/unit/mcp-connection-manager.test.ts
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MCPServerConfig } from '@/types';
import {
  MCP_FAILED_RETRY_COOLDOWN_MS,
  __setMcpConnectionTestOverridesForTests,
  disposeAll,
  getMcpStatus,
  reconnectServer,
  syncMcpConnections,
} from '../../lib/mcp-connection-manager';

interface FakeTransport {
  config: MCPServerConfig;
  closed: boolean;
  close(): Promise<void>;
  start(): Promise<void>;
  send(): Promise<void>;
}

let clock = 0;
let failingCommands = new Set<string>();
let transports: FakeTransport[] = [];
let clientsClosed = 0;

function makeTransport(config: MCPServerConfig): FakeTransport {
  const t: FakeTransport = {
    config,
    closed: false,
    async close() { t.closed = true; },
    async start() {},
    async send() {},
  };
  transports.push(t);
  return t;
}

function makeClient() {
  return {
    async connect(transport: FakeTransport) {
      if (failingCommands.has(transport.config.command ?? '')) {
        throw new Error('spawn failed');
      }
    },
    async listTools() {
      return { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] };
    },
    async close() { clientsClosed++; },
  };
}

function connectAttempts(command: string): number {
  return transports.filter((t) => t.config.command === command).length;
}

beforeEach(() => {
  clock = 1_000_000;
  failingCommands = new Set();
  transports = [];
  clientsClosed = 0;
  __setMcpConnectionTestOverridesForTests({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createClient: () => makeClient() as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createTransport: async (config) => makeTransport(config) as any,
    now: () => clock,
  });
});

afterEach(async () => {
  await disposeAll();
  __setMcpConnectionTestOverridesForTests({});
});

describe('syncMcpConnections', () => {
  it('does not reconnect when the config is unchanged', async () => {
    const config = { command: 'srv', args: ['--a'], env: { A: '1', B: '2' } };
    await syncMcpConnections({ s: config });
    await syncMcpConnections({ s: { env: { B: '2', A: '1' }, args: ['--a'], command: 'srv' } });
    assert.equal(connectAttempts('srv'), 1);
    assert.equal(getMcpStatus().s.status, 'connected');
  });

  it('reconnects when args, env or url change, closing the old client', async () => {
    await syncMcpConnections({ s: { command: 'srv', args: ['--a'] } });
    await syncMcpConnections({ s: { command: 'srv', args: ['--b'] } });
    assert.equal(connectAttempts('srv'), 2);
    assert.equal(clientsClosed, 1);

    await syncMcpConnections({ s: { command: 'srv', args: ['--b'], env: { TOKEN: 'x' } } });
    assert.equal(connectAttempts('srv'), 3);

    await syncMcpConnections({ h: { type: 'http', url: 'http://a/mcp', command: 'h' } });
    await syncMcpConnections({ h: { type: 'http', url: 'http://b/mcp', command: 'h' } });
    assert.equal(connectAttempts('h'), 2);
  });

  it('closes the transport when connect fails', async () => {
    failingCommands.add('bad');
    await syncMcpConnections({ b: { command: 'bad' } });
    assert.equal(getMcpStatus().b.status, 'failed');
    assert.equal(transports.length, 1);
    assert.equal(transports[0].closed, true);
  });

  it('does not retry a failed server within the cooldown', async () => {
    failingCommands.add('bad');
    await syncMcpConnections({ b: { command: 'bad' } });
    clock += MCP_FAILED_RETRY_COOLDOWN_MS - 1;
    await syncMcpConnections({ b: { command: 'bad' } });
    await syncMcpConnections({ b: { command: 'bad' } });
    assert.equal(connectAttempts('bad'), 1);
  });

  it('retries a failed server once the cooldown has elapsed', async () => {
    failingCommands.add('bad');
    await syncMcpConnections({ b: { command: 'bad' } });
    clock += MCP_FAILED_RETRY_COOLDOWN_MS;
    failingCommands.delete('bad');
    await syncMcpConnections({ b: { command: 'bad' } });
    assert.equal(connectAttempts('bad'), 2);
    assert.equal(getMcpStatus().b.status, 'connected');
  });

  it('retries immediately when a failed server config changes', async () => {
    failingCommands.add('bad');
    await syncMcpConnections({ b: { command: 'bad' } });
    await syncMcpConnections({ b: { command: 'good' } });
    assert.equal(connectAttempts('good'), 1);
    assert.equal(getMcpStatus().b.status, 'connected');
  });

  it('reconnectServer ignores the cooldown', async () => {
    failingCommands.add('bad');
    await syncMcpConnections({ b: { command: 'bad' } });
    await reconnectServer('b');
    assert.equal(connectAttempts('bad'), 2);
  });

  it('disconnects servers removed from the desired set', async () => {
    await syncMcpConnections({ a: { command: 'a' }, b: { command: 'b' } });
    await syncMcpConnections({ a: { command: 'a' } });
    assert.deepEqual(Object.keys(getMcpStatus()), ['a']);
  });
});
