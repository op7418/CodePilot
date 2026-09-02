/**
 * Tests for nested OAuth error extraction (issue #464).
 *
 * OpenAI sometimes returns `{ "error": { "message": "..." } }`. The old
 * shallow parse used `j.error` as a truthy object, so users saw
 * `403 - [object Object]`. These cases pin the nested extract order.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractOAuthErrorMessage } from '../../lib/openai-oauth';

describe('extractOAuthErrorMessage', () => {
  it('extracts nested error.message and never returns [object Object]', () => {
    const raw = JSON.stringify({
      error: { message: 'Country, region, or territory not supported' },
    });
    const msg = extractOAuthErrorMessage(raw);
    assert.equal(msg, 'Country, region, or territory not supported');
    assert.equal(msg.includes('[object Object]'), false);
  });

  it('prefers error_description over nested error.message', () => {
    const raw = JSON.stringify({
      error_description: 'invalid_grant: code expired',
      error: { message: 'Country, region, or territory not supported' },
    });
    assert.equal(extractOAuthErrorMessage(raw), 'invalid_grant: code expired');
  });

  it('returns a non-JSON body as-is', () => {
    const raw = 'upstream 502 bad gateway';
    assert.equal(extractOAuthErrorMessage(raw), raw);
  });

  it('falls back to Error.message when the body is empty', () => {
    assert.equal(
      extractOAuthErrorMessage('', new Error('socket hang up')),
      'socket hang up',
    );
  });

  it('stringifies a string error field', () => {
    const raw = JSON.stringify({ error: 'invalid_grant' });
    assert.equal(extractOAuthErrorMessage(raw), 'invalid_grant');
  });
});

describe('openai-oauth-manager lastError pin', () => {
  it('persists openai_oauth_last_error and exposes oauthError', () => {
    const src = readFileSync(
      join(__dirname, '../../lib/openai-oauth-manager.ts'),
      'utf8',
    );
    assert.match(src, /openai_oauth_last_error/);
    assert.match(src, /oauthError/);
  });
});
