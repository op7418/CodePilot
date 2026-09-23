import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMemoryQueryService, createMemoryQueryTools, createMemoryMutationTools } from '@/lib/memory-service';
import { createMemorySearchTools } from '@/lib/builtin-tools/memory-search';
import { createMemorySearchMcpServer } from '@/lib/memory-search-mcp';
import { createCodePilotBuiltinTools } from '@/lib/codex/proxy/builtin-bridge';
import { indexWorkspace, loadManifest } from '@/lib/workspace-indexer';
import { searchWorkspace } from '@/lib/workspace-retrieval';
import { readMemoryRecords, saveMemoryRecordCandidate } from '@/lib/memory-records';

import { createSession, setSetting } from '@/lib/db';
import { bindAssistantMemory } from '@/lib/memory-binding';

const temporaryRoots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-service-'));
  temporaryRoots.push(root);
  return root;
}
function write(root: string, relative: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
}
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type Execute = (args: Record<string, unknown>, options: { toolCallId: string; messages: [] }) => Promise<unknown>;
function executeNative(root: string, name: string, args: Record<string, unknown>) {
  const native = createMemorySearchTools(root, { sourceSessionId: 'memory-test-session' });
  const definition = (native as Record<string, { execute?: unknown }>)[name];
  assert.ok(definition?.execute);
  return (definition.execute as Execute)(args, { toolCallId: 'memory-fixture-call', messages: [] });
}
async function withMcp(root: string, run: (client: Client) => Promise<void>, access: 'all' | 'read' | 'write' = 'all') {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { instance } = createMemorySearchMcpServer(root, { access, sourceSessionId: 'memory-test-session' });
  const client = new Client({ name: 'memory-parity-test', version: '1.0.0' });
  try {
    await instance.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await instance.close();
  }
}
async function mcpText(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return (result.content as Array<{ type: string; text?: string }>).filter(part => part.type === 'text').map(part => part.text).join('\n');
}

