/**
 * Notification Manager — unified multi-channel notification dispatch.
 *
 * Phase 3 Step 3 — events / deliveries split (v4 plan):
 *   • One logical task notification = one `notification_events` row
 *     (the umbrella). `sendNotification()` writes it.
 *   • Each candidate channel = one `notification_deliveries` row tied
 *     to that event by `event_id` (1:N relationship). Renderer /
 *     Electron / Bridge each ack their channel via
 *     `POST /api/tasks/notify/ack`, which settles a leased attempt on the
 *     same durable delivery row.
 *
 * Channel × priority matrix:
 *   - low     → electron-native (queued)
 *   - normal  → electron-native (queued)
 *   - urgent  → electron-native (queued)
 *               + bridge-telegram (queued / not_configured / skipped)
 *
 * non-urgent priority deliberately writes NO `bridge-*` delivery row —
 * Bridge is not a candidate channel for these priorities, and writing
 * `skipped_by_priority` would imply we considered Bridge then bailed,
 * which misrepresents the product policy.
 *
 * Delivery payloads are claimed directly from durable rows. There is no
 * destructive in-memory drain: server/renderer restarts retain queued work.
 */

import {
  getSetting,
  insertNotificationEvent,
  upsertNotificationDelivery,
} from '@/lib/db';

/**
 * Send a notification through appropriate channels based on priority.
 *
 * Implementation lives in the Next.js server process. The actual
 * display happens in Electron Main for every priority. In-app toasts remain
 * an interaction-feedback surface, but are not a notification delivery
 * channel. Each channel acks its delivery row when the native surface
 * confirms success.
 */
export async function sendNotification(opts: {
  title: string;
  body: string;
  priority: 'low' | 'normal' | 'urgent';
  taskId?: string;
  sessionId?: string;
  source?: 'codepilot' | 'external';
  action?: { type: string; payload: string };
}): Promise<{
  event_id: string;
  deliveries: Array<{ channel: string; status: string; error?: string }>;
}> {
  // 1. Generate the umbrella event id and persist the events row.
  const event_id = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  insertNotificationEvent({
    event_id,
    task_id: opts.taskId ?? null,
    session_id: opts.sessionId ?? null,
    action: opts.action ?? null,
    source: opts.source ?? 'codepilot',
    title: opts.title,
    body: opts.body,
    priority: opts.priority,
  });

  // 2. Enumerate candidate channels per priority. Each candidate gets
  //    a `notification_deliveries` row immediately. v4 plan: 1:N
  //    relationship — events row is written ONCE above; the per-channel
  //    rows below are deliveries, not extra event rows.
  //
  // v7 fix (P2) — track delivery states in a Map keyed by channel so
  // the return shape always reflects the FINAL state per channel,
  // never the queued-then-delivered history. The DB row is already
  // UPSERTed in place by upsertNotificationDelivery; the previous
  // Array-based collector pushed an extra entry on every status flip
  // and exposed `bridge-telegram: queued` + `bridge-telegram: delivered`
  // both in the API response.
  const deliveryStates = new Map<
    string,
    { status: 'queued' | 'delivered' | 'error' | 'not_configured' | 'skipped'; error?: string }
  >();

  const writeDelivery = (
    channel: string,
    status: 'queued' | 'delivered' | 'error' | 'not_configured' | 'skipped',
    error?: string,
  ): void => {
    deliveryStates.set(channel, { status, error });
    upsertNotificationDelivery({ event_id, channel, status, error });
  };

  writeDelivery('electron-native', 'queued');

  // bridge-telegram: urgent only (v4 plan locks). For non-urgent we
  // write nothing — the absence of a bridge-* row already expresses
  // "Bridge wasn't a candidate" (product policy: remote channel is
  // urgent-only).
  if (opts.priority === 'urgent') {
    const enabled = getSetting('telegram_enabled') === 'true';
    const botToken = getSetting('telegram_bot_token') || '';
    const chatId = getSetting('telegram_chat_id') || '';
    if (!botToken || !chatId) {
      writeDelivery('bridge-telegram', 'not_configured');
    } else if (!enabled) {
      writeDelivery('bridge-telegram', 'skipped');
    } else {
      writeDelivery('bridge-telegram', 'queued');
    }
  }

  // 4. Bridge fire — urgent + the row we just wrote was 'queued' (i.e.,
  //    actually configured + enabled). On success / failure, flip the
  //    same delivery row in place via UPSERT. v5 plan: UNIQUE(event_id,
  //    channel) at the DB layer means duplicate INSERTs are SQL-rejected
  //    even if a buggy ack route ever tries. v7 fix: also overwrites
  //    the Map entry so the return shape carries only the final state.
  if (opts.priority === 'urgent') {
    const bridgeStatus = deliveryStates.get('bridge-telegram')?.status;
    if (bridgeStatus === 'queued') {
      try {
        const { notifyGeneric } = await import('@/lib/telegram-bot');
        await notifyGeneric(opts.title, opts.body);
        writeDelivery('bridge-telegram', 'delivered');
      } catch (err) {
        writeDelivery(
          'bridge-telegram',
          'error',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  // v7 fix (P2) — emit one entry per channel reflecting the FINAL
  // state, not the (queued, delivered) history. Map iteration order
  // matches insertion, so electron-native comes before bridge-* in the
  // response.
  // v8 fix — preserve `error` alongside `status` so external API
  // consumers (Bridge clients, /api/tasks/notify response readers,
  // future delivery-log surfaces) can show *why* a channel failed,
  // not just that it did. The DB row keeps it via
  // `upsertNotificationDelivery`; the in-memory Map keeps it on
  // `writeDelivery`; the response is the only place it was being
  // dropped. Only emit the field when actually present so successful
  // channels still serialise as `{ channel, status }` (no `error: ""`
  // noise in the response).
  const deliveries = Array.from(deliveryStates.entries()).map(
    ([channel, { status, error }]) =>
      error ? { channel, status, error } : { channel, status },
  );
  return { event_id, deliveries };
}

/**
 * Format a notification for display.
 */
export function formatNotification(title: string, body: string): string {
  return body ? `${title}: ${body}` : title;
}
