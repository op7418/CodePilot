import { createSafeTelemetryError } from './root-cause';

/** The background collector has one explicit capture owner, even after detach. */
export function reportChatCollectionFailure(error: unknown): Promise<void> {
  // Local diagnosis must work with telemetry disabled too. Never log the raw
  // error, message, cause, SQL, session content or identifiers.
  console.error('[chat/route] background collection failed',
    error instanceof Error && error.message === 'CODEPILOT_MESSAGE_PERSISTENCE_FAILED'
      ? 'CODEPILOT_MESSAGE_PERSISTENCE_FAILED' : 'CHAT_COLLECTION_FAILED');
  if (process.env.NODE_ENV !== 'development') {
    if (process.env.NODE_ENV !== 'production'
      || process.env.NEXT_PUBLIC_CODEPILOT_CHANNEL !== 'stable') return Promise.resolve();

    // Keep canonical stack locations but never the DB message, SQL, content or cause.
    const safe = createSafeTelemetryError(
      error instanceof Error ? error : new Error('chat.collection_failed'),
      'chat.collection_failed',
    );
    return import('@sentry/node').then((Sentry) => {
      if (!Sentry.isInitialized()) return;
      Sentry.withScope((scope) => {
        scope.setTag('error.category', 'CHAT_COLLECTION_FAILED');
        scope.setTag('error.outcome', 'product_fault');
        Sentry.captureException(safe);
      });
    }).catch(() => { /* telemetry must never reject the collection owner */ });
  }
  return Promise.resolve();
}
