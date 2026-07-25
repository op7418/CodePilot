/**
 * OpenAI-compatible third-party provider — end-to-end classification (2026-06-09).
 *
 * Pins the fix for the "runtime classification reverses" P0: a generic
 * openai-compatible gateway (user-supplied base_url) must classify as
 * `codepilot_only` — CodePilot + Codex runtimes, Claude Code gated — NOT fall
 * through to `unknown` (which would expose it to Claude Code and gate Codex,
 * the exact opposite of intent). The chain is:
 *   provider_type 'openai-compatible'
 *     → findMatchingPresetForRecord → generic 'openai-compatible' preset
 *     → getProviderCompat → 'codepilot_only'
 *     → getModelCompat → supportedRuntimes [codepilot, codex], claude_code gated.
 *
 * See docs/exec-plans/active/mimo-ultraspeed-openai-compatible-provider.md.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { findMatchingPresetForRecord, getEffectiveProviderProtocol } from '@/lib/provider-catalog';
import { getProviderCompat, getModelCompat, compatLabel, compatTooltip } from '@/lib/runtime-compat';
import { POST as providersPOST } from '../../app/api/providers/route';
import { PUT as providerPUT } from '../../app/api/providers/[id]/route';

// A generic third-party gateway with an arbitrary URL — the case that used to
// fall through every matcher branch and land in `unknown`.
const GW = {
  preset_key: '',
  protocol: 'openai-compatible',
  provider_type: 'openai-compatible',
  base_url: 'https://my-gateway.example.com/v1',
};

describe('openai-compatible classification end-to-end (P0: must not reverse)', () => {
  it('an arbitrary-URL openai-compatible gateway claims the openai-compatible preset (not undefined → unknown)', () => {
    const preset = findMatchingPresetForRecord(GW);
    assert.ok(preset, 'arbitrary-URL openai-compatible provider must claim a preset');
    assert.equal(preset!.key, 'openai-compatible');
    assert.equal(preset!.protocol, 'openai-compatible');
  });

  it('getProviderCompat classifies it as codepilot_only', () => {
    assert.equal(getProviderCompat(GW), 'codepilot_only');
  });

  it('codepilot_only → CodePilot + Codex runtimes, Claude Code gated (the reversed bug would expose Claude Code / gate Codex)', () => {
    const cap = getModelCompat({ modelId: 'sample', providerCompat: getProviderCompat(GW) });
    assert.deepEqual(
      [...(cap.supportedRuntimes ?? [])].sort(),
      ['codepilot_runtime', 'codex_runtime'],
    );
    assert.ok(cap.unsupportedReasonByRuntime?.claude_code, 'Claude Code must carry a gated reason');
    assert.equal(cap.unsupportedReasonByRuntime?.codex_runtime, undefined, 'Codex must NOT be gated');
  });

  it('effective protocol of an openai-compatible provider_type is openai-compatible (even without a raw protocol)', () => {
    assert.equal(getEffectiveProviderProtocol('openai-compatible', '', GW.base_url, ''), 'openai-compatible');
    assert.equal(getEffectiveProviderProtocol('openai-compatible', 'openai-compatible', GW.base_url, ''), 'openai-compatible');
  });
});

// ── DB: created openai-compatible providers must survive (no destructive migration) ──

const originalDataDir = process.env.CLAUDE_GUI_DATA_DIR;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let tempDataDir: string;
let tempHome: string;

beforeEach(() => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-oai-db-'));
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-oai-home-'));
  process.env.CLAUDE_GUI_DATA_DIR = tempDataDir;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  if (originalDataDir !== undefined) process.env.CLAUDE_GUI_DATA_DIR = originalDataDir; else delete process.env.CLAUDE_GUI_DATA_DIR;
  if (originalHome !== undefined) process.env.HOME = originalHome; else delete process.env.HOME;
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile; else delete process.env.USERPROFILE;
  try { fs.rmSync(tempDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('openai-compatible providers are not wiped (P0 no-delete migration)', () => {
  it('the destructive DELETE migration is removed from db.ts (prevents reintroduction)', () => {
    // migrateDb() is module-private and can't be re-run in isolation, so the
    // restart-tolerance guarantee is pinned at the source: the only path that
    // ever removed these rows was this DELETE. It must stay gone.
    const dbSrc = fs.readFileSync(path.resolve(__dirname, '../../lib/db.ts'), 'utf8');
    // Match the executable db.exec(...) form only — the surrounding history
    // comment legitimately quotes the old SQL, so a bare-string match would
    // false-positive on the documentation.
    assert.doesNotMatch(
      dbSrc,
      /db\.exec\(\s*["']DELETE FROM api_providers WHERE protocol = 'openai-compatible'/,
      'the openai-compatible DELETE migration must stay removed — it wiped user-created providers on restart',
    );
  });

  it('a created openai-compatible provider persists and round-trips with provider_type + protocol intact', async () => {
    const { createProvider, getAllProviders } = await import('../../lib/db');
    const created = createProvider({
      name: 'My Gateway',
      provider_type: 'openai-compatible',
      protocol: 'openai-compatible',
      base_url: 'https://my-gateway.example.com/v1',
      api_key: 'sk-gw',
    });
    const found = getAllProviders().find(p => p.id === created.id);
    assert.ok(found, 'openai-compatible provider must persist');
    assert.equal(found!.provider_type, 'openai-compatible');
    assert.equal(found!.protocol, 'openai-compatible');
  });
});

// ── Wiring source pins (client/JSX + runtime path can't be imported cleanly) ──

describe('openai-compatible wiring source pins', () => {
  it('renderer findMatchingPreset delegates to the shared identity resolver', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../components/settings/provider-presets.tsx'), 'utf8');
    assert.match(
      src,
      /resolveProviderPresetIdentity\(provider\)/,
      'renderer matcher must consume the same identity resolver as the server',
    );
  });

  it('ai-provider routes the non-OAuth openai path through chat-completions (.chat), not the Responses default', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../lib/ai-provider.ts'), 'utf8');
    assert.match(
      src,
      /return openai\.chat\(config\.modelId\)/,
      'openai-compatible/openrouter/proxy path must use openai.chat() — bare openai() defaults to /v1/responses in @ai-sdk/openai v3',
    );
    assert.doesNotMatch(
      src,
      /return openai\(config\.modelId\)/,
      'the bare openai(modelId) Responses-default call must be gone from the non-OAuth path',
    );
  });

  it('ProviderForm exposes openai-compatible as a selectable type with the openai-compatible protocol (not anthropic)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../components/settings/ProviderForm.tsx'), 'utf8');
    assert.match(
      src,
      // [^\n]* (not [^}]*) — the preset is one line and contains extra_env: "{}",
      // whose `}` would otherwise truncate the match before `protocol`.
      /"openai-compatible":\s*\{[^\n]*protocol:\s*"openai-compatible"/,
      'PROVIDER_PRESETS must map openai-compatible → protocol openai-compatible (not custom-as-anthropic)',
    );
    assert.match(src, /value:\s*"openai-compatible"/, 'PROVIDER_TYPES must list openai-compatible');
  });
});

// ── API base_url guards (POST + PUT): empty URL must not fall back to api.openai.com ──

function jsonReq(url: string, method: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('openai-compatible base_url guards (no silent fallback to official OpenAI)', () => {
  it('POST rejects openai-compatible with an empty base_url', async () => {
    const res = await providersPOST(jsonReq('http://localhost/api/providers', 'POST', {
      name: '__test_oai_post_empty',
      provider_type: 'openai-compatible',
      protocol: 'openai-compatible',
      base_url: '',
      api_key: 'sk-x',
      extra_env: '{}',
    }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'OPENAI_COMPATIBLE_BASE_URL_REQUIRED');
  });

  it('POST accepts openai-compatible when a base_url is provided', async () => {
    const res = await providersPOST(jsonReq('http://localhost/api/providers', 'POST', {
      name: '__test_oai_post_ok',
      provider_type: 'openai-compatible',
      protocol: 'openai-compatible',
      base_url: 'https://gw.example.com/v1',
      api_key: 'sk-x',
      extra_env: '{}',
    }));
    assert.equal(res.status, 201);
  });

  it('PUT rejects clearing base_url on an openai-compatible provider', async () => {
    const { createProvider } = await import('../../lib/db');
    const created = createProvider({
      name: '__test_oai_put',
      provider_type: 'openai-compatible',
      protocol: 'openai-compatible',
      base_url: 'https://gw.example.com/v1',
      api_key: 'sk-x',
    });
    const res = await providerPUT(
      jsonReq(`http://localhost/api/providers/${created.id}`, 'PUT', { base_url: '' }),
      { params: Promise.resolve({ id: created.id }) },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'OPENAI_COMPATIBLE_BASE_URL_REQUIRED');
  });
});

describe('codepilot_only runtime copy reflects CodePilot + Codex (P2 semantic acceptance)', () => {
  for (const isZh of [true, false]) {
    it(`label + tooltip mention Codex and do not claim CodePilot-only (${isZh ? 'zh' : 'en'})`, () => {
      const label = compatLabel('codepilot_only', isZh);
      const tip = compatTooltip('codepilot_only', isZh);
      assert.match(label, /Codex/i, 'label must mention Codex');
      assert.match(tip, /Codex/i, 'tooltip must mention Codex');
      assert.doesNotMatch(
        tip,
        /only reachable from CodePilot Runtime|仅在 CodePilot Runtime 下可用/i,
        'tooltip must not claim CodePilot-only',
      );
    });
  }
});

describe('test-connection routes openai-compatible to an OpenAI-shape probe (source pin)', () => {
  // claude-client.ts statically imports @anthropic-ai/claude-agent-sdk, so it
  // can't be imported cheaply in a unit test — pin the fix at the source.
  it('claude-client probes openai-compatible with a base-URL guard + Bearer auth, not the Anthropic /v1/messages fallback', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../lib/claude-client.ts'), 'utf8');
    assert.match(
      src,
      /config\.protocol === 'openai-compatible'[\s\S]{0,200}testOpenAICompatibleConnection/,
      'testProviderConnection must route openai-compatible to its own probe before the Anthropic fallback',
    );
    assert.match(
      src,
      /testOpenAICompatibleConnection[\s\S]{0,700}MISSING_BASE_URL/,
      'the probe must reject an empty base URL (so the key never falls back to api.anthropic.com)',
    );
    assert.match(
      src,
      /testOpenAICompatibleConnection[\s\S]{0,900}Bearer \$\{config\.apiKey\}/,
      'the probe must use Bearer auth (OpenAI shape), not x-api-key',
    );
  });
});
