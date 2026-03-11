/**
 * Next.js instrumentation — runs once at server startup.
 * Sets up a global fetch dispatcher that respects HTTP_PROXY / HTTPS_PROXY
 * environment variables, so Telegram API calls (and other outbound fetch)
 * work behind a proxy.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
    if (proxy) {
      setGlobalDispatcher(new EnvHttpProxyAgent());
      console.log(`[instrumentation] Global fetch proxy enabled: ${proxy}`);
    }
  }
}
