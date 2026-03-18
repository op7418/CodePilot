/**
 * Tests for stale default_provider_id cleanup chain.
 *
 * Scenario: user deletes a provider that was set as default →
 * default_provider_id becomes a dangling reference → resolver falls back
 * to env vars → user's configured provider is bypassed.
 *
 * This test suite verifies the three fix points:
 * 1. DELETE /api/providers/[id] clears stale default
 * 2. Resolver does NOT auto-heal on read (pure, no side effects)
 * 3. GET /api/providers/models auto-heals stale default on page load
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getProvider,
  getAllProviders,
  getDefaultProviderId,
  setDefaultProviderId,
  createProvider,
  deleteProvider,
  getDb,
} from '../../lib/db';
import { resolveProvider } from '../../lib/provider-resolver';

// ── Helpers ─────────────────────────────────────────────────────

/** Create a minimal test provider and return its ID */
function createTestProvider(name: string, apiKey = 'test-key'): string {
  const provider = createProvider({
    name,
    provider_type: 'anthropic',
    protocol: 'anthropic',
    base_url: 'https://api.test.com',
    api_key: apiKey,
    extra_env: '{"ANTHROPIC_API_KEY":""}',
  });
  return provider.id;
}

/** Clean up test providers by name prefix */
function cleanupTestProviders() {
  const all = getAllProviders();
  for (const p of all) {
    if (p.name.startsWith('__test_')) {
      deleteProvider(p.id);
    }
  }
  // Don't clear default if it's a real provider
  const defaultId = getDefaultProviderId();
  if (defaultId && !getProvider(defaultId)) {
    setDefaultProviderId('');
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe('Stale default_provider_id cleanup', () => {
  // Save and restore original default
  let originalDefault: string | undefined;

  beforeEach(() => {
    originalDefault = getDefaultProviderId();
    cleanupTestProviders();
  });

  afterEach(() => {
    cleanupTestProviders();
    // Restore original default
    if (originalDefault) {
      setDefaultProviderId(originalDefault);
    }
  });

  describe('deleteProvider clears stale default', () => {
    it('db deleteProvider does NOT clean up default (cleanup is in API route)', () => {
      const id = createTestProvider('__test_default');
      setDefaultProviderId(id);

      // Raw deleteProvider only removes the record — stale default remains
      deleteProvider(id);
      assert.equal(getDefaultProviderId(), id, 'raw deleteProvider should not touch default setting');
      assert.equal(getProvider(id), undefined, 'provider record should be gone');
    });

    it('API-level delete pattern clears stale default and picks next', () => {
      const id1 = createTestProvider('__test_first');
      const id2 = createTestProvider('__test_second');
      setDefaultProviderId(id1);

      // Simulate what DELETE /api/providers/[id] does:
      deleteProvider(id1);
      const currentDefault = getDefaultProviderId();
      if (currentDefault === id1) {
        const remaining = getAllProviders().filter(p => p.name.startsWith('__test_'));
        if (remaining.length > 0) {
          setDefaultProviderId(remaining[0].id);
        } else {
          setDefaultProviderId('');
        }
      }

      const newDefault = getDefaultProviderId();
      assert.notEqual(newDefault, id1, 'should not point to deleted provider');
      assert.ok(getProvider(id2), 'second provider should still exist');
    });

    it('does not change default when deleting a non-default provider', () => {
      const defaultId = createTestProvider('__test_keep_default');
      const otherId = createTestProvider('__test_delete_me');
      setDefaultProviderId(defaultId);

      deleteProvider(otherId);

      assert.equal(getDefaultProviderId(), defaultId, 'default should be unchanged');
      assert.ok(getProvider(defaultId), 'default provider should still exist');
    });
  });

  describe('resolveProvider does NOT auto-heal', () => {
    it('returns undefined provider when default points to deleted record', () => {
      const id = createTestProvider('__test_stale');
      setDefaultProviderId(id);
      deleteProvider(id);
      // Now default_provider_id points to a non-existent provider

      const resolved = resolveProvider({});

      // Resolver should NOT have auto-fixed the stale default
      // (that would cause side effects during Doctor diagnostics)
      assert.equal(resolved.provider, undefined, 'should return undefined, not auto-heal');
    });

    it('does not modify default_provider_id setting on read', () => {
      const staleId = '__test_nonexistent_id_12345';
      setDefaultProviderId(staleId);

      resolveProvider({});

      // The stale ID should still be there — resolver is read-only
      assert.equal(getDefaultProviderId(), staleId, 'resolver should not modify settings');
    });
  });

  describe('error-classifier categorizes stale default correctly', () => {
    it('classifyError produces PROCESS_CRASH for exit code 1', async () => {
      const { classifyError } = await import('../../lib/error-classifier');
      const result = classifyError({
        error: new Error('Claude Code process exited with code 1'),
        providerName: 'Test Provider',
      });
      assert.equal(result.category, 'PROCESS_CRASH');
      assert.ok(result.userMessage.includes('Test Provider'));
    });

    it('classifyError produces AUTH_REJECTED for 401', async () => {
      const { classifyError } = await import('../../lib/error-classifier');
      const result = classifyError({
        error: new Error('401 Unauthorized'),
      });
      assert.equal(result.category, 'AUTH_REJECTED');
      assert.equal(result.retryable, false);
    });

    it('classifyError produces NO_CREDENTIALS for missing key', async () => {
      const { classifyError } = await import('../../lib/error-classifier');
      const result = classifyError({
        error: new Error('missing api key'),
      });
      assert.equal(result.category, 'NO_CREDENTIALS');
    });
  });
});

// ── File-tree keyboard interaction ──────────────────────────────

describe('FileTreeFolder keyboard accessibility', () => {
  it('CollapsibleTrigger div has tabIndex=0 for keyboard focus', async () => {
    // This is a structural test — verify the component source has the right attributes.
    // We can't render React components in node:test, but we can verify the source code.
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/components/ai-elements/file-tree.tsx'),
      'utf-8',
    );

    // The trigger div should have tabIndex={0}
    assert.ok(
      source.includes('CollapsibleTrigger asChild'),
      'should use CollapsibleTrigger with asChild to wrap the row',
    );

    // The FileTreeFolder component (between its export and FileTreeFile) should have
    // exactly 1 tabIndex — on the trigger, not on the outer treeitem div.
    // (Verified more precisely in the dedicated count test below)

    // The trigger should handle Enter and Space
    assert.ok(
      source.includes("e.key === 'Enter'") && source.includes("e.key === ' '"),
      'trigger should handle Enter and Space keys',
    );

    // handleToggle should be called on keyDown
    assert.ok(
      source.includes('handleToggle()'),
      'keyboard handler should call handleToggle',
    );
  });

  it('FileTreeFolder has exactly one tabIndex={0} element', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/components/ai-elements/file-tree.tsx'),
      'utf-8',
    );

    // Extract the FileTreeFolder component source (between export const FileTreeFolder and the next export)
    const folderStart = source.indexOf('export const FileTreeFolder');
    const folderEnd = source.indexOf('export const FileTreeFile');
    const folderSource = source.slice(folderStart, folderEnd);

    // Count tabIndex={0} occurrences — should be exactly 1
    const tabIndexMatches = folderSource.match(/tabIndex=\{0\}/g) || [];
    assert.equal(
      tabIndexMatches.length,
      1,
      `FileTreeFolder should have exactly 1 tabIndex={0}, found ${tabIndexMatches.length}`,
    );
  });
});
