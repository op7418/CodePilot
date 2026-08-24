import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VENDOR_PRESETS, PresetSchema, getDefaultModelsForProvider, getEffectiveProviderProtocol, isValidProtocol } from '../../lib/provider-catalog';

describe('Preset Schema Validation', () => {
  for (const preset of VENDOR_PRESETS) {
    describe(`preset: ${preset.key}`, () => {
      it('passes Zod schema validation', () => {
        const result = PresetSchema.safeParse(preset);
        if (!result.success) {
          assert.fail(`Schema validation failed for ${preset.key}: ${result.error.message}`);
        }
      });

      it('has at least one default model (or is volcengine/ollama/openai-compatible)', () => {
        // openai-compatible is a generic third-party gateway: the user names
        // their own model. Fabricating a default lineup would be fake data —
        // same rationale as volcengine/ollama.
        if (preset.key === 'volcengine' || preset.key === 'ollama' || preset.key === 'openai-compatible') return;
        assert.ok(preset.defaultModels.length > 0, `Preset ${preset.key} expected at least one default model`);
      });

      it('authStyle and defaultEnvOverrides do not conflict', () => {
        if (preset.authStyle === 'auth_token') {
          assert.equal(
            preset.defaultEnvOverrides.ANTHROPIC_API_KEY,
            undefined,
            `auth_token preset ${preset.key} should not have ANTHROPIC_API_KEY in envOverrides`,
          );
        }
        if (preset.authStyle === 'api_key') {
          assert.equal(
            preset.defaultEnvOverrides.ANTHROPIC_AUTH_TOKEN,
            undefined,
            `api_key preset ${preset.key} should not have ANTHROPIC_AUTH_TOKEN in envOverrides`,
          );
        }
      });
    });
  }

  // ── Regression tests for the authStyle fixes ──

  it('OpenRouter uses auth_token', () => {
    const p = VENDOR_PRESETS.find(v => v.key === 'openrouter')!;
    assert.equal(p.authStyle, 'auth_token');
  });

  it('GLM CN uses auth_token', () => {
    const p = VENDOR_PRESETS.find(v => v.key === 'glm-cn')!;
    assert.equal(p.authStyle, 'auth_token');
  });

  it('GLM Global uses auth_token', () => {
    const p = VENDOR_PRESETS.find(v => v.key === 'glm-global')!;
    assert.equal(p.authStyle, 'auth_token');
  });

  it('Moonshot uses auth_token with ENABLE_TOOL_SEARCH disabled', () => {
    const p = VENDOR_PRESETS.find(v => v.key === 'moonshot')!;
    assert.equal(p.authStyle, 'auth_token');
    assert.equal(p.defaultEnvOverrides.ENABLE_TOOL_SEARCH, 'false');
  });

  it('Kimi uses api_key with ENABLE_TOOL_SEARCH disabled', () => {
    const p = VENDOR_PRESETS.find(v => v.key === 'kimi')!;
    assert.equal(p.authStyle, 'api_key');
    assert.equal(p.defaultEnvOverrides.ENABLE_TOOL_SEARCH, 'false');
  });

  it('Bailian uses auth_token', () => {
    const p = VENDOR_PRESETS.find(v => v.key === 'bailian')!;
    assert.equal(p.authStyle, 'auth_token');
  });

  it('openai-compatible preset exists: openai-compatible protocol, api_key auth, no fixed URL, no fabricated catalog', () => {
    const p = VENDOR_PRESETS.find(v => v.key === 'openai-compatible');
    assert.ok(p, 'generic openai-compatible preset must exist');
    assert.equal(p!.protocol, 'openai-compatible');
    assert.equal(p!.authStyle, 'api_key');
    assert.equal(p!.baseUrl, '', 'generic gateway has no fixed base URL — the user supplies it');
    assert.equal(p!.defaultModels.length, 0, 'must not fabricate a model lineup for an arbitrary gateway');
    assert.ok(p!.fields.includes('base_url'), 'must expose base_url so the user can enter their endpoint');
    assert.ok(p!.fields.includes('model_names'), 'must expose model_names so the user can set their model');
    assert.notEqual(p!.sdkProxyOnly, true, 'openai-compatible uses the AI SDK path, not the Claude Code subprocess');
    assert.notEqual(p!.meta?.claudeCodeVerified, true, 'claudeCodeVerified is only meaningful for anthropic presets');
  });

  it('MiniMax regional presets expose current model metadata and OpenAI endpoints', () => {
    const expected = [
      ['minimax-cn', 'https://api.minimaxi.com/v1', 'https://platform.minimaxi.com/docs'],
      ['minimax-global', 'https://api.minimax.io/v1', 'https://platform.minimax.io/docs'],
    ] as const;
    for (const [key, openaiBaseUrl, docsUrl] of expected) {
      const preset = VENDOR_PRESETS.find(v => v.key === key)!;
      const m27 = preset.defaultModels.find(model => model.upstreamModelId === 'MiniMax-M2.7')!;
      const m3 = preset.defaultModels.find(model => model.modelId === 'MiniMax-M3')!;
      assert.equal(m27.capabilities?.contextWindow, 204_800);
      assert.equal(m27.capabilities?.thinkingMode, 'always');
      assert.deepEqual(m27.capabilities?.inputModalities, ['text']);
      assert.equal(m3.capabilities?.contextWindow, 1_000_000);
      assert.equal(m3.capabilities?.supportsAdaptiveThinking, true);
      assert.deepEqual(m3.capabilities?.inputModalities, ['text', 'image', 'video']);
      assert.deepEqual(preset.wireCapabilities?.codexResponses, {
        baseUrl: openaiBaseUrl,
        modelIds: ['MiniMax-M3', 'MiniMax-M2.7'],
      });
      assert.equal(preset.meta?.docsUrl, docsUrl);
    }
  });
});

