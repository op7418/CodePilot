import { useState, useCallback, useEffect } from "react";

/**
 * Generic hook for fetching and saving settings from an API endpoint.
 * Handles loading/saving states and provides a clean CRUD interface.
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
  const [settings, setSettings] = useState<T>(defaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(endpoint);
      if (res.ok) {
        const data = await res.json();
        setSettings({ ...defaults, ...data.settings });
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [endpoint, defaults]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = useCallback(async (updates: Partial<T>) => {
    setSaving(true);
    try {
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: updates }),
      });
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...updates }));
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }, [endpoint]);

  return { settings, loading, saving, save, refresh };
}
