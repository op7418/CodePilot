/**
 * Regression tests for review-driven fixes in provider-resolver.ts.
 *
 * Pins two pieces of behavior so they don't silently regress:
 *
 * 1. settingSources for DB-backed providers is `['user']` only —
 *    'project' and 'local' are dropped to prevent cwd .claude/settings.json
 *    or .claude/settings.local.json from overriding the selected DB
 *    provider's auth via the SDK's qZq() env loader. The user layer is
 *    safe because per-request shadow HOME (claude-home-shadow.ts) writes
 *    a stripped settings.json; the project/local layers can't be shadowed
 *    the same way without breaking file-creation tools (Edit/Write
 *    relative paths), so we exclude them from settingSources entirely.
 *    Project CLAUDE.md and `.mcp.json` are still loaded — by CodePilot's
 *    context-assembler and mcp-loader respectively — independent of
 *    settingSources. Env mode keeps all 3 sources.
 *
 * 2. Short-alias fallback (sonnet/opus/haiku → upstream model) only fires
 *    when the provider has EXACTLY ONE model in its catalog.
 *    Why: Multi-model providers (e.g. OpenRouter with dozens) must NOT
 *    silently rewrite the user's "haiku" choice to "first-in-list", because
 *    that's a hard-to-diagnose behavior + cost change. For multi-model
 *    providers we keep the alias and let upstream return its real "model
 *    not found" error so the user can fix their config.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalDataDir = process.env.CLAUDE_GUI_DATA_DIR;
const originalApiKey = process.env.ANTHROPIC_API_KEY;
const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

let tempDataDir: string;
let tempHome: string;

beforeEach(() => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-resolverfix-db-'));
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-resolverfix-home-'));
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

function writeUserSettingsJson(creds: Record<string, string>) {
  const dir = path.join(tempHome, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: creds }));
}

// ────────────────────────────────────────────────────────────────
// Fix #1: settingSources is ['user'] for DB providers — drop 'project' and
// 'local' to prevent cwd-level settings env from bleeding into the
// explicitly selected provider's auth. Env mode keeps all 3.
// ────────────────────────────────────────────────────────────────

describe('settingSources by provider group', () => {
  it('DB-backed provider gets settingSources=["user"] only — drops project/local', async () => {
    writeUserSettingsJson({
      ANTHROPIC_BASE_URL: 'https://leak-source.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-cc-switch-present',
    });

    const { createProvider } = await import('../../lib/db');
    const provider = createProvider({
      name: 'Explicit Provider',
      provider_type: 'anthropic',
      base_url: 'https://api.real-provider.example.com',
      api_key: 'sk-real-provider',
    });

    const { resolveProvider } = await import('../../lib/provider-resolver');
    const resolved = resolveProvider({ providerId: provider.id });

    assert.ok(resolved.provider, 'expected DB provider to resolve');
    assert.deepEqual(
      resolved.settingSources,
      ['user'],
      [
        'DB-backed provider must include "user" — needed for user-level MCP/plugins/hooks discovery',
        '(env-bleed at user layer is handled by per-request shadow HOME, see claude-home-shadow.ts).',
        'But MUST drop "project" and "local" — the SDK qZq() env loader applies env from EVERY',
        'enabled settingSource layer, and project/local layers cannot be shadowed without breaking',
        'file-creation tools (relative paths). Project CLAUDE.md / .mcp.json are loaded',
        "independently by CodePilot, so they don't need 'project' settingSource.",
      ].join(' '),
    );
  });

  it('env-mode (no DB provider) keeps all three sources so cc-switch + project Claude config work', async () => {
    writeUserSettingsJson({ ANTHROPIC_AUTH_TOKEN: 'sk-cc-switch' });

    const { resolveProvider } = await import('../../lib/provider-resolver');
    const resolved = resolveProvider({});

    assert.equal(resolved.provider, undefined, 'expected env mode (no DB provider)');
    assert.deepEqual(
      resolved.settingSources,
      ['user', 'project', 'local'],
      'env mode (Claude Code group) keeps all sources — full Claude Code config experience including project hooks/permissions',
    );
    assert.equal(resolved.hasCredentials, true);
  });

  it('DB provider — project/local cwd settings can never be exposed to SDK (defense-in-depth)', async () => {
    // Regression test for the P2 review finding: even if a user has
    // <cwd>/.claude/settings.json with ANTHROPIC_BASE_URL, the SDK must
    // never see it for a DB-provider request, because we drop 'project'
    // from settingSources entirely. Asserting at the resolver layer means
    // no caller (chat, generateText, doctor probe) can be tricked into
    // exposing it.
    const { createProvider } = await import('../../lib/db');
    const provider = createProvider({
      name: 'Kimi',
      provider_type: 'anthropic',
      base_url: 'https://kimi.example.com',
      api_key: 'sk-kimi',
    });

    const { resolveProvider } = await import('../../lib/provider-resolver');
    const resolved = resolveProvider({ providerId: provider.id });

    assert.ok(!resolved.settingSources.includes('project'),
      'DB provider settingSources must not include "project" — that would expose <cwd>/.claude/settings.json env to SDK qZq()');
    assert.ok(!resolved.settingSources.includes('local'),
      'DB provider settingSources must not include "local" — that would expose <cwd>/.claude/settings.local.json env to SDK qZq()');
  });
});

// ────────────────────────────────────────────────────────────────
// Fix #2: short-alias fallback only for single-model providers
// ────────────────────────────────────────────────────────────────

describe('short-alias fallback narrowed to single-model providers', () => {
  it('multi-model provider preserves the user-selected alias (no silent rewrite)', async () => {
    const { toAiSdkConfig } = await import('../../lib/provider-resolver');

    // Simulate a resolved provider with MULTIPLE models in its catalog
    const resolved = {
      provider: {
        id: 'or', name: 'OpenRouter', preset_key: 'openrouter', provider_type: 'anthropic', protocol: 'anthropic',
        base_url: 'https://openrouter.ai/api/v1', api_key: 'sk-or',
        is_active: 1, sort_order: 0, extra_env: '{}', headers_json: '{}',
        env_overrides_json: '', role_models_json: '{}', notes: '', options_json: '{}',
        created_at: '', updated_at: '',
      },
      protocol: 'anthropic' as const,
      authStyle: 'api_key' as const,
      model: 'haiku',
      modelDisplayName: 'Haiku 4.5',
      upstreamModel: 'haiku',
      headers: {},
      envOverrides: {},
      roleModels: {},  // no role mapping
      hasCredentials: true,
      availableModels: [
        { modelId: 'gpt-5', upstreamModelId: 'openai/gpt-5', displayName: 'GPT-5' },
        { modelId: 'gemini', upstreamModelId: 'google/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
        { modelId: 'kimi-k2', upstreamModelId: 'moonshot/kimi-k2', displayName: 'Kimi K2' },
      ],
      settingSources: ['project', 'local'],
    };

    const config = toAiSdkConfig(resolved, 'haiku');
    // CRITICAL: must keep "haiku" so upstream returns "model not found" and
    // user knows to configure role_models_json. Must NOT silently use openai/gpt-5.
    assert.equal(
      config.modelId, 'haiku',
      `multi-model provider must preserve alias instead of falling back to availableModels[0]; got ${config.modelId}`,
    );
  });

  it('single-model provider does fall back (alias was just a placeholder)', async () => {
    const { toAiSdkConfig } = await import('../../lib/provider-resolver');

    // Single-model "套餐型" provider: only one upstream model in catalog
    const resolved = {
      provider: {
        id: 'p1', name: 'PackyCode-Sonnet', preset_key: '', provider_type: 'anthropic', protocol: 'anthropic',
        base_url: 'https://relay.example.com', api_key: 'sk-relay',
        is_active: 1, sort_order: 0, extra_env: '{}', headers_json: '{}',
        env_overrides_json: '', role_models_json: '{}', notes: '', options_json: '{}',
        created_at: '', updated_at: '',
      },
      protocol: 'anthropic' as const,
      authStyle: 'api_key' as const,
      model: 'sonnet',
      modelDisplayName: 'Sonnet 4.5',
      upstreamModel: 'sonnet',
      headers: {},
      envOverrides: {},
      roleModels: {},
      hasCredentials: true,
      availableModels: [
        { modelId: 'claude-sonnet-4-5', upstreamModelId: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5' },
      ],
      settingSources: ['project', 'local'],
    };

    const config = toAiSdkConfig(resolved, 'sonnet');
    // OK to map the alias to the only available model — that's what the user
    // signed up for and there's no ambiguity.
    assert.equal(
      config.modelId, 'claude-sonnet-4-5-20250929',
      `single-model provider should fallback the alias; got ${config.modelId}`,
    );
  });

  it('role mapping still works regardless of catalog size', async () => {
    const { toAiSdkConfig } = await import('../../lib/provider-resolver');

    // Multi-model provider WITH explicit role mapping — must use the mapping
    const resolved = {
      provider: {
        id: 'p2', name: 'GLM', preset_key: 'glm-cn', provider_type: 'anthropic', protocol: 'anthropic',
        base_url: 'https://glm.example.com', api_key: 'sk-glm',
        is_active: 1, sort_order: 0, extra_env: '{}', headers_json: '{}',
        env_overrides_json: '', role_models_json: '{}', notes: '', options_json: '{}',
        created_at: '', updated_at: '',
      },
      protocol: 'anthropic' as const,
      authStyle: 'api_key' as const,
      model: 'haiku',
      modelDisplayName: 'Haiku',
      upstreamModel: 'haiku',
      headers: {},
      envOverrides: {},
      roleModels: { haiku: 'glm-4.6-flash', sonnet: 'glm-4.6', opus: 'glm-4.6-thinking' },
      hasCredentials: true,
      availableModels: [
        { modelId: 'glm-4.6-flash', displayName: 'GLM-4.6 Flash' },
        { modelId: 'glm-4.6', displayName: 'GLM-4.6' },
        { modelId: 'glm-4.6-thinking', displayName: 'GLM-4.6 Thinking' },
      ],
      settingSources: ['project', 'local'],
    };

    const config = toAiSdkConfig(resolved, 'haiku');
    // Role mapping wins; should NOT touch the multi-model fallback at all
    assert.equal(config.modelId, 'glm-4.6-flash');
  });
});
