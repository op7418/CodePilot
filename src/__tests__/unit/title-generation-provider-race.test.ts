/**
 * Same-provider TOCTOU guard for automatic chat titles.
 *
 * The race is intentional: capture provider A exactly, delete A, leave default
 * provider B available, then construct each Runtime's real wire configuration.
 * Both paths must continue to consume A's captured snapshot and must never
 * re-enter the forgiving resolver that would silently return B.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalDataDir = process.env.CLAUDE_GUI_DATA_DIR;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-title-provider-race-db-'));
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-title-provider-race-home-'));

process.env.CLAUDE_GUI_DATA_DIR = tempDataDir;
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  closeDb,
  createProvider,
  deleteProvider,
  setDefaultProviderId,
} = require('../../lib/db') as typeof import('../../lib/db');
const {
  resolveExactProvider,
  resolveProvider,
} = require('../../lib/provider-resolver') as typeof import('../../lib/provider-resolver');
const {
  prepareGenerateTextViaSdkCall,
} = require('../../lib/claude-client') as typeof import('../../lib/claude-client');
const { createModel } = require('../../lib/ai-provider') as typeof import('../../lib/ai-provider');

let fixtureIndex = 0;

function seedRace() {
  fixtureIndex += 1;
  const providerA = createProvider({
    name: `Pinned Vendor A ${fixtureIndex}`,
    provider_type: 'anthropic',
    protocol: 'anthropic',
    base_url: `https://vendor-a-${fixtureIndex}.example.com`,
    api_key: `test-key-a-${fixtureIndex}`,
  });
  const providerB = createProvider({
    name: `Default Vendor B ${fixtureIndex}`,
    provider_type: 'anthropic',
    protocol: 'anthropic',
    base_url: `https://vendor-b-${fixtureIndex}.example.com`,
    api_key: `test-key-b-${fixtureIndex}`,
  });
  setDefaultProviderId(providerB.id);

  const captured = resolveExactProvider(providerA.id);
  assert.ok(captured, 'precondition: provider A resolves exactly before deletion');
  assert.equal(deleteProvider(providerA.id), true);
  assert.equal(
    resolveProvider({ providerId: providerA.id }).provider?.id,
    providerB.id,
    'precondition: a fresh forgiving resolution would retarget to B',
  );

  return { providerA, providerB, captured };
}

after(() => {
  closeDb();
  if (originalDataDir !== undefined) process.env.CLAUDE_GUI_DATA_DIR = originalDataDir;
  else delete process.env.CLAUDE_GUI_DATA_DIR;
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
  else delete process.env.USERPROFILE;
  fs.rmSync(tempDataDir, { recursive: true, force: true });
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('automatic title provider snapshot survives deletion without cross-provider fallback', () => {
  it('Claude Code wire uses captured A endpoint and credential, never default B', () => {
    const { providerA, providerB, captured } = seedRace();
    const prepared = prepareGenerateTextViaSdkCall(
      {
        callScene: 'automatic_title',
        providerId: providerA.id,
        resolvedProvider: captured,
        model: 'claude-haiku-4-5',
        system: 'Write a title.',
        prompt: 'User text',
        isolate: true,
      },
      new AbortController(),
    );

    try {
      assert.strictEqual(prepared.resolved, captured, 'wire builder must consume the captured object');
      const env = prepared.queryOptions.env as Record<string, string>;
      assert.equal(env.ANTHROPIC_BASE_URL, providerA.base_url);
      assert.equal(env.ANTHROPIC_API_KEY, providerA.api_key);
      assert.notEqual(env.ANTHROPIC_BASE_URL, providerB.base_url);
      assert.notEqual(env.ANTHROPIC_API_KEY, providerB.api_key);
    } finally {
      prepared.cleanup();
    }
  });

  it('CodePilot Runtime model factory uses captured A config, never default B', () => {
    const { providerA, providerB, captured } = seedRace();
    const created = createModel({
      callScene: 'automatic_title',
      providerId: providerA.id,
      resolvedProvider: captured,
      model: 'claude-haiku-4-5',
    });

    assert.strictEqual(created.resolved, captured, 'model factory must consume the captured object');
    assert.equal(created.config.baseUrl, providerA.base_url);
    assert.equal(created.config.apiKey, providerA.api_key);
    assert.notEqual(created.config.baseUrl, providerB.base_url);
    assert.notEqual(created.config.apiKey, providerB.api_key);
  });
});
