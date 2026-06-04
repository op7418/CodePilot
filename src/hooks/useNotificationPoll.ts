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
 * Phase 3 Step 3 — ack a notification_deliveries row by event_id +
 * channel. Best-effort: any failure is logged and ignored; the
 * notification has already been shown to the user, the worst case is
 * the delivery row stays `queued` (which the UI represents as
 * "shown, ack pending").
 */
function ackDelivery(payload: {
  event_id: string;
  channel: string;
  status: 'delivered' | 'error';
  error?: string;
}): void {
  fetch('/api/tasks/notify/ack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => { /* best effort */ });
}

interface PolledNotification {
  id: string;
  event_id?: string;
  task_id?: string;
  session_id?: string;
  title: string;
  body: string;
  priority: 'low' | 'normal' | 'urgent';
  timestamp: number;
}

/**
 * Polls GET /api/tasks/notify to drain server-side notification queue
 * and display them as toasts + system notifications via Electron IPC.
 *
 * Phase 3 Step 3 — after a successful display, POST /api/tasks/notify/ack
 * so the UI can show "delivered" instead of perpetual "queued". The
 * UPSERT semantics (v5 plan) mean repeated acks are idempotent, so
 * this stays safe even if the renderer + bg-poller both ack the same
 * event after a window-visibility flip.
 */
export function useNotificationPoll() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Request notification permission on mount (web/dev mode only)
  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      !window.electronAPI?.notification &&
      'Notification' in window &&
      Notification.permission === 'default'
    ) {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  useEffect(() => {
    async function poll() {
      try {
        const res = await fetch('/api/tasks/notify');
        if (!res.ok) return;
        const data = await res.json();
        const notifications: PolledNotification[] = data.notifications || [];

        for (const notif of notifications) {
          const eventId = notif.event_id;

          // In-app toast for all priorities (channel: renderer-toast)
          try {
            showToast({
              type: PRIORITY_TO_TOAST[notif.priority] || 'info',
              message: notif.body ? `${notif.title}: ${notif.body}` : notif.title,
            });
            if (eventId) {
              ackDelivery({ event_id: eventId, channel: 'renderer-toast', status: 'delivered' });
            }
          } catch (err) {
            if (eventId) {
              ackDelivery({
                event_id: eventId,
                channel: 'renderer-toast',
                status: 'error',
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // System notification for normal/urgent via Electron IPC
          // bridge (channel: electron-native).
          if (notif.priority === 'normal' || notif.priority === 'urgent') {
            if (typeof window !== 'undefined' && window.electronAPI?.notification) {
              window.electronAPI.notification
                .show({
                  title: notif.title,
                  body: notif.body || '',
                  // Phase 3 Step 3: thread payload through so the OS
                  // notification's click handler can route to
                  // /settings/tasks?focus=… or the chat session.
                  taskId: notif.task_id,
                  sessionId: notif.session_id,
                  event_id: eventId,
                })
                .then((ok) => {
                  if (eventId) {
                    ackDelivery({
                      event_id: eventId,
                      channel: 'electron-native',
                      status: ok ? 'delivered' : 'error',
                    });
                  }
                })
                .catch((err) => {
                  if (eventId) {
                    ackDelivery({
                      event_id: eventId,
                      channel: 'electron-native',
                      status: 'error',
                      error: err instanceof Error ? err.message : String(err),
                    });
                  }
                });
            } else if (
              typeof window !== 'undefined' &&
              'Notification' in window &&
              Notification.permission === 'granted'
            ) {
              // Browser fallback (dev mode) — counts as electron-native
              // for ack purposes since it's the same surface in spirit.
              try {
                new Notification(notif.title, { body: notif.body || '' });
                if (eventId) {
                  ackDelivery({ event_id: eventId, channel: 'electron-native', status: 'delivered' });
                }
              } catch (err) {
                if (eventId) {
                  ackDelivery({
                    event_id: eventId,
                    channel: 'electron-native',
                    status: 'error',
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            }
          }
        }
      } catch {
        // Best effort polling
      }
    }

    // Pause the notification poll while the page is hidden. The main
    // process's bg-notify poller (electron/main.ts) already covers the
    // hidden case, and waking the renderer every 5s on every background
    // tab just to drain an empty queue is wasted CPU + network. Resume
    // with an immediate catch-up poll so the user sees fresh state
    // without waiting POLL_INTERVAL.
    const start = () => {
      if (timerRef.current) return;
      timerRef.current = setInterval(poll, POLL_INTERVAL);
    };
    const stop = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
    const onVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'visible') {
        void poll();
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
      stop();
    };
  }, []);
}
