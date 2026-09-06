/**
 * Regression guards for the Codex review follow-ups on the #449 provider
 * key handling and the resolver trust boundary.
 *
 * Background: the initial #449 fix introduced `hasStoredKey` to avoid
 * sending the masked key string back as real auth, but it had three gaps
 * that Codex flagged post-merge:
 *
 *  1. The "smart auth-style switch" helper link in PresetConnectDialog
 *     still called `setAuthStyle(inferred)` directly — it didn't migrate
 *     `hasStoredKey` / `apiKey` state, so editing a third-party provider
 *     and clicking the helper left the old stored key leaking into
 *     subsequent test/save calls.
 *  2. `resolveForClaudeCode()` in provider-resolver.ts still enforced
 *     `explicitProvider.is_active`, which silently undid the fix that
 *     taught `resolveProvider()`'s default-branch to honor
 *     `default_provider_id` regardless of `is_active`.
 *  3. Once `hasStoredKey` was introduced, there was no way for users to
 *     actually *delete* a stored key — leaving an empty input always
 *     meant "keep the existing value".
 *
 * These are structural tests (node:test can't render React) — we assert
 * against the source files directly, mirroring the pattern used in
 * prompt-dialog-replacement.test.ts and stale-default-provider.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8');
}

describe('Provider key lifecycle — Codex follow-ups', () => {
  // ── P1: unified auth-style migration ────────────────────────────
  describe('PresetConnectDialog: unified auth-style migration', () => {
    const source = readSource('src/components/settings/PresetConnectDialog.tsx');

    it('defines applyAuthStyleChange helper', () => {
      assert.ok(
        source.includes('const applyAuthStyleChange'),
        'should define a single applyAuthStyleChange helper',
      );
    });

    it('helper migrates hasStoredKey + clearStoredKey + apiKey together', () => {
      // The helper body must touch all four pieces of state to avoid the
      // stored-key leak that the dropdown-only fix left behind on the
      // "smart recommend" path.
      const helperBlock = source.match(
        /const applyAuthStyleChange[^}]*\{[\s\S]*?setAuthStyle\([\s\S]*?setApiKey\([\s\S]*?setClearStoredKey\([\s\S]*?setHasStoredKey\([\s\S]*?\}/,
      );
      assert.ok(
        helperBlock,
        'applyAuthStyleChange must update authStyle + apiKey + clearStoredKey + hasStoredKey together',
      );
    });

    it('dropdown onValueChange routes through applyAuthStyleChange', () => {
      assert.ok(
        source.match(/onValueChange=\{[^}]*applyAuthStyleChange\(/),
        'Select onValueChange should call applyAuthStyleChange',
      );
    });

    it('smart recommend helper button routes through applyAuthStyleChange', () => {
      // The helper appears below the Input field with an "inferred" auth
      // style based on the base URL.
      assert.ok(
        source.match(/onClick=\{[^}]*applyAuthStyleChange\(inferred\)/),
        '"Switch" helper button should call applyAuthStyleChange(inferred)',
      );
    });

    it('no residual inline setAuthStyle usage in the two UI sites (smart helper + dropdown)', () => {
      // Guard against future regressions where someone adds a fresh
      // setAuthStyle call in the helper-link onClick or dropdown
      // onValueChange. Both entry points must go through the unified
      // helper, not call setAuthStyle directly.
      assert.ok(
        !source.match(/onClick=\{\(\)\s*=>\s*setAuthStyle\(inferred\)/),
        'smart helper must not call setAuthStyle directly',
      );
      assert.ok(
        !source.match(/onValueChange=\{\(v\)\s*=>\s*\{[^}]*setAuthStyle\(/),
        'dropdown must not call setAuthStyle directly',
      );
    });
  });

  // ── P2a: resolveForClaudeCode trusts explicit provider ─────────
  describe('resolveForClaudeCode trusts the caller', () => {
    const source = readSource('src/lib/provider-resolver.ts');

    it('does not re-resolve based on is_active', () => {
      assert.ok(
        !source.includes('explicitProvider.is_active'),
        'resolveForClaudeCode should not gate on explicitProvider.is_active',
      );
      // Guard against an actual console.warn call (not descriptive text
      // in comments) about inactive explicit providers.
      assert.ok(
        !source.match(/console\.warn\([^)]*inactive,\s*re-resolving/),
        'should not warn about inactive explicit providers — that undoes the #456 fix',
      );
    });

    it('returns buildResolution immediately when explicitProvider is present', () => {
      // Find the resolveForClaudeCode body
      const fnStart = source.indexOf('export function resolveForClaudeCode');
      assert.ok(fnStart >= 0, 'resolveForClaudeCode should be exported');
      const fnBody = source.slice(fnStart, fnStart + 1500);
      assert.ok(
        fnBody.match(/if\s*\(explicitProvider\)\s*\{\s*return\s+buildResolution\(explicitProvider,\s*opts\)/),
        'should short-circuit on any truthy explicitProvider',
      );
    });
  });

  // ── P2b: Test connection guard when a clear is pending ─────────
  describe('PresetConnectDialog: test-connection respects pending clear', () => {
    const source = readSource('src/components/settings/PresetConnectDialog.tsx');

    it('derives canTest covering all four credential states', () => {
      // canTest must handle: no-key preset, new apiKey, stored-key
      // intact, and pending-clear-with-no-replacement. The last case
      // is the Codex P2 hole (testing with a key that's about to be
      // deleted would return misleading success).
      const canTestBlock = source.match(
        /const canTest[\s\S]*?isEdit\s*&&\s*hasStoredKey\s*&&\s*!clearStoredKey/,
      );
      assert.ok(
        canTestBlock,
        'canTest derivation must include "edit + hasStoredKey + !clearStoredKey" branch',
      );
    });

    it('handleTestConnection short-circuits when canTest is false', () => {
      assert.ok(
        source.match(/handleTestConnection\s*=\s*async[\s\S]*?if\s*\(!canTest\)\s*return/),
        'handleTestConnection should early-return when canTest is false',
      );
    });

    it('connection tests use model mappings before falling back to aliases', () => {
      assert.ok(
        source.match(/const testModelName[\s\S]*modelName\.trim\(\)[\s\S]*mapSonnet\.trim\(\)[\s\S]*mapOpus\.trim\(\)[\s\S]*mapHaiku\.trim\(\)/),
        'test connection should prefer user-entered model mappings over default aliases',
      );
      assert.ok(
        source.match(/modelName:\s*testModelName/),
        'test request body should send the resolved test model name',
      );
      assert.ok(
        !source.match(/modelName:\s*modelName\s*\|\|\s*undefined/),
        'test request body should not ignore model mapping fields',
      );
    });

    it('test button disabled prop references canTest', () => {
      assert.ok(
        source.match(/disabled=\{saving \|\| testing \|\| (?:authorizing \|\| )?!canTest\}/),
        'test button disabled prop must include !canTest',
      );
      // Guard against the regression of the old disable rule that
      // only blocked create-mode empty inputs.
      assert.ok(
        !source.match(/disabled=\{saving \|\| testing \|\| \(!apiKey && preset\.fields\.includes/),
        'old "!apiKey && api_key field" rule should be removed',
      );
    });
  });

  // ── P2c: clearStoredKey explicit clear action ──────────────────
  describe('Explicit "clear stored key" intent (hasStoredKey escape hatch)', () => {
    for (const file of [
      'src/components/settings/PresetConnectDialog.tsx',
      'src/components/settings/ProviderForm.tsx',
    ]) {
      describe(file, () => {
        const source = readSource(file);

        it('declares clearStoredKey state', () => {
          assert.ok(
            source.match(/\bclearStoredKey\b[\s\S]*setClearStoredKey/),
            'should declare [clearStoredKey, setClearStoredKey] state',
          );
        });

        it('save logic distinguishes keep / clear / new-value / create', () => {
          // The three-branch apiKeyForSave IIFE must be present. The
          // structural shape we guard against regression:
          //   - "new value"    → apiKey
          //   - "clear intent" → ""
          //   - "keep existing"→ undefined
          //   - fallback       → apiKey
          assert.ok(
            source.match(/apiKeyForSave[\s\S]*if\s*\(apiKey\)\s*return apiKey/),
            'apiKeyForSave should return apiKey first when non-empty',
          );
          assert.ok(
            source.match(/hasStoredKey\s*&&\s*clearStoredKey\)\s*return\s*""/),
            'apiKeyForSave should return "" when clearStoredKey is set',
          );
          assert.ok(
            source.match(/hasStoredKey\)\s*return\s*undefined/),
            'apiKeyForSave should return undefined when keeping stored key',
          );
        });

        it('renders an explicit clear / undo action in the UI', () => {
          // Step 4 copy round (2026-05-06): the visible strings now flow
          // through i18n (`provider.form.clearKeyAction` /
          // `provider.form.undo`), so this static check matches either
          // the i18n key reference OR the legacy hardcoded literal —
          // PresetConnectDialog still ships the bilingual literal pair
          // because it has its own `isZh` branch, while ProviderForm
          // routes the same affordance through `t(...)`. Both forms are
          // valid evidence the action is present.
          assert.ok(
            source.match(/provider\.form\.clearKeyAction|Clear stored key|清除已存密钥/),
            'should render a "Clear stored key" / "清除已存密钥" action',
          );
          assert.ok(
            source.match(/provider\.form\.undo|Undo|撤销/),
            'should render an "Undo" / "撤销" action to restore the keep-existing state',
          );
        });

        it('input onChange cancels a pending clear intent', () => {
          // Typing any new key must automatically reset clearStoredKey so
          // the user doesn't accidentally wipe their key after typing.
          assert.ok(
            source.match(/if\s*\(clearStoredKey\)\s*setClearStoredKey\(false\)/),
            'typing a new value should cancel a pending clear intent',
          );
        });

        it('reset-on-open clears any lingering clearStoredKey flag', () => {
          assert.ok(
            source.match(/setClearStoredKey\(false\)/),
            'reset path should set clearStoredKey back to false',
          );
        });
      });
    }
  });
});
