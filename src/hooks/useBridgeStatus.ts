import { useState, useCallback, useEffect, useRef } from "react";

interface AdapterStatus {
  channelType: string;
  running: boolean;
  connectedAt: string | null;
  lastMessageAt: string | null;
  error: string | null;
}

interface BridgeStatus {
  running: boolean;
  startedAt: string | null;
  adapters: AdapterStatus[];
}

/**
 * Hook for polling bridge status and controlling bridge start/stop.
 * Automatically polls every 5 seconds while the bridge is running.
 */
export function useBridgeStatus(): {
  bridgeStatus: BridgeStatus | null;
  starting: boolean;
  stopping: boolean;
  startBridge: () => Promise<string | null>;
  stopBridge: () => Promise<void>;
  refreshStatus: () => Promise<void>;
} {
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/bridge");
      if (res.ok) {
        const data = await res.json();
        setBridgeStatus(data);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Poll bridge status while the bridge is running and the page is
  // visible. Pausing when the tab is hidden avoids waking the renderer
  // on a 5-second cadence for data the user cannot act on, and frees
  // the network for higher-priority traffic when the user returns.
  useEffect(() => {
    if (!bridgeStatus?.running) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    const start = () => {
      if (pollRef.current) return;
      pollRef.current = setInterval(refreshStatus, 5000);
    };
    const stop = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    const onVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'visible') {
        // Catch up immediately on resume so the UI shows fresh data
        // before the next interval tick.
        void refreshStatus();
        start();
      } else {
        stop();
      }
    };

    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      start();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [bridgeStatus?.running, refreshStatus]);

  const startBridge = useCallback(async (): Promise<string | null> => {
    setStarting(true);
    try {
      const res = await fetch("/api/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const data = await res.json();
      await refreshStatus();
      if (!data.ok && data.reason) {
        return data.reason;
      }
      return null;
    } catch {
      return 'network_error';
    } finally {
      setStarting(false);
    }
  }, [refreshStatus]);

  const stopBridge = useCallback(async () => {
    setStopping(true);
    try {
      await fetch("/api/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      await refreshStatus();
    } catch {
      // ignore
    } finally {
      setStopping(false);
    }
  }, [refreshStatus]);

  return { bridgeStatus, starting, stopping, startBridge, stopBridge, refreshStatus };
}
