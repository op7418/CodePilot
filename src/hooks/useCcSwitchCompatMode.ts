'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export function useCcSwitchCompatMode(): { enabled: boolean; ready: boolean } {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const fetchSetting = useCallback(() => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    if (mountedRef.current) {
      setReady(false);
    }
    fetch('/api/settings/app', { signal: controller.signal })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!controller.signal.aborted && mountedRef.current) {
          setEnabled(data?.settings?.cc_switch_compat_mode === 'true');
        }
      })
      .catch((error: unknown) => {
        if ((error as { name?: string } | undefined)?.name === 'AbortError') return;
        if (!controller.signal.aborted && mountedRef.current) {
          setEnabled(false);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && mountedRef.current) {
          setReady(true);
        }
      });
  }, []);

  useEffect(() => {
    fetchSetting();
    window.addEventListener('app-settings-changed', fetchSetting);
    return () => {
      mountedRef.current = false;
      abortControllerRef.current?.abort();
      window.removeEventListener('app-settings-changed', fetchSetting);
    };
  }, [fetchSetting]);

  return { enabled, ready };
}
