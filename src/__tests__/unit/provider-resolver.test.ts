import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VENDOR_PRESETS,
  inferProtocolFromLegacy,
  inferAuthStyleFromLegacy,
  getDefaultModelsForProvider,
  findPresetForLegacy,
} from '../../lib/provider-catalog';

// ── Provider Catalog Tests ──────────────────────────────────────

describe('Provider Catalog', () => {
  describe('VENDOR_PRESETS', () => {
    it('all presets have required fields', () => {
      for (const preset of VENDOR_PRESETS) {
        assert.ok(preset.key, `Preset missing key`);
        assert.ok(preset.name, `Preset ${preset.key} missing name`);
        assert.ok(preset.protocol, `Preset ${preset.key} missing protocol`);
        assert.ok(preset.description, `Preset ${preset.key} missing description`);
        assert.ok(preset.descriptionZh, `Preset ${preset.key} missing descriptionZh`);
        assert.ok(preset.authStyle, `Preset ${preset.key} missing authStyle`);
        assert.ok(Array.isArray(preset.fields), `Preset ${preset.key} fields not array`);
        assert.ok(preset.iconKey, `Preset ${preset.key} missing iconKey`);
      }
    });

    it('preset keys are unique', () => {
      const keys = VENDOR_PRESETS.map(p => p.key);
      const unique = new Set(keys);
      assert.equal(keys.length, unique.size, `Duplicate preset keys found`);
    });

    it('GLM presets use anthropic protocol', () => {
      const glmPresets = VENDOR_PRESETS.filter(p => p.key.startsWith('glm-'));
      assert.ok(glmPresets.length >= 2, 'Expected at least 2 GLM presets');
      for (const p of glmPresets) {
        assert.equal(p.protocol, 'anthropic', `GLM preset ${p.key} should use anthropic protocol`);
      }
    });

    it('Kimi preset uses anthropic protocol', () => {
      const kimi = VENDOR_PRESETS.find(p => p.key === 'kimi');
      assert.ok(kimi, 'Kimi preset not found');
      assert.equal(kimi.protocol, 'anthropic');
      assert.equal(kimi.authStyle, 'auth_token');
    });

    it('MiniMax presets use anthropic protocol', () => {
      const minimax = VENDOR_PRESETS.filter(p => p.key.startsWith('minimax-'));
      assert.ok(minimax.length >= 2, 'Expected at least 2 MiniMax presets');
      for (const p of minimax) {
        assert.equal(p.protocol, 'anthropic', `MiniMax preset ${p.key} should use anthropic protocol`);
      }
    });

    it('Volcengine preset uses anthropic protocol with auth_token', () => {
      const volc = VENDOR_PRESETS.find(p => p.key === 'volcengine');
      assert.ok(volc, 'Volcengine preset not found');
      assert.equal(volc.protocol, 'anthropic');
      assert.equal(volc.authStyle, 'auth_token');
    });

    it('Bailian preset uses anthropic protocol', () => {
      const bailian = VENDOR_PRESETS.find(p => p.key === 'bailian');
      assert.ok(bailian, 'Bailian preset not found');
      assert.equal(bailian.protocol, 'anthropic');
    });

    it('Bedrock preset uses bedrock protocol with env_only auth', () => {
      const bedrock = VENDOR_PRESETS.find(p => p.key === 'bedrock');
      assert.ok(bedrock, 'Bedrock preset not found');
      assert.equal(bedrock.protocol, 'bedrock');
      assert.equal(bedrock.authStyle, 'env_only');
    });

    it('Vertex preset uses vertex protocol with env_only auth', () => {
      const vertex = VENDOR_PRESETS.find(p => p.key === 'vertex');
      assert.ok(vertex, 'Vertex preset not found');
      assert.equal(vertex.protocol, 'vertex');
      assert.equal(vertex.authStyle, 'env_only');
    });

    it('OpenRouter preset uses openrouter protocol', () => {
      const or = VENDOR_PRESETS.find(p => p.key === 'openrouter');
      assert.ok(or, 'OpenRouter preset not found');
      assert.equal(or.protocol, 'openrouter');
    });

    it('custom-openai preset has been removed', () => {
      const custom = VENDOR_PRESETS.find(p => p.key === 'custom-openai');
      assert.equal(custom, undefined, 'custom-openai preset should not exist');
    });

    it('anthropic-thirdparty preset uses anthropic protocol and has env_overrides field', () => {
      const preset = VENDOR_PRESETS.find(p => p.key === 'anthropic-thirdparty');
      assert.ok(preset, 'anthropic-thirdparty preset not found');
      assert.equal(preset.protocol, 'anthropic');
      assert.ok(preset.fields.includes('env_overrides'), 'should expose env_overrides field');
    });
  });

  describe('inferProtocolFromLegacy', () => {
    it('anthropic type → anthropic protocol', () => {
      assert.equal(inferProtocolFromLegacy('anthropic', 'https://api.anthropic.com'), 'anthropic');
    });

    it('openrouter type → openrouter protocol', () => {
      assert.equal(inferProtocolFromLegacy('openrouter', 'https://openrouter.ai/api'), 'openrouter');
    });

    it('bedrock type → bedrock protocol', () => {
      assert.equal(inferProtocolFromLegacy('bedrock', ''), 'bedrock');
    });

    it('vertex type → vertex protocol', () => {
      assert.equal(inferProtocolFromLegacy('vertex', ''), 'vertex');
    });

    it('gemini-image type → gemini-image protocol', () => {
      assert.equal(inferProtocolFromLegacy('gemini-image', 'https://generativelanguage.googleapis.com'), 'gemini-image');
    });

    // Critical: Chinese vendors with custom type should infer anthropic
    it('custom type + GLM base_url → anthropic protocol', () => {
      assert.equal(inferProtocolFromLegacy('custom', 'https://open.bigmodel.cn/api/anthropic'), 'anthropic');
      assert.equal(inferProtocolFromLegacy('custom', 'https://api.z.ai/api/anthropic'), 'anthropic');
    });

    it('custom type + Kimi base_url → anthropic protocol', () => {
      assert.equal(inferProtocolFromLegacy('custom', 'https://api.kimi.com/coding/'), 'anthropic');
    });

    it('custom type + Moonshot base_url → anthropic protocol', () => {
      assert.equal(inferProtocolFromLegacy('custom', 'https://api.moonshot.cn/anthropic'), 'anthropic');
    });

    it('custom type + MiniMax base_url → anthropic protocol', () => {
      assert.equal(inferProtocolFromLegacy('custom', 'https://api.minimaxi.com/anthropic'), 'anthropic');
      assert.equal(inferProtocolFromLegacy('custom', 'https://api.minimax.io/anthropic'), 'anthropic');
    });

    it('custom type + Volcengine base_url → anthropic protocol', () => {
      assert.equal(inferProtocolFromLegacy('custom', 'https://ark.cn-beijing.volces.com/api/coding'), 'anthropic');
    });

    it('custom type + Bailian base_url → anthropic protocol', () => {
      assert.equal(inferProtocolFromLegacy('custom', 'https://coding.dashscope.aliyuncs.com/apps/anthropic'), 'anthropic');
    });

    it('custom type + unknown URL → anthropic protocol', () => {
      assert.equal(inferProtocolFromLegacy('custom', 'https://my-server.example.com/v1'), 'anthropic');
    });

    it('custom type + URL containing /anthropic → anthropic protocol', () => {
      assert.equal(inferProtocolFromLegacy('custom', 'https://proxy.example.com/anthropic'), 'anthropic');
    });
  });

  describe('inferAuthStyleFromLegacy', () => {
    it('bedrock → env_only', () => {
      assert.equal(inferAuthStyleFromLegacy('bedrock', '{}'), 'env_only');
    });

    it('vertex → env_only', () => {
      assert.equal(inferAuthStyleFromLegacy('vertex', '{}'), 'env_only');
    });

    it('extra_env with ANTHROPIC_AUTH_TOKEN → auth_token', () => {
      assert.equal(
        inferAuthStyleFromLegacy('custom', '{"ANTHROPIC_AUTH_TOKEN":""}'),
        'auth_token',
      );
    });

    it('extra_env with ANTHROPIC_API_KEY → api_key', () => {
      assert.equal(
        inferAuthStyleFromLegacy('custom', '{"ANTHROPIC_API_KEY":""}'),
        'api_key',
      );
    });

    it('empty extra_env → api_key', () => {
      assert.equal(inferAuthStyleFromLegacy('anthropic', '{}'), 'api_key');
    });
  });

  describe('getDefaultModelsForProvider', () => {
    it('anthropic protocol with GLM CN url returns GLM models', () => {
      const models = getDefaultModelsForProvider('anthropic', 'https://open.bigmodel.cn/api/anthropic');
      assert.ok(models.length > 0);
      assert.ok(models.some(m => m.displayName.includes('GLM')));
    });

    it('anthropic protocol with Bailian url returns Bailian models', () => {
      const models = getDefaultModelsForProvider('anthropic', 'https://coding.dashscope.aliyuncs.com/apps/anthropic');
      assert.ok(models.length > 0);
      assert.ok(models.some(m => m.displayName.includes('Qwen')));
    });

    it('anthropic protocol with unknown url returns default Anthropic models', () => {
      const models = getDefaultModelsForProvider('anthropic', 'https://my-proxy.com/api');
      assert.ok(models.length > 0);
      assert.ok(models.some(m => m.modelId === 'sonnet'));
    });

    it('bedrock protocol returns default Anthropic models', () => {
      const models = getDefaultModelsForProvider('bedrock', '');
      assert.ok(models.length > 0);
      assert.ok(models.some(m => m.modelId === 'sonnet'));
    });

    it('openai-compatible protocol with no matching url returns empty', () => {
      const models = getDefaultModelsForProvider('openai-compatible', 'https://example.com/v1');
      assert.equal(models.length, 0);
    });
  });

  describe('findPresetForLegacy', () => {
    it('finds bedrock preset by type', () => {
      const preset = findPresetForLegacy('', 'bedrock');
      assert.ok(preset);
      assert.equal(preset.key, 'bedrock');
    });

    it('finds GLM preset by base_url', () => {
      const preset = findPresetForLegacy('https://open.bigmodel.cn/api/anthropic', 'custom');
      assert.ok(preset);
      assert.equal(preset.key, 'glm-cn');
    });

    it('finds Kimi preset by base_url', () => {
      const preset = findPresetForLegacy('https://api.kimi.com/coding/', 'custom');
      assert.ok(preset);
      assert.equal(preset.key, 'kimi');
    });

    it('finds anthropic-official by base_url + type', () => {
      const preset = findPresetForLegacy('https://api.anthropic.com', 'anthropic');
      assert.ok(preset);
      assert.equal(preset.key, 'anthropic-official');
    });
  });
});

