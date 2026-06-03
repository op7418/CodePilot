import { useState, useCallback, useEffect, useRef } from "react";

/**
 * Settings cache with stale-while-revalidate pattern.
 *
 * Provides instant UI updates by serving cached settings while
 * refreshing in the background. Reduces unnecessary API calls
 * when multiple components mount/unmount during navigation.
 */

// Module-level cache for settings by endpoint
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  /** Promise for in-flight fetch (deduplicates concurrent requests) */
  inflight: Promise<T | null> | null;
}

const settingsCache = new Map<string, CacheEntry<unknown>>();

/** Cache TTL: 30 seconds. Settings don't change frequently. */
const CACHE_TTL_MS = 30_000;

/** Background refresh interval: 5 minutes */
const BACKGROUND_REFRESH_MS = 5 * 60 * 1000;

/**
 * Generic hook for fetching and saving settings from an API endpoint.
 * Handles loading/saving states and provides a clean CRUD interface.
 *
 * Features:
 * - Stale-while-revalidate: serves cached data immediately, refreshes in background
 * - Request deduplication: concurrent mounts share the same in-flight request
 * - Background refresh: periodically refreshes to catch external changes
 * - Optimistic updates: save() updates local state immediately
 */
export function useSettings<T extends Record<string, string>>(
  endpoint: string,
  defaults: T
): {
  settings: T;
  loading: boolean;
  saving: boolean;
  save: (updates: Partial<T>) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [settings, setSettings] = useState<T>(() => {
    // Initialize from cache if available (stale-while-revalidate)
    const cached = settingsCache.get(endpoint) as CacheEntry<T> | undefined;
    if (cached) {
      return { ...defaults, ...cached.data };
    }
    return defaults;
  });
  const [loading, setLoading] = useState(() => {
    // Only show loading if we don't have cached data
    const cached = settingsCache.get(endpoint) as CacheEntry<T> | undefined;
    return !cached;
  });
  const [saving, setSaving] = useState(false);

  // Track if component is mounted to avoid state updates after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  // Fetch settings with deduplication
  const fetchSettings = useCallback(async (forceRefresh = false): Promise<T | null> => {
    const cached = settingsCache.get(endpoint) as CacheEntry<T> | undefined;
    const now = Date.now();

    // Return cached data if fresh and not forcing refresh
    if (!forceRefresh && cached && (now - cached.timestamp) < CACHE_TTL_MS) {
      return cached.data;
    }

    // Deduplicate: if there's already an in-flight request, wait for it
    if (cached?.inflight) {
      return cached.inflight as Promise<T | null>;
    }

    // Start new fetch
    const fetchPromise = fetch(endpoint)
      .then(res => res.ok ? res.json() : null)
      .then((data: { settings?: T } | null) => {
        if (!data?.settings) return null;

        const merged = { ...defaults, ...data.settings } as T;

        // Update cache
        settingsCache.set(endpoint, {
          data: merged,
          timestamp: Date.now(),
          inflight: null,
        });

        return merged;
      })
      .catch(() => {
        // On error, clear in-flight but keep stale cache
        const entry = settingsCache.get(endpoint) as CacheEntry<T> | undefined;
        if (entry) entry.inflight = null;
        return null;
      });

    // Store in-flight promise for deduplication
    if (cached) {
      cached.inflight = fetchPromise;
    } else {
      settingsCache.set(endpoint, {
        data: defaults,
        timestamp: 0,
        inflight: fetchPromise,
      });
    }

    return fetchPromise;
  }, [endpoint, defaults]);

  // Initial fetch with stale-while-revalidate
  const refresh = useCallback(async () => {
    const cached = settingsCache.get(endpoint) as CacheEntry<T> | undefined;
    const now = Date.now();

    // Serve stale data immediately if available
    if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
      if (mountedRef.current) {
        setSettings({ ...defaults, ...cached.data } as T);
        setLoading(false);
      }
      return;
    }

    // Show loading only if no cached data at all
    if (!cached && mountedRef.current) {
      setLoading(true);
    }

    const data = await fetchSettings(!cached); // Force refresh if no cache
    if (data && mountedRef.current) {
      setSettings({ ...defaults, ...data } as T);
      setLoading(false);
    } else if (mountedRef.current) {
      setLoading(false);
    }
  }, [endpoint, defaults, fetchSettings]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Background refresh: periodically check for external changes
  useEffect(() => {
    const interval = setInterval(() => {
      // Only refresh if component is still mounted
      if (mountedRef.current) {
        fetchSettings(true).then(data => {
          if (data && mountedRef.current) {
            setSettings(prev => {
              // Only update if data actually changed
              const merged = { ...defaults, ...data } as T;
              if (JSON.stringify(prev) === JSON.stringify(merged)) return prev;
              return merged;
            });
          }
        });
      }
    }, BACKGROUND_REFRESH_MS);

    return () => clearInterval(interval);
  }, [fetchSettings, defaults]);

  // Optimistic save: update local state immediately, then sync with server
  const save = useCallback(async (updates: Partial<T>) => {
    setSaving(true);

    // Optimistic update
    setSettings(prev => {
      const next = { ...prev, ...updates } as T;
      // Update cache immediately for consistency
      const cached = settingsCache.get(endpoint) as CacheEntry<T> | undefined;
      if (cached) {
        cached.data = next;
        cached.timestamp = Date.now(); // Reset TTL
      }
      return next;
    });

    try {
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: updates }),
      });

      if (!res.ok) {
        // Revert on failure by re-fetching
        const data = await fetchSettings(true);
        if (data && mountedRef.current) {
          setSettings({ ...defaults, ...data } as T);
        }
      }
    } catch {
      // Revert on error by re-fetching
      const data = await fetchSettings(true);
      if (data && mountedRef.current) {
        setSettings({ ...defaults, ...data } as T);
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  }, [endpoint, defaults, fetchSettings]);

  return { settings, loading, saving, save, refresh };
}

/**
 * Invalidate the settings cache for a specific endpoint.
 * Call this when you know settings have changed externally
 * (e.g., after a settings import or API call).
 */
export function invalidateSettingsCache(endpoint: string) {
  settingsCache.delete(endpoint);
}

/**
 * Invalidate all settings caches.
 * Useful after bulk operations or settings resets.
 */
export function invalidateAllSettingsCache() {
  settingsCache.clear();
}

/**
 * Get cache statistics for debugging.
 */
export function getSettingsCacheStats() {
  const entries = Array.from(settingsCache.entries());
  return {
    size: entries.length,
    endpoints: entries.map(([key, value]) => ({
      endpoint: key,
      hasData: Object.keys(value.data).length > 0,
      age: Date.now() - value.timestamp,
      hasInflight: !!value.inflight,
    })),
  };
}
