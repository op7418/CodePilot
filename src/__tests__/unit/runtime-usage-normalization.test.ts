import '../db-isolation.setup';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { addMessage, createSession, deleteSession, getTokenUsageStats } from '@/lib/db';
import { getExplicitNativeCacheDetails, normalizeTurnUsage } from '@/lib/runtime/turn-usage';

describe('v2 Runtime usage normalization', () => {
  it('does not turn SDK-synthesized Anthropic cache zeroes into provider facts', () => {
    assert.equal(getExplicitNativeCacheDetails({
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
      raw: { input_tokens: 42, output_tokens: 7 },
    }), undefined);
    assert.deepEqual(getExplicitNativeCacheDetails({
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
      raw: {
        input_tokens: 42,
        output_tokens: 7,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }), { cacheRead: 0, cacheWrite: 0 });
  });

  it('copies Claude cache buckets only when the SDK actually reported them', () => {
    assert.deepEqual(normalizeTurnUsage({
      input_tokens: 12,
      output_tokens: 5,
      cost_usd: 0.01,
    }, {
      runtimeId: 'claude_code',
      providerInstanceId: 'anthropic-a',
      modelId: 'sonnet',
    }), {
      schemaVersion: 2,
      runtimeId: 'claude_code',
      providerInstanceId: 'anthropic-a',
      modelId: 'sonnet',
      source: 'runtime_reported',
      uncachedInputTokens: 12,
      outputTokens: 5,
      costUsd: 0.01,
      costSource: 'provider_reported',
    });
  });

  it('derives Native uncached input only from a complete provider detail contract', () => {
    const complete = normalizeTurnUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
    }, { runtimeId: 'codepilot_runtime' });
    assert.equal(complete.uncachedInputTokens, 60);
    assert.equal(complete.cacheReadInputTokens, 30);
    assert.equal(complete.cacheWriteInputTokens, 10);

    const partial = normalizeTurnUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 30,
    }, { runtimeId: 'codepilot_runtime' });
    assert.equal(partial.uncachedInputTokens, undefined);
    assert.equal(partial.cacheReadInputTokens, undefined);
  });

  it('uses Codex total-minus-cached without inventing cache writes', () => {
    const usage = normalizeTurnUsage({
      input_tokens: 90,
      output_tokens: 8,
      cache_read_input_tokens: 40,
    }, { runtimeId: 'codex_runtime' });
    assert.equal(usage.uncachedInputTokens, 50);
    assert.equal(usage.cacheReadInputTokens, 40);
    assert.equal(usage.cacheWriteInputTokens, undefined);
  });
});

describe('usage aggregation preserves unknown cost/cache facts', () => {
  const sessions: string[] = [];

  afterEach(() => {
    for (const id of sessions.splice(0)) deleteSession(id);
  });

  it('returns unknown instead of zero when any turn lacks cost or cache denominator facts', () => {
    const session = createSession('usage truth');
    sessions.push(session.id);
    addMessage(session.id, 'assistant', 'known', JSON.stringify({
      input_tokens: 100,
      output_tokens: 10,
      cost_usd: 0.02,
      normalized: {
        schemaVersion: 2,
        runtimeId: 'claude_code',
        source: 'runtime_reported',
        uncachedInputTokens: 60,
        cacheReadInputTokens: 40,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
        costUsd: 0.02,
        costSource: 'provider_reported',
      },
    }));
    addMessage(session.id, 'assistant', 'unknown cost', JSON.stringify({
      input_tokens: 50,
      output_tokens: 5,
      normalized: {
        schemaVersion: 2,
        runtimeId: 'codex_runtime',
        source: 'runtime_reported',
        outputTokens: 5,
      },
    }));

    const stats = getTokenUsageStats(1);
    assert.equal(stats.summary.total_cost, null);
    assert.equal(stats.summary.cost_known_turns, 1);
    assert.equal(stats.summary.usage_turns, 2);
    assert.equal(stats.summary.cache_rate_complete, false);
    assert.equal(stats.summary.cache_eligible_turns, 1);
    assert.ok(stats.daily.some((row) => row.cost === null));
  });
});
