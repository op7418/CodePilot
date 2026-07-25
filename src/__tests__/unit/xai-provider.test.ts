import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPreset, findMatchingPresetForRecord } from '../../lib/provider-catalog';
import { getModelCompat, getProviderCompat } from '../../lib/runtime-compat';
import { buildXaiProviderOptions, mapXaiReasoningEffort } from '../../lib/xai-provider-options';

const originalDataDir = process.env.CLAUDE_GUI_DATA_DIR;
const originalDisableMigration = process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS;
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-xai-provider-'));
process.env.CLAUDE_GUI_DATA_DIR = tempDataDir;
process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS = '1';
fs.writeFileSync(path.join(tempDataDir, 'codepilot.db'), '');

after(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { closeDb } = require('../../lib/db') as typeof import('../../lib/db');
  closeDb();
  if (originalDataDir === undefined) delete process.env.CLAUDE_GUI_DATA_DIR;
  else process.env.CLAUDE_GUI_DATA_DIR = originalDataDir;
  if (originalDisableMigration === undefined) delete process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS;
  else process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS = originalDisableMigration;
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

describe('xAI API Key provider', () => {
  it('ships one branded Grok 4.5 Responses preset', () => {
    const preset = getPreset('xai');
    assert.ok(preset);
    assert.equal(preset.protocol, 'xai');
    assert.equal(preset.baseUrl, 'https://api.x.ai/v1');
    assert.deepEqual(preset.defaultModels.map(model => model.modelId), ['grok-4.5']);
    assert.equal(preset.defaultRoleModels?.default, 'grok-4.5');
    assert.equal(preset.meta?.modelDiscoveryMode, 'catalog_only');
  });

  it('resolves by explicit identity and exposes only CodePilot/Codex runtimes', () => {
    const record = {
      preset_key: 'xai',
      provider_type: 'xai',
      protocol: 'xai',
      base_url: 'https://api.x.ai/v1',
    };
    assert.equal(findMatchingPresetForRecord(record)?.key, 'xai');
    const providerCompat = getProviderCompat(record);
    assert.equal(providerCompat, 'codepilot_only');
    const modelCompat = getModelCompat({ modelId: 'grok-4.5', providerCompat });
    assert.deepEqual([...(modelCompat.supportedRuntimes ?? [])].sort(), [
      'codepilot_runtime',
      'codex_runtime',
    ]);
    assert.ok(modelCompat.unsupportedReasonByRuntime?.claude_code);
  });

  it('constructs @ai-sdk/xai Responses instead of OpenAI Chat Completions', async () => {
    const { createProvider } = await import('../../lib/db');
    const { resolveProvider } = await import('../../lib/provider-resolver');
    const { createModel } = await import('../../lib/ai-provider');
    const provider = createProvider({
      name: 'xAI API Key',
      preset_key: 'xai',
      provider_type: 'xai',
      protocol: 'xai',
      base_url: 'https://api.x.ai/v1',
      api_key: 'xai-test-key-never-send',
      role_models_json: JSON.stringify({ default: 'grok-4.5' }),
    });
    const resolved = resolveProvider({
      callScene: 'interactive_chat',
      providerId: provider.id,
      model: 'grok-4.5',
    });
    const created = createModel({
      callScene: 'interactive_chat',
      resolvedProvider: resolved,
      model: 'grok-4.5',
    });
    assert.equal(created.config.sdkType, 'xai');
    assert.equal(created.config.modelId, 'grok-4.5');
    assert.equal(created.config.baseUrl, 'https://api.x.ai/v1');
    assert.match((created.languageModel as { provider: string }).provider, /^xai\.responses$/);
  });

  it('maps native and Codex effort to xAI namespace without inheriting OpenAI store state', async () => {
    const { buildProviderOptions } = await import('../../lib/codex/proxy/unified-adapter');
    assert.equal(mapXaiReasoningEffort('minimal'), 'none');
    assert.equal(mapXaiReasoningEffort('max'), 'high');
    assert.deepEqual(buildXaiProviderOptions('xhigh'), { store: false, reasoningEffort: 'high' });

    const opts = buildProviderOptions({
      model: 'grok-4.5',
      input: [],
      store: true,
      reasoning: { effort: 'high' },
    });
    assert.deepEqual(opts?.xai, { store: false, reasoningEffort: 'high' });
    assert.equal(opts?.openai?.store, true, 'OpenAI keeps its own independent request value');
  });

  it('connection test uses a bounded, non-generating xAI model probe', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../lib/claude-client.ts'), 'utf8');
    assert.match(source, /config\.protocol === 'xai'[\s\S]{0,120}testXaiConnection/);
    assert.match(source, /fetch\(`\$\{baseUrl\}\/models\/grok-4\.5`/);
    assert.doesNotMatch(source, /testXaiConnection[\s\S]{0,1600}messages:\s*\[/);
  });

  it('connection test refuses to send an xAI key to a non-official endpoint', async () => {
    const { testProviderConnection } = await import('../../lib/claude-client');
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      throw new Error('must not send');
    }) as typeof fetch;
    try {
      const result = await testProviderConnection({
        callScene: 'connection_test',
        apiKey: 'xai-secret-never-send',
        baseUrl: 'https://credential-sink.example/v1',
        protocol: 'xai',
        authStyle: 'api_key',
        presetKey: 'xai',
      });
      assert.equal(result.success, false);
      assert.equal(result.error?.code, 'INVALID_ENDPOINT');
      assert.equal(requests, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