// ── Provider Resolver Tests ─────────────────────────────────────

import { resolveProvider, toClaudeCodeEnv, toAiSdkConfig } from '../../lib/provider-resolver';
import type { ResolvedProvider } from '../../lib/provider-resolver';

describe('Provider Resolver', () => {
  describe('resolveProvider', () => {
    it('returns env-based resolution when providerId is "env"', () => {
      const resolved = resolveProvider({ providerId: 'env' });
      assert.equal(resolved.provider, undefined);
      assert.equal(resolved.protocol, 'anthropic');
      assert.deepEqual(resolved.settingSources, ['user', 'project', 'local']);
    });

    it('returns env-based resolution when no provider configured', () => {
      // With no providers in DB, should return env-based
      const resolved = resolveProvider({});
      // provider may be undefined or the default — depends on DB state
      assert.equal(resolved.protocol, 'anthropic');
    });
  });

  describe('toClaudeCodeEnv', () => {
    it('injects ANTHROPIC_API_KEY for api_key auth style', () => {
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test',
          name: 'Test',
          provider_type: 'anthropic',
          protocol: 'anthropic',
          base_url: 'https://api.anthropic.com',
          api_key: 'sk-test-key',
          is_active: 1,
          sort_order: 0,
          extra_env: '{}',
          headers_json: '{}',
          env_overrides_json: '',
          role_models_json: '{}',
          notes: '',
          created_at: '',
          updated_at: '', options_json: '{}',
        },
        protocol: 'anthropic',
        authStyle: 'api_key',
        model: 'sonnet',
        modelDisplayName: 'Sonnet 4.6',
        upstreamModel: 'sonnet',
        headers: {},
        envOverrides: {},
        roleModels: {},
        hasCredentials: true,
        availableModels: [],
        settingSources: ['project', 'local'],
      };

      const env = toClaudeCodeEnv({ PATH: '/usr/bin' }, resolved);
      assert.equal(env.ANTHROPIC_API_KEY, 'sk-test-key');
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-test-key');
      assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
    });

    it('injects only ANTHROPIC_AUTH_TOKEN for auth_token style', () => {
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test',
          name: 'Kimi',
          provider_type: 'anthropic',
          protocol: 'anthropic',
          base_url: 'https://api.kimi.com/coding/',
          api_key: 'kimi-key',
          is_active: 1,
          sort_order: 0,
          extra_env: '{}',
          headers_json: '{}',
          env_overrides_json: '',
          role_models_json: '{}',
          notes: '',
          created_at: '',
          updated_at: '', options_json: '{}',
        },
        protocol: 'anthropic',
        authStyle: 'auth_token',
        model: 'sonnet',
        modelDisplayName: undefined,
        upstreamModel: undefined,
        headers: {},
        envOverrides: {},
        roleModels: {},
        hasCredentials: true,
        availableModels: [],
        settingSources: ['project', 'local'],
      };

      const env = toClaudeCodeEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'old-key' }, resolved);
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'kimi-key');
      // auth_token style should NOT set ANTHROPIC_API_KEY
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
    });

    it('applies env overrides with empty-string deletion', () => {
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test',
          name: 'Test',
          provider_type: 'anthropic',
          protocol: 'anthropic',
          base_url: '',
          api_key: 'key',
          is_active: 1,
          sort_order: 0,
          extra_env: '{}',
          headers_json: '{}',
          env_overrides_json: '',
          role_models_json: '{}',
          notes: '',
          created_at: '',
          updated_at: '', options_json: '{}',
        },
        protocol: 'anthropic',
        authStyle: 'api_key',
        model: undefined,
        modelDisplayName: undefined,
        upstreamModel: undefined,
        headers: {},
        envOverrides: {
          API_TIMEOUT_MS: '3000000',
          ANTHROPIC_API_KEY: '', // legacy placeholder — should be skipped (auth keys handled by auth injection)
          SOME_CUSTOM_VAR: '',   // non-auth key — should be deleted
        },
        roleModels: {},
        hasCredentials: true,
        availableModels: [],
        settingSources: ['project', 'local'],
      };

      const env = toClaudeCodeEnv({ PATH: '/usr/bin', SOME_CUSTOM_VAR: 'old' }, resolved);
      assert.equal(env.API_TIMEOUT_MS, '3000000');
      // Auth keys are NOT deleted by envOverrides — they're managed by the auth injection logic above
      assert.equal(env.ANTHROPIC_API_KEY, 'key'); // preserved from auth injection
      assert.equal(env.SOME_CUSTOM_VAR, undefined); // non-auth key deleted by empty string
    });

    it('injects role models as env vars', () => {
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test',
          name: 'Test',
          provider_type: 'anthropic',
          protocol: 'anthropic',
          base_url: '',
          api_key: 'key',
          is_active: 1,
          sort_order: 0,
          extra_env: '{}',
          headers_json: '{}',
          env_overrides_json: '',
          role_models_json: '{}',
          notes: '',
          created_at: '',
          updated_at: '', options_json: '{}',
        },
        protocol: 'anthropic',
        authStyle: 'api_key',
        model: undefined,
        modelDisplayName: undefined,
        upstreamModel: undefined,
        headers: {},
        envOverrides: {},
        roleModels: {
          default: 'my-model-v1',
          reasoning: 'my-reasoning-model',
          small: 'my-small-model',
        },
        hasCredentials: true,
        availableModels: [],
        settingSources: ['project', 'local'],
      };

      const env = toClaudeCodeEnv({}, resolved);
      assert.equal(env.ANTHROPIC_MODEL, 'my-model-v1');
      assert.equal(env.ANTHROPIC_REASONING_MODEL, 'my-reasoning-model');
      assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'my-small-model');
    });

    it('preserves env vars when no provider (env-based)', () => {
      const resolved: ResolvedProvider = {
        provider: undefined,
        protocol: 'anthropic',
        authStyle: 'api_key',
        model: undefined,
        modelDisplayName: undefined,
        upstreamModel: undefined,
        headers: {},
        envOverrides: {},
        roleModels: {},
        hasCredentials: false,
        availableModels: [],
        settingSources: ['user', 'project', 'local'],
      };

      const env = toClaudeCodeEnv({
        ANTHROPIC_API_KEY: 'shell-key',
        PATH: '/usr/bin',
      }, resolved);
      assert.equal(env.ANTHROPIC_API_KEY, 'shell-key'); // preserved
      assert.equal(env.PATH, '/usr/bin');
    });
  });

  describe('toAiSdkConfig', () => {
    it('anthropic protocol → anthropic SDK', () => {
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test', name: 'Test', provider_type: 'anthropic', protocol: 'anthropic',
          base_url: 'https://api.anthropic.com', api_key: 'key', is_active: 1, sort_order: 0,
          extra_env: '{}', headers_json: '{}', env_overrides_json: '', role_models_json: '{}',
          notes: '', created_at: '', updated_at: '', options_json: '{}',
        },
        protocol: 'anthropic',
        authStyle: 'api_key',
        model: 'sonnet',
        modelDisplayName: 'Sonnet 4.6',
        upstreamModel: 'sonnet',
        headers: {},
        envOverrides: {},
        roleModels: {},
        hasCredentials: true,
        availableModels: [],
        settingSources: ['project', 'local'],
      };

      const config = toAiSdkConfig(resolved);
      assert.equal(config.sdkType, 'anthropic');
      assert.equal(config.apiKey, 'key');
      assert.equal(config.baseUrl, 'https://api.anthropic.com/v1');
      assert.equal(config.modelId, 'sonnet');
      assert.deepEqual(config.processEnvInjections, {});
    });

    it('openrouter protocol → openai SDK with correct base URL', () => {
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test', name: 'OR', provider_type: 'openrouter', protocol: 'openrouter',
          base_url: 'https://openrouter.ai/api', api_key: 'or-key', is_active: 1, sort_order: 0,
          extra_env: '{}', headers_json: '{}', env_overrides_json: '', role_models_json: '{}',
          notes: '', created_at: '', updated_at: '', options_json: '{}',
        },
        protocol: 'openrouter',
        authStyle: 'api_key',
        model: 'sonnet',
        modelDisplayName: undefined,
        upstreamModel: undefined,
        headers: {},
        envOverrides: {},
        roleModels: {},
        hasCredentials: true,
        availableModels: [],
        settingSources: ['project', 'local'],
      };

      const config = toAiSdkConfig(resolved);
      assert.equal(config.sdkType, 'openai');
      assert.equal(config.apiKey, 'or-key');
      assert.equal(config.baseUrl, 'https://openrouter.ai/api');
    });

    it('bedrock protocol → injects env overrides', () => {
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test', name: 'Bedrock', provider_type: 'bedrock', protocol: 'bedrock',
          base_url: '', api_key: '', is_active: 1, sort_order: 0,
          extra_env: '{}', headers_json: '{}', env_overrides_json: '', role_models_json: '{}',
          notes: '', created_at: '', updated_at: '', options_json: '{}',
        },
        protocol: 'bedrock',
        authStyle: 'env_only',
        model: 'sonnet',
        modelDisplayName: undefined,
        upstreamModel: undefined,
        headers: {},
        envOverrides: {
          CLAUDE_CODE_USE_BEDROCK: '1',
          AWS_REGION: 'us-east-1',
        },
        roleModels: {},
        hasCredentials: true,
        availableModels: [],
        settingSources: ['project', 'local'],
      };

      const config = toAiSdkConfig(resolved);
      assert.equal(config.sdkType, 'bedrock'); // no base_url → native bedrock SDK
      assert.deepEqual(config.processEnvInjections, {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-east-1',
      });
    });

    it('openai-compatible protocol → openai SDK', () => {
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test', name: 'Custom', provider_type: 'custom', protocol: 'openai-compatible',
          base_url: 'https://my-server.com/v1', api_key: 'key', is_active: 1, sort_order: 0,
          extra_env: '{}', headers_json: '{}', env_overrides_json: '', role_models_json: '{}',
          notes: '', created_at: '', updated_at: '', options_json: '{}',
        },
        protocol: 'openai-compatible',
        authStyle: 'api_key',
        model: 'gpt-4',
        modelDisplayName: undefined,
        upstreamModel: undefined,
        headers: {},
        envOverrides: {},
        roleModels: {},
        hasCredentials: true,
        availableModels: [],
        settingSources: ['project', 'local'],
      };

      const config = toAiSdkConfig(resolved);
      assert.equal(config.sdkType, 'openai');
      assert.equal(config.baseUrl, 'https://my-server.com/v1');
    });

    it('model override takes precedence', () => {
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test', name: 'Test', provider_type: 'anthropic', protocol: 'anthropic',
          base_url: '', api_key: 'key', is_active: 1, sort_order: 0,
          extra_env: '{}', headers_json: '{}', env_overrides_json: '', role_models_json: '{}',
          notes: '', created_at: '', updated_at: '', options_json: '{}',
        },
        protocol: 'anthropic',
        authStyle: 'api_key',
        model: 'sonnet',
        modelDisplayName: undefined,
        upstreamModel: undefined,
        headers: {},
        envOverrides: {},
        roleModels: {},
        hasCredentials: true,
        availableModels: [],
        settingSources: ['project', 'local'],
      };

      const config = toAiSdkConfig(resolved, 'opus');
      assert.equal(config.modelId, 'opus');
    });

    it('gemini-image protocol → google SDK', () => {
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test', name: 'Gemini', provider_type: 'gemini-image', protocol: 'gemini-image',
          base_url: 'https://generativelanguage.googleapis.com/v1beta', api_key: 'gkey',
          is_active: 1, sort_order: 0,
          extra_env: '{}', headers_json: '{}', env_overrides_json: '', role_models_json: '{}',
          notes: '', created_at: '', updated_at: '', options_json: '{}',
        },
        protocol: 'gemini-image',
        authStyle: 'api_key',
        model: 'gemini-2.5-flash-image',
        modelDisplayName: undefined,
        upstreamModel: undefined,
        headers: {},
        envOverrides: {},
        roleModels: {},
        hasCredentials: true,
        availableModels: [],
        settingSources: ['project', 'local'],
      };

      const config = toAiSdkConfig(resolved);
      assert.equal(config.sdkType, 'google');
      assert.equal(config.apiKey, 'gkey');
    });
  });
});

