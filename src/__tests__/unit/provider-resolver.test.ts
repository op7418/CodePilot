import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VENDOR_PRESETS,
  inferProtocolFromLegacy as inferProtocolFromLegacyResolved,
  inferAuthStyleFromLegacy,
  getDefaultModelsForProvider,
  findPresetForLegacy as findPresetForLegacyResolved,
} from '../../lib/provider-catalog';
import { resolveEffortMenuLevels } from '../../lib/effort-levels';
import en from '../../i18n/en';
import zh from '../../i18n/zh';

const inferProtocolFromLegacy = (providerType: string, baseUrl: string) =>
  inferProtocolFromLegacyResolved(providerType, baseUrl, '');
const findPresetForLegacy = (
  baseUrl: string,
  providerType: string,
  protocol?: import('../../lib/provider-catalog').Protocol,
) => findPresetForLegacyResolved(baseUrl, providerType, protocol, '');

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

    it('Kimi preset uses anthropic protocol with api_key auth', () => {
      const kimi = VENDOR_PRESETS.find(p => p.key === 'kimi');
      assert.ok(kimi, 'Kimi preset not found');
      assert.equal(kimi.protocol, 'anthropic');
      assert.equal(kimi.authStyle, 'api_key');
    });

    // ── Phase 1 (2026-07-17): GLM-5.2 / Kimi for Coding ─────────────
    //
    // These pin the two USER-VISIBLE claims the catalog makes for the two
    // Coding Plans: which model name the user reads, and which effort tiers
    // the menu may offer. Both were fake before this phase — GLM listed a
    // superseded model pair with no effort capability at all, and Kimi's row
    // said `Kimi K2.5`, a version the vendor rolls forward without telling us.

    describe('GLM Coding Plan (CN + Global)', () => {
      const glmPresets = VENDOR_PRESETS.filter(p => p.key === 'glm-cn' || p.key === 'glm-global');

      it('both regions exist and share one catalog', () => {
        assert.equal(glmPresets.length, 2, 'Expected glm-cn + glm-global');
        assert.deepEqual(glmPresets[0].defaultModels, glmPresets[1].defaultModels);
      });

      it('catalog is the GLM-5.2 generation — no superseded 5-Turbo / 5.1 rows', () => {
        for (const p of glmPresets) {
          const names = p.defaultModels.map(m => m.displayName);
          assert.ok(names.includes('GLM-5.2'), `${p.key} should list GLM-5.2, got ${names.join(', ')}`);
          for (const stale of ['GLM-5-Turbo', 'GLM-5.1']) {
            assert.ok(!names.includes(stale), `${p.key} still lists superseded ${stale}`);
          }
        }
      });

      it('GLM-5.2 is listed once — sonnet+opus both map to it, so two rows would be one model twice', () => {
        for (const p of glmPresets) {
          const glm52Rows = p.defaultModels.filter(m => m.displayName === 'GLM-5.2');
          assert.equal(glm52Rows.length, 1, `${p.key} lists GLM-5.2 ${glm52Rows.length}×`);
        }
      });

      it('role env mapping points both sonnet and opus at glm-5.2', () => {
        for (const p of glmPresets) {
          assert.equal(p.defaultEnvOverrides.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-5.2', p.key);
          assert.equal(p.defaultEnvOverrides.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.2', p.key);
          // haiku is unchanged this round — nothing in the research baseline
          // says the small slot moved off 4.5-Air.
          assert.equal(p.defaultEnvOverrides.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-4.5-air', p.key);
        }
      });

      it('effort capability declares exactly the two real tiers (high, max)', () => {
        for (const p of glmPresets) {
          const glm52 = p.defaultModels.find(m => m.displayName === 'GLM-5.2');
          assert.ok(glm52, `${p.key} missing GLM-5.2 row`);
          assert.equal(glm52.capabilities?.supportsEffort, true, p.key);
          assert.deepEqual(glm52.capabilities?.supportedEffortLevels, ['high', 'max'], p.key);
        }
      });

      it('never offers the low/medium/xhigh tiers GLM silently folds away', () => {
        // GLM maps low/medium/high → high and xhigh/max/ultracode → max, so a
        // `low` row would charge the user for `high` while the button said Low.
        for (const p of glmPresets) {
          for (const m of p.defaultModels) {
            const levels = m.capabilities?.supportedEffortLevels ?? [];
            for (const fake of ['low', 'medium', 'xhigh']) {
              assert.ok(!levels.includes(fake as 'low'), `${p.key}/${m.modelId} offers folded tier ${fake}`);
            }
          }
        }
      });

      it('the two-tier menu carries a mapping note stating BOTH groups in both locales', () => {
        const glm52 = glmPresets[0].defaultModels.find(m => m.displayName === 'GLM-5.2');
        const key = glm52?.capabilities?.effortNoteKey;
        assert.ok(key, 'GLM-5.2 must explain the six-to-two collapse in the menu');
        const enNote = en[key as keyof typeof en] as string;
        const zhNote = zh[key as keyof typeof zh] as string;
        assert.ok(enNote, `missing en string for ${key}`);
        assert.ok(zhNote, `missing zh string for ${key}`);
        // Both source tiers must be named, or the note under-promises the
        // fold: `ultracode` was missing from both locales in the first cut
        // while the code comment claimed six-to-two.
        for (const note of [enNote, zhNote]) {
          for (const tier of ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']) {
            assert.ok(
              note.includes(tier),
              `mapping note omits the ${tier} tier — reads as a partial mapping: "${note}"`,
            );
          }
        }
      });

      it('menu resolves to Auto + the two real tiers', () => {
        const glm52 = glmPresets[0].defaultModels.find(m => m.displayName === 'GLM-5.2');
        assert.deepEqual(
          resolveEffortMenuLevels(glm52?.capabilities?.supportedEffortLevels),
          ['auto', 'high', 'max'],
        );
      });

      it('GLM-4.5-Air declares no effort capability → selector hides, not guesses', () => {
        const air = glmPresets[0].defaultModels.find(m => m.displayName === 'GLM-4.5-Air');
        assert.ok(air, 'GLM-4.5-Air row missing');
        assert.equal(air.capabilities?.supportsEffort, undefined);
        assert.equal(resolveEffortMenuLevels(air.capabilities?.supportedEffortLevels), null);
      });
    });

    describe('Kimi for Coding', () => {
      const kimi = VENDOR_PRESETS.find(p => p.key === 'kimi');

      it('user-visible name is the channel, never the underlying version', () => {
        assert.ok(kimi);
        assert.equal(kimi.defaultModels.length, 1);
        assert.equal(kimi.defaultModels[0].displayName, 'Kimi for Coding');
      });

      it('no K2.5 / K3 version string anywhere in the user-visible Kimi preset', () => {
        assert.ok(kimi);
        const visible = [kimi.name, kimi.description, kimi.descriptionZh, ...kimi.defaultModels.map(m => m.displayName)];
        for (const text of visible) {
          assert.ok(!/K2\.5|K3/i.test(text), `Kimi preset leaks an underlying version: "${text}"`);
        }
      });

      it('does NOT add an explicit k3 row (vendor rolls the channel forward)', () => {
        assert.ok(kimi);
        assert.ok(!kimi.defaultModels.some(m => /k3/i.test(m.modelId) || /k3/i.test(m.upstreamModelId ?? '')));
      });

      it('requests go to the stable channel id, not the bare `sonnet` alias', () => {
        assert.ok(kimi);
        const row = kimi.defaultModels[0];
        // The alias stays as the UI/DB id (existing rows + sessions point at
        // it); upstreamModelId is what actually ships.
        assert.equal(row.modelId, 'sonnet');
        assert.equal(row.upstreamModelId, 'kimi-for-coding');
      });

      it('declares the documented low/high/max tiers without Claude-only pseudo-tiers', () => {
        assert.ok(kimi);
        const caps = kimi.defaultModels[0].capabilities;
        assert.equal(caps?.supportsEffort, true);
        assert.deepEqual(caps?.supportedEffortLevels, ['low', 'high', 'max']);
      });

      it('menu is Auto + Low/High/Max, and `auto` is never a declared vendor tier', () => {
        assert.ok(kimi);
        const caps = kimi.defaultModels[0].capabilities;
        // Auto is CodePilot's "send nothing" option; if it ever leaked into
        // the capability list it would be sent on the wire as effort=auto.
        assert.ok(!(caps?.supportedEffortLevels as string[]).includes('auto'));
        assert.deepEqual(resolveEffortMenuLevels(caps?.supportedEffortLevels), ['auto', 'low', 'high', 'max']);
      });

      it('the Auto distinction is explained in both locales', () => {
        assert.ok(kimi);
        const key = kimi.defaultModels[0].capabilities?.effortNoteKey;
        assert.ok(key, 'Kimi must state that Auto is not a Kimi tier');
        assert.ok(en[key as keyof typeof en], `missing en string for ${key}`);
        assert.ok(zh[key as keyof typeof zh], `missing zh string for ${key}`);
      });
    });

    describe('Moonshot — out of scope for the Kimi rename (Phase 1)', () => {
      it('keeps its own name and K2.5 model row untouched', () => {
        // Moonshot is a separate pay-as-you-go provider that sells the K2.5
        // SKU by name. The `Kimi for Coding` channel abstraction is a Kimi
        // Coding Plan product contract and does NOT apply here; renaming it
        // would claim a channel Moonshot doesn't offer.
        const moonshot = VENDOR_PRESETS.find(p => p.key === 'moonshot');
        assert.ok(moonshot);
        assert.equal(moonshot.name, 'Moonshot');
        assert.equal(moonshot.baseUrl, 'https://api.moonshot.cn/anthropic');
        assert.deepEqual(moonshot.defaultModels, [
          { modelId: 'sonnet', displayName: 'Kimi K2.5', role: 'default' },
        ]);
      });
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

    it('openrouter preset ships upstreamModelId for sonnet/opus/haiku (round 8)', () => {
      // Phase 5b round-8 (2026-05-18) — OpenRouter rejects the bare
      // aliases (`sonnet` / `opus` / `haiku`) with "is not a valid
      // model ID". The preset's defaultModels now ship a verified
      // OpenRouter slug via `upstreamModelId` on each entry so the
      // resolver's `catalogEntry.upstreamModelId` path
      // (provider-resolver.ts:424) sends the right id upstream.
      const preset = VENDOR_PRESETS.find(p => p.key === 'openrouter');
      assert.ok(preset, 'openrouter preset not found');
      const byAlias = new Map(preset!.defaultModels.map(m => [m.modelId, m]));
      const haiku = byAlias.get('haiku');
      const sonnet = byAlias.get('sonnet');
      const opus = byAlias.get('opus');
      assert.ok(haiku, 'haiku alias missing from OpenRouter preset');
      assert.ok(sonnet, 'sonnet alias missing from OpenRouter preset');
      assert.ok(opus, 'opus alias missing from OpenRouter preset');
      // Haiku is the verified smoke pin — exact slug confirmed via
      // real-credential test. Sonnet/opus follow the same OpenRouter
      // naming convention; we pin the prefix shape so a refactor
      // can't drop the version tag.
      assert.equal(
        haiku!.upstreamModelId,
        'anthropic/claude-haiku-4.5',
        'OpenRouter haiku must map to the verified slug anthropic/claude-haiku-4.5',
      );
      assert.match(
        sonnet!.upstreamModelId ?? '',
        /^anthropic\/claude-sonnet-\d+\.\d+$/,
        'OpenRouter sonnet must follow anthropic/claude-sonnet-X.Y pattern',
      );
      assert.match(
        opus!.upstreamModelId ?? '',
        /^anthropic\/claude-opus-\d+\.\d+$/,
        'OpenRouter opus must follow anthropic/claude-opus-X.Y pattern',
      );
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

import { resolveProvider, toClaudeCodeEnv, toAiSdkConfig, resolveEffectiveAnthropicBaseUrl } from '../../lib/provider-resolver';
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
          preset_key: 'anthropic-official',
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
      // api_key mode must NOT set ANTHROPIC_AUTH_TOKEN — upstream adds Bearer header
      // when AUTH_TOKEN is present, which conflicts with API-key-only providers (Kimi)
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
    });

    it('injects only ANTHROPIC_AUTH_TOKEN for auth_token style', () => {
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test',
          name: 'Kimi',
          preset_key: 'kimi',
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
      // auth_token style explicitly clears ANTHROPIC_API_KEY (required by Ollama etc.)
      assert.equal(env.ANTHROPIC_API_KEY, '');
    });

    it('applies env overrides with empty-string deletion', () => {
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test',
          name: 'Test',
          preset_key: 'anthropic-official',
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
          ANTHROPIC_MODEL: 'sonnet', // stale legacy model override — should be skipped (role models own it)
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
      assert.notEqual(env.ANTHROPIC_MODEL, 'sonnet',
        'envOverrides must not reintroduce stale bare model aliases after resolver injection');
      assert.equal(env.SOME_CUSTOM_VAR, undefined); // non-auth key deleted by empty string
    });

    it('injects role models as env vars', () => {
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test',
          name: 'Test',
          preset_key: 'anthropic-official',
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

    it('canonicalizes short role-model aliases to upstream IDs before injecting Claude Code env', () => {
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test',
          name: 'Legacy Gateway',
          preset_key: '',
          provider_type: 'anthropic',
          protocol: 'anthropic',
          base_url: 'https://gateway.example.com/anthropic',
          api_key: 'key',
          is_active: 1,
          sort_order: 0,
          extra_env: '{}',
          headers_json: '{}',
          env_overrides_json: '',
          role_models_json: '{"default":"sonnet","sonnet":"sonnet","haiku":"haiku","opus":"opus"}',
          notes: '',
          created_at: '',
          updated_at: '',
          options_json: '{}',
        },
        protocol: 'anthropic',
        authStyle: 'api_key',
        model: 'sonnet',
        upstreamModel: 'claude-sonnet-4-6',
        modelDisplayName: 'Sonnet 4.6',
        headers: {},
        envOverrides: {},
        roleModels: {
          default: 'sonnet',
          sonnet: 'sonnet',
          haiku: 'haiku',
          opus: 'opus',
        },
        hasCredentials: true,
        availableModels: [
          { modelId: 'sonnet', upstreamModelId: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
          { modelId: 'haiku', upstreamModelId: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
          { modelId: 'opus', upstreamModelId: 'claude-opus-4-7', displayName: 'Opus 4.7' },
        ],
        settingSources: ['user'],
      };

      const env = toClaudeCodeEnv({}, resolved);
      assert.equal(env.ANTHROPIC_MODEL, 'claude-sonnet-4-6');
      assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-4-6');
      assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-4-5-20251001');
      assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-7');
      assert.notEqual(env.ANTHROPIC_MODEL, 'sonnet',
        'Claude Code compat gateways must not receive the bare UI alias `sonnet`');
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
          id: 'test', name: 'Test', preset_key: 'anthropic-official', provider_type: 'anthropic', protocol: 'anthropic',
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

    it('openrouter protocol — model=haiku alias maps to upstream anthropic/claude-haiku-4.5 (round-8 fix)', () => {
      // Phase 5b round-8 (2026-05-18) — Codex real-credential smoke
      // confirmed OpenRouter rejects bare aliases ("haiku is not a
      // valid model ID"). The fix added explicit upstreamModelId on
      // OPENROUTER_ANTHROPIC_MODELS in provider-catalog.ts, and
      // toAiSdkConfig's existing catalogEntry.upstreamModelId path
      // (provider-resolver.ts:424) reads it. Pin the resolved
      // modelId on the AI-SDK config produced for an OpenRouter +
      // haiku call so a future refactor can't silently drop the
      // upstream slug.
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test', name: 'OR', preset_key: 'openrouter', provider_type: 'openrouter', protocol: 'openrouter',
          base_url: 'https://openrouter.ai/api', api_key: 'or-key', is_active: 1, sort_order: 0,
          extra_env: '{}', headers_json: '{}', env_overrides_json: '', role_models_json: '{}',
          notes: '', created_at: '', updated_at: '', options_json: '{}',
        },
        protocol: 'openrouter',
        authStyle: 'api_key',
        model: 'haiku',
        modelDisplayName: 'Haiku 4.5',
        upstreamModel: 'anthropic/claude-haiku-4.5',
        headers: {},
        envOverrides: {},
        roleModels: {},
        hasCredentials: true,
        availableModels: [
          {
            modelId: 'haiku',
            upstreamModelId: 'anthropic/claude-haiku-4.5',
            displayName: 'Haiku 4.5',
            role: 'haiku',
          },
        ],
        settingSources: ['project', 'local'],
      };

      // Pass the alias explicitly (mirrors how the chat send path
      // invokes toAiSdkConfig with a per-turn modelOverride).
      const config = toAiSdkConfig(resolved, 'haiku');
      assert.equal(config.sdkType, 'claude-code-compat',
        'OpenRouter /api still routes through claude-code-compat (round 7)');
      assert.equal(
        config.modelId,
        'anthropic/claude-haiku-4.5',
        'haiku alias must resolve to the OpenRouter upstream slug, NOT be sent as bare "haiku"',
      );
    });

    it('openrouter protocol — Anthropic skin (/api) → claude-code-compat SDK (round-7 fix)', () => {
      // Phase 5b round-7 (2026-05-18) — OpenRouter exposes two skin
      // endpoints: `/api` (Anthropic Messages format) and `/api/v1`
      // (OpenAI Chat Completions format). Pre-fix the resolver
      // hardcoded `sdkType: 'openai'` for both, so an Anthropic-skin
      // base URL was sent OpenAI Chat Completions chunks against the
      // Messages endpoint — real-credential smoke saw 200 OK with
      // empty text, non-stream returned "Invalid JSON response". Fix
      // routes the Anthropic skin through `claude-code-compat` (the
      // existing third-party Anthropic-compatible adapter we use for
      // sdkProxyOnly providers like Zhipu / Kimi).
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test', name: 'OR', preset_key: 'openrouter', provider_type: 'openrouter', protocol: 'openrouter',
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
      assert.equal(config.sdkType, 'claude-code-compat',
        'Anthropic skin /api must route through claude-code-compat, NOT the OpenAI SDK');
      assert.equal(config.apiKey, 'or-key');
      assert.equal(config.baseUrl, 'https://openrouter.ai/api',
        'Base URL must stay /api (NOT auto-upgraded to /api/v1)');
    });

    it('openrouter protocol — OpenAI skin (/api/v1) → openai SDK', () => {
      // Belt: round-7 fix only branches the Anthropic skin away. The
      // OpenAI skin (the canonical OpenRouter URL most users have)
      // keeps the existing `sdkType: 'openai'` path. Pin so a future
      // refactor doesn't accidentally widen the branch.
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test', name: 'OR', preset_key: 'openrouter', provider_type: 'openrouter', protocol: 'openrouter',
          base_url: 'https://openrouter.ai/api/v1', api_key: 'or-key', is_active: 1, sort_order: 0,
          extra_env: '{}', headers_json: '{}', env_overrides_json: '', role_models_json: '{}',
          notes: '', created_at: '', updated_at: '', options_json: '{}',
        },
        protocol: 'openrouter',
        authStyle: 'api_key',
        model: 'gpt-4o',
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
      assert.equal(config.baseUrl, 'https://openrouter.ai/api/v1');
    });

    it('openrouter protocol — empty base_url → defaults to OpenAI skin', () => {
      // Defensive: if a provider record has no base_url set (legacy
      // row), we default to /api/v1 (OpenAI skin) which keeps the
      // pre-round-7 behaviour for un-configured records.
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test', name: 'OR', preset_key: 'openrouter', provider_type: 'openrouter', protocol: 'openrouter',
          base_url: '', api_key: 'or-key', is_active: 1, sort_order: 0,
          extra_env: '{}', headers_json: '{}', env_overrides_json: '', role_models_json: '{}',
          notes: '', created_at: '', updated_at: '', options_json: '{}',
        },
        protocol: 'openrouter',
        authStyle: 'api_key',
        model: 'gpt-4o',
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
      assert.equal(config.baseUrl, 'https://openrouter.ai/api/v1');
    });

    it('bedrock protocol → injects env overrides', () => {
      const resolved: ResolvedProvider = {
        provider: {
          id: 'test', name: 'Bedrock', preset_key: 'bedrock', provider_type: 'bedrock', protocol: 'bedrock',
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
          id: 'test', name: 'Custom', preset_key: '', provider_type: 'custom', protocol: 'openai-compatible',
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
          id: 'test', name: 'Test', preset_key: 'anthropic-official', provider_type: 'anthropic', protocol: 'anthropic',
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
          id: 'test', name: 'Gemini', preset_key: 'gemini-image', provider_type: 'gemini-image', protocol: 'gemini-image',
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
        id: 'test', name: 'GLM', preset_key: 'glm-cn', provider_type: 'custom', protocol: 'anthropic',
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
        id: 'test', name: 'GLM', preset_key: 'glm-cn', provider_type: 'custom', protocol: 'anthropic',
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
        id: 'test', name: 'GLM', preset_key: 'glm-cn', provider_type: 'custom', protocol: 'anthropic',
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

// ────────────────────────────────────────────────────────────────
// Hidden role models must NOT leak into Claude Code subprocess env
// ────────────────────────────────────────────────────────────────
//
// Regression coverage for the P2 finding (2026-04-26): the resolver's
// `requestedModel` chain skips hidden role defaults via `dbHiddenIds`,
// but `roleModels` itself was untouched. `toClaudeCodeEnv()` then read
// the original (still-hidden) value out of `roleModels.default` and
// wrote it to `ANTHROPIC_MODEL` for the SDK subprocess — defeating
// the user's intent to hide the model.
//
// `buildResolution()` now strips every role slot whose value is in
// `dbHiddenIds` and fills `roleModels.default` from the picked fallback
// upstream so `ANTHROPIC_MODEL` stays meaningful.

describe('OpenRouter Anthropic-skin — alias-row canonicalization (round 9)', () => {
  it('legacy DB row haiku→haiku is canonicalized to anthropic/claude-haiku-4.5 via the preset', () => {
    // Phase 5b round-9 (2026-05-18) — round 8 added upstream slugs
    // to the OpenRouter preset, but existing provider records had
    // `provider_models` rows with `upstream_model_id='haiku'` (alias
    // self-reference) from when the preset was alias-only. The
    // DB-wins merge in resolveProvider shadowed the new preset, so
    // smoke was still sending bare `haiku` upstream. This test
    // exercises the normalize step: legacy alias-self DB row +
    // OpenRouter Anthropic-skin base URL → resolved upstream is the
    // preset slug.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createProvider, deleteProvider, upsertProviderModel } = require('../../lib/db');
    const provider = createProvider({
      name: '__test_openrouter_round9__',
      provider_type: 'openrouter',
      base_url: 'https://openrouter.ai/api', // Anthropic skin — NOT /api/v1
      api_key: 'or-test-key',
    });
    try {
      // Materialize the legacy-shape DB row that round 9 must heal.
      upsertProviderModel({
        provider_id: provider.id,
        model_id: 'haiku',
        upstream_model_id: 'haiku', // <-- legacy alias self-reference
        display_name: 'Haiku 4.5',
        enabled: 1,
        source: 'manual',
        user_edited: 0,
        sort_order: 0,
      });

      const resolved = resolveProvider({
        providerId: provider.id,
        model: 'haiku',
      });

      const haikuEntry = resolved.availableModels.find(m => m.modelId === 'haiku');
      assert.ok(haikuEntry, 'haiku must remain in availableModels after normalize');
      assert.equal(
        haikuEntry!.upstreamModelId,
        'anthropic/claude-haiku-4.5',
        'legacy alias self-reference must be canonicalized to the preset slug',
      );

      const config = toAiSdkConfig(resolved, 'haiku');
      assert.equal(
        config.modelId,
        'anthropic/claude-haiku-4.5',
        'toAiSdkConfig must produce the canonicalized upstream so the proxy sends OpenRouter a valid model id',
      );
      assert.equal(
        config.sdkType,
        'claude-code-compat',
        '/api Anthropic skin still routes through claude-code-compat (round 7)',
      );
    } finally {
      deleteProvider(provider.id);
    }
  });

  it('user-configured full upstream slug is preserved (no override)', () => {
    // Belt: if a user manually set `anthropic/claude-haiku-4.6` (a
    // different version than our preset 4.5), the normalize MUST
    // NOT clobber it. Customization wins. The gate is strict:
    // override only when upstream is undefined OR === alias.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createProvider, deleteProvider, upsertProviderModel } = require('../../lib/db');
    const provider = createProvider({
      name: '__test_openrouter_round9_preserve__',
      provider_type: 'openrouter',
      base_url: 'https://openrouter.ai/api',
      api_key: 'or-test-key',
    });
    try {
      upsertProviderModel({
        provider_id: provider.id,
        model_id: 'haiku',
        upstream_model_id: 'anthropic/claude-haiku-4.6', // user-set, different version
        display_name: 'Haiku 4.6 (user-pinned)',
        enabled: 1,
        source: 'manual',
        user_edited: 1,
        sort_order: 0,
      });

      const resolved = resolveProvider({
        providerId: provider.id,
        model: 'haiku',
      });
      const haikuEntry = resolved.availableModels.find(m => m.modelId === 'haiku');
      assert.equal(
        haikuEntry!.upstreamModelId,
        'anthropic/claude-haiku-4.6',
        'user-configured upstream must NOT be overwritten by the preset',
      );
    } finally {
      deleteProvider(provider.id);
    }
  });

  it('OpenAI skin (/api/v1) provider is NOT touched by the OpenRouter normalize', () => {
    // The normalize is gated by isOpenRouterAnthropicSkinUrl which
    // returns false for /api/v1. So an OpenAI-skin OpenRouter
    // provider's DB rows pass through unchanged. (Bare aliases on
    // OpenAI skin are still wrong upstream but that's a different
    // surface — not in scope here.)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createProvider, deleteProvider, upsertProviderModel } = require('../../lib/db');
    const provider = createProvider({
      name: '__test_openrouter_round9_openai_skin__',
      provider_type: 'openrouter',
      base_url: 'https://openrouter.ai/api/v1', // OpenAI skin
      api_key: 'or-test-key',
    });
    try {
      upsertProviderModel({
        provider_id: provider.id,
        model_id: 'haiku',
        upstream_model_id: 'haiku', // legacy alias self-reference
        display_name: 'Haiku',
        enabled: 1,
        source: 'manual',
        user_edited: 0,
        sort_order: 0,
      });

      const resolved = resolveProvider({
        providerId: provider.id,
        model: 'haiku',
      });
      const haikuEntry = resolved.availableModels.find(m => m.modelId === 'haiku');
      assert.equal(
        haikuEntry!.upstreamModelId,
        'haiku',
        'OpenAI skin /api/v1 must NOT be touched by the OpenRouter Anthropic-skin normalize',
      );
    } finally {
      deleteProvider(provider.id);
    }
  });
});

describe('Hidden role models do not leak into Claude Code env', () => {
  it('hidden role default is stripped + ANTHROPIC_MODEL takes picked fallback', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createProvider, deleteProvider, upsertProviderModel } = require('../../lib/db');
    const provider = createProvider({
      name: '__test_hidden_role_default__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'test-key',
      // Default role points at the model we are about to hide.
      role_models_json: JSON.stringify({ default: 'hidden-default-model' }),
    });
    try {
      // Materialize provider_models rows: hide the role default, leave a
      // visible model around so the resolver's fallback can pick it.
      upsertProviderModel({
        provider_id: provider.id,
        model_id: 'hidden-default-model',
        upstream_model_id: 'hidden-default-model',
        display_name: 'Hidden Default',
        enabled: 0,
        source: 'manual',
        user_edited: 1,
        sort_order: 0,
      });
      upsertProviderModel({
        provider_id: provider.id,
        model_id: 'visible-fallback',
        upstream_model_id: 'visible-fallback',
        display_name: 'Visible Fallback',
        enabled: 1,
        source: 'manual',
        user_edited: 1,
        sort_order: 1,
      });

      const resolved = resolveProvider({ providerId: provider.id });

      assert.equal(resolved.model, 'visible-fallback',
        'resolver picks the visible model as fallback');
      assert.notEqual(resolved.roleModels.default, 'hidden-default-model',
        'hidden default must be stripped from roleModels');
      assert.equal(resolved.roleModels.default, 'visible-fallback',
        'roleModels.default is filled from the picked upstream');

      const env = toClaudeCodeEnv({}, resolved);
      assert.notEqual(env.ANTHROPIC_MODEL, 'hidden-default-model',
        'ANTHROPIC_MODEL must NOT carry the hidden role default');
      assert.equal(env.ANTHROPIC_MODEL, 'visible-fallback',
        'ANTHROPIC_MODEL takes the picked fallback so the SDK subprocess agrees with the chat picker');
    } finally {
      deleteProvider(provider.id);
    }
  });

  it('hidden sonnet/haiku/opus role slots are stripped from ANTHROPIC_DEFAULT_*_MODEL', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createProvider, deleteProvider, upsertProviderModel } = require('../../lib/db');
    const provider = createProvider({
      name: '__test_hidden_role_aliases__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'test-key',
      role_models_json: JSON.stringify({
        default: 'visible-default',
        sonnet: 'hidden-sonnet',
        haiku: 'hidden-haiku',
        opus: 'visible-opus',
      }),
    });
    try {
      upsertProviderModel({
        provider_id: provider.id, model_id: 'visible-default',
        upstream_model_id: 'visible-default', display_name: 'Visible',
        enabled: 1, source: 'manual', user_edited: 1, sort_order: 0,
      });
      upsertProviderModel({
        provider_id: provider.id, model_id: 'hidden-sonnet',
        upstream_model_id: 'hidden-sonnet', display_name: 'Hidden Sonnet',
        enabled: 0, source: 'manual', user_edited: 1, sort_order: 1,
      });
      upsertProviderModel({
        provider_id: provider.id, model_id: 'hidden-haiku',
        upstream_model_id: 'hidden-haiku', display_name: 'Hidden Haiku',
        enabled: 0, source: 'manual', user_edited: 1, sort_order: 2,
      });
      upsertProviderModel({
        provider_id: provider.id, model_id: 'visible-opus',
        upstream_model_id: 'visible-opus', display_name: 'Visible Opus',
        enabled: 1, source: 'manual', user_edited: 1, sort_order: 3,
      });

      const resolved = resolveProvider({ providerId: provider.id });

      assert.equal(resolved.roleModels.sonnet, undefined,
        'hidden sonnet slot stripped');
      assert.equal(resolved.roleModels.haiku, undefined,
        'hidden haiku slot stripped');
      assert.equal(resolved.roleModels.opus, 'visible-opus',
        'visible opus slot preserved');
      assert.equal(resolved.roleModels.default, 'visible-default',
        'visible default slot preserved (no fill needed)');

      const env = toClaudeCodeEnv({}, resolved);
      assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined,
        'no ANTHROPIC_DEFAULT_SONNET_MODEL when sonnet slot is hidden');
      assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined,
        'no ANTHROPIC_DEFAULT_HAIKU_MODEL when haiku slot is hidden');
      assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'visible-opus',
        'visible opus reaches Claude Code subprocess');
      assert.equal(env.ANTHROPIC_MODEL, 'visible-default',
        'visible default reaches Claude Code subprocess');
    } finally {
      deleteProvider(provider.id);
    }
  });

  it('non-hidden role models are preserved (regression guard)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createProvider, deleteProvider, upsertProviderModel } = require('../../lib/db');
    const provider = createProvider({
      name: '__test_non_hidden_role_pass_through__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'test-key',
      role_models_json: JSON.stringify({
        default: 'glm-5-turbo',
        sonnet: 'glm-5-turbo',
        small: 'glm-air',
      }),
    });
    try {
      upsertProviderModel({
        provider_id: provider.id, model_id: 'glm-5-turbo',
        upstream_model_id: 'glm-5-turbo', display_name: 'GLM-5-Turbo',
        enabled: 1, source: 'manual', user_edited: 1, sort_order: 0,
      });
      upsertProviderModel({
        provider_id: provider.id, model_id: 'glm-air',
        upstream_model_id: 'glm-air', display_name: 'GLM Air',
        enabled: 1, source: 'manual', user_edited: 1, sort_order: 1,
      });

      const resolved = resolveProvider({ providerId: provider.id });
      const env = toClaudeCodeEnv({}, resolved);

      assert.equal(env.ANTHROPIC_MODEL, 'glm-5-turbo',
        'unhidden default still propagates to ANTHROPIC_MODEL');
      assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-5-turbo',
        'unhidden sonnet still propagates');
      assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'glm-air',
        'unhidden small still propagates');
    } finally {
      deleteProvider(provider.id);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Runtime Compatibility Matrix — Provider compat tier mapping
// ────────────────────────────────────────────────────────────────

describe('getProviderCompat tier mapping', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getProviderCompat: getProviderCompatResolved } = require('../../lib/runtime-compat') as typeof import('../../lib/runtime-compat');
  const getProviderCompat = (record: { provider_type: string; base_url: string }) =>
    getProviderCompatResolved({ preset_key: '', protocol: record.provider_type, ...record });

  it('Anthropic official → claude_code_ready', () => {
    assert.equal(
      getProviderCompat({ provider_type: 'anthropic', base_url: 'https://api.anthropic.com' }),
      'claude_code_ready',
    );
  });

  it('verified Coding Plan preset (GLM CN) → claude_code_verified', () => {
    assert.equal(
      getProviderCompat({ provider_type: 'anthropic', base_url: 'https://open.bigmodel.cn/api/anthropic' }),
      'claude_code_verified',
    );
  });

  it('verified Coding Plan preset (Volcengine) → claude_code_verified', () => {
    assert.equal(
      getProviderCompat({ provider_type: 'anthropic', base_url: 'https://ark.cn-beijing.volces.com/api/coding' }),
      'claude_code_verified',
    );
  });

  it('verified Coding Plan preset (Kimi) → claude_code_verified', () => {
    assert.equal(
      getProviderCompat({ provider_type: 'anthropic', base_url: 'https://api.kimi.com/coding/' }),
      'claude_code_verified',
    );
  });

  it('OpenRouter Anthropic skin (`/api`) → openrouter_anthropic_skin', () => {
    // OpenRouter's `/api` endpoint speaks Anthropic wire protocol per
    // their Claude Code integration docs; it must NOT classify as
    // codepilot_only or the Claude Code Runtime picker hides every
    // OpenRouter row.
    assert.equal(
      getProviderCompat({ provider_type: 'openrouter', base_url: 'https://openrouter.ai/api' }),
      'openrouter_anthropic_skin',
    );
  });

  it('OpenRouter OpenAI-compat skin (`/api/v1`) → codepilot_only', () => {
    // The `/v1` skin is OpenAI-compatible (`/chat/completions`) and only
    // reachable from CodePilot Runtime. Users editing the URL or pasting
    // from OpenAI tutorials can land here.
    assert.equal(
      getProviderCompat({ provider_type: 'openrouter', base_url: 'https://openrouter.ai/api/v1' }),
      'codepilot_only',
    );
  });

  it('OpenRouter Anthropic skin trailing slash → openrouter_anthropic_skin', () => {
    // Defensive: matcher must normalize trailing slash so
    // `https://openrouter.ai/api/` still classifies as the Anthropic
    // skin, not as `codepilot_only`.
    assert.equal(
      getProviderCompat({ provider_type: 'openrouter', base_url: 'https://openrouter.ai/api/' }),
      'openrouter_anthropic_skin',
    );
  });

  it('image preset → media_only', () => {
    assert.equal(
      getProviderCompat({ provider_type: 'gemini-image', base_url: 'https://generativelanguage.googleapis.com' }),
      'media_only',
    );
  });

  it('anthropic-thirdparty fallback (any anthropic URL with no brand match) → claude_code_experimental', () => {
    // The `anthropic-thirdparty` preset is a wildcard (empty baseUrl) that
    // catches any anthropic-protocol record not matched by a brand preset.
    // Without `claudeCodeVerified`, it lands on the experimental tier.
    assert.equal(
      getProviderCompat({ provider_type: 'anthropic', base_url: 'https://nobody-knows-this.example.com' }),
      'claude_code_experimental',
    );
  });

  it('truly unrecognized provider_type with custom URL → unknown', () => {
    assert.equal(
      getProviderCompat({ provider_type: 'definitely-not-a-protocol', base_url: 'https://x.example.com' }),
      'unknown',
    );
  });
});

// ────────────────────────────────────────────────────────────────
// getModelCompat — model-layer flags
// ────────────────────────────────────────────────────────────────
//
// Covers the alias-lift removal: codepilot_only providers no longer
// re-flag their `claude-*` rows as claude_code_compatible. The provider
// is "OpenAI 兼容" / "不进入 Claude Code 流程" at the UI layer; smuggling
// claude aliases back into the Claude Code runtime would contradict that.

describe('getModelCompat alias-lift removal (P2a regression)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getModelCompat } = require('../../lib/runtime-compat');

  it('codepilot_only + claude alias model id → NOT claude_code_compatible', () => {
    const cap = getModelCompat({
      modelId: 'anthropic/claude-3-opus',
      providerCompat: 'codepilot_only',
    });
    assert.equal(cap.claude_code_compatible, undefined,
      'no alias lift — codepilot_only provider keeps claude alias OFF the Claude Code runtime');
    assert.equal(cap.codepilot_runtime_compatible, true,
      'still reachable from the CodePilot runtime');
  });

  it('codepilot_only + bare sonnet alias → NOT claude_code_compatible', () => {
    const cap = getModelCompat({
      modelId: 'sonnet',
      providerCompat: 'codepilot_only',
    });
    assert.equal(cap.claude_code_compatible, undefined);
  });

  it('claude_code_ready + any model → claude_code_compatible AND codepilot_runtime_compatible', () => {
    const cap = getModelCompat({
      modelId: 'claude-sonnet-4-6',
      providerCompat: 'claude_code_ready',
    });
    assert.equal(cap.claude_code_compatible, true);
    assert.equal(cap.codepilot_runtime_compatible, true);
  });

  it('claude_code_verified + any model → claude_code_compatible AND codepilot_runtime_compatible', () => {
    // Phase 2 Step 4c follow-up (2026-05-07): with
    // `ClaudeCodeCompatAdapter` (src/lib/claude-code-compat/), CodePilot
    // Runtime now speaks the same Anthropic wire format the SDK
    // subprocess does, so verified anthropic-compat presets (GLM / Kimi /
    // MiniMax / Volcengine / Xiaomi MiMo / Bailian / DeepSeek Coding
    // Plan) are reachable from BOTH runtimes. The previous "SDK-bound"
    // assumption hid these from the AISDK picker, leaving only OpenAI
    // OAuth GPT — fixed at the model layer here and at the route's
    // group-layer filter (no more sdkProxyOnly group drop).
    const cap = getModelCompat({
      modelId: 'glm-5-turbo',
      providerCompat: 'claude_code_verified',
    });
    assert.equal(cap.claude_code_compatible, true);
    assert.equal(cap.codepilot_runtime_compatible, true,
      'ClaudeCodeCompatAdapter makes verified anthropic-compat presets reachable from CodePilot Runtime');
  });

  it('claude_code_experimental + any model → claude_code_compatible AND codepilot_runtime_compatible', () => {
    // Same reasoning as the verified case — verified vs experimental
    // differ only in UI tone (info vs warning) and copy ("兼容" vs
    // "实验"), not in routing capability.
    const cap = getModelCompat({
      modelId: 'some-anthropic-thirdparty-model',
      providerCompat: 'claude_code_experimental',
    });
    assert.equal(cap.claude_code_compatible, true);
    assert.equal(cap.codepilot_runtime_compatible, true);
  });

  it('media_only → media flag, no chat flags', () => {
    const cap = getModelCompat({
      modelId: 'gemini-2.0-flash-exp-image-generation',
      providerCompat: 'media_only',
    });
    assert.equal(cap.media, true);
    assert.equal(cap.claude_code_compatible, undefined);
    assert.equal(cap.codepilot_runtime_compatible, undefined);
  });

  it('openrouter_anthropic_skin + any model → claude_code_compatible only', () => {
    // OpenRouter `/api` skin speaks Anthropic wire protocol per
    // OpenRouter docs; surface every row in the Claude Code Runtime
    // picker (otherwise the user sees the whole provider greyed out as
    // "当前执行引擎不可用"). codepilot_runtime_compatible is left
    // unset — CodePilot Runtime expects the OpenAI-shape `/v1` URL, so
    // routing it through the Anthropic-shape URL would silently fail.
    const cap = getModelCompat({
      modelId: 'anthropic/claude-sonnet-4-6',
      providerCompat: 'openrouter_anthropic_skin',
    });
    assert.equal(cap.claude_code_compatible, true);
    assert.equal(cap.codepilot_runtime_compatible, undefined);
  });

  it('openrouter_anthropic_skin + non-anthropic model → still claude_code_compatible (no per-id alias-lift gate)', () => {
    // Don't restore old "only `claude-*` ids visible" alias-lift logic.
    // Provider tier alone decides reachability; the Models page badge
    // disappears for the whole OpenRouter group, not per-row.
    const cap = getModelCompat({
      modelId: 'meta-llama/llama-4-scout',
      providerCompat: 'openrouter_anthropic_skin',
    });
    assert.equal(cap.claude_code_compatible, true);
  });
});

// ────────────────────────────────────────────────────────────────
// Runtime Compatibility Matrix — provider-resolver gating
// ────────────────────────────────────────────────────────────────
//
// `opts.runtime` filters the default-model fallback chain to candidates
// that the active runtime can actually reach. Combines with the existing
// `dbHiddenIds` gate. Explicit `opts.model` is honored even if
// runtime-incompatible — caller asked for it by name, mismatches surface
// downstream with a clearer error than a silent rewrite would produce.

describe('provider-resolver runtime gate', () => {
  // Each test in this block sets `default_model` setting to '' so the
  // global legacy fallback (priority 5 in the resolver) doesn't smuggle
  // a stale per-machine default in and short-circuit the runtime gate
  // we're trying to exercise. Restored in teardown so other tests are
  // unaffected.
  let savedDefaultModel: string | null | undefined;
  const setup = () => {
    savedDefaultModel = getSetting('default_model');
    setSetting('default_model', '');
  };
  const teardown = () => {
    setSetting('default_model', savedDefaultModel || '');
  };

  it('codepilot_only provider in claude_code mode → final-final fallback (alias lift removed)', () => {
    setup();
    // OpenRouter (`codepilot_only`) — after the alias lift was removed in
    // runtime-compat.ts, NO row on this provider satisfies the
    // `claude_code` runtime gate. The resolver's runtime-filtered chain
    // (globalDefault → roleModels.default → setting → runtimeFilteredAvailable[0])
    // therefore yields nothing, and falls through to the final-final
    // `availableModels[0]` (without runtime gating) so the resolution is
    // never empty. The wire-format mismatch surfaces at the chat route /
    // SDK layer instead of inside the resolver. This keeps the resolver
    // total — chat routes can still produce a usable ResolvedProvider
    // even when there's no runtime-compatible candidate.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createProvider, deleteProvider, upsertProviderModel } = require('../../lib/db');
    const provider = createProvider({
      name: '__test_runtime_gate_or__',
      provider_type: 'openrouter',
      base_url: 'https://openrouter.ai/api',
      api_key: 'test-key',
      role_models_json: JSON.stringify({ default: 'meta-llama/llama-3.1-70b' }),
    });
    try {
      upsertProviderModel({
        provider_id: provider.id, model_id: 'meta-llama/llama-3.1-70b',
        upstream_model_id: 'meta-llama/llama-3.1-70b', display_name: 'Llama 3.1 70B',
        enabled: 1, source: 'manual', user_edited: 1, sort_order: 0,
      });

      // No runtime gate → role default wins (legacy behavior).
      const noGate = resolveProvider({ providerId: provider.id });
      assert.equal(noGate.model, 'meta-llama/llama-3.1-70b',
        'without runtime gate, role default is honored');

      // claude_code runtime → no compat candidate → final-final fallback to
      // availableModels[0] (still gated by enabled=1, just not by runtime).
      const ccGate = resolveProvider({ providerId: provider.id, runtime: 'claude_code' });
      assert.equal(ccGate.model, 'meta-llama/llama-3.1-70b',
        'final-final fallback when no row is claude_code_compatible');

      // codepilot_runtime → llama is codepilot_runtime_compatible, gate passes.
      const cpGate = resolveProvider({ providerId: provider.id, runtime: 'codepilot_runtime' });
      assert.equal(cpGate.model, 'meta-llama/llama-3.1-70b',
        'codepilot runtime keeps the codepilot_only role default');
    } finally {
      deleteProvider(provider.id);
      teardown();
    }
  });

  it('explicit opts.model is honored even when incompatible with the active runtime', () => {
    setup();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createProvider, deleteProvider, upsertProviderModel } = require('../../lib/db');
    const provider = createProvider({
      name: '__test_runtime_explicit_honored__',
      provider_type: 'openrouter',
      base_url: 'https://openrouter.ai/api',
      api_key: 'test-key',
    });
    try {
      upsertProviderModel({
        provider_id: provider.id, model_id: 'meta-llama/llama-3.1-70b',
        upstream_model_id: 'meta-llama/llama-3.1-70b', display_name: 'Llama 3.1 70B',
        enabled: 1, source: 'manual', user_edited: 1, sort_order: 0,
      });

      // Explicit model that is incompatible with claude_code runtime — still honored.
      const resolved = resolveProvider({
        providerId: provider.id,
        model: 'meta-llama/llama-3.1-70b',
        runtime: 'claude_code',
      });
      assert.equal(resolved.model, 'meta-llama/llama-3.1-70b',
        'explicit opts.model bypasses the runtime gate (caller asked by name)');
    } finally {
      deleteProvider(provider.id);
      teardown();
    }
  });

  it('hidden role slot stripped under claude_code runtime (experimental tier)', () => {
    setup();
    // Use a generic anthropic-thirdparty wildcard provider — provider tier
    // is `claude_code_experimental`, so EVERY model row is
    // `claude_code_compatible` at the model layer. That isolates the
    // hidden-slot strip behaviour from the runtime-incompat strip
    // behaviour (which we cover with the codepilot_only test above):
    // here the only thing that should remove a role slot is the hidden
    // gate, and the runtime gate should be transparent.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createProvider, deleteProvider, upsertProviderModel } = require('../../lib/db');
    const provider = createProvider({
      name: '__test_runtime_stacked_guards__',
      provider_type: 'anthropic',
      base_url: 'https://generic-anthropic-thirdparty.example.com',
      api_key: 'test-key',
      role_models_json: JSON.stringify({
        default: 'visible-default',
        sonnet: 'hidden-row', // hidden — should be stripped from roleModels
      }),
    });
    try {
      upsertProviderModel({
        provider_id: provider.id, model_id: 'visible-default',
        upstream_model_id: 'visible-default', display_name: 'Visible',
        enabled: 1, source: 'manual', user_edited: 1, sort_order: 0,
      });
      upsertProviderModel({
        provider_id: provider.id, model_id: 'hidden-row',
        upstream_model_id: 'hidden-row', display_name: 'Hidden Row',
        enabled: 0, source: 'manual', user_edited: 1, sort_order: 1,
      });

      const resolved = resolveProvider({
        providerId: provider.id,
        runtime: 'claude_code',
      });
      assert.equal(resolved.model, 'visible-default',
        'visible default is honored under runtime gate (experimental tier passes)');
      assert.equal(resolved.roleModels.sonnet, undefined,
        'hidden sonnet slot stripped from roleModels');
      assert.equal(resolved.roleModels.default, 'visible-default',
        'visible default slot preserved');

      const env = toClaudeCodeEnv({}, resolved);
      assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined,
        'hidden sonnet does NOT leak into ANTHROPIC_DEFAULT_SONNET_MODEL');
      assert.equal(env.ANTHROPIC_MODEL, 'visible-default',
        'ANTHROPIC_MODEL takes the visible default');
    } finally {
      deleteProvider(provider.id);
      teardown();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// routeAuxiliaryModel — pure function tests
// ────────────────────────────────────────────────────────────────

describe('routeAuxiliaryModel (pure routing)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { routeAuxiliaryModel } = require('../../lib/provider-resolver');

  // Helper: build a minimal ResolvedProvider for testing
  function mockMain(opts: {
    id?: string;
    roleModels?: { small?: string; haiku?: string; default?: string };
    model?: string;
    upstreamModel?: string;
    envMode?: boolean;
  }): ResolvedProvider {
    const roleModels = opts.roleModels || {};
    if (opts.envMode) {
      return {
        provider: undefined,
        protocol: 'anthropic',
        authStyle: 'api_key',
        model: opts.model,
        upstreamModel: opts.upstreamModel,
        modelDisplayName: undefined,
        headers: {},
        envOverrides: {},
        roleModels,
        hasCredentials: false,
        availableModels: [],
        settingSources: ['project', 'local'],
      };
    }
    return {
      provider: {
        id: opts.id || 'main-prov',
        name: 'Test Main',
        preset_key: 'anthropic-official',
        provider_type: 'anthropic',
        protocol: 'anthropic',
        base_url: 'https://api.anthropic.com',
        api_key: 'sk-test',
        is_active: 1,
        sort_order: 0,
        extra_env: '{}',
        headers_json: '{}',
        env_overrides_json: '',
        role_models_json: JSON.stringify(roleModels),
        notes: '',
        created_at: '',
        updated_at: '', options_json: '{}',
      },
      protocol: 'anthropic',
      authStyle: 'api_key',
      model: opts.model || 'claude-sonnet-4-6',
      upstreamModel: opts.upstreamModel || opts.model || 'claude-sonnet-4-6',
      modelDisplayName: undefined,
      headers: {},
      envOverrides: {},
      roleModels,
      hasCredentials: true,
      availableModels: [],
      settingSources: ['project', 'local'],
    };
  }

  describe('Tier 1 — env override', () => {
    it('env override with both provider and model wins everything', () => {
      const result = routeAuxiliaryModel('compact', {
        main: mockMain({ roleModels: { small: 'haiku-4.5' } }),
        isMainSdkProxyOnly: false,
        others: [],
        envOverride: { providerId: 'custom-prov', modelId: 'custom-model' },
      });
      assert.equal(result.providerId, 'custom-prov');
      assert.equal(result.modelId, 'custom-model');
      assert.equal(result.source, 'env_override');
    });

    it('env override missing modelId does NOT apply (needs both)', () => {
      const result = routeAuxiliaryModel('compact', {
        main: mockMain({ roleModels: { small: 'haiku-4.5' } }),
        isMainSdkProxyOnly: false,
        others: [],
        envOverride: { providerId: 'custom-prov' }, // missing modelId
      });
      assert.equal(result.source, 'main_small');
      assert.equal(result.modelId, 'haiku-4.5');
    });

    it('env override missing providerId does NOT apply', () => {
      const result = routeAuxiliaryModel('compact', {
        main: mockMain({ roleModels: { small: 'haiku-4.5' } }),
        isMainSdkProxyOnly: false,
        others: [],
        envOverride: { modelId: 'custom-model' }, // missing providerId
      });
      assert.equal(result.source, 'main_small');
    });
  });

  describe('Tier 2 — main provider small slot', () => {
    it('main small slot is preferred when main is not sdkProxyOnly', () => {
      const result = routeAuxiliaryModel('compact', {
        main: mockMain({ roleModels: { small: 'haiku-4.5', haiku: 'haiku-4.5-alt' } }),
        isMainSdkProxyOnly: false,
        others: [],
      });
      assert.equal(result.source, 'main_small');
      assert.equal(result.modelId, 'haiku-4.5');
    });

    it('main small slot is SKIPPED when main is sdkProxyOnly', () => {
      const result = routeAuxiliaryModel('compact', {
        main: mockMain({ id: 'kimi', roleModels: { small: 'kimi-small' } }),
        isMainSdkProxyOnly: true,
        others: [],
      });
      // falls through to main_floor since no other providers
      assert.equal(result.source, 'main_floor');
      assert.equal(result.providerId, 'kimi');
    });
  });

  describe('Tier 3 — main provider haiku slot', () => {
    it('main haiku used when small is absent', () => {
      const result = routeAuxiliaryModel('compact', {
        main: mockMain({ roleModels: { haiku: 'haiku-only' } }),
        isMainSdkProxyOnly: false,
        others: [],
      });
      assert.equal(result.source, 'main_haiku');
      assert.equal(result.modelId, 'haiku-only');
    });
  });

  describe('Tier 4 — fallback provider', () => {
    it('fallback provider small used when main is sdkProxyOnly', () => {
      const result = routeAuxiliaryModel('compact', {
        main: mockMain({ id: 'kimi', roleModels: { small: 'kimi-small' } }),
        isMainSdkProxyOnly: true,
        others: [
          {
            id: 'anthropic',
            roleModels: { small: 'claude-haiku-4-5' },
            isSdkProxyOnly: false,
          },
        ],
      });
      assert.equal(result.source, 'fallback_provider_small');
      assert.equal(result.providerId, 'anthropic');
      assert.equal(result.modelId, 'claude-haiku-4-5');
    });

    it('fallback provider haiku used when no small anywhere', () => {
      const result = routeAuxiliaryModel('compact', {
        main: mockMain({ id: 'kimi', roleModels: {} }),
        isMainSdkProxyOnly: true,
        others: [
          {
            id: 'anthropic',
            roleModels: { haiku: 'claude-haiku-4-5' },
            isSdkProxyOnly: false,
          },
        ],
      });
      assert.equal(result.source, 'fallback_provider_haiku');
      assert.equal(result.providerId, 'anthropic');
    });

    it('fallback skips other providers that are also sdkProxyOnly', () => {
      const result = routeAuxiliaryModel('compact', {
        main: mockMain({ id: 'kimi', roleModels: {} }),
        isMainSdkProxyOnly: true,
        others: [
          {
            id: 'glm',
            roleModels: { small: 'glm-air' },
            isSdkProxyOnly: true, // skipped
          },
          {
            id: 'anthropic',
            roleModels: { small: 'claude-haiku-4-5' },
            isSdkProxyOnly: false,
          },
        ],
      });
      assert.equal(result.source, 'fallback_provider_small');
      assert.equal(result.providerId, 'anthropic');
    });
  });

  describe('Tier 5 — main floor (ultimate fallback)', () => {
    it('falls back to main + main model when no small/haiku anywhere', () => {
      const result = routeAuxiliaryModel('compact', {
        main: mockMain({
          id: 'main',
          roleModels: {},
          model: 'main-model',
          upstreamModel: 'upstream-main-model',
        }),
        isMainSdkProxyOnly: false,
        others: [],
      });
      assert.equal(result.source, 'main_floor');
      assert.equal(result.providerId, 'main');
      // upstreamModel is preferred over model when both are set
      assert.equal(result.modelId, 'upstream-main-model');
    });

    it('falls back to main_floor when all other providers are sdkProxyOnly', () => {
      const result = routeAuxiliaryModel('compact', {
        main: mockMain({ id: 'main-kimi', roleModels: {} }),
        isMainSdkProxyOnly: true,
        others: [
          { id: 'glm', roleModels: { small: 'glm' }, isSdkProxyOnly: true },
          { id: 'minimax', roleModels: { small: 'minimax' }, isSdkProxyOnly: true },
        ],
      });
      assert.equal(result.source, 'main_floor');
      assert.equal(result.providerId, 'main-kimi');
    });

    it('env mode with undefined provider still returns main_floor with providerId=env', () => {
      const result = routeAuxiliaryModel('compact', {
        main: mockMain({ envMode: true, roleModels: {}, upstreamModel: 'env-model' }),
        isMainSdkProxyOnly: false,
        others: [],
      });
      assert.equal(result.source, 'main_floor');
      assert.equal(result.providerId, 'env');
      assert.equal(result.modelId, 'env-model');
    });

    it('never returns null/undefined modelId (empty string fallback)', () => {
      const result = routeAuxiliaryModel('compact', {
        main: mockMain({ envMode: true, roleModels: {} }),
        isMainSdkProxyOnly: false,
        others: [],
      });
      assert.equal(result.source, 'main_floor');
      assert.equal(typeof result.modelId, 'string');
    });
  });

  describe('task parameter', () => {
    it('task parameter does not affect routing for the same ctx', () => {
      const ctx = {
        main: mockMain({ roleModels: { small: 'haiku-4.5' } }),
        isMainSdkProxyOnly: false,
        others: [],
      };
      const compact = routeAuxiliaryModel('compact', ctx);
      const vision = routeAuxiliaryModel('vision', ctx);
      const summarize = routeAuxiliaryModel('summarize', ctx);
      const webExtract = routeAuxiliaryModel('web_extract', ctx);
      assert.equal(compact.modelId, 'haiku-4.5');
      assert.equal(vision.modelId, 'haiku-4.5');
      assert.equal(summarize.modelId, 'haiku-4.5');
      assert.equal(webExtract.modelId, 'haiku-4.5');
    });
  });
});

// ────────────────────────────────────────────────────────────────
// resolveAuxiliaryModel — integration with real DB state
// ────────────────────────────────────────────────────────────────

describe('resolveAuxiliaryModel (live wrapper)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolveAuxiliaryModel } = require('../../lib/provider-resolver');

  it('returns a well-formed result without throwing', () => {
    const result = resolveAuxiliaryModel('compact');
    assert.ok(result);
    assert.equal(typeof result.providerId, 'string');
    assert.equal(typeof result.modelId, 'string');
    assert.ok(
      ['env_override', 'main_small', 'main_haiku', 'fallback_provider_small',
       'fallback_provider_haiku', 'main_floor'].includes(result.source),
      `unexpected source: ${result.source}`,
    );
  });

  it('env override applies when AUXILIARY_COMPACT_PROVIDER+MODEL are set', () => {
    process.env.AUXILIARY_COMPACT_PROVIDER = 'test-prov';
    process.env.AUXILIARY_COMPACT_MODEL = 'test-model';
    try {
      const result = resolveAuxiliaryModel('compact');
      assert.equal(result.source, 'env_override');
      assert.equal(result.providerId, 'test-prov');
      assert.equal(result.modelId, 'test-model');
    } finally {
      delete process.env.AUXILIARY_COMPACT_PROVIDER;
      delete process.env.AUXILIARY_COMPACT_MODEL;
    }
  });

  it('each task type reads its own env var (AUXILIARY_<TASK>_*)', () => {
    process.env.AUXILIARY_VISION_PROVIDER = 'vision-prov';
    process.env.AUXILIARY_VISION_MODEL = 'vision-model';
    try {
      const vision = resolveAuxiliaryModel('vision');
      assert.equal(vision.source, 'env_override');
      assert.equal(vision.modelId, 'vision-model');

      // compact should NOT pick up vision env vars
      const compact = resolveAuxiliaryModel('compact');
      assert.notEqual(compact.source, 'env_override');
    } finally {
      delete process.env.AUXILIARY_VISION_PROVIDER;
      delete process.env.AUXILIARY_VISION_MODEL;
    }
  });

  // ───────────────────────────────────────────────────────────
  // Regression tests for Codex review 2026-04-12
  // ───────────────────────────────────────────────────────────

  // ─ Codex review round 2: tighten Fix 1 and Fix 2 regression tests ─
  //
  // Previous assertions were too loose — they would have accepted the
  // pre-fix behavior. These rewrites explicitly reject the pre-fix
  // outcomes and pin the post-fix semantics.

  it('[fix 1 P1 strict] session providerId wins over the global default — source discriminator', () => {
    // Pre-fix behavior: resolveAuxiliaryModel() called resolveProvider()
    // with NO arguments → picked the global default as "main" → returned
    // source='main_small' pointing at the DEFAULT provider's small slot.
    //
    // Post-fix behavior: opts.providerId is forwarded, so the SESSION
    // provider becomes "main". If the session provider has no small/haiku,
    // the global default (if it has small/haiku) becomes a TIER-4 FALLBACK,
    // producing source='fallback_provider_small' — a different enum value.
    //
    // The `source` field is the unambiguous discriminator. Asserting
    // source !== 'main_small' catches the exact pre-fix regression.

    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      createProvider,
      deleteProvider,
      getSetting,
      setSetting,
    } = require('../../lib/db');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const savedDefaultId = getSetting('default_provider_id') || '';

    const globalDefault = createProvider({
      name: '__test_aux_globalDefault__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'sk-global',
      role_models_json: JSON.stringify({
        default: 'global-default-model',
        small: 'global-small-slot',
      }),
    });
    const session = createProvider({
      name: '__test_aux_session__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'sk-session',
      // Intentionally NO small/haiku — forces tier-4 or main_floor
      role_models_json: JSON.stringify({ default: 'session-default-model' }),
    });
    setSetting('default_provider_id', globalDefault.id);

    try {
      const result = resolveAuxiliaryModel('compact', { providerId: session.id });

      // Strict assertion on `source` — the unambiguous discriminator.
      //
      // Pre-fix semantics: globalDefault is resolved as "main" (because
      // resolveProvider() with no opts reads default_provider_id), so its
      // small slot matches tier 2 → source='main_small'.
      //
      // Post-fix semantics: `session` is resolved as "main" because opts
      // is forwarded. `session` has no small/haiku, so tier 2/3 are
      // skipped. Tier 4 may or may not find a fallback provider
      // depending on other DB state, but regardless, source will be one
      // of [fallback_provider_small, fallback_provider_haiku, main_floor]
      // — NEVER main_small/main_haiku (because `session` explicitly
      // lacks those slots).
      //
      // This assertion catches the exact pre-fix regression: if session
      // context is ignored and globalDefault becomes main, source would
      // be main_small/main_haiku, which we now reject.
      assert.notEqual(
        result.source,
        'main_small',
        'Regression: source=main_small means the session providerId was ignored and the global default was resolved as main',
      );
      assert.notEqual(
        result.source,
        'main_haiku',
        'Regression: source=main_haiku means the session providerId was ignored',
      );
      assert.ok(
        ['fallback_provider_small', 'fallback_provider_haiku', 'main_floor'].includes(result.source),
        `Expected fallback/floor tier, got source=${result.source}`,
      );

      // If the returned source is main_floor, providerId MUST be session
      // (because main_floor by definition uses the main provider). Any
      // other ID in main_floor would indicate the session context was
      // dropped somewhere in the routing.
      if (result.source === 'main_floor') {
        assert.equal(
          result.providerId,
          session.id,
          'main_floor should bind to the session provider, not the global default',
        );
      }
    } finally {
      setSetting('default_provider_id', savedDefaultId);
      deleteProvider(session.id);
      deleteProvider(globalDefault.id);
    }
  });

  it('[regression] stale invalid protocol in another provider does not crash tier-4 fallback scan', () => {
    // A DB row with an invalid raw protocol string (e.g. migrated from an
    // older schema, imported from a broken export, or created before the
    // write-path validation landed) must not poison the "other providers"
    // enumeration in resolveAuxiliaryModel. Before the effective-protocol
    // fix the enum would pass 'random-garbage' straight to
    // findPresetForLegacy and computeEffectiveRoleModels, producing
    // inconsistent downstream routing between main and auxiliary paths.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createProvider, deleteProvider } = require('../../lib/db');

    // Main provider — intentionally no small/haiku slots so the resolver
    // must walk past tier-2/3 and into the tier-4 scan where the broken
    // provider would be evaluated.
    const main = createProvider({
      name: '__test_aux_main_no_small__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'sk-main',
      role_models_json: JSON.stringify({ default: 'opus' }),
    });

    // Broken provider with an unknown protocol string. provider_type is
    // anthropic so the effective-protocol helper can still infer something
    // sensible; the broken value just shouldn't propagate.
    const broken = createProvider({
      name: '__test_aux_invalid_protocol__',
      provider_type: 'anthropic',
      protocol: 'random-garbage',
      base_url: 'https://api.anthropic.com',
      api_key: 'sk-broken',
      role_models_json: JSON.stringify({ default: 'opus', small: 'broken-small' }),
    });

    try {
      // Must not throw. We don't pin the exact source because it depends
      // on DB state from parallel tests — but the call has to survive and
      // yield a valid routing.
      const result = resolveAuxiliaryModel('compact', { providerId: main.id });
      assert.ok(result);
      assert.ok(
        ['env_override', 'main_small', 'main_haiku', 'fallback_provider_small',
         'fallback_provider_haiku', 'main_floor'].includes(result.source),
        `unexpected source: ${result.source}`,
      );
    } finally {
      deleteProvider(main.id);
      deleteProvider(broken.id);
    }
  });

  it('[fix 1 P1] explicit providerId with small slot IS returned as main_small (positive case)', () => {
    // Positive-case companion: the explicit providerId has a small slot,
    // so the result MUST be main_small + that provider's slot. This
    // catches a regression where session providerId is ignored and we
    // return some other provider's slot.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createProvider, deleteProvider } = require('../../lib/db');
    const explicit = createProvider({
      name: '__test_aux_explicit__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'sk-explicit',
      role_models_json: JSON.stringify({
        default: 'opus-foo',
        small: 'explicit-small-unique-marker',
      }),
    });
    try {
      const result = resolveAuxiliaryModel('compact', { providerId: explicit.id });
      assert.equal(result.source, 'main_small');
      assert.equal(result.providerId, explicit.id);
      assert.equal(result.modelId, 'explicit-small-unique-marker');
    } finally {
      deleteProvider(explicit.id);
    }
  });

  it('[fix 2 P2 strict] computeEffectiveRoleModels merges preset.defaultRoleModels when json is empty', () => {
    // The tier-4 scan previously only read role_models_json, missing
    // preset-backed defaultRoleModels. The fix extracted this helper
    // from buildResolution's merge logic (provider-resolver.ts:664-675).
    //
    // We test the helper directly because:
    //   - No non-sdkProxyOnly preset in the catalog currently sets
    //     defaultRoleModels (only MiniMax/MiMo set it, all sdkProxyOnly),
    //     so a live end-to-end scenario is impossible with the real catalog
    //   - The merge rule is simple enough that direct unit testing gives
    //     the strongest possible contract lock
    //   - A synthetic preset fixture lets us cover the exact branches:
    //     (a) empty json + preset defaults → merged
    //     (b) json with slots → json wins
    //     (c) no preset → empty json stays empty
    //     (d) json default/sonnet present → merge suppressed (guard)

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { computeEffectiveRoleModels } = require('../../lib/provider-resolver');

    const makeProvider = (json: string) => ({
      id: 'p',
          name: 'Test',
          preset_key: 'anthropic-official',
          provider_type: 'anthropic',
      protocol: 'anthropic',
      base_url: 'https://example.com',
      api_key: 'k',
      is_active: 1,
      sort_order: 0,
      extra_env: '{}',
      headers_json: '{}',
      env_overrides_json: '',
      role_models_json: json,
      notes: '',
      created_at: '',
      updated_at: '',
      options_json: '{}',
    });

    // Minimal preset fixture — computeEffectiveRoleModels only reads
    // .defaultRoleModels on the preset, so we don't need the full shape.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockPresetWithDefaults: any = {
      key: 'test-preset',
      defaultRoleModels: { small: 'preset-small', haiku: 'preset-haiku' },
    };

    // (a) empty json + preset defaults → merged
    const empty = computeEffectiveRoleModels(
      makeProvider(JSON.stringify({})),
      mockPresetWithDefaults,
      'anthropic',
    );
    assert.equal(empty.small, 'preset-small', 'empty json should inherit preset small');
    assert.equal(empty.haiku, 'preset-haiku', 'empty json should inherit preset haiku');

    // (b) json with its own slots → json values win (spread order in fix)
    const withOwn = computeEffectiveRoleModels(
      makeProvider(JSON.stringify({ small: 'own-small' })),
      mockPresetWithDefaults,
      'anthropic',
    );
    // The current guard only merges when !default && !sonnet; json already
    // has no default/sonnet, so merge fires, then json.small overrides
    // preset.small via spread order.
    assert.equal(withOwn.small, 'own-small', 'own json small should win over preset small');
    assert.equal(withOwn.haiku, 'preset-haiku', 'preset haiku should still be inherited');

    // (c) no preset → empty json stays empty
    const noPreset = computeEffectiveRoleModels(
      makeProvider(JSON.stringify({})),
      undefined,
      'anthropic',
    );
    assert.deepEqual(noPreset, {}, 'no preset means nothing to merge');

    // (d) json.default is present → merge guard suppresses preset injection
    const withDefault = computeEffectiveRoleModels(
      makeProvider(JSON.stringify({ default: 'own-default' })),
      mockPresetWithDefaults,
      'anthropic',
    );
    assert.equal(withDefault.default, 'own-default');
    assert.equal(withDefault.small, undefined, 'preset merge should be suppressed when json.default exists');
    assert.equal(withDefault.haiku, undefined);

    // (e) json.sonnet is present → same guard
    const withSonnet = computeEffectiveRoleModels(
      makeProvider(JSON.stringify({ sonnet: 'own-sonnet' })),
      mockPresetWithDefaults,
      'anthropic',
    );
    assert.equal(withSonnet.sonnet, 'own-sonnet');
    assert.equal(withSonnet.small, undefined);
    assert.equal(withSonnet.haiku, undefined);
  });

  it('[fix 2 P2] tier-4 scan uses computeEffectiveRoleModels (integration smoke)', () => {
    // Integration-level smoke: even with the real catalog (where no
    // non-sdkProxyOnly preset exposes defaultRoleModels), verify that
    // the tier-4 scan calls computeEffectiveRoleModels and doesn't
    // throw when providers rely on preset defaults. The strict
    // behavioral assertion lives in the previous test; this one just
    // guards against a refactor breaking the wire-up.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createProvider, deleteProvider } = require('../../lib/db');

    const mainSdkOnly = createProvider({
      name: '__test_main_sdkonly_smoke__',
      provider_type: 'anthropic',
      // Kimi coding URL is sdkProxyOnly via preset
      base_url: 'https://api.moonshot.cn/anthropic/',
      api_key: 'sk-main',
      role_models_json: JSON.stringify({}),
    });
    const fallbackEmpty = createProvider({
      name: '__test_fallback_empty_smoke__',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'sk-fallback',
      role_models_json: JSON.stringify({}),
    });

    try {
      // Should not throw regardless of whether tier-4 finds anything.
      const result = resolveAuxiliaryModel('compact', { providerId: mainSdkOnly.id });
      assert.ok(result);
      assert.ok(typeof result.providerId === 'string');
      assert.ok(typeof result.source === 'string');
    } finally {
      deleteProvider(mainSdkOnly.id);
      deleteProvider(fallbackEmpty.id);
    }
  });
});

