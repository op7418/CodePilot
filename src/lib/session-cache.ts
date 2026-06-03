/**
 * Session list cache with stale-while-revalidate pattern.
 *
 * Caches the session list to provide instant UI on mount while
 * refreshing in the background. Deduplicates concurrent requests
 * and provides optimistic updates for better UX.
 */

import type { ChatSession } from '@/types';

interface SessionCacheEntry {
  sessions: ChatSession[];
  timestamp: number;
  /** Promise for in-flight fetch (deduplicates concurrent requests) */
  inflight: Promise<ChatSession[] | null> | null;
}

// Module-level singleton cache
let cache: SessionCacheEntry | null = null;

/** Cache TTL: 10 seconds. Sessions change more frequently than settings. */
const CACHE_TTL_MS = 10_000;

/** Background refresh interval: 30 seconds */
const BACKGROUND_REFRESH_MS = 30_000;

/** Maximum age before forced refresh: 2 minutes */
const MAX_CACHE_AGE_MS = 2 * 60 * 1000;

/**
 * Fetch sessions with caching and deduplication.
 *
 * @param forceRefresh - If true, bypass cache and fetch fresh data
 * @returns Array of sessions, or null if fetch failed
 */
export async function fetchSessionsWithCache(forceRefresh = false): Promise<ChatSession[] | null> {
  const now = Date.now();

  // Return cached data if fresh and not forcing refresh
  if (!forceRefresh && cache && (now - cache.timestamp) < CACHE_TTL_MS) {
    return cache.sessions;
  }

  // Deduplicate: if there's already an in-flight request, wait for it
  if (cache?.inflight) {
    return cache.inflight;
  }

  // Start new fetch
  const fetchPromise = fetch("/api/chat/sessions")
    .then(res => res.ok ? res.json() : null)
    .then((data: { sessions?: ChatSession[] } | null) => {
      const sessions = data?.sessions || [];

      // Update cache
      cache = {
        sessions,
        timestamp: Date.now(),
        inflight: null,
      };

      return sessions;
    })
    .catch(() => {
      // On error, clear in-flight but keep stale cache
      if (cache) cache.inflight = null;
      return null;
    });

  // Store in-flight promise for deduplication
  if (cache) {
    cache.inflight = fetchPromise;
  } else {
    cache = {
      sessions: [],
      timestamp: 0,
      inflight: fetchPromise,
    };
  }

  return fetchPromise;
}

/**
 * Get cached sessions synchronously (may be stale).
 * Returns null if no cache exists.
 */
export function getCachedSessions(): ChatSession[] | null {
  return cache?.sessions ?? null;
}

/**
 * Check if cached data is fresh (within TTL).
 */
export function isCacheFresh(): boolean {
  if (!cache) return false;
  return (Date.now() - cache.timestamp) < CACHE_TTL_MS;
}

/**
 * Check if cached data is usable (within max age).
 * Stale data can still be served while refreshing in background.
 */
export function isCacheUsable(): boolean {
  if (!cache) return false;
  return (Date.now() - cache.timestamp) < MAX_CACHE_AGE_MS;
}

/**
 * Update the cache with new session data.
 * Useful for optimistic updates after create/delete/rename.
 */
export function updateSessionCache(sessions: ChatSession[]): void {
  cache = {
    sessions,
    timestamp: Date.now(),
    inflight: null,
  };
}

/**
 * Add a session to the cache (optimistic insert).
 */
export function addSessionToCache(session: ChatSession): void {
  if (!cache) {
    cache = { sessions: [session], timestamp: Date.now(), inflight: null };
    return;
  }
  // Add to beginning (newest first)
  cache.sessions = [session, ...cache.sessions.filter(s => s.id !== session.id)];
}

/**
 * Update a session in the cache (optimistic update).
 */
export function updateSessionInCache(sessionId: string, updates: Partial<ChatSession>): void {
  if (!cache) return;
  cache.sessions = cache.sessions.map(s =>
    s.id === sessionId ? { ...s, ...updates } : s
  );
}

/**
 * Remove a session from the cache (optimistic delete).
 */
export function removeSessionFromCache(sessionId: string): void {
  if (!cache) return;
  cache.sessions = cache.sessions.filter(s => s.id !== sessionId);
}

/**
 * Invalidate the session cache.
 * Call this when you know sessions have changed externally.
 */
export function invalidateSessionCache(): void {
  cache = null;
}

/**
 * Get cache statistics for debugging.
 */
export function getSessionCacheStats() {
  if (!cache) {
    return { exists: false, size: 0, age: 0, isFresh: false, isUsable: false };
  }
  const age = Date.now() - cache.timestamp;
  return {
    exists: true,
    size: cache.sessions.length,
    age,
    isFresh: age < CACHE_TTL_MS,
    isUsable: age < MAX_CACHE_AGE_MS,
    hasInflight: !!cache.inflight,
  };
}

/**
 * Background refresh: fetch fresh data and update cache.
 * Does not return data — just keeps cache warm.
 */
export function warmSessionCache(): void {
  if (!cache || (Date.now() - cache.timestamp) > BACKGROUND_REFRESH_MS) {
    fetchSessionsWithCache(true).catch(() => {
      // Silently ignore failures — warming is best-effort
    });
  }
}
