import '../db-isolation.setup';
import { APICallError } from 'ai';
import { after, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createAuxiliaryTextRunner, resolveAuxiliaryProvider } from '../../lib/auxiliary-provider';
import { createModel } from '../../lib/ai-provider';
import { resolveProvider, type ResolvedProvider } from '../../lib/provider-resolver';
import { createProvider, deleteProvider, setDefaultProviderId, setSetting } from '../../lib/db';

const originalKey = process.env.ANTHROPIC_API_KEY;
const originalToken = process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
after(() => {
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = originalKey;
  if (originalToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = originalToken;
});

const env = (hasCredentials = true): ResolvedProvider => ({
  provider: undefined, protocol: 'anthropic', authStyle: 'api_key', model: 'opus', upstreamModel: 'claude-opus-4-7',
  modelDisplayName: 'Opus', headers: {}, envOverrides: {}, roleModels: {}, hasCredentials,
  availableModels: [{ modelId: 'haiku', upstreamModelId: 'claude-haiku-4-5-20251001', displayName: 'Haiku' }],
  settingSources: ['user', 'project', 'local'],
});
const request = { callScene: 'automatic_memory_extract' as const, scopeKey: 'local-workspace', system: 'Extract', prompt: 'fixture' };

describe('auxiliary requests use one exact Native-capable route', () => {
  it('settings-only is unavailable for all three auxiliary scenes and never invokes generation', async () => {
    let calls = 0;
    const runner = createAuxiliaryTextRunner({ resolve: () => env(), generate: async () => { calls++; return 'bad'; } });
    for (const callScene of ['automatic_memory_extract', 'automatic_quick_actions', 'active_turn_memory_rerank'] as const) {
      assert.deepEqual(await runner.run({ ...request, callScene }), { status: 'unavailable', reason: 'claude_settings_only' });
      assert.deepEqual(runner.getStatus(request.scopeKey, callScene), { status: 'unavailable', reason: 'claude_settings_only' });
    }
    assert.equal(calls, 0);
    assert.throws(() => createModel({ callScene: 'interactive_chat', resolvedProvider: env(),
      resolvedConfig: { sdkType: 'anthropic', modelId: 'haiku', apiKey: undefined, authToken: undefined,
        baseUrl: undefined, headers: {}, processEnvInjections: {} } }),
    (error: unknown) => (error as { code?: string }).code === 'CLAUDE_SETTINGS_ONLY');
  });

  it('missing credentials stay distinguishable from SDK-only credentials', async () => {
    const runner = createAuxiliaryTextRunner({ resolve: () => env(false) });
    assert.deepEqual(await runner.run(request), { status: 'unavailable', reason: 'credentials_missing' });
  });

  it('auxiliary selects Haiku without changing shared resolver defaults and captures transport once', async () => {
    process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
    setSetting('global_default_model', 'opus');
    setSetting('global_default_model_provider', 'env');
    assert.equal(resolveProvider({ providerId: 'env', useCase: 'small' }).model, 'opus', 'shared callers retain configured defaults');
    let resolutions = 0;
    const snapshot = env();
    const runner = createAuxiliaryTextRunner({ resolve: () => { resolutions++; return snapshot; },
      generate: async (params) => {
        assert.strictEqual(params.resolvedProvider, snapshot);
        assert.equal(params.model, 'claude-haiku-4-5-20251001');
        assert.equal(params.resolvedConfig?.apiKey, 'synthetic-test-key');
        // Even if env changes after capture, the actual factory uses the snapshot.
        delete process.env.ANTHROPIC_API_KEY;
        const created = createModel({ ...params, resolvedConfig: params.resolvedConfig });
        assert.equal(created.config.apiKey, 'synthetic-test-key');
        return 'remembered';
      } });
    assert.deepEqual(await runner.run(request), { status: 'completed', text: 'remembered' });
    assert.equal(resolutions, 1);
    assert.deepEqual(runner.getStatus(request.scopeKey, request.callScene), { status: 'unavailable', reason: 'claude_settings_only' });
    process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
    assert.deepEqual(runner.getStatus(request.scopeKey, request.callScene), { status: 'completed' });
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('an explicit deleted provider never falls back to the default vendor', () => {
    const other = createProvider({ name: 'other', provider_type: 'anthropic', api_key: 'synthetic-other' });
    setDefaultProviderId(other.id);
    assert.equal(resolveAuxiliaryProvider({ providerId: 'deleted-provider' }), null);
    deleteProvider(other.id);
    setDefaultProviderId('');
  });

  it('the real auxiliary text pipeline sends the captured small model and returns SDK stream text', async () => {
    process.env.ANTHROPIC_API_KEY = 'synthetic-wire-key';
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'claude-haiku-4-5-20251001');
      assert.equal(new Headers(init?.headers).get('x-api-key'), 'synthetic-wire-key');
      const chunks = [
        { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant',
          model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Remembered' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      return new Response(chunks.map(chunk => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } });
    };
    try {
      const runner = createAuxiliaryTextRunner({ resolve: () => env() });
      assert.deepEqual(await runner.run(request), { status: 'completed', text: 'Remembered' });
      assert.equal(requests, 1);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('blocks background policy before generation without choosing another provider', async () => {
    const snapshot = env();
    const selected = createProvider({ name: 'restricted', provider_type: 'anthropic',
      preset_key: 'qwen-token-plan-personal-cn', base_url: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic', api_key: 'synthetic' });
    snapshot.provider = selected;
    // A deliberately strict identity is exercised by the production policy tests;
    // this fixture uses the catalog resolver to avoid inventing a policy flag.
    const { getProviderUsagePolicy } = await import('../../lib/provider-call-policy');
    assert.equal(getProviderUsagePolicy(selected), 'interactive_only');
      let calls = 0;
      const runner = createAuxiliaryTextRunner({ resolve: () => snapshot, generate: async () => { calls++; return 'bad'; } });
      assert.deepEqual(await runner.run(request), { status: 'unavailable', reason: 'policy_blocked' });
      assert.equal(calls, 0);
    deleteProvider(selected.id);
  });

  it('cools repeated failures, separates workspaces, and recovers when credentials change', async () => {
    process.env.ANTHROPIC_API_KEY = 'synthetic-before';
    let time = 0;
    let calls = 0;
    let succeed = false;
    const runner = createAuxiliaryTextRunner({ now: () => time, resolve: () => env(),
      generate: async () => { calls++; if (!succeed) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); return 'ok'; } });
    assert.equal((await runner.run(request)).status, 'failed');
    time = 1000;
    assert.equal((await runner.run(request)).status, 'cooldown');
    assert.equal(calls, 1);
    assert.equal((await runner.run({ ...request, scopeKey: 'another-workspace' })).status, 'failed');
    assert.equal(calls, 2);
    process.env.ANTHROPIC_API_KEY = 'synthetic-after';
    succeed = true;
    assert.deepEqual(await runner.run(request), { status: 'completed', text: 'ok' });
    assert.equal(calls, 3);
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('does not coalesce different prompts into another request’s output', async () => {
    process.env.ANTHROPIC_API_KEY = 'synthetic-key';
    let finish!: (value: string) => void;
    let calls = 0;
    const runner = createAuxiliaryTextRunner({ resolve: () => env(), generate: async () => {
      calls++; return new Promise((resolve) => { finish = resolve; });
    } });
    const first = runner.run(request);
    assert.deepEqual(await runner.run({ ...request, prompt: 'different' }), { status: 'cooldown', reason: 'in_flight' });
    finish('first result');
    assert.deepEqual(await first, { status: 'completed', text: 'first result' });
    assert.equal(calls, 1);
    delete process.env.ANTHROPIC_API_KEY;
  });
});

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fingerprintAuxiliaryConfiguration, readAuxiliaryConfigurationBlock, blockAuxiliaryConfiguration } from '../../lib/auxiliary-provider-identity';
import { captureAuxiliaryRoute } from '../../lib/auxiliary-provider';
import { PROVIDER_CALL_SCENES } from '../../lib/provider-call-policy';
import { telemetryCallScene } from '../../lib/telemetry/diagnostics';

it('waits for configuration changes only after credential failures, across time, scopes, scenes and runner restarts', async () => {
  for (const [name, error, reason] of [
    ['missing-key', Object.assign(new Error('Synthetic missing API key'), { name: 'AI_LoadAPIKeyError' }), 'credentials_missing'],
    ['oauth-expired', Object.assign(new Error('Synthetic expired login'), { code: 'PROVIDER_OAUTH_EXPIRED' }), 'credentials_missing'],
    ['401', new APICallError({ message: 'synthetic auth', url: 'https://example.invalid', requestBodyValues: {}, statusCode: 401 }), 'credentials_missing'],
    ['403', new APICallError({ message: 'synthetic forbidden', url: 'https://example.invalid', requestBodyValues: {}, statusCode: 403 }), 'credentials_missing'],
  ] as const) {
    process.env.ANTHROPIC_API_KEY = `synthetic-block-${name}`;
    let time = 0;
    let calls = 0;
    const deps = { now: () => time, maxEntries: 1, resolve: () => env(), generate: async () => { calls++; throw error; } };
    const runner = createAuxiliaryTextRunner(deps);
    const blocked = { status: 'unavailable', reason, requiresConfigurationChange: true };
    assert.deepEqual(await runner.run({ ...request, scopeKey: name }), blocked);
    time = 365 * 24 * 60 * 60_000;
    assert.deepEqual(await runner.run({ ...request, scopeKey: `${name}-new-session` }), blocked);
    assert.deepEqual(await createAuxiliaryTextRunner(deps).run({ ...request, callScene: 'automatic_quick_actions', scopeKey: `${name}-after-restart` }), blocked);
    assert.equal(calls, 1, 'time and cache eviction cannot authorize another provider call');
    process.env.ANTHROPIC_API_KEY = `synthetic-repaired-${name}`;
    const recovered = createAuxiliaryTextRunner({ ...deps, generate: async () => { calls++; return 'recovered'; } });
    assert.deepEqual(await recovered.run(request), { status: 'completed', text: 'recovered' });
    assert.equal(calls, 2);
  }
  delete process.env.ANTHROPIC_API_KEY;
});

it('uses a private keyed fingerprint stable across processes without putting API keys in persisted receipts', async () => {
  process.env.ANTHROPIC_API_KEY = 'synthetic-cross-process-key';
  const snapshot = env();
  const route = captureAuxiliaryRoute('env', snapshot)!;
  const serialized = JSON.stringify([snapshot.provider, route.resolvedConfig]);
  assert.ok(route.fingerprint);
  assert.match(route.fingerprint, /^hmac-v1:[0-9a-f]{64}$/);
  assert.notEqual(route.fingerprint.slice('hmac-v1:'.length), createHash('sha256').update(serialized).digest('hex'));
  const runner = createAuxiliaryTextRunner({ resolve: () => snapshot,
    generate: async () => { throw Object.assign(new Error('Synthetic expired login'), { code: 'PROVIDER_OAUTH_EXPIRED' }); } });
  await runner.run(request);
  const script = `
    const { captureAuxiliaryRoute, createAuxiliaryTextRunner } = require('./src/lib/auxiliary-provider.ts');
    const snapshot = JSON.parse(process.argv[1]);
    let calls = 0;
    const runner = createAuxiliaryTextRunner({ resolve: () => snapshot, generate: async () => { calls++; return 'unexpected'; } });
    runner.run({ callScene: 'automatic_memory_extract', scopeKey: 'new-process', system: 'fixture', prompt: 'fixture' })
      .then(result => console.log(JSON.stringify({ fingerprint: captureAuxiliaryRoute('env', snapshot).fingerprint, calls, result })));
  `;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '-e', script, JSON.stringify(snapshot)], { encoding: 'utf8' });
  const child = JSON.parse(output.split('\n').find(line => line.startsWith('{'))!);
  assert.equal(child.fingerprint, route.fingerprint);
  assert.equal(child.calls, 0);
  assert.equal(child.result.requiresConfigurationChange, true);
  assert.equal(readAuxiliaryConfigurationBlock('env', route.fingerprint), 'credentials_missing');
  const directory = process.env.CLAUDE_GUI_DATA_DIR!;
  const keyFile = path.join(directory, 'auxiliary-identity-key.v1');
  assert.equal(fs.statSync(keyFile).size, 32);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  for (const filename of fs.readdirSync(directory).filter(name => name.startsWith('auxiliary-block-'))) {
    const receipt = fs.readFileSync(path.join(directory, filename), 'utf8');
    assert.doesNotMatch(receipt, /synthetic-|apiKey|prompt|accessToken/);
  }
  assert.notEqual(fingerprintAuxiliaryConfiguration('synthetic-value-one').slice('hmac-v1:'.length), createHash('sha256').update('synthetic-value-one').digest('hex'));
  assert.notEqual(fingerprintAuxiliaryConfiguration('synthetic-value-one'), fingerprintAuxiliaryConfiguration('synthetic-value-two'));
  delete process.env.ANTHROPIC_API_KEY;
});

it('all canonical provider scenes survive telemetry allowlisting, arbitrary caller strings do not', () => {
  for (const scene of PROVIDER_CALL_SCENES) assert.equal(telemetryCallScene(scene), scene);
  assert.equal(telemetryCallScene('https://secret.invalid/customer'), 'unknown');
  assert.equal(new Set(PROVIDER_CALL_SCENES).size, PROVIDER_CALL_SCENES.length);
});

it('fails closed for a symlinked or publicly readable identity key', () => {
  const previous = process.env.CLAUDE_GUI_DATA_DIR;
  const directory = fs.mkdtempSync(path.join(previous!, 'auxiliary-key-boundary-'));
  process.env.CLAUDE_GUI_DATA_DIR = directory;
  const target = path.join(directory, 'controlled-fixture');
  const keyFile = path.join(directory, 'auxiliary-identity-key.v1');
  fs.writeFileSync(target, Buffer.alloc(32, 0x17), { mode: 0o600 });
  try {
    if (process.platform !== 'win32') {
      fs.symlinkSync(target, keyFile);
      assert.throws(() => fingerprintAuxiliaryConfiguration('synthetic-secret'), /^Error: AUXILIARY_IDENTITY_KEY_UNAVAILABLE$/);
      fs.unlinkSync(keyFile);
      fs.writeFileSync(keyFile, Buffer.alloc(32, 0x18), { mode: 0o644 });
      assert.throws(() => fingerprintAuxiliaryConfiguration('synthetic-secret'), /^Error: AUXILIARY_IDENTITY_KEY_UNAVAILABLE$/);
      fs.unlinkSync(keyFile);
    }
    fs.writeFileSync(keyFile, 'corrupt', { mode: 0o600 });
    assert.throws(() => fingerprintAuxiliaryConfiguration('synthetic-secret'), /^Error: AUXILIARY_IDENTITY_KEY_UNAVAILABLE$/);
    assert.deepEqual(fs.readFileSync(target), Buffer.alloc(32, 0x17));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_GUI_DATA_DIR; else process.env.CLAUDE_GUI_DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function withPrivateState<T>(action: (directory: string) => Promise<T>): Promise<T> {
  const previous = process.env.CLAUDE_GUI_DATA_DIR;
  const directory = fs.mkdtempSync(path.join(previous!, 'auxiliary-state-'));
  process.env.CLAUDE_GUI_DATA_DIR = directory;
  try { return await action(directory); }
  finally {
    if (previous === undefined) delete process.env.CLAUDE_GUI_DATA_DIR; else process.env.CLAUDE_GUI_DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
  }
}

it('HTTP 400/413/429 use timed cooldown, never a permanent cross-scene or restart block', async () => {
  for (const statusCode of [400, 413, 429]) await withPrivateState(async directory => {
    process.env.ANTHROPIC_API_KEY = `synthetic-http-${statusCode}`;
    let time = 0;
    let calls = 0;
    const deps = { now: () => time, resolve: () => env(), generate: async () => {
      calls++;
      throw new APICallError({ message: 'synthetic upstream rejection', url: 'https://example.invalid', requestBodyValues: {}, statusCode });
    } };
    const runner = createAuxiliaryTextRunner(deps);
    const first = await runner.run(request);
    assert.deepEqual(first, { status: 'failed', reason: 'request_failed', retryAt: 60_000 });
    time = 30_000;
    assert.equal((await runner.run(request)).status, 'cooldown');
    assert.equal(calls, 1);
    time = 60_001;
    assert.equal((await runner.run(request)).status, 'failed');
    assert.equal(calls, 2, 'elapsed backoff authorizes another request for temporary HTTP failures');
    assert.equal((await runner.run({ ...request, callScene: 'automatic_quick_actions', scopeKey: 'other' })).status, 'failed');
    assert.equal((await createAuxiliaryTextRunner(deps).run(request)).status, 'failed');
    assert.equal(calls, 4);
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith('auxiliary-block-')), false);
    const script = `const { createAuxiliaryTextRunner } = require('./src/lib/auxiliary-provider.ts');
      let calls = 0; const snapshot = JSON.parse(process.argv[1]);
      createAuxiliaryTextRunner({ resolve: () => snapshot, generate: async () => { calls++; return 'recovered'; } })
        .run({ callScene: 'active_turn_memory_rerank', scopeKey: 'new-process', system: 'fixture', prompt: 'fixture' })
        .then(result => console.log(JSON.stringify({ calls, result })));`;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '-e', script, JSON.stringify(env())], { encoding: 'utf8' });
    const child = JSON.parse(output.split('\n').find(line => line.startsWith('{'))!);
    assert.equal(child.calls, 1);
    assert.equal(child.result.status, 'completed');
  });
});

it('ignores v1 overbroad receipts so upgrade can recover both quota and unproven credential blocks', async () => {
  await withPrivateState(async directory => {
    process.env.ANTHROPIC_API_KEY = 'synthetic-upgrade';
    const route = captureAuxiliaryRoute('env', env())!;
    assert.ok(route.fingerprint);
    blockAuxiliaryConfiguration('env', route.fingerprint, 'credentials_missing');
    const filename = path.join(directory, fs.readdirSync(directory).find(name => name.startsWith('auxiliary-block-'))!);
    for (const reason of ['configuration_required', 'credentials_missing']) {
      fs.writeFileSync(filename, JSON.stringify({ version: 1, fingerprint: route.fingerprint, reason }), { mode: 0o600 });
      assert.equal(readAuxiliaryConfigurationBlock('env', route.fingerprint), undefined);
      let calls = 0;
      const runner = createAuxiliaryTextRunner({ resolve: () => env(), generate: async () => { calls++; return 'recovered'; } });
      assert.equal((await runner.run(request)).status, 'completed');
      assert.equal(calls, 1);
    }
  });
});

it('identity errors return visible unavailable status without breaking capture, run, or status reads', async () => {
  await withPrivateState(async directory => {
    process.env.ANTHROPIC_API_KEY = 'synthetic-key-io';
    let calls = 0;
    const runner = createAuxiliaryTextRunner({ resolve: () => env(), generate: async () => { calls++; return 'ok'; } });
    assert.equal((await runner.run(request)).status, 'completed');
    const keyFile = path.join(directory, 'auxiliary-identity-key.v1');
    const original = fs.readFileSync(keyFile);
    fs.writeFileSync(keyFile, 'invalid');
    const route = captureAuxiliaryRoute('env', env())!;
    assert.equal(route.unavailable, 'identity_unavailable');
    assert.equal(route.fingerprint, undefined);
    const expected = { status: 'unavailable', reason: 'identity_unavailable' };
    assert.deepEqual(await runner.run(request), expected);
    assert.deepEqual(runner.getStatus(request.scopeKey, request.callScene), expected);
    assert.equal(calls, 1);
    fs.writeFileSync(keyFile, original);
    if (process.platform !== 'win32') {
      fs.chmodSync(keyFile, 0o644);
      assert.deepEqual(await runner.run(request), expected, 'permission changes remain visible after a prior valid read');
      fs.chmodSync(keyFile, 0o600);
    }
    assert.equal((await runner.run(request)).status, 'completed');
    assert.equal(calls, 2);
  });
});

it('receipt read errors report persistence unavailable and recover after local storage repair', async () => {
  await withPrivateState(async directory => {
    process.env.ANTHROPIC_API_KEY = 'synthetic-receipt-read';
    const route = captureAuxiliaryRoute('env', env())!;
    assert.ok(route.fingerprint);
    blockAuxiliaryConfiguration('env', route.fingerprint, 'credentials_missing');
    const file = path.join(directory, fs.readdirSync(directory).find(name => name.startsWith('auxiliary-block-'))!);
    fs.writeFileSync(file, '{broken');
    let calls = 0;
    const runner = createAuxiliaryTextRunner({ resolve: () => env(), generate: async () => { calls++; return 'ok'; } });
    const expected = { status: 'unavailable', reason: 'persistence_unavailable' };
    assert.deepEqual(await runner.run(request), expected);
    assert.deepEqual(runner.getStatus(request.scopeKey, request.callScene), expected);
    assert.equal(calls, 0);
    fs.unlinkSync(file);
    assert.equal((await runner.run(request)).status, 'completed');
    assert.equal(calls, 1);
  });
});

it('receipt write failures keep the credential latch across scopes and scenes without retransmitting', async () => {
  await withPrivateState(async () => {
    process.env.ANTHROPIC_API_KEY = 'synthetic-receipt-write';
    let calls = 0;
    const runner = createAuxiliaryTextRunner({ maxEntries: 1, resolve: () => env(), generate: async () => {
      calls++; throw new APICallError({ message: 'synthetic auth', url: 'https://example.invalid', requestBodyValues: {}, statusCode: 401 });
    } });
    const originalRename = fs.renameSync;
    const rename = mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
      if (String(target).includes('auxiliary-block-')) throw Object.assign(new Error('synthetic disk failure'), { code: 'EACCES' });
      return originalRename(source, target);
    });
    try {
      const expected = { status: 'unavailable', reason: 'persistence_unavailable' };
      assert.deepEqual(await runner.run(request), expected);
      assert.deepEqual(runner.getStatus(request.scopeKey, request.callScene), expected);
      assert.deepEqual(await runner.run({ ...request, scopeKey: 'other', callScene: 'automatic_quick_actions' }), expected);
      assert.deepEqual(await runner.run({ ...request, scopeKey: 'third', callScene: 'active_turn_memory_rerank' }), expected);
      assert.equal(calls, 1);
    } finally { rename.mock.restore(); }
    assert.deepEqual(await runner.run(request), { status: 'unavailable', reason: 'credentials_missing', requiresConfigurationChange: true });
    assert.equal(calls, 1, 'repair persists the known failure without another provider request');
    assert.equal((await createAuxiliaryTextRunner({ resolve: () => env(), generate: async () => { calls++; return 'bad'; } }).run(request)).status, 'unavailable');
    assert.equal(calls, 1);
  });
});

it('status lookup validates current credential/model/provider identity instead of exposing cached success', async () => {
  await withPrivateState(async () => {
    process.env.ANTHROPIC_API_KEY = 'synthetic-status-before';
    const runner = createAuxiliaryTextRunner({ resolve: () => env(), generate: async () => 'ok' });
    assert.equal((await runner.run(request)).status, 'completed');
    assert.deepEqual(runner.getStatus(request.scopeKey, request.callScene), { status: 'completed' });
    process.env.ANTHROPIC_API_KEY = 'synthetic-status-after';
    assert.equal(runner.getStatus(request.scopeKey, request.callScene), undefined);
    const provider = createProvider({ name: 'status-other', provider_type: 'anthropic', api_key: 'synthetic-other-status' });
    try {
      const actual = createAuxiliaryTextRunner({ generate: async () => 'ok' });
      assert.equal((await actual.run({ ...request, providerId: 'env' })).status, 'completed');
      assert.equal(actual.getStatus(request.scopeKey, request.callScene, { providerId: provider.id }), undefined);
      assert.deepEqual(actual.getStatus(request.scopeKey, request.callScene, { providerId: 'deleted-fixture' }), { status: 'unavailable', reason: 'provider_missing' });
    } finally { deleteProvider(provider.id); }
  });
});

it('failure to create identity metadata is reported without a provider request or raw filesystem error', async () => {
  await withPrivateState(async () => {
    process.env.ANTHROPIC_API_KEY = 'synthetic-create-denied';
    let calls = 0;
    const runner = createAuxiliaryTextRunner({ resolve: () => env(), generate: async () => { calls++; return 'ok'; } });
    const originalOpen = fs.openSync;
    const open = mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).includes('auxiliary-identity-key.v1')) throw Object.assign(new Error('sensitive private path fixture'), { code: 'EACCES' });
      return originalOpen(...args);
    });
    try {
      const expected = { status: 'unavailable', reason: 'identity_unavailable' };
      assert.deepEqual(await runner.run(request), expected);
      assert.deepEqual(runner.getStatus(request.scopeKey, request.callScene), expected);
      assert.equal(captureAuxiliaryRoute('env', env())?.unavailable, 'identity_unavailable');
      assert.equal(calls, 0);
    } finally { open.mock.restore(); }
    assert.equal((await runner.run(request)).status, 'completed');
    assert.equal(calls, 1);
  });
});
