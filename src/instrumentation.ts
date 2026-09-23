/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Used to initialize runtime log capture for the Doctor export feature.
 *
 * Sentry server-side init is gated behind a non-development guard. The
 * `@sentry/node` package eagerly registers a chain of `@opentelemetry/*`
 * instrumentations (HTTP, fs, dns, undici, …) on import — under
 * `next dev` with Turbopack this graph is one of the heaviest single
 * contributors to the dev-server RSS floor, and we don't ship dev-only
 * crashes anywhere. Production / packaged builds keep the original
 * behavior: read `NEXT_PUBLIC_SENTRY_DSN`, honor the
 * `~/.codepilot/sentry-disabled` opt-out marker, and call `Sentry.init`.
 *
 * `initRuntimeLog()` and `ensureSchedulerRunning()` deliberately stay
 * OUTSIDE the dev-guard — runtime-log capture and persisted task
 * scheduling have to work in `next dev` too.
 *
 * Locked in by `src/__tests__/unit/instrumentation-shape.test.ts`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Electron passes the provider data-encryption key only to this packaged
    // server process. Consume it into process-global memory immediately and
    // delete the env entries before any Agent/tool subprocess can inherit it.
    const { consumeProviderSecretEnvironment } = await import('@/lib/provider-secret-crypto');
    consumeProviderSecretEnvironment();

    if (process.env.NODE_ENV !== 'development') {
      // Initialize Sentry for server-side error capture (respects opt-out marker file)
      const fs = await import('fs');
      const path = await import('path');
      const { resolveCodePilotDataDir } = await import('@/lib/codepilot-data-dir');
      const { configureNextServerIntegrations, resolveTelemetryConfig, TELEMETRY_IGNORE_ERRORS } = await import('@/lib/telemetry/contract');
      const { isTelemetryFailureHandled } = await import('@/lib/telemetry/provider-marker');
      const { sanitizeTelemetryBreadcrumb, sanitizeTelemetryEvent } = await import('@/lib/telemetry/sanitize');
      const markerPath = path.join(resolveCodePilotDataDir(), 'sentry-disabled');
      const optedOut = fs.existsSync(markerPath) && fs.readFileSync(markerPath, 'utf-8').trim() === 'true';
      const config = resolveTelemetryConfig({
        dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        channel: process.env.NEXT_PUBLIC_CODEPILOT_CHANNEL,
        version: process.env.NEXT_PUBLIC_APP_VERSION,
        nodeEnv: process.env.NODE_ENV,
        optedOut,
      });
      if (config.enabled) {
        const Sentry = await import('@sentry/node');
        const { createTelemetrySmokeError, telemetrySmokeEnabled } = await import('@/lib/telemetry/smoke');
        Sentry.init({
          dsn: config.dsn,
          environment: config.environment,
          release: config.release,
          sendDefaultPii: false,
          tracesSampleRate: 0,
          ignoreErrors: TELEMETRY_IGNORE_ERRORS,
          integrations: (defaults) => configureNextServerIntegrations(
            defaults,
            Sentry.httpIntegration({
              trackIncomingRequestsAsSessions: false,
              maxIncomingRequestBodySize: 'none',
            }),
          ),
          beforeBreadcrumb(breadcrumb) {
            return sanitizeTelemetryBreadcrumb(breadcrumb);
          },
          beforeSend(event, hint) {
            if (isTelemetryFailureHandled(hint.originalException)) return null;
            return sanitizeTelemetryEvent(event, {
              layer: 'next_server',
              channel: config.channel,
              platform: process.platform,
              arch: process.arch,
            });
          },
        });
        if (telemetrySmokeEnabled(process.env.NEXT_PUBLIC_CODEPILOT_TELEMETRY_SMOKE)) {
          const eventId = Sentry.captureException(createTelemetrySmokeError('next_server'));
          console.log(`[telemetry-smoke] layer=next_server event_id=${eventId}`);
          await Sentry.flush(5_000);
        }
      }
    }

    const { initRuntimeLog } = await import('@/lib/runtime-log');
    initRuntimeLog();

    // Packaged Electron utility processes report only numeric memory facts to
    // Main. In next dev there is no Electron parentPort, so this is a no-op.
    const { startServerRuntimeObservability } = await import('@/lib/server-runtime-observability');
    startServerRuntimeObservability();

    // Reconcile assistant heartbeat desired state before the scheduler starts
    // scanning due rows. This repairs missing/drifted rows on cold boot and
    // removes disabled rows without waiting for the Settings page to open.
    const { reconcileAssistantHeartbeat } = await import('@/lib/assistant-heartbeat');
    const heartbeat = await reconcileAssistantHeartbeat();
    if (heartbeat.status === 'blocked') {
      console.warn('[heartbeat] startup reconciliation blocked:', heartbeat.reason);
    }

    // A replacement utility process must settle durable interrupted state but
    // must not automatically relaunch scheduled AI work. Normal app restart
    // clears the Main-owned safe-mode environment.
    if (process.env.CODEPILOT_RECOVERY_SAFE_MODE !== '1') {
      const { ensureSchedulerRunning } = await import('@/lib/task-scheduler');
      ensureSchedulerRunning();
    } else {
      console.warn('[server-recovery] scheduler suppressed in safe mode');
    }
  }
}
