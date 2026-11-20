import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(
  path.resolve(__dirname, '../../components/settings/ProviderManager.tsx'),
  'utf8',
);
const enSrc = readFileSync(
  path.resolve(__dirname, '../../i18n/en.ts'),
  'utf8',
);
const zhSrc = readFileSync(
  path.resolve(__dirname, '../../i18n/zh.ts'),
  'utf8',
);

describe('xAI dual-channel Settings contract', () => {
  it('keeps API Key and OAuth as distinct user-visible entries', () => {
    assert.match(source, /OFFICIAL_DIRECT_API_KEYS[\s\S]*'xai'/);
    assert.match(source, /key:\s*'xai-oauth'/);
    assert.match(source, /name:\s*'Grok Build OAuth'/);
    assert.match(source, /provider\.mgr\.xaiOAuthDesc/);
    assert.match(source, /provider\.mgr\.xaiLoginDesc/);
    assert.match(enSrc, /'provider\.mgr\.xaiOAuthDesc':[\s\S]{0,160}API Key remains available/);
    assert.match(enSrc, /'provider\.mgr\.xaiLoginDesc':[\s\S]{0,160}public Grok Build OAuth client/);
  });

  it('offers browser and device-code as methods of one OAuth identity', () => {
    assert.match(source, /handleXaiLogin\('browser'\)/);
    assert.match(source, /handleXaiLogin\('device'\)/);
    assert.match(source, /verificationUriComplete \|\| xaiDevice\.verificationUri/);
    assert.doesNotMatch(source, /key:\s*'xai-oauth-(browser|device)'/);
  });

  it('locks the dialog to the chosen method so browser login never asks for a device code', () => {
    assert.match(source, /xaiLoginMethod === 'browser'/);
    assert.match(source, /provider\.mgr\.xaiBrowserHint/);
    assert.match(zhSrc, /'provider\.mgr\.xaiBrowserHint':[\s\S]{0,160}此流程不需要设备码/);
    assert.match(enSrc, /'provider\.mgr\.xaiBrowserHint':[\s\S]{0,200}no device code is required/);
    assert.match(source, /xaiLoginMethod === 'browser'[\s\S]*xaiDevice \?/);
  });

  it('keeps a disabled OAuth entry visible with a reason and API-key fallback', () => {
    assert.match(source, /disabledReason/);
    assert.match(source, /disabled:\s*xaiAuth\?\.enabled === false/);
    assert.match(source, /entry\.disabled/);
    assert.match(source, /provider\.mgr\.disabled/);
    assert.match(zhSrc, /'provider\.mgr\.disabled':\s*'已关闭'/);
    assert.match(enSrc, /'provider\.mgr\.disabled':\s*'Disabled'/);
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
    assert.match(xaiCard, /provider\.mgr\.billingSource/);
    assert.match(enSrc, /'provider\.mgr\.billingSource':\s*'Billing source'/);
  });

  it('surfaces the OAuth entitlement in Image & video providers and wires it to the image default', () => {
    assert.match(source, /provider\.mediaProviders/);
    assert.match(source, /Grok Imagine Image 2\.0/);
    assert.match(source, /Grok Imagine Video 1\.5/);
    assert.match(source, /setActiveImageProvider\('xai-oauth'\)/);
    assert.match(source, /xaiAuth\?\.usable/);
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
