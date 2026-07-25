/**
 * Phase A regression tests (post-refactor-cleanup.md):
 *   - Opus 4.8 接入 (Anthropic direct + OpenRouter)
 *   - Opus 4.7 专属请求参数逻辑泛化到 4.7+4.8 family (不回归 4.7)
 *   - #23 Sonnet 4.6 alias 修复 (不再落回 Sonnet 4.0 / 4.5)
 *
 * Catalog entries are asserted via source-pin (the catalog arrays are
 * module-private); param/context logic is tested functionally via the
 * exported helpers. Real-credential send smoke is the user's step
 * (validates integration path, not official capabilities).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sanitizeClaudeModelOptions,
  isOpusAdaptiveThinkingModel,
} from '../../lib/claude-model-options';
import { getContextWindow } from '../../lib/model-context';
import { ENV_CLAUDE_CODE_MODELS } from '../../lib/provider-catalog';

const LIB = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../lib');
const read = (f: string) => fs.readFileSync(path.join(LIB, f), 'utf8');
const SRC = path.resolve(LIB, '..');
const readSrc = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

describe('Opus 4.7+ adaptive-thinking family (4.7 + 4.8) — param generalization', () => {
  it('detects 4.7 and 4.8 (dash / dated / short id); excludes 4.6 and Sonnet', () => {
    assert.equal(isOpusAdaptiveThinkingModel('claude-opus-4-7'), true);
    assert.equal(isOpusAdaptiveThinkingModel('claude-opus-4-8'), true);
    assert.equal(isOpusAdaptiveThinkingModel('opus-4-8'), true);
    assert.equal(isOpusAdaptiveThinkingModel('us.anthropic.claude-opus-4-8-v1:0'), true);
    // dotted OpenRouter slug must also match (Codex review P2 — don't rely on
    // the assumption that dotted upstream never reaches this sanitizer)
    assert.equal(isOpusAdaptiveThinkingModel('anthropic/claude-opus-4.8'), true);
    assert.equal(isOpusAdaptiveThinkingModel('anthropic/claude-opus-4.7'), true);
    assert.equal(isOpusAdaptiveThinkingModel('claude-opus-4-20250514'), false); // Opus 4.6
    assert.equal(isOpusAdaptiveThinkingModel('claude-sonnet-4-6'), false);
    assert.equal(isOpusAdaptiveThinkingModel(undefined), false);
  });

  it('4.8: manual extended thinking → adaptive/summarized; 1M default (no beta header)', () => {
    const out = sanitizeClaudeModelOptions({
      model: 'claude-opus-4-8',
      thinking: { type: 'enabled', budgetTokens: 10000 },
      context1m: true,
    });
    assert.deepEqual(out.thinking, { type: 'adaptive', display: 'summarized' });
    assert.equal(out.applyContext1mBeta, false); // 4.8 ships 1M by default
    assert.equal(out.isOpusAdaptiveThinking, true);
  });

  it('4.7 NOT regressed: same adaptive conversion + no beta', () => {
    const out = sanitizeClaudeModelOptions({
      model: 'claude-opus-4-7',
      thinking: { type: 'enabled' },
      context1m: true,
    });
    assert.deepEqual(out.thinking, { type: 'adaptive', display: 'summarized' });
    assert.equal(out.applyContext1mBeta, false);
    assert.equal(out.isOpusAdaptiveThinking, true);
  });

  it('non-family model (Sonnet 4.6): keeps manual thinking + applies 1M beta when asked', () => {
    const out = sanitizeClaudeModelOptions({
      model: 'claude-sonnet-4-6',
      thinking: { type: 'enabled', budgetTokens: 8000 },
      context1m: true,
    });
    assert.equal(out.thinking?.type, 'enabled');
    assert.equal(out.applyContext1mBeta, true);
    assert.equal(out.isOpusAdaptiveThinking, false);
  });

  it('effort is passed through untouched (per-model default is the SDK/CLI job, not ours)', () => {
    assert.equal(sanitizeClaudeModelOptions({ model: 'claude-opus-4-8', effort: 'high' }).effort, 'high');
    assert.equal(sanitizeClaudeModelOptions({ model: 'claude-opus-4-7', effort: 'xhigh' }).effort, 'xhigh');
  });
});

describe('Opus 4.8 context window', () => {
  it('claude-opus-4-8 → 1M', () => {
    assert.equal(getContextWindow('claude-opus-4-8'), 1_000_000);
  });
  it('Opus 4.7 still 1M (not regressed)', () => {
    assert.equal(getContextWindow('claude-opus-4-7'), 1_000_000);
  });
});

describe('Opus 4.8 catalog entries (source-pin) — Anthropic direct + OpenRouter', () => {
  const catalog = read('provider-catalog.ts');
  const resolver = read('provider-resolver.ts');

  it('Anthropic first-party has opus-4-8 → claude-opus-4-8', () => {
    assert.match(catalog, /modelId:\s*'opus-4-8',\s*\n\s*upstreamModelId:\s*'claude-opus-4-8'/);
  });
  it('OpenRouter has opus-4-8 → anthropic/claude-opus-4.8 (Codex-confirmed slug, explicit fixture)', () => {
    assert.match(catalog, /upstreamModelId:\s*'anthropic\/claude-opus-4\.8'/);
  });
  it('env-mode has opus-4-8 → claude-opus-4-8 (via shared ENV_CLAUDE_CODE_MODELS; resolver derives)', () => {
    // 2026-06-10: the resolver's inline envModels copy was consolidated into
    // provider-catalog's ENV_CLAUDE_CODE_MODELS (Codex P1 — three copies had
    // drifted). Pin the canonical entry + that the resolver derives from it.
    const opus48 = ENV_CLAUDE_CODE_MODELS.find(m => m.modelId === 'opus-4-8');
    assert.equal(opus48?.upstreamModelId, 'claude-opus-4-8');
    assert.match(resolver, /=\s*ENV_CLAUDE_CODE_MODELS/);
  });
  it('Opus 4.7 entries still present — not regressed (alias `opus` stays 4.7)', () => {
    assert.match(catalog, /upstreamModelId:\s*'claude-opus-4-7'/);
    assert.match(catalog, /upstreamModelId:\s*'anthropic\/claude-opus-4\.7'/);
  });
  it('opus-4-8 entries carry NO `role` field (so roleModels.opus / default stays 4.7)', () => {
    const blocks = catalog.split("modelId: 'opus-4-8'").slice(1);
    assert.ok(blocks.length >= 2, 'expected >= 2 opus-4-8 entries (first-party + openrouter)');
    for (const b of blocks) {
      const head = b.slice(0, b.indexOf('capabilities'));
      assert.doesNotMatch(head, /\brole:/);
    }
  });
});

describe('#23 Sonnet 4.6 alias → upstream (no stale Sonnet 4.0 / 4.5 fallback)', () => {
  it('env sonnet → claude-sonnet-4-6 (shared list); resolver has no stale Sonnet 4.0/4.5 upstream', () => {
    const sonnet = ENV_CLAUDE_CODE_MODELS.find(m => m.modelId === 'sonnet');
    assert.equal(sonnet?.upstreamModelId, 'claude-sonnet-4-6');
    const src = read('provider-resolver.ts');
    assert.doesNotMatch(src, /'claude-sonnet-4-20250514'/);
    assert.doesNotMatch(src, /'claude-sonnet-4-5-20250929'/);
  });
  it('ai-provider env CURRENT_DEFAULTS sonnet → claude-sonnet-4-6', () => {
    const src = read('ai-provider.ts');
    assert.match(src, /sonnet:\s*'claude-sonnet-4-6'/);
    assert.doesNotMatch(src, /sonnet:\s*'claude-sonnet-4-5-20250929'/);
  });
  it('onboarding + checkin processors no longer fall back to Sonnet 4.0', () => {
    for (const f of ['onboarding-processor.ts', 'checkin-processor.ts']) {
      assert.doesNotMatch(read(f), /'claude-sonnet-4-20250514'/);
    }
  });
});

describe('#23 Sonnet 4.6 — API route layer (Codex review P1: providers/models, skills/search, media plan)', () => {
  it('providers/models route: DEFAULT_MODELS + ENV_ALIAS derive from ENV_CLAUDE_CODE_MODELS (no Sonnet 4.0)', () => {
    const src = readSrc('app/api/providers/models/route.ts');
    assert.doesNotMatch(src, /'claude-sonnet-4-20250514'/);
    // 2026-06-10 consolidation: the route no longer hardcodes the env model
    // rows — it derives from the shared list, where sonnet pins to 4.6.
    assert.match(src, /ENV_CLAUDE_CODE_MODELS/);
    assert.equal(
      ENV_CLAUDE_CODE_MODELS.find(m => m.modelId === 'sonnet')?.upstreamModelId,
      'claude-sonnet-4-6',
    );
  });
  it('skills/search delegates model selection to the shared resolver (no stale local MODEL_MAP)', () => {
    const src = readSrc('app/api/skills/search/route.ts');
    assert.doesNotMatch(src, /'claude-sonnet-4-20250514'/);
    assert.doesNotMatch(src, /'claude-opus-4-20250514'/); // Opus 4.6
    assert.doesNotMatch(src, /'claude-haiku-4-20250414'/);
    assert.doesNotMatch(src, /MODEL_MAP/);
    assert.match(src, /resolveProvider\(\{[\s\S]{0,120}callScene:\s*'user_skill_search'/);
    assert.match(src, /generateTextFromProvider\(\{[\s\S]{0,120}callScene:\s*'user_skill_search'/);
  });
  it('media/jobs/plan fallback → claude-sonnet-4-6 (no Sonnet 4.0)', () => {
    const src = readSrc('app/api/media/jobs/plan/route.ts');
    assert.doesNotMatch(src, /'claude-sonnet-4-20250514'/);
    assert.match(src, /'claude-sonnet-4-6'/);
  });
});