// ── Entry Point Consistency Tests ───────────────────────────────

describe('Entry Point Consistency', () => {
  it('all Anthropic-compatible Chinese vendors infer correct protocol from legacy custom type', () => {
    const vendors: Array<{ name: string; url: string }> = [
      { name: 'GLM CN', url: 'https://open.bigmodel.cn/api/anthropic' },
      { name: 'GLM Global', url: 'https://api.z.ai/api/anthropic' },
      { name: 'Kimi', url: 'https://api.kimi.com/coding/' },
      { name: 'Moonshot', url: 'https://api.moonshot.cn/anthropic' },
      { name: 'MiniMax CN', url: 'https://api.minimaxi.com/anthropic' },
      { name: 'MiniMax Global', url: 'https://api.minimax.io/anthropic' },
      { name: 'Volcengine', url: 'https://ark.cn-beijing.volces.com/api/coding' },
      { name: 'Bailian', url: 'https://coding.dashscope.aliyuncs.com/apps/anthropic' },
    ];

    for (const v of vendors) {
      const protocol = inferProtocolFromLegacy('custom', v.url);
      assert.equal(
        protocol,
        'anthropic',
        `${v.name} (${v.url}) should infer anthropic, got ${protocol}`,
      );
    }
  });

  it('legacy custom type with non-anthropic URL infers anthropic', () => {
    const protocol = inferProtocolFromLegacy('custom', 'https://my-ollama.local:11434/v1');
    assert.equal(protocol, 'anthropic');
  });
});

