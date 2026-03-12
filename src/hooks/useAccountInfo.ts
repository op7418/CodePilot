import { useState, useCallback, useEffect } from "react";

interface AccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
}

/**
 * Hook for fetching Claude SDK account information.
 */
export function useAccountInfo(): {
  accountInfo: AccountInfo | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/sdk/account");
      if (res.ok) {
        const data = await res.json();
        if (data.account) {
          setAccountInfo(data.account);
        }
      }
    } catch {
      // Account info not available
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { accountInfo, loading, refresh };
}
