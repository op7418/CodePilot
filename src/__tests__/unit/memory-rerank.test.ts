import '../db-isolation.setup';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createSession, setSetting, updateSessionProviderId } from '@/lib/db';
import { bindAssistantMemory } from '@/lib/memory-binding';
import { createMemoryQueryService } from '@/lib/memory-service';
import { createMemorySearchTools } from '@/lib/builtin-tools/memory-search';
import { createMemorySearchMcpServer } from '@/lib/memory-search-mcp';
import { createCodePilotBuiltinTools } from '@/lib/codex/proxy/builtin-bridge';
import { getBuiltinTools } from '@/lib/builtin-tools';
import { resolveCodePilotDataDir } from '@/lib/codepilot-data-dir';
import { resolveProvider } from '@/lib/provider-resolver';
import { captureAuxiliaryRoute } from '@/lib/auxiliary-provider';
import type { MemoryAdapterOptions } from '@/lib/memory-rerank';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-ranking-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'a.md'), '# Note\ncerulean first.');
  fs.writeFileSync(path.join(root, 'b.md'), '# Note\ncerulean other.');
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true }); });
type Execute = (input: {query: string}, options: unknown) => Promise<string>;

it('production Native, MCP and proxy handlers share the real auxiliary SDK pipeline and frozen route', async () => {
  const root = fixture();
  setSetting('assistant_workspace_path', root);
  const session = createSession('rerank assistant', undefined, undefined, root);
  bindAssistantMemory(session.id);
  updateSessionProviderId(session.id, 'env');
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-memory-key';
  const native = createMemorySearchTools(root, { sourceSessionId: session.id, providerId: 'env' });
  const { instance } = createMemorySearchMcpServer(root, { sourceSessionId: session.id, providerId: 'env' });
  const proxy = createCodePilotBuiltinTools({ sessionId: session.id, targetProviderId: 'env', workspacePath: root });
  // Mutate ambient credentials only after all three adapters captured their route.
  process.env.ANTHROPIC_API_KEY = 'different-ambient-key';
  let requests = 0;
  let rankingText = '[1,0]';
  globalThis.fetch = async (_url, init) => {
    requests++;
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'synthetic-memory-key');
    const body = JSON.parse(String(init?.body));
    assert.match(body.model, /haiku/);
    const chunks = [
      { type: 'message_start', message: { id: 'msg_memory', type: 'message', role: 'assistant', model: body.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: rankingText } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ];
    return new Response(chunks.map(chunk => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } });
  };
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'memory-rerank', version: '1' });
  try {
    await instance.connect(st); await client.connect(ct);
    const input = { query: 'cerulean' };
    const nativeResult = await (native.codepilot_memory_search!.execute as unknown as Execute)(input, { toolCallId: 'rank', messages: [], context: {} });
    const mcp = await client.callTool({ name: 'codepilot_memory_search', arguments: input });
    const proxyResult = await (proxy.tools.codepilot_memory_search.execute as unknown as Execute)(input, { toolCallId: 'rank', messages: [], context: {} });
    assert.match(nativeResult, /^1\. \[b\.md/);
    assert.equal((mcp.content as {text: string}[])[0].text, nativeResult);
    assert.equal(proxyResult, nativeResult);
    assert.equal(requests, 3, 'each real adapter must reach the shared auxiliary transport');
    for (const invalid of ['not-json', '[0]', '[1,1]', '[2,0]']) {
      rankingText = invalid;
      const degraded = await (native.codepilot_memory_search!.execute as unknown as Execute)(input, {});
      assert.equal(degraded, `Memory ranking failed: invalid_response. Using keyword order.\n\n${createMemoryQueryService(root).search(input)}`);
    }
  } finally {
    await client.close(); await instance.close(); globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = originalKey;
  }
});

it('unavailable route and invalid, partial, throwing or timed-out reranking preserve deterministic hits', async () => {
  const root = fixture();
  const input = { query: 'cerulean', limit: 1 };
  const expected = createMemoryQueryService(root).search(input);
  const native = createMemorySearchTools(root, { providerId: 'deleted-memory-provider' });
  assert.equal(await (native.codepilot_memory_search!.execute as unknown as Execute)(input, {}), expected);
  for (const [rerank, reason] of [
    [async () => ['invented.md', 'a.md'], 'invalid_response'], [async () => ['b.md'], 'invalid_response'],
    [async () => { throw new Error('sensitive failure detail'); }, 'request_failed'], [async () => undefined, 'invalid_response'],
  ] as const) {
    const result = await createMemoryQueryService(root, { rerank }).searchEnhanced(input);
    assert.equal(result, `Memory ranking failed: ${reason}. Using keyword order.\n\n${expected}`);
    assert.doesNotMatch(result, /sensitive failure detail/);
  }
  let aborted = false;
  const result = await createMemoryQueryService(root, { rerank: ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => { aborted = true; resolve(undefined); }, { once: true });
  }) }).searchEnhanced(input);
  assert.equal(result, `Memory ranking failed: timeout. Using keyword order.\n\n${expected}`); assert.equal(aborted, true);
});

