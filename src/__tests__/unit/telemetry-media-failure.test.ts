import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MediaUserActionError } from '../../lib/media-error';
import { prepareMediaFailureForRethrow } from '../../lib/telemetry/media-failure';
import { isTelemetryFailureHandled } from '../../lib/telemetry/provider-marker';

function errorWith(fields: Record<string, unknown>): Error {
  return Object.assign(new Error('media provider failed'), fields);
}

describe('media failure telemetry ownership', () => {
  it('marks local user-action failures without changing the thrown object', () => {
    const error = new MediaUserActionError('MEDIA_SOURCE_NOT_FOUND', 'File not found');
    const prepared = prepareMediaFailureForRethrow(error, 'Media import failed');
    assert.equal(prepared, error);
    assert.equal(isTelemetryFailureHandled(error), true);
  });

  it('marks provider 4xx, safety, billing, and auth outcomes', () => {
    for (const error of [
      errorWith({ statusCode: 400 }),
      errorWith({ statusCode: 402 }),
      errorWith({ statusCode: 429 }),
      errorWith({ code: 'INVALID_API_KEY' }),
    ]) {
      prepareMediaFailureForRethrow(error, 'Image generation failed');
      assert.equal(isTelemetryFailureHandled(error), true);
    }
  });

  it('requires an explicit aborted user signal before silencing cancellation text', () => {
    const ambiguousAbort = new Error('request aborted by upstream');
    prepareMediaFailureForRethrow(ambiguousAbort, 'Image generation failed');
    assert.equal(isTelemetryFailureHandled(ambiguousAbort), false);

    const userAbort = new Error('request aborted by user');
    prepareMediaFailureForRethrow(userAbort, 'Image generation failed', { userCancelled: true });
    assert.equal(isTelemetryFailureHandled(userAbort), true);
  });

  it('finds a handled media cause through bounded wrappers', () => {
    const mediaError = new MediaUserActionError('MEDIA_SOURCE_NOT_FOUND', 'File not found');
    prepareMediaFailureForRethrow(mediaError, 'Media import failed');
    const wrapped = new Error('AI SDK tool wrapper', { cause: mediaError });
    assert.equal(isTelemetryFailureHandled(wrapped), true);

    const tooDeep = new Error('depth-5', {
      cause: new Error('depth-4', {
        cause: new Error('depth-3', {
          cause: new Error('depth-2', {
            cause: new Error('depth-1', { cause: mediaError }),
          }),
        }),
      }),
    });
    assert.equal(isTelemetryFailureHandled(tooDeep), false, 'cause traversal must remain bounded');
  });

  it('leaves exhausted upstream and unknown product faults reportable', () => {
    for (const error of [
      errorWith({ statusCode: 503 }),
      errorWith({ code: 'ETIMEDOUT' }),
      errorWith({ code: 'ENOTFOUND' }),
      new Error('unexpected media persistence invariant'),
    ]) {
      prepareMediaFailureForRethrow(error, 'Image generation failed');
      assert.equal(isTelemetryFailureHandled(error), false);
    }
  });

  it('drops a wrapped handled failure through a real Sentry transport and sends a 503 control', async () => {
    const Sentry = await import('@sentry/node');
    const envelopes: unknown[] = [];
    const eventItemCount = (): number => envelopes.reduce<number>((count, envelope) => {
      if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) return count;
      return count + envelope[1].filter((item) => (
        Array.isArray(item) && (item[0] as { type?: unknown })?.type === 'event'
      )).length;
    }, 0);
    Sentry.init({
      dsn: 'https://public@example.invalid/1',
      defaultIntegrations: false,
      sendDefaultPii: false,
      transport: () => ({
        send(envelope) {
          envelopes.push(envelope);
          return Promise.resolve({ statusCode: 200 });
        },
        flush() { return Promise.resolve(true); },
      }),
      beforeSend(event, hint) {
        return isTelemetryFailureHandled(hint.originalException) ? null : event;
      },
    });
    try {
      const mediaError = new MediaUserActionError('MEDIA_PROVIDER_NOT_CONFIGURED', 'Configure media');
      prepareMediaFailureForRethrow(mediaError, 'Image generation failed');
      Sentry.captureException(new Error('AI SDK tool wrapper', { cause: mediaError }));
      await Sentry.flush(1_000);
      assert.equal(eventItemCount(), 0, 'handled media cause must produce zero event items');

      const upstream = errorWith({ statusCode: 503 });
      prepareMediaFailureForRethrow(upstream, 'Image generation failed');
      Sentry.captureException(new Error('AI SDK tool wrapper', { cause: upstream }));
      await Sentry.flush(1_000);
      assert.equal(eventItemCount(), 1, 'reportable upstream control proves the transport is connected');
    } finally {
      await Sentry.close(1_000);
    }
  });
});
