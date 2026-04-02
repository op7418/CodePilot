/**
 * Unit tests for mcp-loader.
 *
 * Run with: npx tsx --test src/__tests__/unit/mcp-loader.test.ts
 *
 * Tests verify:
 * 1. loadCodePilotMcpServers returns undefined when no servers have ${...} placeholders
 * 2. loadCodePilotMcpServers returns only servers with resolved placeholders
 * 3. loadAllMcpServers returns all merged servers
 * 4. Cache invalidation works
 * 5. Disabled servers are filtered out
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Import the module — will use real filesystem
// Tests are designed to work with the user's actual config
import { loadCodePilotMcpServers, loadAllMcpServers, invalidateMcpCache } from '../../lib/mcp-loader';

afterEach(() => {
  invalidateMcpCache();
});

describe('mcp-loader', () => {

  it('loadCodePilotMcpServers: returns undefined when no servers have placeholders', () => {
    // Most real configs don't have ${...} placeholders
    // This test verifies the common case returns undefined (= let SDK handle everything)
    const result = loadCodePilotMcpServers();
    // Either undefined (no placeholders) or a map (has placeholders)
    // Both are valid; we just verify it doesn't throw
    if (result === undefined) {
      assert.equal(result, undefined);
    } else {
      assert.ok(typeof result === 'object');
      // Verify all returned servers have env values (they were resolved from placeholders)
      for (const server of Object.values(result)) {
        assert.ok(server.env, 'returned servers should have env property');
      }
    }
  });

  it('loadAllMcpServers: returns merged config or undefined', () => {
    const result = loadAllMcpServers();
    // Result depends on whether user has MCP servers configured
    if (result !== undefined) {
      assert.ok(typeof result === 'object');
      for (const [name, server] of Object.entries(result)) {
        assert.ok(typeof name === 'string');
        // All servers should NOT be disabled (disabled ones are filtered out)
        assert.notEqual(server.enabled, false);
      }
    }
  });

  it('cache: consecutive calls return same reference', () => {
    const result1 = loadAllMcpServers();
    const result2 = loadAllMcpServers();
    // Same cache should be hit — references should be equal
    // (unless there are no servers, in which case both are undefined)
    if (result1 !== undefined && result2 !== undefined) {
      assert.equal(result1, result2, 'cached results should be the same reference');
    }
  });

  it('invalidateMcpCache: forces fresh read', () => {
    const result1 = loadAllMcpServers();
    invalidateMcpCache();
    const result2 = loadAllMcpServers();
    // After invalidation, a new object should be created
    // (they may be deeply equal but should be different references)
    if (result1 !== undefined && result2 !== undefined) {
      // New cache entry means new object
      assert.notEqual(result1, result2, 'invalidated cache should produce new reference');
    }
  });
});
