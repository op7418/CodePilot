import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ApiProvider } from '../../types';
import type { ResolvedProvider } from '../../lib/provider-resolver';
import {
  assertProviderCallAllowed,
  isInteractiveSceneAllowed,
  ProviderCallPolicyError,
  type ProviderCallScene,
} from '../../lib/provider-call-policy';

const originalDataDir = process.env.CLAUDE_GUI_DATA_DIR;
const originalDisableMigration = process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS;
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-call-policy-'));
process.env.CLAUDE_GUI_DATA_DIR = tempDataDir;
process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS = '1';
fs.writeFileSync(path.join(tempDataDir, 'codepilot.db'), '');

const subscriptionProvider: ApiProvider = {
  id: 'qwen-subscription',
  name: 'Qwen Token Plan Personal',
  preset_key: 'qwen-token-plan-personal-cn',
  provider_type: 'anthropic',
  protocol: 'anthropic',
  base_url: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
  api_key: 'test-key-never-send',
  is_active: 1,
  sort_order: 0,
  extra_env: '{}',
  headers_json: '{}',
  env_overrides_json: '{}',
  role_models_json: '{}',
  options_json: '{}',
  notes: '',
  created_at: '',
  updated_at: '',
};

const generalProvider: ApiProvider = {
  ...subscriptionProvider,
  id: 'general-provider',
  name: 'General provider',
  preset_key: '',
  base_url: 'https://general.example.com',
};

const allowedScenes: ProviderCallScene[] = [
  'interactive_chat',
  'active_turn_compact',
  'active_turn_memory_rerank',
  'user_onboarding',
  'user_checkin',
  'user_dashboard_refresh',
  'user_cli_describe',
  'user_skill_search',
  'connection_test',
];

const blockedScenes: ProviderCallScene[] = [
  'automatic_title',
  'automatic_memory_extract',
  'automatic_quick_actions',
  'automatic_dashboard_refresh',
  'background_cli_describe',
  'background_skill_search',
  'scheduled_task',
  'assistant_heartbeat',
  'media_plan',
  'structured_generation',
  'bridge',
];

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

describe('interactive-only provider call policy', () => {
  it('has an explicit positive or negative ruling for every callScene', () => {
    const allScenes: ProviderCallScene[] = [...allowedScenes, ...blockedScenes];
    assert.equal(new Set(allScenes).size, 20, 'scene matrix must cover the complete union');
    for (const scene of allowedScenes) assert.equal(isInteractiveSceneAllowed(scene), true, scene);
    for (const scene of blockedScenes) assert.equal(isInteractiveSceneAllowed(scene), false, scene);
  });

  for (const scene of allowedScenes) {
    it(`allows ${scene}`, () => {
      assert.doesNotThrow(() => assertProviderCallAllowed(subscriptionProvider, scene));
    });
  }

  for (const scene of blockedScenes) {
    it(`blocks ${scene} with a structured policy error`, () => {
      assert.throws(
        () => assertProviderCallAllowed(subscriptionProvider, scene),
        (error: unknown) => {
          assert.ok(error instanceof ProviderCallPolicyError);
          assert.equal(error.code, 'INTERACTIVE_ONLY_SCENE_BLOCKED');
          assert.equal(error.scene, scene);
          assert.equal(error.presetKey, 'qwen-token-plan-personal-cn');
          return true;
        },
      );
    });
  }

  it('fails closed when a credential-bearing closure omits callScene', () => {
    assert.throws(
      () => assertProviderCallAllowed(subscriptionProvider, undefined),
      (error: unknown) => error instanceof ProviderCallPolicyError
        && error.code === 'CALL_SCENE_REQUIRED',
    );
  });

  it('does not restrict non-subscription providers', () => {
    for (const scene of [...allowedScenes, ...blockedScenes]) {
      assert.doesNotThrow(() => assertProviderCallAllowed(generalProvider, scene));
    }
  });

  it('does not let a corrupted known preset identity bypass its restrictive policy', () => {
    const corrupted = { ...subscriptionProvider, base_url: 'https://unexpected.example/v1' };
    assert.throws(
      () => assertProviderCallAllowed(corrupted, 'scheduled_task'),
      (error: unknown) => error instanceof ProviderCallPolicyError
        && error.code === 'INTERACTIVE_ONLY_SCENE_BLOCKED',
    );
  });

  it('keeps an ambiguous legacy Qwen shared URL interactive-only until the user confirms a plan', () => {
    const ambiguous = { ...subscriptionProvider, preset_key: '' };
    assert.throws(
      () => assertProviderCallAllowed(ambiguous, 'automatic_memory_extract'),
      ProviderCallPolicyError,
    );
  });

  it('rejects hidden automation before model construction or any fetch', async () => {
    const { createModel } = await import('../../lib/ai-provider');
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;
      throw new Error('fetch must not be reached');
    }) as typeof fetch;
    const resolved: ResolvedProvider = {
      provider: subscriptionProvider,
      protocol: 'anthropic',
      authStyle: 'api_key',
      model: 'qwen3.8-max-preview',
      upstreamModel: 'qwen3.8-max-preview',
      modelDisplayName: 'Qwen3.8 Max Preview',
      headers: {},
      envOverrides: {},
      roleModels: {},
      hasCredentials: true,
      availableModels: [],
      settingSources: ['user'],
    };

    try {
      for (const scene of [
        'automatic_memory_extract',
        'automatic_quick_actions',
        'scheduled_task',
        'assistant_heartbeat',
      ] as const) {
        assert.throws(
          () => createModel({ callScene: scene, resolvedProvider: resolved }),
          ProviderCallPolicyError,
        );
      }
      assert.equal(requestCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('never borrows an interactive-only provider from auxiliary tier 4', async () => {
    const { routeAuxiliaryModel } = await import('../../lib/provider-resolver');
    const main: ResolvedProvider = {
      provider: generalProvider,
      protocol: 'anthropic',
      authStyle: 'api_key',
      model: 'main-model',
      upstreamModel: 'main-model',
      modelDisplayName: 'Main model',
      headers: {},
      envOverrides: {},
      roleModels: {},
      hasCredentials: true,
      availableModels: [],
      settingSources: ['user'],
    };
    const result = routeAuxiliaryModel('summarize', {
      main,
      isMainSdkProxyOnly: false,
      others: [
        {
          id: subscriptionProvider.id,
          roleModels: { small: 'qwen3.6-flash' },
          isSdkProxyOnly: false,
          isInteractiveOnly: true,
        },
      ],
    });
    assert.equal(result.source, 'main_floor');
    assert.equal(result.providerId, generalProvider.id);
  });
});
