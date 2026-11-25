import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../../lib/error-classifier';

describe('error-classifier', () => {
  it('classifies 503 provider responses as temporarily unavailable', () => {
    const result = classifyError({
      error: new Error('HTTP 503: {"error":"Service temporarily unavailable"}'),
      providerName: 'Third-party Provider',
    });

    assert.equal(result.category, 'PROVIDER_UNAVAILABLE');
    assert.equal(result.retryable, true);
    assert.ok(result.userMessage.includes('Third-party Provider'));
    assert.ok(result.actionHint.includes('model name mapping'));
  });
});
