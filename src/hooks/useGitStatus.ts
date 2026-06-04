"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { GitStatus } from "@/types";

const POLL_INTERVAL = 10000; // 10s

export function useGitStatus(cwd: string) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  const fetchStatus = useCallback(async () => {
    if (!cwdRef.current) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/git/status?cwd=${encodeURIComponent(cwdRef.current)}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to fetch status');
      }
      const data: GitStatus = await res.json();
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch status');
    } finally {
      setLoading(false);
    }
  }, []);

  // Polling with visibility-aware pause/resume
  useEffect(() => {
    if (!cwd) {
      setStatus(null);
      return;
    }

    // Initial fetch
    fetchStatus();

    // Start polling only when page is visible
    function startPolling() {
      if (intervalRef.current) return;
      intervalRef.current = setInterval(fetchStatus, POLL_INTERVAL);
    }

    function stopPolling() {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        // Page became visible — fetch immediately and restart polling
        fetchStatus();
        startPolling();
      } else {
        // Page hidden — stop polling to save CPU/network
        stopPolling();
      }
    }

    // Start polling if page is currently visible
    if (document.visibilityState === 'visible') {
      startPolling();
    }

    document.addEventListener('visibilitychange', handleVisibility);

    // Listen for manual refresh events (e.g. after commit from topbar)
    const handleRefreshEvent = () => fetchStatus();
    window.addEventListener('git-refresh', handleRefreshEvent);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('git-refresh', handleRefreshEvent);
    };
  }, [cwd, fetchStatus]);

  return { status, loading, error, refresh: fetchStatus };
}
