/**
 * Smoke-fix (2026-06-02) — `Settings page loads @smoke` caught a 404:
 *   GET /api/providers/codex_account/models?all=1 → 404 "Provider not found".
 *
 * codex_account is the Codex (ChatGPT) OAuth virtual provider — it routes
 * through Codex's app-server and has no api_providers row / no provider_models.
 * The overview's per-provider manual-count loop excluded `env` and
 * `openai-oauth` but NOT `codex_account`, so it fired the per-provider fetch
 * and 404'd, reddening the Settings smoke (page rendered fine — just console
 * noise). Fix: skip all virtual / non-DB providers via a named set.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isCountableDbProvider, NON_DB_PROVIDER_IDS } from '@/components/settings/useOverviewData';

describe('overview model-count loop skips virtual / non-DB providers', () => {
  it('excludes codex_account (the 404 source)', () => {
    assert.equal(isCountableDbProvider('codex_account'), false);
  });

  it('also excludes env + OAuth virtual providers', () => {
    assert.equal(isCountableDbProvider('env'), false);
    assert.equal(isCountableDbProvider('openai-oauth'), false);
    assert.equal(isCountableDbProvider('xai-oauth'), false);
  });

  it('still counts real DB providers', () => {
    assert.equal(isCountableDbProvider('deepseek-abc123'), true);
    assert.equal(isCountableDbProvider('openrouter'), true);
  });

  it('NON_DB_PROVIDER_IDS is exactly the known virtual ids', () => {
    assert.deepEqual([...NON_DB_PROVIDER_IDS].sort(), ['codex_account', 'env', 'openai-oauth', 'xai-oauth']);
  });

  it('source: the count loop filters via isCountableDbProvider (not an ad-hoc !== chain)', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../components/settings/useOverviewData.ts'),
      'utf8',
    );
    assert.match(
      src,
      /dbGroupsToCount = groups\.filter\(\(g\) => isCountableDbProvider\(g\.provider_id\)\)/,
      'the manual-count loop must filter virtual providers via isCountableDbProvider',
    );
  });
});
