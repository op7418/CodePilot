/**
 * Memory extraction compatibility helpers and successful-write receipt checks.
 *
 * Legacy counter helpers remain for callers; production scheduling and extraction
 * are owned by memory-lifecycle.ts with durable source references. Optional
 * model execution goes through the shared auxiliary provider runner; this
 * module does not execute or fork an agent.
 */

const DEFAULT_EXTRACTION_INTERVAL = 3; // Extract every 3 turns
const GLOBAL_KEY = '__memory_extraction_counters__';

/** Per-session counter map (survives HMR via globalThis). */
function getCounterMap(): Map<string, number> {
  if (!(globalThis as Record<string, unknown>)[GLOBAL_KEY]) {
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = new Map<string, number>();
  }
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as Map<string, number>;
}

/**
 * Get extraction interval based on buddy rarity.
 * Epic+ buddies extract every 2 turns instead of 3.
 */
export function getExtractionInterval(buddyRarity?: string): number {
  if (buddyRarity === 'epic' || buddyRarity === 'legendary') return 2;
  return DEFAULT_EXTRACTION_INTERVAL;
}

/**
 * Check if memory extraction should run for this turn.
 * Returns true every N assistant turns (interval depends on buddy rarity).
 * Counter is scoped per sessionId so sessions don't interfere with each other.
 */
export function shouldExtractMemory(buddyRarity?: string, sessionId?: string): boolean {
  const interval = getExtractionInterval(buddyRarity);
  const key = sessionId || '__default__';
  const counters = getCounterMap();
  const counter = (counters.get(key) || 0) + 1;
  counters.set(key, counter);
  return counter % interval === 0;
}

/**
 * Reset the extraction counter for a specific session (e.g., on session change).
 */
export function resetExtractionCounter(sessionId?: string): void {
  const counters = getCounterMap();
  if (sessionId) {
    counters.delete(sessionId);
  } else {
    counters.clear();
  }
}

/** Only a successful managed mutation receipt can suppress automatic extraction.
 * Reads, attempts and failed writes are not persistence evidence. */
export function hasMemoryWritesInResponse(responseText: string): boolean {
  try {
    const blocks: unknown = JSON.parse(responseText);
    if (!Array.isArray(blocks)) return false;
    const calls = new Map(blocks.filter(b => b?.type === 'tool_use').map(b => [b.id, b.name]));
    return blocks.some(block => {
      if (block?.type !== 'tool_result' || block.is_error) return false;
      const name = calls.get(block.tool_use_id);
      if (typeof name !== 'string' || !/(?:^|__)codepilot_memory_(?:remember|update|forget)$/.test(name)) return false;
      const raw = typeof block.content === 'string' ? block.content : '';
      try {
        const receipt = JSON.parse(raw);
        return receipt.type === 'memory_write_receipt' && receipt.status === 'saved'
          && typeof receipt.revision === 'string' && receipt.revision.length > 0;
      } catch { return false; }
    });
  } catch { return false; }
}