it('recent isolates unsafe files and nonexistent sources never reveal absolute paths', () => {
  const root = fixture();
  const outside = fixture();
  fs.mkdirSync(path.join(root, 'memory/daily'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory.md'), 'valid long-term');
  fs.writeFileSync(path.join(root, 'memory/daily/2026-09-20.md'), 'valid daily');
  fs.symlinkSync(path.join(outside, 'a.md'), path.join(root, 'memory/daily/2026-09-21.md'));
  const service = createMemoryQueryService(root);
  const recent = service.recent();
  assert.match(recent, /valid long-term/); assert.match(recent, /valid daily/);
  assert.match(recent, /Partial recent/); assert.doesNotMatch(recent, /cerulean/);
  const missing = service.get({ file_path: 'missing.md' });
  assert.match(missing, /not found/); assert.equal(missing.includes(root), false);
  fs.symlinkSync(path.join(outside, 'nonexistent-secret.md'), path.join(root, 'broken.md'));
  assert.equal(service.get({ file_path: 'broken.md' }).includes(outside), false);
});

it('production Native registry and proxy do not expose Memory for ordinary same-cwd sessions', () => {
  const root = fixture();
  setSetting('assistant_workspace_path', root);
  const session = createSession('ordinary project', undefined, undefined, root);
  const native = getBuiltinTools({ sessionId: session.id, workspacePath: root, grokVideoAvailable: false });
  assert.equal(Object.keys(native.tools).some(name => name.startsWith('codepilot_memory_')), false);
  const proxy = createCodePilotBuiltinTools({ sessionId: session.id, workspacePath: root, targetProviderId: 'fixture' });
  assert.equal(Object.keys(proxy.tools).some(name => name.startsWith('codepilot_memory_')), false);
});

it('production Codex proxy advertises routed MCP writes and returns the call to app-server without executing it', async () => {
  const { createUnifiedAdapter } = await import('@/lib/codex/proxy/unified-adapter');
  const { parseResponsesRequest } = await import('@/lib/codex/proxy/parse-request');
  const { resolveProvider } = await import('@/lib/provider-resolver');
  const root = fixture();
  setSetting('assistant_workspace_path', root);
  const session = createSession('proxy memory writes', undefined, undefined, root);
  bindAssistantMemory(session.id);
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-proxy-memory';
  const identityFile = path.join(resolveCodePilotDataDir(), 'auxiliary-identity-key.v1');
  const identityBefore = fs.existsSync(identityFile) ? { bytes: fs.readFileSync(identityFile), mode: fs.statSync(identityFile).mode & 0o777 } : undefined;
  fs.writeFileSync(identityFile, Buffer.alloc(8));
  fs.chmodSync(identityFile, 0o600);
  let expectsWrite = true;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(JSON.stringify(body.system).includes('memory_write_receipt'), expectsWrite);
    assert.ok(body.tools.some((tool: {name: string}) => tool.name === 'codepilot_memory_search'), 'optional identity failure preserves foreground read tools');
    const name = 'mcp__codepilot_memory_write__codepilot_memory_remember';
    return Response.json({ id: 'msg_proxy', type: 'message', role: 'assistant', model: body.model,
      content: expectsWrite ? [{ type: 'tool_use', id: 'call_memory', name, input: { content: 'do not execute in proxy' } }]
        : [{ type: 'text', text: 'ready' }],
      stop_reason: expectsWrite ? 'tool_use' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } });
  };
  try {
    for (const writes of [true, false]) {
      expectsWrite = writes;
      const parsed = parseResponsesRequest({ model: 'haiku', stream: false,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Remember this' }] }],
        tools: writes ? [{ type: 'namespace', name: 'mcp__codepilot_memory_write__', tools: [
          { type: 'function', name: 'codepilot_memory_remember', description: 'Save memory', parameters: {
            type: 'object', properties: { content: { type: 'string' } }, required: ['content'],
          } },
        ] }] : [],
      });
      assert.equal(parsed.ok, true);
      if (!parsed.ok) throw new Error('parse failed');
      const result = await createUnifiedAdapter('anthropic')({ targetProviderId: 'env', sessionId: session.id,
        workspacePath: root, body: parsed.body, signal: new AbortController().signal }, resolveProvider({ providerId: 'env' }));
      assert.equal(result.kind, 'json', JSON.stringify(result));
      if (result.kind === 'json' && writes) {
        assert.ok(result.body.output.some(item => item.type === 'function_call' && item.name === 'codepilot_memory_remember'),
          'MCP write call must remain visible to app-server and its approval gate');
      }
      assert.equal(fs.existsSync(path.join(root, 'memory/records.md')), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (identityBefore) { fs.writeFileSync(identityFile, identityBefore.bytes); fs.chmodSync(identityFile, identityBefore.mode); } else fs.rmSync(identityFile, { force: true });
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = originalKey;
  }
});

async function checkConstructedAdapters(root: string, sessionId: string, route: MemoryAdapterOptions, rankingReason?: string) {
  const native = createMemorySearchTools(root, { sourceSessionId: sessionId, ...route });
  const { instance } = createMemorySearchMcpServer(root, { sourceSessionId: sessionId, ...route });
  const proxy = createCodePilotBuiltinTools({ sessionId, workspacePath: root,
    targetProviderId: 'env', resolvedProvider: route.resolvedProvider });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'initialization-failure', version: '1' });
  try {
    await instance.connect(st); await client.connect(ct);
    for (const name of ['codepilot_memory_search', 'codepilot_memory_get', 'codepilot_memory_recent',
      'codepilot_memory_remember', 'codepilot_memory_update', 'codepilot_memory_forget']) {
      assert.ok(name in native, `${name} remains mounted on Native`);
      assert.ok((await client.listTools()).tools.some(tool => tool.name === name), `${name} remains mounted on MCP`);
    }
    const input = { query: 'cerulean' };
    const output = await (native.codepilot_memory_search!.execute as unknown as Execute)(input, {});
    const baseline = createMemoryQueryService(root).search(input);
    assert.ok(output.endsWith(baseline));
    if (rankingReason) assert.match(output, new RegExp(`Memory ranking unavailable: ${rankingReason}.*Using keyword order`));
    else assert.equal(output, baseline);
    const mcp = await client.callTool({ name: 'codepilot_memory_search', arguments: input });
    assert.equal((mcp.content as { text: string }[])[0].text, output);
    assert.equal(await (proxy.tools.codepilot_memory_search.execute as unknown as Execute)(input, {}), output);
    // CRUD stays usable despite unavailable optional ranking identity/config.
    const executeWrite = native.codepilot_memory_remember!.execute as unknown as (args: unknown, options: unknown) => Promise<string>;
    assert.equal(JSON.parse(await executeWrite({ content: 'Native mutation survives optional enhancement failure' }, {})).status, 'saved');
    const saved = await client.callTool({ name: 'codepilot_memory_remember', arguments: { content: 'MCP mutation survives optional enhancement failure' } });
    assert.equal(JSON.parse((saved.content as { text: string }[])[0].text).status, 'saved');
  } finally { await client.close(); await instance.close(); }
}

