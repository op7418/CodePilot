'use client';

import { useCallback, useEffect, useState } from 'react';

export function useCcSwitchCompatMode(): { enabled: boolean; ready: boolean } {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);

  const fetchSetting = useCallback(() => {
    setReady(false);
    fetch('/api/settings/app')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        setEnabled(data?.settings?.cc_switch_compat_mode === 'true');
      })
      .catch(() => {
        setEnabled(false);
      })
      .finally(() => {
        setReady(true);
      });
  }, []);

  useEffect(() => {
    fetchSetting();
    window.addEventListener('app-settings-changed', fetchSetting);
    return () => window.removeEventListener('app-settings-changed', fetchSetting);
  }, [fetchSetting]);

  return { enabled, ready };
}