describe('Memory local query core', () => {
  it('finds a body-only term in the production index and in a fresh unindexed workspace', () => {
    const root = fixture();
    write(root, 'notes.md', '# Meeting\n\nThe selected color is cerulean.');
    assert.match(createMemoryQueryService(root).search({ query: 'cerulean' }), /notes\.md/);
    indexWorkspace(root);
    assert.equal(searchWorkspace(root, 'cerulean')[0]?.path, 'notes.md');
    // Current files win over stale snapshots; no index mutation is needed.
    write(root, 'notes.md', '# Meeting\nThe color is now vermilion.');
    assert.match(createMemoryQueryService(root).search({ query: 'vermilion' }), /notes\.md/);
    assert.equal(createMemoryQueryService(root).search({ query: 'cerulean' }), 'No matching memories found.');
  });

  it('applies filters before limit and decay before selection, with deterministic ties', () => {
    const root = fixture();
    for (let i = 0; i < 25; i++) write(root, `z${i}.md`, '# amber amber amber\nWrong tag.');
    write(root, 'a.md', '---\ntags: [selected]\n---\n# Note\n正文 amber');
    const service = createMemoryQueryService(root, { now: () => Date.parse('2026-09-21T00:00:00Z') });
    assert.match(service.search({ query: 'amber', tags: ['#SELECTED'], limit: 1 }), /a\.md/);
    write(root, 'memory/daily/2026-01-01.md', '# copper copper\nOld.');
    write(root, 'memory/daily/2026-09-21.md', '# Note\nCurrent copper.');
    const daily = service.search({ query: 'copper', file_type: 'daily', limit: 1 });
    assert.match(daily, /2026-09-21/);
    assert.doesNotMatch(daily, /2026-01-01/);
    write(root, 'b.md', '# Note\nindigo');
    write(root, 'c.md', '# Note\nindigo');
    assert.ok(service.search({ query: 'indigo' }).indexOf('b.md') < service.search({ query: 'indigo' }).indexOf('c.md'));
  });

  it('enforces relative/real path boundaries for get, recent and private metadata', () => {
    const root = fixture();
    const workspace = path.join(root, 'work');
    const sibling = path.join(root, 'work-other');
    fs.mkdirSync(workspace); fs.mkdirSync(sibling);
    write(sibling, 'secret.md', 'SYNTHETIC_OUTSIDE_MARKER');
    write(workspace, '.assistant/private.md', 'SYNTHETIC_PRIVATE_MARKER');
    const service = createMemoryQueryService(workspace);
    for (const file_path of ['../work-other/secret.md', sibling + '/secret.md', 'C:\\private\\secret.md', '.assistant/private.md']) {
      const result = service.get({ file_path });
      assert.match(result, /Access denied/);
      assert.doesNotMatch(result, /SYNTHETIC/);
    }
    fs.symlinkSync(path.join(sibling, 'secret.md'), path.join(workspace, 'linked.md'));
    assert.match(service.get({ file_path: 'linked.md' }), /Access denied/);
    fs.symlinkSync(path.join(workspace, '.assistant/private.md'), path.join(workspace, 'hidden-alias.md'));
    assert.match(service.get({ file_path: 'hidden-alias.md' }), /Access denied/);
    fs.symlinkSync(path.join(sibling, 'secret.md'), path.join(workspace, 'memory.md'));
    assert.match(service.recent(), /Access denied/);
    assert.doesNotMatch(service.search({ query: 'SYNTHETIC' }), /SYNTHETIC_OUTSIDE_MARKER|SYNTHETIC_PRIVATE_MARKER/);
  });

  it('keeps legacy files queryable when managed records conflict, without exposing raw history', () => {
    const root = fixture();
    write(root, 'memory.md', '# Long-term\nThe project uses amethyst.');
    write(root, 'memory/records.md', 'A user-owned legacy file containing PRIVATE_RECORD_HISTORY');
    const query = createMemoryQueryService(root);
    const search = query.search({ query: 'amethyst' });
    assert.match(search, /Managed memory unavailable/);
    assert.match(search, /memory\.md/);
    assert.match(query.get({ file_path: 'memory.md' }), /amethyst/);
    assert.match(query.recent(), /amethyst/);
    assert.doesNotMatch(query.search({ query: 'PRIVATE_RECORD_HISTORY' }), /PRIVATE_RECORD_HISTORY/);
    assert.match(query.get({ file_path: 'memory/records.md' }), /Access denied/);
  });

  it('uses 1-based inclusive line ranges and bounded output even beyond line 200', () => {
    const root = fixture();
    write(root, 'memory.md', Array.from({ length: 250 }, (_, i) => `line-${i + 1}`).join('\n'));
    const service = createMemoryQueryService(root);
    assert.equal(service.get({ file_path: 'memory.md', line_start: 210, line_end: 211 }), 'Source: memory.md:210 (workspace-file)\nline-210\nline-211');
    assert.match(service.get({ file_path: 'memory.md', line_start: 3, line_end: 2 }), /line_end/);
    assert.match(service.get({ file_path: 'memory.md', line_start: 0 }), /Memory read failed/);
    write(root, 'long.md', '字'.repeat(10000));
    const output = service.get({ file_path: 'long.md' });
    assert.ok(output.length < 3200);
    assert.match(output, /truncated/);
  });

  it('excludes raw record history from index/search/get and projects only active records', async () => {
    const root = fixture();
    const remembered = saveMemoryRecordCandidate(root, {
      content: 'preferred color ultramarine', source: { kind: 'manual' }, idempotencyKey: 'seed',
    });
    const record = remembered.records[0];
    const query = createMemoryQueryService(root);
    const mutation = createMemoryMutationTools(root, { sourceSessionId: 'correcting-session' });
    const corrected = JSON.parse(await mutation.codepilot_memory_update.execute({ id: record.id, expected_revision: remembered.revision, content: 'preferred color chartreuse' }));
    assert.equal(corrected.type, 'memory_write_receipt');
    assert.equal(corrected.status, 'saved');
    indexWorkspace(root);
    assert.equal(loadManifest(root).some(entry => entry.path === 'memory/records.md'), false);
    assert.equal(searchWorkspace(root, 'ultramarine').length, 0);
    assert.equal(query.search({ query: 'ultramarine' }), 'No matching memories found.');
    assert.match(query.search({ query: 'chartreuse' }), /memory\/records\//);
    assert.match(query.get({ file_path: 'memory/records.md' }), /Access denied/);
    assert.match(query.get({ file_path: `memory/records/${record.id}.md` }), /Access denied/);
    assert.doesNotMatch(query.recent(), /ultramarine/);
    assert.match(query.recent(), /correcting-session/);
    const forgotten = JSON.parse(await mutation.codepilot_memory_forget.execute({ id: corrected.recordId, expected_revision: corrected.revision }));
    assert.equal(forgotten.status, 'saved');
    assert.equal(query.search({ query: 'chartreuse' }), 'No matching memories found.');
    assert.doesNotMatch(query.recent(), /chartreuse/);
    assert.match(query.get({ file_path: `memory/records/${corrected.recordId}.md` }), /Access denied/);
  });
});

describe('Memory adapters share actual schemas and handlers', () => {
  it('Native, real MCP and Codex proxy return identical search/get/recent results', async () => {
    const root = fixture();
    write(root, 'notes.md', '---\ntags: [selected]\n---\n# Project\nRemember saffron.\n[[related]]');
    write(root, 'memory.md', '# Long-term\nPrefer concise responses.');
    write(root, 'memory/daily/2026-09-21.md', '# Today\nWe chose saffron.');
    const cases: [string, Record<string, unknown>][] = [
      ['codepilot_memory_search', { query: 'saffron', tags: ['selected'] }],
      ['codepilot_memory_search', { query: 'saffron', file_type: 'daily' }],
      ['codepilot_memory_get', { file_path: 'notes.md', line_start: 4, line_end: 6 }],
      ['codepilot_memory_get', { file_path: '../outside.md' }],
      ['codepilot_memory_recent', {}],
    ];
    setSetting('assistant_workspace_path', root);
    const session = createSession('bound memory fixture', undefined, undefined, root);
    bindAssistantMemory(session.id);
    const proxy = createCodePilotBuiltinTools({ sessionId: session.id, targetProviderId: 'fixture-provider', workspacePath: root, grokVideoAvailable: false });
    await withMcp(root, async client => {
      for (const [name, args] of cases) {
        const native = await executeNative(root, name, args);
        assert.equal(await mcpText(client, name, args), native, `MCP ${name}`);
        const proxyExecute = proxy.tools[name]?.execute as unknown as Execute;
        assert.ok(proxyExecute);
        assert.equal(await proxyExecute(args, { toolCallId: 'fixture', messages: [] }), native, `proxy ${name}`);
      }
      const definitions = createMemoryQueryTools(root);
      const list = await client.listTools();
      for (const [name, definition] of Object.entries(definitions)) {
        const wire = list.tools.find(candidate => candidate.name === name);
        assert.ok(wire);
        assert.equal(wire.description, definition.description);
      }
    });
    assert.equal(proxy.tools.codepilot_memory_remember, undefined, 'proxy must not bypass MCP write approval');
  });

  it('MCP and Native mutations share receipts, trusted provenance, correction and forgetting', async () => {
    const root = fixture();
    await withMcp(root, async client => {
      const saved = JSON.parse(await mcpText(client, 'codepilot_memory_remember', { content: 'prefers teal', idempotency_key: 'preference-1' }));
      assert.equal(saved.status, 'saved');
      assert.ok(saved.recordId);
      const duplicate = JSON.parse(String(await executeNative(root, 'codepilot_memory_remember', { content: 'prefers teal', idempotency_key: 'preference-1' })));
      assert.equal(duplicate.status, 'duplicate');
      assert.equal(duplicate.recordId, saved.recordId);
      assert.equal(readMemoryRecords(root).records[0].source.kind, 'tool');
      assert.equal(readMemoryRecords(root).records[0].source.sessionId, 'memory-test-session');
      const updated = JSON.parse(String(await executeNative(root, 'codepilot_memory_update', { id: saved.recordId, content: 'prefers violet', expected_revision: saved.revision })));
      assert.equal(updated.status, 'saved');
      assert.equal(await mcpText(client, 'codepilot_memory_search', { query: 'teal' }), 'No matching memories found.');
      assert.match(await mcpText(client, 'codepilot_memory_search', { query: 'violet' }), /violet/);
      const conflict = JSON.parse(await mcpText(client, 'codepilot_memory_forget', { id: updated.recordId, expected_revision: saved.revision }));
      assert.equal(conflict.type, 'memory_write_error');
      assert.equal(conflict.code, 'conflict');
      const forgotten = JSON.parse(await mcpText(client, 'codepilot_memory_forget', { id: updated.recordId, expected_revision: updated.revision }));
      assert.equal(forgotten.status, 'saved');
      assert.doesNotMatch(String(await executeNative(root, 'codepilot_memory_recent', {})), /teal|violet/);
    });
  });

  it('MCP write-only/read-only surfaces remain separate and no context cannot forge attribution', async () => {
    const root = fixture();
    await withMcp(root, async client => {
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['codepilot_memory_get', 'codepilot_memory_recent', 'codepilot_memory_search']);
    }, 'read');
    await withMcp(root, async client => {
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['codepilot_memory_forget', 'codepilot_memory_remember', 'codepilot_memory_update']);
    }, 'write');
    const noSource = createMemoryMutationTools(root);
    const result = JSON.parse(await noSource.codepilot_memory_remember.execute({ content: 'claim' }));
    assert.equal(result.type, 'memory_write_error');
    assert.equal(readMemoryRecords(root).records.length, 0);
    const direct = createMemoryMutationTools(root, { sourceSessionId: 'trusted' });
    const forged = JSON.parse(await direct.codepilot_memory_remember.execute({ content: 'claim', source: { kind: 'manual' } } as never));
    assert.equal(forged.type, 'memory_write_error');
    assert.equal(readMemoryRecords(root).records.length, 0);
  });
});
