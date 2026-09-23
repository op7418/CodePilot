import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDisplayTokenUsage } from '../../lib/token-usage-display';

describe('token usage display validation', () => {
  it('accepts real required counters and supported optional values', () => {
    assert.deepEqual(parseDisplayTokenUsage(JSON.stringify({
      input_tokens: 12,
      output_tokens: 8,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
      cost_usd: 0.0015,
    })), {
      input_tokens: 12,
      output_tokens: 8,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
      cost_usd: 0.0015,
    });
  });

  it('hides the statistic when a required counter is missing or invalid', () => {
    assert.equal(parseDisplayTokenUsage('{"input_tokens":12}'), null);
    assert.equal(parseDisplayTokenUsage('{"input_tokens":12,"output_tokens":null}'), null);
    assert.equal(parseDisplayTokenUsage('{"input_tokens":12,"output_tokens":-1}'), null);
    assert.equal(parseDisplayTokenUsage('{"input_tokens":12,"output_tokens":1.5}'), null);
    assert.equal(parseDisplayTokenUsage('{not-json'), null);
  });

  it('omits invalid optional values without manufacturing replacements', () => {
    assert.deepEqual(parseDisplayTokenUsage({
      input_tokens: 0,
      output_tokens: 4,
      cache_read_input_tokens: '7',
      cache_creation_input_tokens: -2,
      cost_usd: Number.NaN,
    }), {
      input_tokens: 0,
      output_tokens: 4,
    });
  });

  it('keeps only sourced v2 cost/cache facts and drops malformed normalized data', () => {
    const parsed = parseDisplayTokenUsage({
      input_tokens: 20,
      output_tokens: 4,
      normalized: {
        schemaVersion: 2,
        runtimeId: 'codex_runtime',
        source: 'runtime_reported',
        uncachedInputTokens: 15,
        cacheReadInputTokens: 5,
        outputTokens: 4,
        costUsd: 0,
        costSource: 'provider_reported',
      },
    });
    assert.equal(parsed?.normalized?.cacheReadInputTokens, 5);
    assert.equal(parsed?.normalized?.costUsd, 0);

    const malformed = parseDisplayTokenUsage({
      input_tokens: 20,
      output_tokens: 4,
      normalized: { schemaVersion: 2, runtimeId: 'bogus', source: 'runtime_reported' },
    });
    assert.equal(malformed?.normalized, undefined);
  });
});