describe('toClaudeCodeEnv: env shape after CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST removal', () => {
  // The flag was removed in the cc-switch credential bridge fix — SDK 0.2.62
  // does not implement this variable, so setting it was dead code. These
  // tests pin the current behavior so the flag doesn't get reintroduced
  // accidentally, and verify the core env injection still works correctly.
  it('with provider: cleans ANTHROPIC_* from baseEnv and injects the provider auth', async () => {
    const { toClaudeCodeEnv } = await import('../../lib/provider-resolver');

    const resolvedWithProvider = {
      provider: {
        id: 'test', name: 'Test', preset_key: 'anthropic-official', provider_type: 'anthropic', protocol: 'anthropic',
        base_url: 'https://api.anthropic.com', api_key: 'sk-test',
        is_active: 1, sort_order: 0, extra_env: '{}', headers_json: '{}',
        env_overrides_json: '', role_models_json: '{}', notes: '', options_json: '{}',
        created_at: '', updated_at: '',
      },
      protocol: 'anthropic' as const,
      authStyle: 'api_key' as const,
      model: 'sonnet',
      modelDisplayName: 'Sonnet 4.6',
      upstreamModel: 'sonnet',
      headers: {},
      envOverrides: {},
      roleModels: { default: 'claude-sonnet-4-5' },
      hasCredentials: true,
      availableModels: [],
      settingSources: ['project', 'local'],
    };
    const env = toClaudeCodeEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'stale-key-should-be-removed',
      ANTHROPIC_BASE_URL: 'https://stale-proxy.example.com',
    }, resolvedWithProvider);

    // Dead-code flag must NOT be set
    assert.equal(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, undefined);
    // Provider auth correctly injected
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-test');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
    // Model injection
    assert.equal(env.ANTHROPIC_MODEL, 'claude-sonnet-4-5');
  });

  it('without provider (env mode): preserves baseEnv ANTHROPIC_* for cc-switch compatibility', async () => {
    const { toClaudeCodeEnv } = await import('../../lib/provider-resolver');

    const resolvedWithoutProvider = {
      provider: undefined,
      protocol: 'anthropic' as const,
      authStyle: 'api_key' as const,
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
      PATH: '/usr/bin',
      ANTHROPIC_AUTH_TOKEN: 'cc-switch-token',
      ANTHROPIC_BASE_URL: 'https://proxy.example.com',
    }, resolvedWithoutProvider);

    // Dead-code flag must NOT be set
    assert.equal(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, undefined);
    // Caller's env is preserved so SDK's settingSources:['user'] path can layer settings.json on top
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'cc-switch-token');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://proxy.example.com');
  });
});

