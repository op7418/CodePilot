/**
 * Notification Manager — unified multi-channel notification dispatch.
 *
 * Three channels by priority:
 * - low: Toast only (in-app, non-intrusive)
 * - normal: Toast + Electron system notification
 * - urgent: Toast + Electron system notification + Telegram (if configured)
 *
 * In-app delivery: notifications are queued in a server-side ring buffer.
 * The frontend polls GET /api/tasks/notify to drain the queue and show toasts.
 */

// ── Server-side notification queue (survives HMR via globalThis) ────

interface QueuedNotification {
  id: string;
  title: string;
  body: string;
  priority: 'low' | 'normal' | 'urgent';
  timestamp: number;
}

const QUEUE_KEY = '__codepilot_notification_queue__';
const MAX_QUEUE_SIZE = 50;

function getQueue(): QueuedNotification[] {
  if (!(globalThis as Record<string, unknown>)[QUEUE_KEY]) {
    (globalThis as Record<string, unknown>)[QUEUE_KEY] = [];
  }
  return (globalThis as Record<string, unknown>)[QUEUE_KEY] as QueuedNotification[];
}

/** Push a notification into the server-side queue for frontend polling. */
export function enqueueNotification(title: string, body: string, priority: 'low' | 'normal' | 'urgent'): void {
  const queue = getQueue();
  queue.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    body,
    priority,
    timestamp: Date.now(),
  });
  // Ring buffer: drop oldest if over limit
  while (queue.length > MAX_QUEUE_SIZE) queue.shift();
}

/** Drain all queued notifications (returns and clears the queue). */
export function drainNotifications(): QueuedNotification[] {
  const queue = getQueue();
  const items = [...queue];
  queue.length = 0;
  return items;
}

/**
 * Send a notification through appropriate channels based on priority.
 *
 * Note: This runs in the Next.js server process. Toast and Electron notifications
 * are delivered via the poll queue. Telegram is called directly for urgent.
 */
export async function sendNotification(opts: {
  title: string;
  body: string;
  priority: 'low' | 'normal' | 'urgent';
  action?: { type: string; payload: string };
}): Promise<{ sent: string[] }> {
  const sent: string[] = [];

  // Channel 1: Queue for frontend polling (all priorities)
  enqueueNotification(opts.title, opts.body, opts.priority);
  sent.push('queued');

  // Channel 2: Telegram for urgent (direct server-side call)
  if (opts.priority === 'urgent') {
    try {
      const { notifyGeneric } = await import('@/lib/telegram-bot');
      await notifyGeneric(opts.title, opts.body);
      sent.push('telegram');
    } catch {
      // Best effort — Telegram may not be configured
    }
  }

  return { sent };
}

/**
 * Format a notification for display.
 */
export function formatNotification(title: string, body: string): string {
  return body ? `${title}: ${body}` : title;
}
