/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Used to initialize runtime log capture for the Doctor export feature.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getSetting } = await import('@/lib/db');
    const { applyNetworkProxyFromAppSettings, readNetworkProxySettings } = await import('@/lib/network-proxy');

    // Re-apply persisted network proxy settings on boot.
    // Without this, proxy envs only take effect after settings are saved once in current process.
    applyNetworkProxyFromAppSettings(readNetworkProxySettings(getSetting));

    // Initialize Sentry for server-side error capture (respects opt-out marker file)
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (dsn) {
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');
      const markerPath = path.join(os.homedir(), '.codepilot', 'sentry-disabled');
      const optedOut = fs.existsSync(markerPath) && fs.readFileSync(markerPath, 'utf-8').trim() === 'true';
      if (!optedOut) {
        const Sentry = await import('@sentry/node');
        Sentry.init({
          dsn,
          environment: process.env.NODE_ENV,
          release: `codepilot@${process.env.NEXT_PUBLIC_APP_VERSION}`,
          tracesSampleRate: 0,
          ignoreErrors: [
            // Aborts — user/client cancellation, not bugs
            'AbortError',
            'Operation aborted',
            'The operation was aborted',
            'signal is aborted',
            // Electron renderer doesn't implement window.prompt — known and handled with PromptDialog
            'prompt() is not supported',
            // Browser quirk: not a real error but Chromium reports it
            'ResizeObserver loop',
          ],
          beforeSend(event) {
            // Strip auth headers
            if (event.request?.headers) {
              delete event.request.headers['x-api-key'];
              delete event.request.headers['authorization'];
              delete event.request.headers['anthropic-api-key'];
            }
            // Add server context
            event.tags = {
              ...event.tags,
              runtime: 'server',
              'os.platform': process.platform,
              'os.arch': process.arch,
              'node.version': process.version,
            };
            return event;
          },
        });
      }
    }

    const { initRuntimeLog } = await import('@/lib/runtime-log');
    initRuntimeLog();

    // Start the task scheduler so persisted tasks resume on cold boot
    // (previously only started as a side effect of /api/chat)
    const { ensureSchedulerRunning } = await import('@/lib/task-scheduler');
    ensureSchedulerRunning();
  }
}