describe('getDefaultModelsForProvider — provider-catalog flow', () => {
  it('bedrock with empty baseUrl resolves to BEDROCK_VERTEX_DEFAULT_MODELS (Opus 4.6 alias, no xhigh)', () => {
    const models = getDefaultModelsForProvider('bedrock', '');
    const opus = models.find(m => m.modelId === 'opus');
    assert.ok(opus, 'bedrock catalog should include opus');
    // Bedrock opus alias resolves to 4.6 upstream per official docs —
    // label must not promise 4.7.
    assert.ok(
      !/4\.7/.test(opus.displayName),
      `bedrock opus display should not claim 4.7 (got "${opus.displayName}")`,
    );
    assert.equal(
      opus.upstreamModelId,
      undefined,
      'bedrock opus should stay alias-only (no first-party upstreamModelId leak)',
    );
    const levels = opus.capabilities?.supportedEffortLevels ?? [];
    assert.ok(
      !levels.includes('xhigh'),
      `bedrock opus must not advertise xhigh effort (got [${levels.join(', ')}])`,
    );
  });

  it('vertex with empty baseUrl resolves to BEDROCK_VERTEX_DEFAULT_MODELS (Opus 4.6 alias)', () => {
    const models = getDefaultModelsForProvider('vertex', '');
    const opus = models.find(m => m.modelId === 'opus');
    assert.ok(opus, 'vertex catalog should include opus');
    assert.ok(
      !/4\.7/.test(opus.displayName),
      `vertex opus display should not claim 4.7 (got "${opus.displayName}")`,
    );
    assert.equal(opus.upstreamModelId, undefined);
  });

  it('anthropic protocol (unmatched baseUrl) returns alias-only catalog — no claude-opus-4-7 pin', () => {
    // Third-party proxies fall through to this branch. Pinning first-party
    // upstream here would break OpenRouter/LiteLLM/Ollama compatibility.
    const models = getDefaultModelsForProvider('anthropic', 'https://unknown-proxy.example/v1');
    const opus = models.find(m => m.modelId === 'opus');
    assert.ok(opus);
    assert.equal(
      opus.upstreamModelId,
      undefined,
      'generic anthropic-protocol catalog should not leak first-party upstream ID',
    );
  });

  it('anthropic-official preset returns first-party catalog (opus pinned to claude-opus-4-7)', () => {
    const official = VENDOR_PRESETS.find(p => p.key === 'anthropic-official');
    assert.ok(official, 'anthropic-official preset must exist');
    const opus = official.defaultModels.find(m => m.modelId === 'opus');
    assert.equal(
      opus?.upstreamModelId,
      'claude-opus-4-7',
      'first-party opus must pin upstream to claude-opus-4-7',
    );
    const levels = opus?.capabilities?.supportedEffortLevels ?? [];
    assert.ok(levels.includes('xhigh'), 'first-party opus must advertise xhigh');
  });

  it('legacy anthropic provider (provider_type=anthropic, baseUrl="") resolves to first-party catalog', () => {
    // Migrated Default providers from older settings end up with
    // provider_type='anthropic' and empty base_url. The native runtime
    // treats them as api.anthropic.com; without the providerType hint
    // they'd fall through to the alias-only catalog and bypass Opus 4.7
    // sanitizer / xhigh / 1M window.
    const models = getDefaultModelsForProvider('anthropic', '', 'anthropic');
    const opus = models.find(m => m.modelId === 'opus');
    assert.equal(
      opus?.upstreamModelId,
      'claude-opus-4-7',
      'legacy empty-baseUrl anthropic must pin opus to claude-opus-4-7',
    );
    const levels = opus?.capabilities?.supportedEffortLevels ?? [];
    assert.ok(levels.includes('xhigh'), 'legacy first-party opus must advertise xhigh');
  });

  it('effective protocol: raw anthropic wins over inference', () => {
    assert.equal(
      getEffectiveProviderProtocol('custom', 'anthropic', '', ''),
      'anthropic',
      'non-empty valid raw protocol should be honored as-is',
    );
  });

  it('effective protocol: empty raw protocol falls back to provider_type inference', () => {
    // Legacy migrated rows have provider_type='anthropic' + protocol=''.
    // They must resolve to 'anthropic' so write-path validation and doctor
    // diagnostics treat them the same as an explicit 'anthropic' POST.
    assert.equal(
      getEffectiveProviderProtocol('anthropic', '', '', ''),
      'anthropic',
    );
    assert.equal(
      getEffectiveProviderProtocol('anthropic', undefined, '', ''),
      'anthropic',
    );
  });

  it('effective protocol: bedrock provider_type without raw protocol still classifies as bedrock', () => {
    assert.equal(
      getEffectiveProviderProtocol('bedrock', '', '', ''),
      'bedrock',
    );
  });

  it('effective protocol: unknown raw protocol falls back to inference', () => {
    // A stray / legacy non-Protocol string in raw shouldn't pass through.
    assert.equal(
      getEffectiveProviderProtocol('anthropic', 'random-garbage', '', ''),
      'anthropic',
    );
  });

  it('isValidProtocol: accepts every Protocol union member and rejects garbage', () => {
    // Used by POST/PUT to block invalid protocol strings from ever landing
    // in the DB. If the Protocol union grows, this test will naturally
    // pair with the VALID_PROTOCOLS set update in provider-catalog.ts.
    const members: string[] = [
      'anthropic', 'openai-compatible', 'openrouter',
      'bedrock', 'vertex', 'google', 'gemini-image', 'openai-image',
    ];
    for (const m of members) {
      assert.equal(isValidProtocol(m), true, `'${m}' must be valid`);
    }
    assert.equal(isValidProtocol('random-garbage'), false);
    assert.equal(isValidProtocol(''), false);
    assert.equal(isValidProtocol(undefined), false);
    assert.equal(isValidProtocol(null), false);
    assert.equal(isValidProtocol(123), false);
  });

  it('openai-compatible chat provider at https://api.openai.com/v1 does NOT inherit GPT Image catalog', () => {
    // Regression: adding the openai-image preset made api.openai.com/v1 an
    // exact-match URL for a media preset. Without the protocol guard, any
    // chat provider configured with the same URL (e.g. openai-compatible)
    // would silently fetch the GPT Image model list into the chat model
    // selector.
    const chatModels = getDefaultModelsForProvider(
      'openai-compatible',
      'https://api.openai.com/v1',
    );
    const hasImageModel = chatModels.some(m => /^gpt-image/i.test(m.modelId));
    assert.equal(hasImageModel, false, 'openai-compatible must not inherit GPT Image catalog');

    // And the happy path — the same URL with protocol='openai-image' still
    // resolves to GPT Image models.
    const imageModels = getDefaultModelsForProvider(
      'openai-image',
      'https://api.openai.com/v1',
    );
    assert.ok(
      imageModels.some(m => /^gpt-image/i.test(m.modelId)),
      'openai-image at the canonical URL must still return GPT Image models',
    );
  });

  it('missing providerType with empty baseUrl stays alias-only (no accidental first-party promotion)', () => {
    // When provider_type is unknown or explicitly something else, the
    // empty-baseUrl branch does NOT kick in — prevents, e.g., a third-
    // party custom provider from being mis-labeled as first-party.
    const models = getDefaultModelsForProvider('anthropic', '');
    const opus = models.find(m => m.modelId === 'opus');
    assert.equal(
      opus?.upstreamModelId,
      undefined,
      'anthropic+empty baseUrl without providerType must remain alias-only',
    );
  });
});
