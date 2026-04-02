/**
 * Unit tests for memory-extractor — per-session counters and write detection.
 *
 * Run with: npx tsx --test src/__tests__/unit/memory-extractor.test.ts
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

describe('memory-extractor', () => {
  beforeEach(async () => {
    const { resetExtractionCounter } = await import('../../lib/memory-extractor');
    resetExtractionCounter(); // clear all counters
  });

  describe('shouldExtractMemory — per-session isolation', () => {
    it('fires every 3 turns for default rarity', async () => {
      const { shouldExtractMemory } = await import('../../lib/memory-extractor');
      const results: boolean[] = [];
      for (let i = 0; i < 9; i++) {
        results.push(shouldExtractMemory(undefined, 'session-a'));
      }
      // Should be true at turns 3, 6, 9 (indices 2, 5, 8)
      assert.deepEqual(results, [false, false, true, false, false, true, false, false, true]);
    });

    it('fires every 2 turns for epic rarity', async () => {
      const { shouldExtractMemory } = await import('../../lib/memory-extractor');
      const results: boolean[] = [];
      for (let i = 0; i < 6; i++) {
        results.push(shouldExtractMemory('epic', 'session-b'));
      }
      assert.deepEqual(results, [false, true, false, true, false, true]);
    });

    it('fires every 2 turns for legendary rarity', async () => {
      const { shouldExtractMemory } = await import('../../lib/memory-extractor');
      const results: boolean[] = [];
      for (let i = 0; i < 4; i++) {
        results.push(shouldExtractMemory('legendary', 'session-c'));
      }
      assert.deepEqual(results, [false, true, false, true]);
    });

    it('different sessions have independent counters', async () => {
      const { shouldExtractMemory } = await import('../../lib/memory-extractor');

      // Session A: 2 turns (not yet)
      shouldExtractMemory(undefined, 'session-a');
      shouldExtractMemory(undefined, 'session-a');

      // Session B: 3 turns (fires!)
      shouldExtractMemory(undefined, 'session-b');
      shouldExtractMemory(undefined, 'session-b');
      const bResult = shouldExtractMemory(undefined, 'session-b');

      // Session A: 3rd turn should fire (not affected by session B)
      const aResult = shouldExtractMemory(undefined, 'session-a');

      assert.equal(bResult, true);
      assert.equal(aResult, true);
    });

    it('resetExtractionCounter clears specific session', async () => {
      const { shouldExtractMemory, resetExtractionCounter } = await import('../../lib/memory-extractor');

      // Advance session-a to turn 2
      shouldExtractMemory(undefined, 'session-a');
      shouldExtractMemory(undefined, 'session-a');

      // Reset session-a
      resetExtractionCounter('session-a');

      // Next 3 calls should restart from 0
      const results: boolean[] = [];
      for (let i = 0; i < 3; i++) {
        results.push(shouldExtractMemory(undefined, 'session-a'));
      }
      assert.deepEqual(results, [false, false, true]);
    });
  });

  describe('hasMemoryWritesInResponse', () => {
    it('detects tool_use with memory.md path', async () => {
      const { hasMemoryWritesInResponse } = await import('../../lib/memory-extractor');
      const json = JSON.stringify([
        { type: 'text', text: 'I updated your memory.' },
        { type: 'tool_use', id: '1', name: 'Write', input: { file_path: '/workspace/memory.md' } },
      ]);
      assert.equal(hasMemoryWritesInResponse(json), true);
    });

    it('detects tool_result with daily memory path', async () => {
      const { hasMemoryWritesInResponse } = await import('../../lib/memory-extractor');
      const json = JSON.stringify([
        { type: 'tool_result', tool_use_id: '1', content: 'Written to memory/daily/2026-04-01.md' },
      ]);
      assert.equal(hasMemoryWritesInResponse(json), true);
    });

    it('detects tool_use with soul.md path', async () => {
      const { hasMemoryWritesInResponse } = await import('../../lib/memory-extractor');
      const json = JSON.stringify([
        { type: 'tool_use', id: '1', name: 'Edit', input: { file_path: 'soul.md' } },
      ]);
      assert.equal(hasMemoryWritesInResponse(json), true);
    });

    it('returns false for plain text without tool blocks', async () => {
      const { hasMemoryWritesInResponse } = await import('../../lib/memory-extractor');
      assert.equal(hasMemoryWritesInResponse('Hello, I talked about memory today.'), false);
    });

    it('returns false for tool blocks without memory paths', async () => {
      const { hasMemoryWritesInResponse } = await import('../../lib/memory-extractor');
      const json = JSON.stringify([
        { type: 'tool_use', id: '1', name: 'Write', input: { file_path: '/project/src/index.ts' } },
        { type: 'tool_result', tool_use_id: '1', content: 'File written.' },
      ]);
      assert.equal(hasMemoryWritesInResponse(json), false);
    });

    it('returns false for empty string', async () => {
      const { hasMemoryWritesInResponse } = await import('../../lib/memory-extractor');
      assert.equal(hasMemoryWritesInResponse(''), false);
    });
  });

  describe('getExtractionInterval', () => {
    it('returns 3 for common rarity', async () => {
      const { getExtractionInterval } = await import('../../lib/memory-extractor');
      assert.equal(getExtractionInterval('common'), 3);
    });

    it('returns 3 for uncommon rarity', async () => {
      const { getExtractionInterval } = await import('../../lib/memory-extractor');
      assert.equal(getExtractionInterval('uncommon'), 3);
    });

    it('returns 2 for epic rarity', async () => {
      const { getExtractionInterval } = await import('../../lib/memory-extractor');
      assert.equal(getExtractionInterval('epic'), 2);
    });

    it('returns 2 for legendary rarity', async () => {
      const { getExtractionInterval } = await import('../../lib/memory-extractor');
      assert.equal(getExtractionInterval('legendary'), 2);
    });

    it('returns 3 for undefined rarity', async () => {
      const { getExtractionInterval } = await import('../../lib/memory-extractor');
      assert.equal(getExtractionInterval(undefined), 3);
    });
  });
});
