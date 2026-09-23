import { NextRequest, NextResponse } from 'next/server';
import { getNotificationEvent, listNotificationDeliveries } from '@/lib/db';
import { validateRendererNotificationTestRequest } from '@/lib/notification-claim-policy';
import { sendNotification } from '@/lib/notification-manager';

export async function POST(request: NextRequest) {
  const policy = validateRendererNotificationTestRequest(request);
  if (!policy.ok) return NextResponse.json({ error: policy.error }, { status: policy.status });

  const result = await sendNotification({
    title: 'CodePilot · 测试系统通知',
    body: '如果你看到并听到系统允许的提示音，说明本机原生通知链路正常。',
    priority: 'normal',
    source: 'codepilot',
    action: { type: 'route', payload: '/settings/assistant?notificationTest=1' },
  });

  return NextResponse.json({
    event_id: result.event_id,
    delivery: result.deliveries.find((item) => item.channel === 'electron-native') ?? null,
  });
}

export async function GET(request: NextRequest) {
  const eventId = request.nextUrl.searchParams.get('event_id') || '';
  if (!/^evt-[A-Za-z0-9-]{1,80}$/.test(eventId)) {
    return NextResponse.json({ error: 'A valid event_id is required.' }, { status: 400 });
  }
  const event = getNotificationEvent(eventId);
  if (!event) return NextResponse.json({ error: 'Notification event not found.' }, { status: 404 });
  const delivery = listNotificationDeliveries(eventId).find((item) => item.channel === 'electron-native') ?? null;
  return NextResponse.json({ event_id: eventId, delivery });
}
