import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createProvider, getProvider, updateProvider } from './db';
import { VENDOR_PRESETS, resolveProviderPresetIdentity } from './provider-catalog';
import { envProxyFetch } from './env-proxy-fetch';
import { TOKENDANCE_APP_URL, TOKENDANCE_ORIGIN, TOKENDANCE_PRESETS } from './tokendance';

type Status = 'pending' | 'exchanging' | 'complete' | 'cancelled' | 'expired' | 'failed';
type Flow = {
  id: string; verifier: string; state: string; presetKey: string; targetId?: string;
  originalKey?: string; status: Status; expiresAt: number; providerId?: string;
  server?: Server; timer?: ReturnType<typeof setTimeout>; controller: AbortController;
};
const globalState = globalThis as typeof globalThis & { __tokenDanceAuth?: { flow?: Flow } };
const store = globalState.__tokenDanceAuth ??= {};
const LIFETIME = 10 * 60_000;

function close(flow: Flow) {
  if (flow.timer) clearTimeout(flow.timer);
  flow.server?.close();
  flow.verifier = '';
  flow.originalKey = undefined;
}

export function cancelTokenDanceAuth(id: string) {
  const flow = store.flow;
  if (flow?.id !== id || !['pending', 'exchanging'].includes(flow.status)) return;
  flow.status = 'cancelled';
  flow.controller.abort();
  close(flow);
}

export function tokenDanceAuthStatus(id: string) {
  const flow = store.flow;
  return flow?.id === id
    ? { status: flow.status, expiresAt: flow.expiresAt, providerId: flow.providerId }
    : { status: 'expired' as const };
}

export async function completeTokenDanceAuth(id: string, code: string) {
  const flow = store.flow;
  if (!flow || flow.id !== id || flow.status !== 'pending' || Date.now() >= flow.expiresAt) {
    throw new Error('TokenDance authorization expired. Start again.');
  }
  if (!code.trim() || code.length > 4096) throw new Error('Invalid authorization code');
  flow.status = 'exchanging';
  try {
    // Never retry: a response lost after successful exchange has consumed the code.
    const response = await envProxyFetch(`${TOKENDANCE_ORIGIN}/portal/api/v1/auth/keys`, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), code_verifier: flow.verifier, code_challenge_method: 'S256' }),
      signal: AbortSignal.any([flow.controller.signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) throw new Error('exchange failed');
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('key' in data) || typeof data.key !== 'string' || !data.key.trim()) {
      throw new Error('invalid key response');
    }
    if (store.flow !== flow || flow.controller.signal.aborted || Date.now() >= flow.expiresAt) return;
    const preset = VENDOR_PRESETS.find(p => p.key === flow.presetKey)!;
    if (flow.targetId) {
      const target = getProvider(flow.targetId);
      if (!target || target.api_key !== flow.originalKey
        || resolveProviderPresetIdentity(target).status !== 'resolved'
        || target.preset_key !== flow.presetKey) throw new Error('connection changed');
      updateProvider(target.id, { api_key: data.key });
      flow.providerId = target.id;
    } else {
      flow.providerId = createProvider({
        name: preset.name, preset_key: preset.key, provider_type: preset.protocol,
        protocol: preset.protocol, base_url: preset.baseUrl, api_key: data.key,
      }).id;
    }
    flow.status = 'complete';
  } catch {
    if (store.flow === flow && flow.status === 'exchanging') flow.status = 'failed';
    // Do not echo exchange bodies, codes, keys or provider secret errors.
  } finally { close(flow); }
}

export async function startTokenDanceAuth(presetKey: string, method: 'browser' | 'code', targetId?: string) {
  if (!(TOKENDANCE_PRESETS as readonly string[]).includes(presetKey)) throw new Error('Invalid TokenDance preset');
  const target = targetId ? getProvider(targetId) : undefined;
  if (targetId && (!target || target.preset_key !== presetKey || resolveProviderPresetIdentity(target).status !== 'resolved')) {
    throw new Error('TokenDance connection not found or changed');
  }
  if (store.flow) cancelTokenDanceAuth(store.flow.id);
  const flow: Flow = {
    id: randomBytes(24).toString('base64url'), state: randomBytes(32).toString('base64url'),
    verifier: randomBytes(48).toString('base64url'), presetKey, targetId,
    originalKey: target?.api_key, status: 'pending', expiresAt: Date.now() + LIFETIME,
    controller: new AbortController(),
  };
  store.flow = flow;
  const url = new URL('/auth', TOKENDANCE_ORIGIN);
  url.searchParams.set('code_challenge', createHash('sha256').update(flow.verifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('app_url', TOKENDANCE_APP_URL);
  url.searchParams.set('key_name', 'Codepilot');
  try {
    if (method === 'browser') {
      const server = createServer((request, response) => {
        const callback = new URL(request.url || '/', 'http://127.0.0.1');
        const origin = request.headers.origin;
        if (request.method !== 'GET' || callback.pathname !== '/callback'
          || callback.searchParams.get('state') !== flow.state
          || (origin && origin !== TOKENDANCE_ORIGIN)
          || store.flow !== flow || flow.status !== 'pending') {
          response.writeHead(400).end('Invalid authorization callback'); return;
        }
        const code = callback.searchParams.get('code');
        if (!code || code.length > 4096) { response.writeHead(400).end('Missing authorization code'); return; }
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        response.end('Return to CodePilot to check authorization. 请返回 CodePilot 查看授权结果。');
        void completeTokenDanceAuth(flow.id, code).catch(() => {});
      });
      flow.server = server;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      if (store.flow !== flow || flow.controller.signal.aborted) { server.close(); throw new Error('cancelled'); }
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('callback unavailable');
      const callback = new URL(`http://127.0.0.1:${address.port}/callback`);
      callback.searchParams.set('state', flow.state);
      url.searchParams.set('callback_url', callback.toString());
      server.unref();
    }
    flow.timer = setTimeout(() => {
      if (['pending', 'exchanging'].includes(flow.status)) {
        flow.status = 'expired'; flow.controller.abort(); close(flow);
      }
    }, LIFETIME);
    flow.timer.unref();
    return { flowId: flow.id, url: url.toString(), expiresAt: flow.expiresAt };
  } catch {
    flow.status = 'failed'; close(flow);
    throw new Error('TokenDance browser callback unavailable. Use authorization-code mode.');
  }
}
