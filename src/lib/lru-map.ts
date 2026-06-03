/**
 * Lightweight LRU Map with a fixed capacity.
 * When the map exceeds `maxSize`, the least-recently-used entry is evicted.
 * "Used" means either `get()` or `set()`.
 *
 * Enhanced with optional statistics tracking for cache hit rate monitoring.
 */

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  /** Hit rate as a value between 0 and 1 */
  hitRate: number;
  /** Total number of lookups (hits + misses) */
  totalLookups: number;
}

export class LRUMap<K, V> {
  private map = new Map<K, V>();
  private readonly maxSize: number;
  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;
  private _trackingEnabled = false;

  constructor(maxSize: number, options?: { trackStats?: boolean }) {
    this.maxSize = maxSize;
    this._trackingEnabled = options?.trackStats ?? false;
  }

  /**
   * Enable or disable statistics tracking.
   * When disabled, stats counters are not incremented (zero overhead).
   */
  set trackingEnabled(enabled: boolean) {
    this._trackingEnabled = enabled;
  }

  get trackingEnabled(): boolean {
    return this._trackingEnabled;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, value);
      if (this._trackingEnabled) this._hits++;
    } else if (this._trackingEnabled) {
      this._misses++;
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict the oldest (first) entry
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
        if (this._trackingEnabled) this._evictions++;
      }
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  get capacity(): number {
    return this.maxSize;
  }

  clear(): void {
    this.map.clear();
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  /**
   * Get cache statistics. Only meaningful when trackingEnabled is true.
   * Returns a snapshot of the current counters.
   */
  getStats(): CacheStats {
    const totalLookups = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      hitRate: totalLookups > 0 ? this._hits / totalLookups : 0,
      totalLookups,
    };
  }

  /**
   * Reset all statistics counters to zero.
   */
  resetStats(): void {
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  /**
   * Get all keys in order from least-recently-used to most-recently-used.
   * Useful for debugging and cache inspection.
   */
  keys(): K[] {
    return Array.from(this.map.keys());
  }

  /**
   * Get all values in order from least-recently-used to most-recently-used.
   */
  values(): V[] {
    return Array.from(this.map.values());
  }

  /**
   * Check if the cache is at capacity.
   */
  get isFull(): boolean {
    return this.map.size >= this.maxSize;
  }

  /**
   * Get the utilization ratio (size / capacity).
   */
  get utilization(): number {
    return this.maxSize > 0 ? this.map.size / this.maxSize : 0;
  }
}

/**
 * Create an LRUMap with statistics tracking enabled.
 * Convenience factory for caches where monitoring is desired.
 */
export function createTrackedLRUMap<K, V>(maxSize: number): LRUMap<K, V> {
  return new LRUMap<K, V>(maxSize, { trackStats: true });
}
