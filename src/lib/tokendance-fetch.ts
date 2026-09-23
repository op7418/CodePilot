import { envProxyFetch } from './env-proxy-fetch';
import { TOKENDANCE_APP_URL, TOKENDANCE_ORIGIN, tokenDanceRecoveryMessage, parseTokenDanceModels } from './tokendance';

/** Restrict credentials and attribution to the documented gateway routes. */
export function createTokenDanceFetch(fetchImpl: typeof fetch = envProxyFetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== TOKENDANCE_ORIGIN || url.username || url.password || url.hash
      || !['/gateway/v1/models', '/gateway/v1/chat/completions', '/gateway/v1/messages', '/gateway/v1/messages/count_tokens'].includes(url.pathname)) {
      throw new Error('Invalid TokenDance gateway endpoint');
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set('X-App-URL', TOKENDANCE_APP_URL);
    const response = await fetchImpl(input, { ...init, headers, redirect: 'error' });
    const message = tokenDanceRecoveryMessage(response);
    if (!message) return response;
    // Both SDK protocols understand error.message. Preserve status and recovery
    // header; replace only the documented recovery error, never retry/delete keys.
    await response.body?.cancel();
    const resultHeaders = new Headers(response.headers);
    resultHeaders.delete('content-length');
    resultHeaders.delete('content-encoding');
    resultHeaders.set('content-type', 'application/json');
    return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message } }), {
      status: response.status, headers: resultHeaders,
    });
  };
}

export const tokenDanceFetch = createTokenDanceFetch();

/** The public catalog does not validate a key. Test a small generation instead. */
export async function testTokenDanceConnection(config: { apiKey: string; protocol: string; modelName?: string }) {
  const signal = AbortSignal.timeout(20_000);
  try {
    let model = config.modelName;
    if (!model) {
      const catalog = await tokenDanceFetch(`${TOKENDANCE_ORIGIN}/gateway/v1/models`, { signal });
      if (!catalog.ok) throw new Error('catalog unavailable');
      model = parseTokenDanceModels(await catalog.json(), config.protocol).ids[0];
    }
    if (!model) throw new Error('catalog empty');
    const anthropic = config.protocol === 'anthropic';
    const response = await tokenDanceFetch(`${TOKENDANCE_ORIGIN}/gateway/v1/${anthropic ? 'messages' : 'chat/completions'}`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}`, ...(anthropic ? { 'anthropic-version': '2023-06-01' } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 32, stream: false }),
    });
    const recovery = tokenDanceRecoveryMessage(response);
    await response.body?.cancel();
    if (response.ok) return { success: true };
    const { localizeModelSelectionError } = await import('./model-selection-error-i18n');
    return { success: false, error: {
      code: `HTTP_${response.status}`,
      message: recovery ? localizeModelSelectionError(recovery) : `TokenDance returned HTTP ${response.status}.`,
      suggestion: '',
    } };
  } catch {
    return { success: false, error: { code: 'TOKENDANCE_CONNECTION_FAILED', message: 'TokenDance connection test could not complete.', suggestion: 'Check the network and API key, then retry.' } };
  }
}
