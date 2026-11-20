/**
 * Codex effort resolution on the codex_runtime `turn/start` path.
 *
 * P1 (2026-06-01) — original rule: never forward CodePilot's `xhigh` / `max`
 * to a Codex app-server that only knows minimal|low|medium|high (old builds
 * reject unknown variants fatally; 0.133 warns and falls back to medium).
 *
 * Phase 0 (2026-07-17) — that global clamp became a lie of its own once
 * GPT-5.6 shipped real `xhigh` / `max` tiers: the user picked Max and the
 * wire carried `high`. The rule is now a PER-MODEL allowlist read from
 * `model/list` (resolveCodexEffort), with clampCodexEffort demoted to the
 * fallback used only when the model's tiers are unknown (cold cache / logged
 * out / old binary).
 *
 * Scope guard: codex-only. Claude Code / Native keep the full union for
 * Anthropic Opus tiers — they do NOT import from ./effort.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  clampCodexEffort,
  resolveCodexEffort,
  resolveCodexProviderEffort,
  codexVersionSupportsProviderExtendedEffort,
  toGenericEffortLevels,
  CODEX_SUPPORTED_EFFORTS,
  CODEX_GENERIC_EXCLUDED_EFFORTS,
} from '@/lib/codex/effort';

describe('resolveCodexProviderEffort — CodePilot provider catalog + binary gate', () => {
  const contract = { supportedLevels: ['low', 'high', 'max'], defaultLevel: 'max' };

  it('preserves explicit Max and resolves Auto to the vendor default', () => {
    const vocabulary = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.equal(resolveCodexProviderEffort('max', contract, vocabulary), 'max');
    assert.equal(resolveCodexProviderEffort(undefined, contract, vocabulary), 'max');
  });

  it('fails visibly when an old binary has not advertised Max', () => {
    assert.throws(
      () => resolveCodexProviderEffort('max', contract, ['minimal', 'low', 'medium', 'high']),
      /will not silently downgrade/,
    );
  });

  it('uses binary version evidence without requiring a Codex Account model cache', () => {
    assert.equal(codexVersionSupportsProviderExtendedEffort('codex-cli 0.144.2'), true);
    assert.equal(codexVersionSupportsProviderExtendedEffort('codex-cli 0.145.0-alpha.1'), true);
    assert.equal(codexVersionSupportsProviderExtendedEffort('codex-cli 0.144.1'), false);
    assert.equal(codexVersionSupportsProviderExtendedEffort('codex-cli 0.144.2-alpha.9'), false);
    assert.equal(
      codexVersionSupportsProviderExtendedEffort(
        'Codex Desktop/0.147.0-alpha.6.5 (Mac OS 26.5.2; arm64) dumb (codex_codepilot; 0.67.0)',
      ),
      true,
    );
    assert.equal(
      codexVersionSupportsProviderExtendedEffort(
        'Codex Desktop/0.144.2-alpha.9 (Mac OS 26.5.2; arm64) dumb (codex_codepilot; 0.67.0)',
      ),
      false,
    );
    assert.equal(codexVersionSupportsProviderExtendedEffort('agent/9.9.9 codex-cli 0.144.2'), false);
    assert.equal(codexVersionSupportsProviderExtendedEffort('codex-cli/9.9.9 (codex-cli 0.144.2)'), false);
    assert.equal(resolveCodexProviderEffort('max', contract, undefined, 'codex-cli 0.144.2'), 'max');
    assert.throws(
      () => resolveCodexProviderEffort('max', contract, undefined, 'codex-cli 0.144.1'),
      /a Codex Account login is not required/,
    );
  });
});

// ── per-model allowlist (the Phase 0 rule) ───────────────────────────

/** What codex-cli 0.144.2 really reports for GPT-5.6 Sol. */
const SOL_TIERS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

describe('resolveCodexEffort — declared tiers pass through verbatim', () => {
  it('forwards xhigh when the model declares it (NOT clamped to high)', () => {
    assert.equal(resolveCodexEffort('xhigh', SOL_TIERS), 'xhigh');
  });

  it('forwards max when the model declares it (NOT clamped to high)', () => {
    assert.equal(resolveCodexEffort('max', SOL_TIERS), 'max');
  });

  it('forwards the ordinary tiers unchanged', () => {
    for (const level of ['low', 'medium', 'high']) {
      assert.equal(resolveCodexEffort(level, SOL_TIERS), level);
    }
  });
});

describe('resolveCodexEffort — undeclared tiers are omitted, never coerced', () => {
  const modest = ['low', 'medium', 'high'];

  it('omits xhigh for a model that does not declare it', () => {
    assert.equal(
      resolveCodexEffort('xhigh', modest),
      undefined,
      'omit lets Codex use its own default; coercing to high would invent a choice',
    );
  });

  it('omits max for a model that does not declare it', () => {
    assert.equal(resolveCodexEffort('max', modest), undefined);
  });

  it('omits a tier nobody has heard of', () => {
    assert.equal(resolveCodexEffort('ultra-mega', SOL_TIERS), undefined);
  });

  it('omits absent selections (Auto)', () => {
    assert.equal(resolveCodexEffort(undefined, SOL_TIERS), undefined);
    assert.equal(resolveCodexEffort(null, SOL_TIERS), undefined);
    assert.equal(resolveCodexEffort('', SOL_TIERS), undefined);
  });
});

