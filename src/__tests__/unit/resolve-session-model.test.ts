/**
 * Unit tests for resolveSessionModelPure — model/provider resolution logic.
 *
 * Run with: npx tsx --test src/__tests__/unit/resolve-session-model.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const GROUPS = [
  { provider_id: 'anthropic', models: [{ value: 'sonnet' }, { value: 'opus' }, { value: 'haiku' }] },
  { provider_id: 'openrouter', models: [{ value: 'gpt-4o' }, { value: 'llama-3' }] },
  { provider_id: 'local', models: [{ value: 'qwen-32b' }] },
];

function ctx(overrides: Partial<Parameters<typeof import('../../lib/resolve-session-model').resolveSessionModelPure>[2]> = {}) {
  return {
    globalModel: '',
    globalProvider: '',
    groups: GROUPS,
    lsModel: '',
    lsProvider: '',
    ...overrides,
  };
}

describe('resolveSessionModelPure', () => {
  it('returns session model when present', async () => {
    const { resolveSessionModelPure } = await import('../../lib/resolve-session-model');
    const result = resolveSessionModelPure('opus', 'anthropic', ctx());
    assert.deepEqual(result, { model: 'opus', providerId: 'anthropic' });
  });

  it('returns session model even with global default set', async () => {
    const { resolveSessionModelPure } = await import('../../lib/resolve-session-model');
    const result = resolveSessionModelPure('haiku', 'anthropic', ctx({
      globalModel: 'gpt-4o',
      globalProvider: 'openrouter',
    }));
    assert.deepEqual(result, { model: 'haiku', providerId: 'anthropic' });
  });

  it('uses global default when it belongs to the session provider', async () => {
    const { resolveSessionModelPure } = await import('../../lib/resolve-session-model');
    const result = resolveSessionModelPure('', 'anthropic', ctx({
      globalModel: 'opus',
      globalProvider: 'anthropic',
    }));
    assert.deepEqual(result, { model: 'opus', providerId: 'anthropic' });
  });

  it('does NOT use global default from a different provider', async () => {
    const { resolveSessionModelPure } = await import('../../lib/resolve-session-model');
    // Session is anthropic, global default is openrouter's gpt-4o
    const result = resolveSessionModelPure('', 'anthropic', ctx({
      globalModel: 'gpt-4o',
      globalProvider: 'openrouter',
    }));
    // Should fall back to anthropic's first model, not gpt-4o
    assert.deepEqual(result, { model: 'sonnet', providerId: 'anthropic' });
  });

  it('falls back to provider first model when no global default', async () => {
    const { resolveSessionModelPure } = await import('../../lib/resolve-session-model');
    const result = resolveSessionModelPure('', 'openrouter', ctx());
    assert.deepEqual(result, { model: 'gpt-4o', providerId: 'openrouter' });
  });

  it('uses global default freely when session has no provider', async () => {
    const { resolveSessionModelPure } = await import('../../lib/resolve-session-model');
    const result = resolveSessionModelPure('', '', ctx({
      globalModel: 'gpt-4o',
      globalProvider: 'openrouter',
    }));
    assert.deepEqual(result, { model: 'gpt-4o', providerId: 'openrouter' });
  });

  it('falls back to localStorage when no session, no global default', async () => {
    const { resolveSessionModelPure } = await import('../../lib/resolve-session-model');
    const result = resolveSessionModelPure('', '', ctx({
      lsModel: 'haiku',
      lsProvider: 'anthropic',
    }));
    assert.deepEqual(result, { model: 'haiku', providerId: 'anthropic' });
  });

  it('falls back to sonnet when nothing is available', async () => {
    const { resolveSessionModelPure } = await import('../../lib/resolve-session-model');
    const result = resolveSessionModelPure('', '', ctx());
    assert.deepEqual(result, { model: 'sonnet', providerId: '' });
  });

  it('skips global default if model not in provider catalog', async () => {
    const { resolveSessionModelPure } = await import('../../lib/resolve-session-model');
    // Global says anthropic/opus but the models list doesn't include it (stale config)
    const result = resolveSessionModelPure('', 'anthropic', ctx({
      globalModel: 'nonexistent-model',
      globalProvider: 'anthropic',
      groups: [{ provider_id: 'anthropic', models: [{ value: 'sonnet' }, { value: 'haiku' }] }],
    }));
    // Should skip invalid global default, use first available
    assert.deepEqual(result, { model: 'sonnet', providerId: 'anthropic' });
  });

  it('handles session provider not in groups (deleted provider)', async () => {
    const { resolveSessionModelPure } = await import('../../lib/resolve-session-model');
    const result = resolveSessionModelPure('', 'deleted-provider', ctx({
      globalModel: 'opus',
      globalProvider: 'anthropic',
    }));
    // Session provider not found, global default belongs to different provider
    // No sessionGroup match, no global match → falls through to global default (no provider)
    // Actually: sessionProviderId is truthy, so Case 1 runs but finds no group.
    // globalProvider !== sessionProviderId, so global not used.
    // No sessionGroup models → falls through Case 1.
    // Case 2: globalModel exists → use it with globalProvider
    assert.deepEqual(result, { model: 'opus', providerId: 'anthropic' });
  });

  it('handles empty groups array', async () => {
    const { resolveSessionModelPure } = await import('../../lib/resolve-session-model');
    const result = resolveSessionModelPure('', 'anthropic', ctx({
      groups: [],
      lsModel: 'haiku',
      lsProvider: 'anthropic',
    }));
    // No group found for anthropic, no global default → localStorage
    assert.deepEqual(result, { model: 'haiku', providerId: 'anthropic' });
  });
});
