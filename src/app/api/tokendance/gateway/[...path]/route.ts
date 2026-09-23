import { tokenDanceFetch } from '@/lib/tokendance-fetch';

export const runtime = 'nodejs';

/** Claude Code's subprocess cannot expose response headers to the UI. This
 * narrow streaming relay normalizes only documented TokenDance recovery errors. */
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const route = path.join('/');
  if (!['v1/messages', 'v1/messages/count_tokens'].includes(route)) {
    return new Response(null, { status: 404 });
  }
  const headers = new Headers();
  for (const name of ['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'content-type']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('authorization') && !headers.has('x-api-key')) return new Response(null, { status: 401 });
  try {
    const upstream = new URL(`https://tokendance.space/gateway/${route}`);
    // Claude Code uses beta=true on Messages. No arbitrary routing parameters.
    if (new URL(request.url).searchParams.get('beta') === 'true') upstream.searchParams.set('beta', 'true');
    const response = await tokenDanceFetch(upstream, {
      method: 'POST', headers, body: await request.arrayBuffer(), signal: request.signal,
    });
    const responseHeaders = new Headers();
    for (const name of ['content-type', 'request-id', 'retry-after', 'tokendance-recovery-action']) {
      const value = response.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch {
    return Response.json({ type: 'error', error: { type: 'api_error', message: 'TokenDance gateway request failed. Please retry.' } }, { status: 502 });
  }
}
