'use client';

import { useEffect, useRef } from 'react';
import { showToast, type ToastType } from '@/hooks/useToast';

const POLL_INTERVAL = 5_000; // 5s

const PRIORITY_TO_TOAST: Record<string, ToastType> = {
  low: 'info',
  normal: 'info',
  urgent: 'warning',
};

/**
 * Polls GET /api/tasks/notify to drain server-side notification queue
 * and display them as toasts + system notifications via Electron IPC.
 */
export function useNotificationPoll() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    async function poll() {
      try {
        const res = await fetch('/api/tasks/notify');
        if (!res.ok) return;
        const data = await res.json();
        const notifications = data.notifications || [];

        for (const notif of notifications) {
          // In-app toast for all priorities
          showToast({
            type: PRIORITY_TO_TOAST[notif.priority] || 'info',
            message: notif.body ? `${notif.title}: ${notif.body}` : notif.title,
          });

          // System notification for normal/urgent via Electron IPC bridge
          if (notif.priority === 'normal' || notif.priority === 'urgent') {
            if (typeof window !== 'undefined' && window.electronAPI?.notification) {
              // Electron: use native notification via IPC (supports click-to-focus)
              window.electronAPI.notification.show({
                title: notif.title,
                body: notif.body || '',
              }).catch(() => {}); // best effort
            } else if (
              typeof window !== 'undefined' &&
              'Notification' in window &&
              Notification.permission === 'granted'
            ) {
              // Browser fallback (dev mode)
              new Notification(notif.title, { body: notif.body || '' });
            }
          }
        }
      } catch {
        // Best effort polling
      }
    }

    timerRef.current = setInterval(poll, POLL_INTERVAL);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);
}
