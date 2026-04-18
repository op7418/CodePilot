type NetworkProxySettings = {
  network_proxy_enabled?: string;
  network_proxy_url?: string;
  network_no_proxy?: string;
  network_proxy_ca_path?: string;
};

const DEFAULT_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1'];

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
