const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export type LocalNotificationConsumer = 'electron-main' | 'renderer';

type PolicyFailure = { ok: false; status: number; error: string };
type CommonRequestResult = { ok: true; target: URL } | PolicyFailure;

function validateJsonLoopbackRequest(request: Request): CommonRequestResult {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return { ok: false, status: 415, error: 'Content-Type must be application/json.' };
  }

  let target: URL;
  try {
    const requestUrl = new URL(request.url);
    const host = request.headers.get('host')?.trim();
    target = host ? new URL(`${requestUrl.protocol}//${host}`) : requestUrl;
  } catch {
    return { ok: false, status: 403, error: 'Invalid request host.' };
  }
  if (!LOOPBACK.has(target.hostname.toLowerCase())) {
    return { ok: false, status: 403, error: 'Notification consumers must use loopback.' };
  }
  return { ok: true, target };
}

export function validateNotificationConsumerRequest(
  request: Request,
  channel: unknown,
): { ok: true; consumer: 'electron-main' } | PolicyFailure {
  const common = validateJsonLoopbackRequest(request);
  if (!common.ok) return common;
  if (channel !== 'electron-native') {
    return { ok: false, status: 400, error: 'Unsupported notification channel.' };
  }

  const declaredConsumer = request.headers.get('x-codepilot-consumer');
  const origin = request.headers.get('origin');
  if (declaredConsumer !== 'electron-main' || origin) {
    return { ok: false, status: 403, error: 'electron-native is owned by Electron Main.' };
  }
  return { ok: true, consumer: 'electron-main' };
}

/** Same-origin browser boundary for the Settings "test notification" action. */
export function validateRendererNotificationTestRequest(
  request: Request,
): { ok: true; consumer: 'renderer' } | PolicyFailure {
  const common = validateJsonLoopbackRequest(request);
  if (!common.ok) return common;

  const declaredConsumer = request.headers.get('x-codepilot-consumer');
  if (declaredConsumer) {
    return { ok: false, status: 403, error: 'Renderer requests cannot impersonate Electron Main.' };
  }
  const origin = request.headers.get('origin');
  if (!origin) return { ok: false, status: 403, error: 'A same-origin renderer request is required.' };
  try {
    if (new URL(origin).origin !== common.target.origin) {
      return { ok: false, status: 403, error: 'Cross-origin requests are not allowed.' };
    }
  } catch {
    return { ok: false, status: 403, error: 'Invalid request origin.' };
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin') {
    return { ok: false, status: 403, error: 'Cross-site requests are not allowed.' };
  }
  return { ok: true, consumer: 'renderer' };
}