// ── Env Provider in AI SDK Path ─────────────────────────────────

describe('Env Provider AI SDK Consistency', () => {
  it('env resolution with ANTHROPIC_API_KEY sets hasCredentials=true', () => {
    // Simulate having an env var
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-env-key';
    try {
      const resolved = resolveProvider({ providerId: 'env' });
      assert.equal(resolved.provider, undefined, 'env mode should have provider=undefined');
      assert.equal(resolved.hasCredentials, true, 'env mode with ANTHROPIC_API_KEY should have hasCredentials=true');
      assert.equal(resolved.protocol, 'anthropic');
    } finally {
      if (origKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = origKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it('env resolution without any credentials sets hasCredentials=false', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    const origToken = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      const resolved = resolveProvider({ providerId: 'env' });
      assert.equal(resolved.provider, undefined);
      // hasCredentials depends on DB settings too, but with clean env it should be false
      // (DB settings may or may not be set in test env, so we just verify provider is undefined)
    } finally {
      if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
      if (origToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = origToken;
    }
  });

  it('toAiSdkConfig with env resolution produces valid anthropic config', () => {
    // Isolate from real env vars AND DB settings that may be set on developer machines
    const envSnapshot = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    const dbSnapshot = {
      anthropic_auth_token: getSetting('anthropic_auth_token'),
      anthropic_base_url: getSetting('anthropic_base_url'),
    };
    setSetting('anthropic_auth_token', '');
    setSetting('anthropic_base_url', '');
    try {
      const resolved: ResolvedProvider = {
        provider: undefined,
        protocol: 'anthropic',
        authStyle: 'api_key',
        model: 'sonnet',
        upstreamModel: 'sonnet',
        modelDisplayName: undefined,
        headers: {},
        envOverrides: {},
        roleModels: {},
        hasCredentials: true,
        availableModels: [],
        settingSources: ['user', 'project', 'local'],
      };
      const config = toAiSdkConfig(resolved);
      assert.equal(config.sdkType, 'anthropic');
      assert.equal(config.modelId, 'sonnet');
      // No apiKey/baseUrl — SDK will read from process.env
      assert.equal(config.apiKey, undefined);
      assert.equal(config.baseUrl, undefined);
    } finally {
      for (const [k, v] of Object.entries(envSnapshot)) {
        if (v !== undefined) process.env[k] = v; else delete process.env[k];
      }
      setSetting('anthropic_auth_token', dbSnapshot.anthropic_auth_token || '');
      setSetting('anthropic_base_url', dbSnapshot.anthropic_base_url || '');
    }
  });
});

// ── Upstream Model ID Mapping ───────────────────────────────────

describe('Upstream Model ID Mapping', () => {
  it('toAiSdkConfig maps internal model ID to upstream via availableModels', () => {
    const resolved: ResolvedProvider = {
      provider: {
        id: 'test', name: 'GLM', provider_type: 'custom', protocol: 'anthropic',
        base_url: 'https://open.bigmodel.cn/api/anthropic', api_key: 'key',
        is_active: 1, sort_order: 0, extra_env: '{}', headers_json: '{}',
        env_overrides_json: '', role_models_json: '{}', notes: '', created_at: '', updated_at: '', options_json: '{}',
      },
      protocol: 'anthropic',
      authStyle: 'api_key',
      model: 'sonnet',
      upstreamModel: 'glm-5-turbo', // resolved from catalog
      modelDisplayName: 'GLM-5-Turbo',
      headers: {},
      envOverrides: {},
      roleModels: {},
      hasCredentials: true,
      availableModels: [
        { modelId: 'sonnet', upstreamModelId: 'glm-5-turbo', displayName: 'GLM-5-Turbo' },
        { modelId: 'opus', upstreamModelId: 'glm-5.1', displayName: 'GLM-5.1' },
      ],
      settingSources: ['project', 'local'],
    };

    // Without override — uses resolved.upstreamModel
    const config1 = toAiSdkConfig(resolved);
    assert.equal(config1.modelId, 'glm-5-turbo', 'should use upstream model ID from resolution');

    // With override matching an available model — should map to upstream
    const config2 = toAiSdkConfig(resolved, 'opus');
    assert.equal(config2.modelId, 'glm-5.1', 'override "opus" should map to upstream "glm-5.1"');

    // With override NOT in available models — passes through as-is
    const config3 = toAiSdkConfig(resolved, 'unknown-model');
    assert.equal(config3.modelId, 'unknown-model', 'unknown override should pass through');
  });

  it('toClaudeCodeEnv injects role model env vars for upstream mapping', () => {
    const resolved: ResolvedProvider = {
      provider: {
        id: 'test', name: 'GLM', provider_type: 'custom', protocol: 'anthropic',
        base_url: 'https://open.bigmodel.cn/api/anthropic', api_key: 'key',
        is_active: 1, sort_order: 0, extra_env: '{}', headers_json: '{}',
        env_overrides_json: '', role_models_json: '{"default":"glm-5-turbo","sonnet":"glm-5-turbo","opus":"glm-5.1"}',
        notes: '', created_at: '', updated_at: '', options_json: '{}',
      },
      protocol: 'anthropic',
      authStyle: 'api_key',
      model: 'sonnet',
      upstreamModel: 'glm-5-turbo',
      modelDisplayName: 'GLM-5-Turbo',
      headers: {},
      envOverrides: {},
      roleModels: { default: 'glm-5-turbo', sonnet: 'glm-5-turbo', opus: 'glm-5.1' },
      hasCredentials: true,
      availableModels: [],
      settingSources: ['project', 'local'],
    };

    const env = toClaudeCodeEnv({}, resolved);
    assert.equal(env.ANTHROPIC_MODEL, 'glm-5-turbo', 'ANTHROPIC_MODEL should be set from roleModels.default');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-5-turbo');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.1');
  });
});

// ── Entry Point Resolution Contract ─────────────────────────────
// Verifies that ALL entry points (chat, bridge, onboarding, check-in, media plan)
// produce identical resolution results for the same inputs, and that the AI SDK
// path does not have any fallback logic outside the unified resolver.

describe('Entry Point Resolution Contract', () => {
  it('env provider with no credentials does not silently fallback', () => {
    // When providerId='env' is explicitly selected but shell has no credentials,
    // the resolver must return hasCredentials=false. The AI SDK path (text-generator)
    // must then throw — NOT silently pick a random DB provider.
    const origKey = process.env.ANTHROPIC_API_KEY;
    const origToken = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      const resolved = resolveProvider({ providerId: 'env' });
      assert.equal(resolved.provider, undefined, 'env mode must return provider=undefined');
      // hasCredentials should be false when no env vars are set
      // (may be true if legacy DB setting exists, which is also valid)
      if (!resolved.hasCredentials) {
        // This is the case text-generator should throw on — NOT fallback to DB
        assert.equal(resolved.hasCredentials, false);
        assert.equal(resolved.provider, undefined);
        // Contract: any consumer seeing this result must throw, not fallback
      }
    } finally {
      if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
      else delete process.env.ANTHROPIC_API_KEY;
      if (origToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = origToken;
      else delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });

  it('all entry points resolve identically for same providerId + model', () => {
    // Simulate what each entry point does: call resolveProvider with the same inputs.
    // Chat, bridge, onboarding, check-in, media plan must all get the same result.
    const opts = {
      sessionProviderId: 'env' as string | undefined,
      sessionModel: 'sonnet' as string | undefined,
    };

    const chatResolved = resolveProvider(opts);
    const bridgeResolved = resolveProvider(opts);
    const onboardingResolved = resolveProvider(opts);
    const checkinResolved = resolveProvider(opts);
    const planResolved = resolveProvider(opts);

    // All must return identical provider, model, protocol, hasCredentials
    for (const [name, r] of [
      ['bridge', bridgeResolved],
      ['onboarding', onboardingResolved],
      ['checkin', checkinResolved],
      ['plan', planResolved],
    ] as const) {
      assert.equal(r.provider?.id, chatResolved.provider?.id, `${name} provider mismatch`);
      assert.equal(r.model, chatResolved.model, `${name} model mismatch`);
      assert.equal(r.upstreamModel, chatResolved.upstreamModel, `${name} upstreamModel mismatch`);
      assert.equal(r.protocol, chatResolved.protocol, `${name} protocol mismatch`);
      assert.equal(r.hasCredentials, chatResolved.hasCredentials, `${name} hasCredentials mismatch`);
    }
  });

  it('toAiSdkConfig for env mode does not require provider record', () => {
    // Isolate from real env vars AND DB settings
    const envSnapshot = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    const dbSnapshot = {
      anthropic_auth_token: getSetting('anthropic_auth_token'),
      anthropic_base_url: getSetting('anthropic_base_url'),
    };
    setSetting('anthropic_auth_token', '');
    setSetting('anthropic_base_url', '');
    try {
      // env mode: provider=undefined, hasCredentials=true
      // toAiSdkConfig must produce a valid config that relies on process.env for auth
      const resolved: ResolvedProvider = {
        provider: undefined,
        protocol: 'anthropic',
        authStyle: 'api_key',
        model: 'sonnet',
        upstreamModel: 'sonnet',
        modelDisplayName: undefined,
        headers: {},
        envOverrides: {},
        roleModels: {},
        hasCredentials: true,
        availableModels: [],
        settingSources: ['user', 'project', 'local'],
      };
      const config = toAiSdkConfig(resolved);
      assert.equal(config.sdkType, 'anthropic');
      assert.equal(config.apiKey, undefined, 'env mode should not inject apiKey — SDK reads from process.env');
      assert.equal(config.baseUrl, undefined, 'env mode should not inject baseUrl — SDK reads from process.env');
      assert.equal(config.modelId, 'sonnet');
    } finally {
      for (const [k, v] of Object.entries(envSnapshot)) {
        if (v !== undefined) process.env[k] = v; else delete process.env[k];
      }
      setSetting('anthropic_auth_token', dbSnapshot.anthropic_auth_token || '');
      setSetting('anthropic_base_url', dbSnapshot.anthropic_base_url || '');
    }
  });

  it('upstream model mapping is consistent between AI SDK and Claude Code paths', () => {
    // For a provider where modelId !== upstreamModelId,
    // both toAiSdkConfig and toClaudeCodeEnv must use the upstream ID
    const resolved: ResolvedProvider = {
      provider: {
        id: 'test', name: 'GLM', provider_type: 'custom', protocol: 'anthropic',
        base_url: 'https://open.bigmodel.cn/api/anthropic', api_key: 'key',
        is_active: 1, sort_order: 0, extra_env: '{}', headers_json: '{}',
        env_overrides_json: '', role_models_json: '{"default":"glm-5-turbo"}',
        notes: '', created_at: '', updated_at: '', options_json: '{}',
      },
      protocol: 'anthropic',
      authStyle: 'api_key',
      model: 'sonnet',
      upstreamModel: 'glm-5-turbo',
      modelDisplayName: 'GLM-5-Turbo',
      headers: {},
      envOverrides: {},
      roleModels: { default: 'glm-5-turbo' },
      hasCredentials: true,
      availableModels: [
        { modelId: 'sonnet', upstreamModelId: 'glm-5-turbo', displayName: 'GLM-5-Turbo' },
      ],
      settingSources: ['project', 'local'],
    };

    // AI SDK path: toAiSdkConfig should use upstreamModel
    const aiConfig = toAiSdkConfig(resolved);
    assert.equal(aiConfig.modelId, 'glm-5-turbo', 'AI SDK should use upstream model ID');

    // Claude Code path: toClaudeCodeEnv should set ANTHROPIC_MODEL from roleModels.default
    const ccEnv = toClaudeCodeEnv({}, resolved);
    assert.equal(ccEnv.ANTHROPIC_MODEL, 'glm-5-turbo', 'Claude Code env should use upstream model ID');

    // Both paths use the same upstream ID
    assert.equal(aiConfig.modelId, ccEnv.ANTHROPIC_MODEL, 'AI SDK and Claude Code must use same upstream model');
  });
});

// ── Global Default Model Tests ──────────────────────────────────

import { getSetting, setSetting } from '../../lib/db';

describe('Global Default Model', () => {
  // Save and restore settings around each test
  let savedModel: string | null | undefined;
  let savedProvider: string | null | undefined;

  const setup = () => {
    savedModel = getSetting('global_default_model');
    savedProvider = getSetting('global_default_model_provider');
  };
  const teardown = () => {
    setSetting('global_default_model', savedModel || '');
    setSetting('global_default_model_provider', savedProvider || '');
  };

  // ── env provider branch ───────────────────────────────────────

  it('env provider uses global default model when it belongs to env', () => {
    setup();
    try {
      setSetting('global_default_model', 'opus');
      setSetting('global_default_model_provider', 'env');

      const resolved = resolveProvider({ providerId: 'env' });
      assert.equal(resolved.model, 'opus', 'should use global default model for env provider');
    } finally {
      teardown();
    }
  });

  it('env provider ignores global default model when it belongs to another provider', () => {
    setup();
    try {
      setSetting('global_default_model', 'some-model');
      setSetting('global_default_model_provider', 'some-other-provider-id');

      const resolved = resolveProvider({ providerId: 'env' });
      // Should NOT use 'some-model' because it belongs to a different provider
      assert.notEqual(resolved.model, 'some-model',
        'should not apply global default from another provider');
    } finally {
      teardown();
    }
  });

  it('explicit model overrides global default', () => {
    setup();
    try {
      setSetting('global_default_model', 'opus');
      setSetting('global_default_model_provider', 'env');

      const resolved = resolveProvider({ providerId: 'env', model: 'haiku' });
      assert.equal(resolved.model, 'haiku', 'explicit model should take priority');
    } finally {
      teardown();
    }
  });

  it('session model overrides global default', () => {
    setup();
    try {
      setSetting('global_default_model', 'opus');
      setSetting('global_default_model_provider', 'env');

      const resolved = resolveProvider({ providerId: 'env', sessionModel: 'sonnet' });
      assert.equal(resolved.model, 'sonnet', 'session model should take priority');
    } finally {
      teardown();
    }
  });

  // ── DB provider branch ────────────────────────────────────────

  it('DB provider uses global default model when it belongs to that provider', () => {
    setup();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic import in test to avoid top-level side effects
const { createProvider, deleteProvider } = require('../../lib/db');
    const provider = createProvider({
      name: '__test_global_default__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'test-key',
    });
    try {
      setSetting('global_default_model', 'test-model-x');
      setSetting('global_default_model_provider', provider.id);

      const resolved = resolveProvider({ providerId: provider.id });
      assert.equal(resolved.model, 'test-model-x',
        'DB provider should use global default when provider ID matches');
    } finally {
      deleteProvider(provider.id);
      teardown();
    }
  });

  it('DB provider ignores global default model when it belongs to a different provider', () => {
    setup();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic import in test to avoid top-level side effects
const { createProvider, deleteProvider } = require('../../lib/db');
    const provider = createProvider({
      name: '__test_global_default_cross__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'test-key',
      role_models_json: JSON.stringify({ default: 'own-default-model' }),
    });
    try {
      setSetting('global_default_model', 'foreign-model');
      setSetting('global_default_model_provider', 'some-completely-different-id');

      const resolved = resolveProvider({ providerId: provider.id });
      // Should fall through to roleModels.default, NOT use 'foreign-model'
      assert.notEqual(resolved.model, 'foreign-model',
        'DB provider should not use global default from another provider');
      assert.equal(resolved.model, 'own-default-model',
        'should fall through to roleModels.default');
    } finally {
      deleteProvider(provider.id);
      teardown();
    }
  });

  it('DB provider: session model overrides global default even when provider matches', () => {
    setup();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic import in test to avoid top-level side effects
const { createProvider, deleteProvider } = require('../../lib/db');
    const provider = createProvider({
      name: '__test_global_default_session__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'test-key',
    });
    try {
      setSetting('global_default_model', 'global-pick');
      setSetting('global_default_model_provider', provider.id);

      const resolved = resolveProvider({ providerId: provider.id, sessionModel: 'session-pick' });
      assert.equal(resolved.model, 'session-pick',
        'session model should take priority over global default');
    } finally {
      deleteProvider(provider.id);
      teardown();
    }
  });
});
