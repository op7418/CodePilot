import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { Dispatcher } from 'undici';
import {
  createEnvProxyFetch,
  resolveProxyForUrl,
} from '../../lib/env-proxy-fetch';

const servers = new Set<http.Server>();

async function listen(server: http.Server): Promise<number> {
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

after(async () => {
  await Promise.all([...servers].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('environment proxy fetch', () => {
  it('resolves HTTPS through the Electron-injected HTTP proxy and honors NO_PROXY', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:10987' };
    assert.deepEqual(resolveProxyForUrl(new URL('https://auth.x.ai/oauth2/token'), env), {
      kind: 'proxy',
      proxyUrl: 'http://127.0.0.1:10987/',
    });
    assert.deepEqual(resolveProxyForUrl(new URL('https://auth.x.ai/oauth2/token'), {
      ...env,
      NO_PROXY: '.x.ai',
    }), { kind: 'direct', reason: 'no_proxy' });
  });

  it('prefers lowercase proxy variables and preserves unsupported SOCKS behaviour as direct', () => {
    assert.deepEqual(resolveProxyForUrl(new URL('https://auth.x.ai'), {
      https_proxy: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:10987',
    }), { kind: 'proxy', proxyUrl: 'http://127.0.0.1:7890/' });
    assert.deepEqual(resolveProxyForUrl(new URL('https://auth.x.ai'), {
      HTTPS_PROXY: 'socks5://127.0.0.1:1080',
    }), { kind: 'direct', reason: 'unsupported_proxy' });
  });

  it('attaches one cached dispatcher without changing request body or signal', async () => {
    const fakeDispatcher = { dispatch: () => true } as unknown as Dispatcher;
    let dispatcherCreations = 0;
    const calls: RequestInit[] = [];
    const controller = new AbortController();
    const wrapped = createEnvProxyFetch({
      env: { HTTPS_PROXY: 'http://127.0.0.1:10987' },
      dispatcherFactory: () => {
        dispatcherCreations += 1;
        return fakeDispatcher;
      },
      fetchImpl: (async (_input, init) => {
        calls.push(init ?? {});
        return new Response('{}');
      }) as typeof fetch,
    });

    for (let index = 0; index < 2; index += 1) {
      await wrapped('https://auth.x.ai/oauth2/token', {
        method: 'POST',
        body: `request=${index}`,
        signal: controller.signal,
      });
    }

    assert.equal(dispatcherCreations, 1);
    assert.equal((calls[0] as RequestInit & { dispatcher?: Dispatcher }).dispatcher, fakeDispatcher);
    assert.equal(calls[0].body, 'request=0');
    assert.equal(calls[0].signal, controller.signal);
  });

  it('reaches an otherwise unresolvable target through a real Undici CONNECT proxy', async () => {
    const upstream = http.createServer((_req, res) => {
      res.setHeader('Connection', 'close');
      res.end('proxied');
    });
    const upstreamPort = await listen(upstream);
    const proxy = http.createServer();
    proxy.on('connect', (_req, clientSocket, head) => {
      const upstreamSocket = net.connect(upstreamPort, '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstreamSocket.write(head);
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
      });
      upstreamSocket.on('error', () => clientSocket.destroy());
    });
    const proxyPort = await listen(proxy);

    const wrapped = createEnvProxyFetch({
      env: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` },
    });
    const response = await wrapped('http://unresolvable.invalid/proxy-proof');
    assert.equal(await response.text(), 'proxied');
  });
});