for (const fault of ['insecure_permissions', 'corrupt_key'] as const) {
  it(`actual ${fault} identity failure leaves all three adapter tool surfaces usable`, {
    skip: fault === 'insecure_permissions' && process.platform === 'win32', // POSIX mode contract; corrupt-key guard covers every platform.
  }, async () => {
    const root = fixture();
    setSetting('assistant_workspace_path', root);
    const session = createSession('identity failure', undefined, undefined, root);
    bindAssistantMemory(session.id); updateSessionProviderId(session.id, 'env');
    const file = path.join(resolveCodePilotDataDir(), 'auxiliary-identity-key.v1');
    const before = fs.existsSync(file) ? { bytes: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 } : undefined;
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'synthetic-identity-failure';
    fs.writeFileSync(file, Buffer.alloc(fault === 'corrupt_key' ? 8 : 32));
    fs.chmodSync(file, fault === 'insecure_permissions' ? 0o644 : 0o600);
    const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('identity failure must not spend on reranking'); });
    try {
      assert.equal(captureAuxiliaryRoute('env')?.unavailable, 'identity_unavailable', 'exercise the actual identity file guard');
      await checkConstructedAdapters(root, session.id, { providerId: 'env' }, 'identity_unavailable');
      const registered = getBuiltinTools({ sessionId: session.id, workspacePath: root, providerId: 'env', grokVideoAvailable: false });
      assert.ok(registered.tools.codepilot_memory_search);
      assert.ok(registered.tools.codepilot_memory_remember);
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
      if (before) { fs.writeFileSync(file, before.bytes); fs.chmodSync(file, before.mode); } else fs.rmSync(file, { force: true });
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });
}

it('unexpected snapshot resolution failures are caught locally by all real adapter constructors', async () => {
  const root = fixture();
  setSetting('assistant_workspace_path', root);
  const session = createSession('capture exception', undefined, undefined, root); bindAssistantMemory(session.id);
  const snapshot = resolveProvider({ providerId: 'env' });
  Object.defineProperty(snapshot, 'availableModels', { get() { throw new Error('sensitive-route-exception'); } });
  const warning = mock.method(console, 'warn', () => {});
  try {
    await checkConstructedAdapters(root, session.id, { providerId: 'env', resolvedProvider: snapshot });
    assert.ok(warning.mock.callCount() >= 3);
    for (const call of warning.mock.calls) assert.deepEqual(call.arguments, ['[memory] MEMORY_RERANK_INITIALIZATION_UNAVAILABLE']);
  } finally { warning.mock.restore(); }
});
