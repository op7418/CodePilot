import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(
  path.resolve(__dirname, '../../components/settings/ProviderManager.tsx'),
  'utf8',
);

describe('xAI dual-channel Settings contract', () => {
  it('keeps API Key and OAuth as distinct user-visible entries', () => {
    assert.match(source, /OFFICIAL_DIRECT_API_KEYS[\s\S]*'xai'/);
    assert.match(source, /key:\s*'xai-oauth'/);
    assert.match(source, /name:\s*'xAI Grok OAuth'/);
    assert.match(source, /API Key remains available/);
  });

  it('offers browser and device-code as methods of one OAuth identity', () => {
    assert.match(source, /handleXaiLogin\('browser'\)/);
    assert.match(source, /handleXaiLogin\('device'\)/);
    assert.match(source, /verificationUriComplete \|\| xaiDevice\.verificationUri/);
    assert.doesNotMatch(source, /key:\s*'xai-oauth-(browser|device)'/);
  });

  it('locks the dialog to the chosen method so browser login never asks for a device code', () => {
    assert.match(source, /xaiLoginMethod === 'browser'/);
    assert.match(source, /此流程不需要设备码/);
    assert.match(source, /no device code is required/);
    assert.match(source, /xaiLoginMethod === 'browser'[\s\S]*xaiDevice \?/);
  });

  it('keeps a disabled OAuth entry visible with a reason and API-key fallback', () => {
    assert.match(source, /disabledReason/);
    assert.match(source, /disabled:\s*xaiAuth\?\.enabled === false/);
    assert.match(source, /entry\.disabled/);
    assert.match(source, /已关闭|Disabled/);
  });

  it('connected card exposes local logout and the manual account-management link', () => {
    assert.match(source, /onDelete=\{handleXaiLogout\}/);
    assert.match(source, /href=\{xaiAuth\.accountUrl\}/);
    assert.match(source, /accounts\.x\.ai/);
  });

  it('does not fabricate a quota, percentage, or plan name for xAI OAuth', () => {
    const xaiCard = source.slice(
      source.indexOf("{xaiAuth?.authenticated && ("),
      source.indexOf("{codexAccount?.kind === 'logged_in'", source.indexOf("{xaiAuth?.authenticated && (")),
    );
    assert.doesNotMatch(xaiCard, /quota|remaining|percentage|\bPro\b|\bPremium\b/i);
    assert.match(xaiCard, /Billing source/);
  });

  it('cancels both server flow and UI polling when the dialog closes', () => {
    assert.match(source, /xaiPollTimerRef/);
    assert.match(source, /clearInterval\(xaiPollTimerRef\.current\)/);
    assert.match(source, /fetch\('\/api\/xai-oauth\/cancel', \{ method: 'POST' \}\)/);
  });

  it('uses the server flow lifetime and cancels the server when the UI deadline expires', () => {
    assert.match(source, /data\.expiresIn \* 1000/);
    assert.match(source, /pollXaiOAuthCompletion\(serverLifetimeMs \+ 5_000\)/);
    assert.match(source, /Date\.now\(\) >= deadline[\s\S]*cancelXaiOAuthAttempt\(\)/);
  });
});