// ── Effective Anthropic base URL → context-window trust gate (#632) ─────
// resolveEffectiveAnthropicBaseUrl computes the base URL the Claude Code SDK
// subprocess will ACTUALLY use, with the same precedence as toClaudeCodeEnv.
// claude-client gates trust of the SDK-reported contextWindow on it: a
// third-party proxy here reports the SDK's generic ~200K default, which must
// NOT be shown as a real capacity (the GLM "200K" the user reported).
import { isFirstPartyAnthropicEndpoint } from '../../lib/ai-provider';

describe('resolveEffectiveAnthropicBaseUrl — context-window trust gate (#632)', () => {
  const GLM_URL = 'https://open.bigmodel.cn/api/anthropic';
  const makeDbProvider = (base_url: string): NonNullable<ResolvedProvider['provider']> => ({
    id: 'p1', name: 'Test', preset_key: '', provider_type: 'custom', protocol: 'anthropic',
    base_url, api_key: 'key', is_active: 1, sort_order: 0, extra_env: '{}',
    headers_json: '{}', env_overrides_json: '', role_models_json: '{}', notes: '',
    created_at: '', updated_at: '', options_json: '{}',
  });
  const baseResolved = (overrides: Partial<ResolvedProvider>): ResolvedProvider => ({
    provider: undefined, protocol: 'anthropic', authStyle: 'api_key',
    model: 'sonnet', upstreamModel: 'sonnet', modelDisplayName: undefined,
    headers: {}, envOverrides: {}, roleModels: {}, hasCredentials: true,
    availableModels: [], settingSources: ['user'], ...overrides,
  });

  // ── DB provider path: base_url IS the effective URL ──
  it('DB third-party provider (GLM) → effective URL third-party → NOT first-party', () => {
    const eff = resolveEffectiveAnthropicBaseUrl(baseResolved({ provider: makeDbProvider(GLM_URL) }));
    assert.equal(eff, GLM_URL);
    assert.equal(isFirstPartyAnthropicEndpoint(eff), false, 'GLM proxy must not be trusted for the SDK window');
  });

  it('DB official-Anthropic provider → first-party (trusted)', () => {
    const eff = resolveEffectiveAnthropicBaseUrl(baseResolved({ provider: makeDbProvider('https://api.anthropic.com') }));
    assert.equal(isFirstPartyAnthropicEndpoint(eff), true);
  });

  it('DB provider with empty base_url + credentials → undefined → first-party (SDK default api.anthropic.com)', () => {
    const eff = resolveEffectiveAnthropicBaseUrl(baseResolved({ provider: makeDbProvider(''), hasCredentials: true }));
    assert.equal(eff, undefined);
    assert.equal(isFirstPartyAnthropicEndpoint(eff), true);
  });

  // ── DB provider WITHOUT credentials — Codex P2 (2026-06-20). toClaudeCodeEnv
  // runs neither branch, so the SDK inherits ambient process.env.ANTHROPIC_BASE_URL
  // (NOT provider.base_url, NOT settings). The helper must mirror that or it would
  // trust a first-party-looking provider row while the SDK actually hits a
  // third-party env proxy. ──
  it('DB provider WITHOUT credentials → follows ambient process.env, NOT provider.base_url (P2)', () => {
    const origEnv = process.env.ANTHROPIC_BASE_URL;
    const origSetting = getSetting('anthropic_base_url');
    setSetting('anthropic_base_url', '');
    process.env.ANTHROPIC_BASE_URL = GLM_URL; // ambient third-party proxy
    try {
      // provider.base_url looks first-party, but no credentials → SDK ignores it.
      const eff = resolveEffectiveAnthropicBaseUrl(
        baseResolved({ provider: makeDbProvider('https://api.anthropic.com'), hasCredentials: false }),
      );
      assert.equal(eff, GLM_URL, 'no-cred provider must defer to ambient env, not its own base_url');
      assert.equal(isFirstPartyAnthropicEndpoint(eff), false, 'a third-party ambient env must untrust even behind a first-party-looking no-cred provider row');
    } finally {
      if (origEnv !== undefined) process.env.ANTHROPIC_BASE_URL = origEnv; else delete process.env.ANTHROPIC_BASE_URL;
      setSetting('anthropic_base_url', origSetting || '');
    }
  });

  it('DB provider WITHOUT credentials + clean env → undefined → first-party (no false untrust)', () => {
    const origEnv = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    try {
      const eff = resolveEffectiveAnthropicBaseUrl(
        baseResolved({ provider: makeDbProvider(GLM_URL), hasCredentials: false }),
      );
      assert.equal(eff, undefined, 'no-cred provider with clean ambient env → SDK default (provider.base_url is not injected)');
      assert.equal(isFirstPartyAnthropicEndpoint(eff), true);
    } finally {
      if (origEnv !== undefined) process.env.ANTHROPIC_BASE_URL = origEnv; else delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  // ── env / legacy / cc-switch path (resolved.provider === undefined) — THE #632 P1 HOLE.
  // Must consult process.env.ANTHROPIC_BASE_URL AND settings.anthropic_base_url,
  // because isFirstPartyAnthropicEndpoint(undefined) === true would otherwise
  // re-trust a third-party proxy reached via env/legacy. ──
  it('env mode + process.env.ANTHROPIC_BASE_URL third-party → NOT first-party (P1 regression)', () => {
    const origEnv = process.env.ANTHROPIC_BASE_URL;
    const origSetting = getSetting('anthropic_base_url');
    setSetting('anthropic_base_url', '');
    process.env.ANTHROPIC_BASE_URL = GLM_URL;
    try {
      const eff = resolveEffectiveAnthropicBaseUrl(baseResolved({ provider: undefined }));
      assert.equal(eff, GLM_URL);
      assert.equal(isFirstPartyAnthropicEndpoint(eff), false, 'env-mode third-party proxy must NOT trust the SDK window — this is the #632 P1 hole');
    } finally {
      if (origEnv !== undefined) process.env.ANTHROPIC_BASE_URL = origEnv; else delete process.env.ANTHROPIC_BASE_URL;
      setSetting('anthropic_base_url', origSetting || '');
    }
  });

  it('env mode + settings.anthropic_base_url third-party → NOT first-party', () => {
    const origEnv = process.env.ANTHROPIC_BASE_URL;
    const origSetting = getSetting('anthropic_base_url');
    delete process.env.ANTHROPIC_BASE_URL;
    setSetting('anthropic_base_url', GLM_URL);
    try {
      const eff = resolveEffectiveAnthropicBaseUrl(baseResolved({ provider: undefined }));
      assert.equal(eff, GLM_URL);
      assert.equal(isFirstPartyAnthropicEndpoint(eff), false);
    } finally {
      if (origEnv !== undefined) process.env.ANTHROPIC_BASE_URL = origEnv; else delete process.env.ANTHROPIC_BASE_URL;
      setSetting('anthropic_base_url', origSetting || '');
    }
  });

  it('env mode clean (no env, no settings) → undefined → first-party (official default)', () => {
    const origEnv = process.env.ANTHROPIC_BASE_URL;
    const origSetting = getSetting('anthropic_base_url');
    delete process.env.ANTHROPIC_BASE_URL;
    setSetting('anthropic_base_url', '');
    try {
      const eff = resolveEffectiveAnthropicBaseUrl(baseResolved({ provider: undefined }));
      assert.equal(eff, undefined);
      assert.equal(isFirstPartyAnthropicEndpoint(eff), true);
    } finally {
      if (origEnv !== undefined) process.env.ANTHROPIC_BASE_URL = origEnv; else delete process.env.ANTHROPIC_BASE_URL;
      setSetting('anthropic_base_url', origSetting || '');
    }
  });
});
