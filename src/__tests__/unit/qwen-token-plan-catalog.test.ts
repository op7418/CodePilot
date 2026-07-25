import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPreset,
  resolveProviderPresetIdentity,
  findMatchingPresetForRecord,
} from '../../lib/provider-catalog';

const TOKEN_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic';

describe('Qwen Token Plan catalog contract', () => {
  it('personal plan exposes exactly six text models and current role/env defaults', () => {
    const preset = getPreset('qwen-token-plan-personal-cn');
    assert.ok(preset);
    assert.deepEqual(preset.defaultModels.map(model => model.modelId), [
      'qwen3.8-max-preview', 'qwen3.7-max', 'qwen3.7-plus',
      'qwen3.6-flash', 'glm-5.2', 'deepseek-v4-pro',
    ]);
    assert.deepEqual(preset.defaultRoleModels, {
      default: 'qwen3.8-max-preview',
      sonnet: 'qwen3.8-max-preview',
      opus: 'qwen3.8-max-preview',
      haiku: 'qwen3.6-flash',
    });
    assert.equal(preset.defaultEnvOverrides.CLAUDE_CODE_SUBAGENT_MODEL, 'qwen3.7-max');
    assert.equal(preset.usagePolicy, 'interactive_only');
  });

  it('qwen3.8 publishes only the evidenced thinking, effort, context, and temperature contract', () => {
    for (const key of ['qwen-token-plan-personal-cn', 'bailian-token-plan-cn']) {
      const model = getPreset(key)?.defaultModels.find(item => item.modelId === 'qwen3.8-max-preview');
      assert.ok(model, `${key} must include qwen3.8-max-preview`);
      assert.equal(model.capabilities?.thinkingMode, 'always');
      assert.deepEqual(model.capabilities?.supportedEffortLevels, ['low', 'high', 'xhigh']);
      assert.equal(model.capabilities?.defaultEffortLevel, 'xhigh');
      assert.equal(model.capabilities?.contextWindow, 983616);
      assert.equal(model.capabilities?.thinkingTemperatureDefault, 0.6);
      assert.equal(model.capabilities?.thinkingTemperatureMin, 0.6);
      assert.equal(model.capabilities?.temperatureClampBehavior, 'upstream_clamps_below_min');
      assert.equal(model.capabilities?.vision, undefined, 'unverified vision must not be fabricated');
      assert.equal(model.capabilities?.toolUse, undefined, 'per-model tool verification remains smoke-gated');
    }
  });

  it('all three Qwen subscription products are machine-readable interactive-only plans', () => {
    for (const key of ['bailian', 'qwen-token-plan-personal-cn', 'bailian-token-plan-cn']) {
      const preset = getPreset(key);
      assert.ok(preset);
      assert.equal(preset.usagePolicy, 'interactive_only');
    }
  });

  it('explicit personal/team identities resolve independently on the shared URL', () => {
    for (const key of ['qwen-token-plan-personal-cn', 'bailian-token-plan-cn']) {
      const record = {
        preset_key: key,
        protocol: 'anthropic',
        provider_type: 'anthropic',
        base_url: TOKEN_URL,
      };
      assert.equal(findMatchingPresetForRecord(record)?.key, key);
      const resolution = resolveProviderPresetIdentity(record);
      assert.equal(resolution.status, 'resolved');
      if (resolution.status === 'resolved') assert.equal(resolution.source, 'preset_key');
    }
  });

  it('legacy shared URL is ambiguous and never resolves by catalog order', () => {
    const resolution = resolveProviderPresetIdentity({
      preset_key: '',
      protocol: 'anthropic',
      provider_type: 'anthropic',
      base_url: TOKEN_URL,
    });
    assert.equal(resolution.status, 'ambiguous');
    if (resolution.status === 'ambiguous') {
      assert.deepEqual(resolution.candidateKeys, [
        'bailian-token-plan-cn',
        'qwen-token-plan-personal-cn',
      ]);
    }
  });

  it('plan cards carry separate official docs, key, purchase, and bilingual term breadcrumbs', () => {
    const personal = getPreset('qwen-token-plan-personal-cn')!;
    const team = getPreset('bailian-token-plan-cn')!;
    for (const preset of [personal, team]) {
      assert.match(preset.meta?.docsUrl ?? '', /^https:\/\/platform\.qianwenai\.com\/docs\/token-plan\//);
      assert.match(preset.meta?.apiKeyUrl ?? '', /^https:\/\/platform\.qianwenai\.com\/docs\/api-reference\/preparation\/api-key/);
      assert.ok(preset.meta?.purchaseUrl);
      assert.ok((preset.meta?.notes?.length ?? 0) >= 3);
      assert.equal(preset.meta?.notesZh?.length, preset.meta?.notes?.length);
    }
  });
});
