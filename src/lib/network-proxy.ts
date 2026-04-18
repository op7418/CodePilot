import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import type { Dispatcher } from 'undici';

type NetworkProxySettings = {
  network_proxy_enabled?: string;
  network_proxy_url?: string;
  network_no_proxy?: string;
  network_proxy_ca_path?: string;
};

const DEFAULT_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1'];
const DISPATCHER_STATE_KEY = '__codepilotNetworkDispatcherState__' as const;

type ManagedDispatcherState = {
  dispatcher: Dispatcher | null;
  signature: string;
};

function setOrDeleteEnv(key: string, value: string): void {
  if (value) {
    process.env[key] = value;
    return;
  }
  delete process.env[key];
}

function normalizeNoProxy(raw: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const token of raw.split(',').map(v => v.trim()).filter(Boolean)) {
    if (seen.has(token)) continue;
    seen.add(token);
    merged.push(token);
  }
  for (const token of DEFAULT_NO_PROXY_ENTRIES) {
    if (seen.has(token)) continue;
    seen.add(token);
    merged.push(token);
  }
  return merged.join(',');
}

function getDispatcherState(): ManagedDispatcherState {
  const globalRef = globalThis as Record<string, unknown>;
  const existing = globalRef[DISPATCHER_STATE_KEY] as ManagedDispatcherState | undefined;
  if (existing) return existing;
  const initial: ManagedDispatcherState = { dispatcher: null, signature: '' };
  globalRef[DISPATCHER_STATE_KEY] = initial;
  return initial;
}

function closeDispatcher(dispatcher: Dispatcher | null): void {
  if (!dispatcher) return;
  const maybeClose = (dispatcher as { close?: () => Promise<void> }).close;
  if (typeof maybeClose !== 'function') return;
  void maybeClose.call(dispatcher).catch(() => {
    // best effort cleanup
  });
}

function ensureGlobalDispatcher(signature: string, createDispatcher: () => Dispatcher): void {
  const state = getDispatcherState();
  // If another part of the app replaced the dispatcher, don't assume ours is active.
  if (
    state.signature === signature
    && state.dispatcher
    && getGlobalDispatcher() === state.dispatcher
  ) {
    return;
  }

  const next = createDispatcher();
  setGlobalDispatcher(next);
  closeDispatcher(state.dispatcher);
  state.dispatcher = next;
  state.signature = signature;
}

export function applyNetworkProxyFromAppSettings(settings: NetworkProxySettings): void {
  const enabled = settings.network_proxy_enabled === 'true';
  const proxyUrl = (settings.network_proxy_url || '').trim();
  const noProxy = normalizeNoProxy((settings.network_no_proxy || '').trim());
  const caPath = (settings.network_proxy_ca_path || '').trim();

  if (!enabled) {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    delete process.env.NODE_EXTRA_CA_CERTS;
    ensureGlobalDispatcher('direct', () => new Agent());
    return;
  }

  if (!proxyUrl) {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
  } else {
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.http_proxy = proxyUrl;
    process.env.https_proxy = proxyUrl;
  }

  setOrDeleteEnv('NO_PROXY', noProxy);
  setOrDeleteEnv('no_proxy', noProxy);
  setOrDeleteEnv('NODE_EXTRA_CA_CERTS', caPath);

  if (!proxyUrl) {
    ensureGlobalDispatcher('direct', () => new Agent());
    return;
  }

  // Use EnvHttpProxyAgent so NO_PROXY/no_proxy rules are honored.
  // Recreate the dispatcher whenever proxy/no_proxy/CA signature changes.
  const signature = `proxy:${proxyUrl}|no_proxy:${noProxy}|ca:${caPath}`;
  ensureGlobalDispatcher(signature, () => new EnvHttpProxyAgent());
}

export function readNetworkProxySettings(
  getSetting: (key: string) => string | undefined,
): NetworkProxySettings {
  return {
    network_proxy_enabled: getSetting('network_proxy_enabled') ?? '',
    network_proxy_url: getSetting('network_proxy_url') ?? '',
    network_no_proxy: getSetting('network_no_proxy') ?? '',
    network_proxy_ca_path: getSetting('network_proxy_ca_path') ?? '',
  };
}

export type { NetworkProxySettings };
