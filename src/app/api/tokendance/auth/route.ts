import { cancelTokenDanceAuth, completeTokenDanceAuth, startTokenDanceAuth, tokenDanceAuthStatus } from '@/lib/tokendance-auth';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return Response.json(tokenDanceAuthStatus(new URL(request.url).searchParams.get('flowId') || ''), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  // Next's internal Request URL can use localhost while the renderer uses
  // 127.0.0.1. The original Host header is the browser's same-origin authority.
  const requestUrl = new URL(request.url);
  const expectedOrigin = `${requestUrl.protocol}//${request.headers.get('host') || requestUrl.host}`;
  if (origin && origin !== expectedOrigin) return new Response(null, { status: 403 });
  try {
    const body = await request.json();
    if (body.action === 'start' && typeof body.presetKey === 'string'
      && ['browser', 'code'].includes(body.method) && (body.providerId === undefined || typeof body.providerId === 'string')) {
      return Response.json(await startTokenDanceAuth(body.presetKey, body.method, body.providerId));
    }
    if (typeof body.flowId === 'string' && body.action === 'cancel') {
      cancelTokenDanceAuth(body.flowId); return Response.json({ ok: true });
    }
    if (typeof body.flowId === 'string' && typeof body.code === 'string' && body.action === 'complete') {
      await completeTokenDanceAuth(body.flowId, body.code);
      return Response.json(tokenDanceAuthStatus(body.flowId));
    }
    return Response.json({ error: 'Invalid authorization request' }, { status: 400 });
  } catch {
    return Response.json({ error: 'TokenDance authorization could not complete. Start again or use an API key.' }, { status: 400 });
  }
}
