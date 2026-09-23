import { getSetting } from '@/lib/db';
import { sendNotification } from '@/lib/notification-manager';
import { translate, type Locale } from '@/i18n';

const MAX_SUBJECT_LENGTH = 80;

function notificationLocale(): Locale {
  return getSetting('locale') === 'zh' ? 'zh' : 'en';
}

/** Keep lock-screen notification copy compact and free of control characters. */
export function normalizeNotificationSubject(value: string | undefined, fallback: string): string {
  const normalized = (value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return fallback;
  return normalized.length > MAX_SUBJECT_LENGTH
    ? `${normalized.slice(0, MAX_SUBJECT_LENGTH - 1)}…`
    : normalized;
}

function sessionRoute(sessionId: string): string {
  return `/chat/${encodeURIComponent(sessionId)}`;
}

export async function notifyInteractiveChatApproval(args: {
  sessionId: string;
  sessionTitle?: string;
  toolName?: string;
}): Promise<string> {
  const locale = notificationLocale();
  const session = normalizeNotificationSubject(
    args.sessionTitle,
    translate(locale, 'notifications.untitledSession'),
  );
  const tool = normalizeNotificationSubject(
    args.toolName,
    translate(locale, 'notifications.unknownAction'),
  );
  const result = await sendNotification({
    title: translate(locale, 'notifications.approvalRequiredTitle'),
    body: translate(locale, 'notifications.approvalRequiredBody', { session, tool }),
    priority: 'normal',
    sessionId: args.sessionId,
    source: 'codepilot',
    action: { type: 'route', payload: sessionRoute(args.sessionId) },
  });
  return result.event_id;
}

export async function notifyInteractiveChatCompleted(args: {
  sessionId: string;
  sessionTitle?: string;
}): Promise<string> {
  const locale = notificationLocale();
  const session = normalizeNotificationSubject(
    args.sessionTitle,
    translate(locale, 'notifications.untitledSession'),
  );
  const result = await sendNotification({
    title: translate(locale, 'notifications.taskCompletedTitle'),
    body: translate(locale, 'notifications.taskCompletedBody', { session }),
    priority: 'normal',
    sessionId: args.sessionId,
    source: 'codepilot',
    action: { type: 'route', payload: sessionRoute(args.sessionId) },
  });
  return result.event_id;
}
