import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyNetworkProxyFromAppSettings, readNetworkProxySettings } from '@/lib/network-proxy';

const ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
] as const;

let snapshot: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function saveEnvSnapshot() {
  snapshot = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
}

function restoreEnvSnapshot() {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('applyNetworkProxyFromAppSettings', () => {
  afterEach(() => restoreEnvSnapshot());

  it('enables proxy env vars and optional NO_PROXY/CA path', () => {
    saveEnvSnapshot();

    applyNetworkProxyFromAppSettings({
      network_proxy_enabled: 'true',
      network_proxy_url: 'http://127.0.0.1:7890',
      network_no_proxy: 'localhost,127.0.0.1',
      network_proxy_ca_path: '/tmp/custom-ca.pem',
    });

    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:7890');
    assert.equal(process.env.HTTPS_PROXY, 'http://127.0.0.1:7890');
    assert.equal(process.env.http_proxy, 'http://127.0.0.1:7890');
    assert.equal(process.env.https_proxy, 'http://127.0.0.1:7890');
    assert.equal(process.env.NO_PROXY, 'localhost,127.0.0.1,::1');
    assert.equal(process.env.no_proxy, 'localhost,127.0.0.1,::1');
    assert.equal(process.env.NODE_EXTRA_CA_CERTS, '/tmp/custom-ca.pem');
  });

  it('adds localhost bypass defaults into NO_PROXY when enabled', () => {
    saveEnvSnapshot();

    applyNetworkProxyFromAppSettings({
      network_proxy_enabled: 'true',
      network_proxy_url: 'http://127.0.0.1:7890',
      network_no_proxy: 'example.com,localhost',
      network_proxy_ca_path: '',
    });

    assert.equal(process.env.NO_PROXY, 'example.com,localhost,127.0.0.1,::1');
    assert.equal(process.env.no_proxy, 'example.com,localhost,127.0.0.1,::1');
  });

  it('clears proxy env vars when disabled', () => {
    saveEnvSnapshot();

    process.env.HTTP_PROXY = 'http://127.0.0.1:7890';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    process.env.http_proxy = 'http://127.0.0.1:7890';
    process.env.https_proxy = 'http://127.0.0.1:7890';
    process.env.NO_PROXY = 'localhost';
    process.env.no_proxy = 'localhost';
    process.env.NODE_EXTRA_CA_CERTS = '/tmp/custom-ca.pem';

    applyNetworkProxyFromAppSettings({
      network_proxy_enabled: '',
      network_proxy_url: 'http://127.0.0.1:7890',
      network_no_proxy: '',
      network_proxy_ca_path: '',
    });

    assert.equal(process.env.HTTP_PROXY, undefined);
    assert.equal(process.env.HTTPS_PROXY, undefined);
    assert.equal(process.env.http_proxy, undefined);
    assert.equal(process.env.https_proxy, undefined);
    assert.equal(process.env.NO_PROXY, undefined);
    assert.equal(process.env.no_proxy, undefined);
    assert.equal(process.env.NODE_EXTRA_CA_CERTS, undefined);
  });

  it('reads network proxy settings from settings getter safely', () => {
    const values: Record<string, string> = {
      network_proxy_enabled: 'true',
      network_proxy_url: 'http://127.0.0.1:7890',
      network_no_proxy: 'localhost',
      network_proxy_ca_path: '/tmp/custom-ca.pem',
    };
    const settings = readNetworkProxySettings((key) => values[key]);
    assert.deepEqual(settings, values);

    const empty = readNetworkProxySettings(() => undefined);
    assert.deepEqual(empty, {
      network_proxy_enabled: '',
      network_proxy_url: '',
      network_no_proxy: '',
      network_proxy_ca_path: '',
    });
  });
});
