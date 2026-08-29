/**
 * Phase 4 / #577A (2026-06-02) — Xiaomi MiMo model "reverts" to mimo-v2-pro.
 *
 * Investigation verdict: there is NO overwrite of saved data. The MiMo presets
 * declared `fields: ['api_key']` (no model field), so the connect dialog saved
 * `role_models_json: '{}'`, and the resolver (provider-resolver.ts ~987) then
 * back-fills the stale catalog default `mimo-v2-pro` on every send. The user's
 * v2.5 choice was never persisted to the field the resolver reads.
 *
 * Fix: expose `model_names` for both MiMo presets so the user CAN set their
 * model (persisted to role_models_json.default), and pre-fill the connect
 * dialog's model field from the preset default. The resolver already honors a
 * non-empty role_models_json.default — these tests pin that guarantee + the
 * preset/wiring changes.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VENDOR_PRESETS } from '@/lib/provider-catalog';

// ── Catalog: MiMo presets expose model_names + carry a default model ─────────

describe('MiMo presets expose a model field (#577A)', () => {
  const mimoPresets = VENDOR_PRESETS.filter((p) => p.key.startsWith('xiaomi-mimo'));

  it('there are MiMo presets to begin with', () => {
    assert.ok(mimoPresets.length >= 2, 'expected pay-as-you-go + token-plan MiMo presets');
  });

  it('every MiMo preset includes model_names so the user can set their model', () => {
    for (const p of mimoPresets) {
      assert.ok(
        p.fields.includes('model_names'),
        `${p.key} must expose model_names (without it role_models_json stays "{}" and the resolver re-fills the stale default)`,
      );
    }
  });

  it('every MiMo preset still carries a default model id (for pre-fill + back-compat)', () => {
    for (const p of mimoPresets) {
      const def = p.defaultRoleModels?.default ?? p.defaultModels?.[0]?.upstreamModelId;
      assert.ok(def, `${p.key} must have a default model id`);
    }
  });
});

// ── DB integration: a user-set MiMo model is honored, not reverted ───────────

const originalDataDir = process.env.CLAUDE_GUI_DATA_DIR;
const originalApiKey = process.env.ANTHROPIC_API_KEY;
const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let tempDataDir: string;
let tempHome: string;

beforeEach(() => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-mimo-db-'));
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-mimo-home-'));
  process.env.CLAUDE_GUI_DATA_DIR = tempDataDir;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});

afterEach(() => {
  if (originalDataDir !== undefined) process.env.CLAUDE_GUI_DATA_DIR = originalDataDir;
  else delete process.env.CLAUDE_GUI_DATA_DIR;
  if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
  if (originalAuthToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
  if (originalHome !== undefined) process.env.HOME = originalHome; else delete process.env.HOME;
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile; else delete process.env.USERPROFILE;
  try { fs.rmSync(tempDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function createMimoProvider(roleModels: Record<string, string>) {
  const { createProvider } = await import('../../lib/db');
  return createProvider({
    name: 'Xiaomi MiMo',
    provider_type: 'anthropic',
    base_url: 'https://api.xiaomimimo.com/anthropic',
    api_key: 'sk-mimo',
    role_models_json: JSON.stringify(roleModels),
  });
}

describe('MiMo resolver honors a user-set model (no silent revert) — #577A', () => {
  it('a user-set role_models_json.default is used verbatim, NOT reverted to mimo-v2-pro', async () => {
    const provider = await createMimoProvider({ default: 'mimo-v2.5-pro' });
    const { resolveProvider, toClaudeCodeEnv } = await import('../../lib/provider-resolver');
    const resolved = resolveProvider({ providerId: provider.id });
    const env = toClaudeCodeEnv({}, resolved);
    assert.equal(env.ANTHROPIC_MODEL, 'mimo-v2.5-pro', 'user MiMo model must be honored');
    assert.notEqual(env.ANTHROPIC_MODEL, 'mimo-v2-pro', 'must not revert to the stale catalog default');
  });

  it('an EMPTY role_models_json still back-fills the catalog default — exactly why the connect dialog must persist a value', async () => {
    const provider = await createMimoProvider({});
    const { resolveProvider, toClaudeCodeEnv } = await import('../../lib/provider-resolver');
    const resolved = resolveProvider({ providerId: provider.id });
    const env = toClaudeCodeEnv({}, resolved);
    assert.equal(
      env.ANTHROPIC_MODEL,
      // Merge decision (2026-06-04 integration rehearsal): catalog default is
      // main's `mimo-v2.5-pro` (B-020 — users want 2.5 Pro), with the worktree's
      // #577 `model_names` override mechanism preserved on top. Was `mimo-v2-pro`
      // on the worktree branch alone.
      'mimo-v2.5-pro',
      'empty mapping back-fills the preset default — the model_names field now lets the user override it',
    );
  });

  it('a user who selects UltraSpeed gets it verbatim (no revert to mimo-v2.5-pro)', async () => {
    const provider = await createMimoProvider({ default: 'mimo-v2.5-pro-ultraspeed' });
    const { resolveProvider, toClaudeCodeEnv } = await import('../../lib/provider-resolver');
    const resolved = resolveProvider({ providerId: provider.id });
    const env = toClaudeCodeEnv({}, resolved);
    assert.equal(env.ANTHROPIC_MODEL, 'mimo-v2.5-pro-ultraspeed', 'user-picked UltraSpeed must be honored verbatim');
  });
});

// ── Wiring source pins (connect dialog pre-fill) ─────────────────────────────

describe('connect dialog pre-fills exposed model fields from the preset default (#577A)', () => {
  const presetsSrc = fs.readFileSync(
    path.resolve(__dirname, '../../components/settings/provider-presets.tsx'),
    'utf8',
  );
  const dialogSrc = fs.readFileSync(
    path.resolve(__dirname, '../../components/settings/PresetConnectDialog.tsx'),
    'utf8',
  );

  it('QuickPreset carries defaultModelId from the catalog', () => {
    assert.match(
      presetsSrc,
      /defaultModelId:\s*vp\.defaultRoleModels\?\.default\s*\?\?\s*vp\.defaultModels\?\.\[0\]\?\.upstreamModelId/,
      'toQuickPreset must expose the catalog default model id',
    );
  });

  it('create mode pre-fills modelName only when the preset exposes model_names', () => {
    assert.match(
      dialogSrc,
      /setModelName\(\s*preset\.fields\.includes\("model_names"\)\s*\?\s*\(preset\.defaultModelId \|\| ""\)\s*:\s*""\s*,?\s*\)/,
      'create mode must pre-fill the model field from the preset default without seeding a hidden default for mapping-only presets',
    );
  });
});

// ── MiMo UltraSpeed — PAYG/API only, never the default, never on Token Plan ──

describe('MiMo UltraSpeed model (2026-06-09)', () => {
  const payg = VENDOR_PRESETS.find((p) => p.key === 'xiaomi-mimo');
  const tokenPlan = VENDOR_PRESETS.find((p) => p.key === 'xiaomi-mimo-token-plan');
  const hasUltraSpeed = (preset?: { defaultModels: { modelId: string; upstreamModelId?: string }[] }) =>
    !!preset?.defaultModels.some(
      (m) => m.modelId === 'mimo-v2.5-pro-ultraspeed' || m.upstreamModelId === 'mimo-v2.5-pro-ultraspeed',
    );

  it('PAYG (API) preset offers mimo-v2.5-pro-ultraspeed as a selectable model', () => {
    assert.ok(payg, 'xiaomi-mimo PAYG preset must exist');
    assert.ok(hasUltraSpeed(payg), 'PAYG preset must include UltraSpeed as an optional model');
  });

  it('UltraSpeed is NOT the default — default stays mimo-v2.5-pro (approval-gated model)', () => {
    assert.equal(payg!.defaultRoleModels?.default, 'mimo-v2.5-pro');
  });

  it('Token Plan preset does NOT include UltraSpeed (no Token-Plan doc/smoke yet)', () => {
    assert.ok(tokenPlan, 'token-plan preset must exist');
    assert.ok(!hasUltraSpeed(tokenPlan), 'UltraSpeed must NOT be added to the token-plan preset');
  });
});
