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
  startBridge: () => Promise<void>;
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

  // Poll bridge status while bridge is running
  useEffect(() => {
    if (bridgeStatus?.running) {
      pollRef.current = setInterval(refreshStatus, 5000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, [bridgeStatus?.running, refreshStatus]);

  const startBridge = useCallback(async () => {
    setStarting(true);
    try {
      await fetch("/api/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      await refreshStatus();
    } catch {
      // ignore
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
