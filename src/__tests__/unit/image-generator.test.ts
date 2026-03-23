import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGeminiImageProviderConfig } from '../../lib/image-generator';

describe('image-generator provider config', () => {
  it('forwards custom base URL to Google SDK config', () => {
    const config = resolveGeminiImageProviderConfig({
      api_key: 'gemini-key',
      base_url: 'https://proxy.example.com/google/v1beta',
      extra_env: '{"GEMINI_IMAGE_MODEL":"gemini-3-pro-image-preview"}',
    });

    assert.equal(config.apiKey, 'gemini-key');
    assert.equal(config.baseURL, 'https://proxy.example.com/google/v1beta');
    assert.equal(config.model, 'gemini-3-pro-image-preview');
  });

  it('falls back to default model and omits empty base URL', () => {
    const config = resolveGeminiImageProviderConfig({
      api_key: 'gemini-key',
      base_url: '',
      extra_env: '{}',
    });

    assert.equal(config.apiKey, 'gemini-key');
    assert.equal(config.baseURL, undefined);
    assert.equal(config.model, 'gemini-3.1-flash-image-preview');
  });
});