describe('resolveCodexEffort — no capability info falls back to the conservative clamp', () => {
  for (const declared of [undefined, []]) {
    const label = declared === undefined ? 'undefined' : 'empty';
    it(`clamps xhigh → high when tiers are ${label} (old binary may reject xhigh fatally)`, () => {
      assert.equal(resolveCodexEffort('xhigh', declared), 'high');
    });
    it(`keeps medium as-is when tiers are ${label}`, () => {
      assert.equal(resolveCodexEffort('medium', declared), 'medium');
    });
    it(`omits an unknown tier when tiers are ${label}`, () => {
      assert.equal(resolveCodexEffort('bogus', declared), undefined);
    });
  }
});

// ── ultra is Codex-only, not a generic selector tier ─────────────────

describe('toGenericEffortLevels — ultra never reaches the shared effort menu', () => {
  it('drops ultra from the real GPT-5.6 Sol tier list', () => {
    assert.deepEqual(toGenericEffortLevels(SOL_TIERS), ['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('keeps xhigh / max — only Codex-exclusive tiers are withheld', () => {
    assert.deepEqual(toGenericEffortLevels(['xhigh', 'max']), ['xhigh', 'max']);
  });

  it('an ultra-only model projects to an EMPTY generic list', () => {
    assert.deepEqual(toGenericEffortLevels(['ultra']), []);
  });

  it('handles undefined', () => {
    assert.deepEqual(toGenericEffortLevels(undefined), []);
  });

  it('CODEX_GENERIC_EXCLUDED_EFFORTS pins ultra as the withheld tier', () => {
    assert.deepEqual([...CODEX_GENERIC_EXCLUDED_EFFORTS], ['ultra']);
  });
});

// ── the fallback clamp itself (unchanged behavior, narrower role) ─────

describe('clampCodexEffort — conservative fallback contract', () => {
  it('maps xhigh → high', () => {
    assert.equal(clampCodexEffort('xhigh'), 'high');
  });

  it('maps max → high', () => {
    assert.equal(clampCodexEffort('max'), 'high');
  });

  for (const level of ['minimal', 'low', 'medium', 'high'] as const) {
    it(`keeps ${level} as-is`, () => {
      assert.equal(clampCodexEffort(level), level);
    });
  }

  it('returns undefined for undefined / null / empty / unknown', () => {
    assert.equal(clampCodexEffort(undefined), undefined);
    assert.equal(clampCodexEffort(null), undefined);
    assert.equal(clampCodexEffort(''), undefined);
    assert.equal(clampCodexEffort('ultra-mega'), undefined);
  });

  it('CODEX_SUPPORTED_EFFORTS is the four-level fallback floor (no xhigh/max)', () => {
    assert.deepEqual([...CODEX_SUPPORTED_EFFORTS], ['minimal', 'low', 'medium', 'high']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Wiring pin — the resolver tests above prove the helper, but not that
// runtime.ts USES it. The runtime spawns the app-server (can't mock without
// dragging the whole subprocess machinery into a unit test), so we pin the
// turn/start wiring at the source level — same convention as the
// thread/start + thread/resume pins in codex-runtime-proxy-injection.test.ts.
// Catches a revert to raw `options.effort` (leaking undeclared tiers) or to
// the global clamp (silently downgrading a model's real max) at zero cost.
// ─────────────────────────────────────────────────────────────────────

describe('CodexRuntime turn/start — effort wiring pin (per-model allowlist)', () => {
  const runtimeSrc = fs.readFileSync(
    path.resolve(__dirname, '../../lib/codex/runtime.ts'),
    'utf8',
  );

  it('imports both account and provider effort resolvers from ./effort', () => {
    assert.match(
      runtimeSrc,
      /import\s*\{[^}]*resolveCodexEffort[^}]*resolveCodexProviderEffort[^}]*\}\s*from\s*['"]\.\/effort['"]/,
      'runtime.ts must import both effort resolvers from ./effort',
    );
  });

  it('reads the current model allowlist from the model/list cache', () => {
    assert.match(
      runtimeSrc,
      /getCachedCodexEffortLevels\(\s*options\.model\s*\)/,
      'runtime.ts must look up THIS model’s declared tiers before sending effort',
    );
  });

  it('resolves Codex Account per-model and CodePilot Providers from their own catalog contract', () => {
    assert.match(
      runtimeSrc,
      /codexEffort\s*=\s*resolveCodexEffort\(\s*options\.effort\s*,\s*declaredEfforts\s*\)/,
      'runtime.ts must resolve options.effort against the per-model allowlist',
    );
    assert.match(runtimeSrc, /getResolvedModelEffortContract\(resolvedProvider,\s*options\.model\)/);
    assert.match(runtimeSrc, /resolveCodexProviderEffort\(/);
    assert.match(runtimeSrc, /getCachedCodexEffortVocabulary\(\)/);
    assert.match(runtimeSrc, /getCodexAvailability\(\)/);
  });

  it('turn/start payload sends the resolved codexEffort', () => {
    assert.match(runtimeSrc, /['"]turn\/start['"]/, 'expected a turn/start request in runtime.ts');
    assert.match(runtimeSrc, /effort:\s*codexEffort/, 'turn/start must send the resolved effort');
  });

  it('does NOT forward raw options.effort (would leak undeclared tiers)', () => {
    assert.doesNotMatch(runtimeSrc, /effort:\s*options\.effort/);
  });

  it('does NOT global-clamp on the turn path (would downgrade a real max to high)', () => {
    assert.doesNotMatch(
      runtimeSrc,
      /clampCodexEffort\(/,
      'the global clamp is now reachable only as resolveCodexEffort’s internal fallback',
    );
  });
});
