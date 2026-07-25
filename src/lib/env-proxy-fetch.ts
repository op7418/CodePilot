/**
 * Opt-in proxy-aware fetch for server-side requests.
 *
 * Node's fetch does not consume HTTP_PROXY / HTTPS_PROXY by default. Electron
 * injects the system proxy into the packaged Next server's environment, so a
 * caller that needs the same route as the system browser must attach an Undici
 * dispatcher explicitly. Keep this opt-in: changing the global dispatcher
 * would also affect loopback APIs and unrelated providers.
 */
import { ProxyAgent, type Dispatcher } from 'undici';
import { hostMatchesNoProxy } from './provider-dns-preflight';

type ProxyEnvironment = Record<string, string | undefined>;

export type ProxyResolution =
  | { kind: 'direct'; reason: 'not_configured' | 'no_proxy' | 'unsupported_proxy' }
  | { kind: 'proxy'; proxyUrl: string };

export interface ProxyAwareFetchOptions {
  env?: ProxyEnvironment;
  fetchImpl?: typeof fetch;
  dispatcherFactory?: (proxyUrl: string) => Dispatcher;
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find(value => typeof value === 'string' && value.trim().length > 0)?.trim();
}

/** Resolve one request; callers must treat a proxy result as credential-bearing. */
export function resolveProxyForUrl(
  target: URL,
  env: ProxyEnvironment = process.env,
): ProxyResolution {
  if (hostMatchesNoProxy(target.hostname, env)) {
    return { kind: 'direct', reason: 'no_proxy' };
  }

  // Match Undici/curl precedence: lowercase overrides uppercase. HTTPS may
  // fall back to HTTP_PROXY, which is how Electron exposes a system HTTP proxy.
  const rawProxy = target.protocol === 'https:'
    ? firstNonEmpty([
        env.https_proxy,
        env.HTTPS_PROXY,
        env.http_proxy,
        env.HTTP_PROXY,
        env.all_proxy,
        env.ALL_PROXY,
      ])
    : firstNonEmpty([
        env.http_proxy,
        env.HTTP_PROXY,
        env.all_proxy,
        env.ALL_PROXY,
      ]);
  if (!rawProxy) return { kind: 'direct', reason: 'not_configured' };

  try {
    const proxyUrl = new URL(rawProxy);
    // Undici ProxyAgent supports HTTP(S) CONNECT proxies. Preserve the old
    // direct behaviour for SOCKS/PAC values instead of turning them into a new
    // hard failure; TUN-mode clients can still capture that direct socket.
    if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
      return { kind: 'direct', reason: 'unsupported_proxy' };
    }
    return { kind: 'proxy', proxyUrl: proxyUrl.toString() };
  } catch {
    return { kind: 'direct', reason: 'unsupported_proxy' };
  }
}

function requestUrl(input: RequestInfo | URL): URL | undefined {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    return new URL(input.url);
  } catch {
    // Relative URLs belong to the local Next/browser layer. This helper is for
    // absolute upstream URLs and must not guess an origin for a relative path.
    return undefined;
  }
}

/**
 * Create a fetch that routes absolute upstream URLs through an environment
 * HTTP(S) proxy while leaving NO_PROXY, relative, and unsupported-proxy paths
 * direct. The dispatcher cache is private so proxy credentials are never
 * surfaced in errors or logs.
 */
export function createEnvProxyFetch(options: ProxyAwareFetchOptions = {}): typeof fetch {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl
    ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const dispatcherFactory = options.dispatcherFactory ?? ((proxyUrl: string) => new ProxyAgent(proxyUrl));
  const dispatchers = new Map<string, Dispatcher>();

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = requestUrl(input);
    if (!target) return fetchImpl(input, init);

    const resolution = resolveProxyForUrl(target, env);
    if (resolution.kind === 'direct') return fetchImpl(input, init);

    let dispatcher = dispatchers.get(resolution.proxyUrl);
    if (!dispatcher) {
      dispatcher = dispatcherFactory(resolution.proxyUrl);
      dispatchers.set(resolution.proxyUrl, dispatcher);
    }
    const proxyInit = { ...init, dispatcher } as RequestInit & { dispatcher: Dispatcher };
    return fetchImpl(input, proxyInit);
  }) as typeof fetch;
}

/** Shared xAI network path; environment is read from the packaged server. */
export const envProxyFetch = createEnvProxyFetch();
