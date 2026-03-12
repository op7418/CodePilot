import { useState, useCallback, useEffect } from "react";

interface VerifyResult {
  ok: boolean;
  message: string;
}

/**
 * Generic hook for bridge adapter settings management.
 * Encapsulates the fetch/save/verify pattern shared by all bridge adapters
 * (Telegram, Discord, Feishu, QQ).
 */
export function useBridgeAdapter<T extends Record<string, string>>(
  platform: string,
  defaults: T
): {
  settings: T;
  loading: boolean;
  saving: boolean;
  save: (updates: Partial<T>) => Promise<void>;
  refresh: () => Promise<void>;
  verify: (params: Record<string, string>) => Promise<void>;
  verifying: boolean;
  verifyResult: VerifyResult | null;
  setVerifyResult: (result: VerifyResult | null) => void;
} {
  const [settings, setSettings] = useState<T>(defaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const endpoint = `/api/settings/${platform}`;

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

  const verify = useCallback(async (params: Record<string, string>) => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch(`${endpoint}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const data = await res.json();

      if (data.verified) {
        setVerifyResult({
          ok: true,
          message: data.botName
            ? `Verified as ${data.botName}`
            : "Verification successful",
        });
      } else {
        setVerifyResult({
          ok: false,
          message: data.error || "Verification failed",
        });
      }
    } catch {
      setVerifyResult({ ok: false, message: "Verification failed" });
    } finally {
      setVerifying(false);
    }
  }, [endpoint]);

  return {
    settings, loading, saving, save, refresh,
    verify, verifying, verifyResult, setVerifyResult,
  };
}
