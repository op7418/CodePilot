import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { reportChatCollectionFailure } from '../../lib/telemetry/chat-collection-failure';
import { observeChatCollection } from '../../lib/chat-collection-response';
import { sanitizeTelemetryEvent } from '../../lib/telemetry/sanitize';

it('reports one safe event for a caught collector failure and none outside stable production', async () => {
  const Sentry = await import('@sentry/node');
  const env = { NODE_ENV: process.env.NODE_ENV, NEXT_PUBLIC_CODEPILOT_CHANNEL: process.env.NEXT_PUBLIC_CODEPILOT_CHANNEL };
  const events: unknown[] = [];
  const localLogs: unknown[][] = [];
  const logMock = mock.method(console, 'error', (...args: unknown[]) => { localLogs.push(args); });
  Sentry.init({
    dsn: 'https://public@example.invalid/1', defaultIntegrations: false,
    transport: () => ({
      send(envelope) {
        for (const [header, payload] of envelope[1]) if (header.type === 'event') events.push(payload);
        return Promise.resolve({ statusCode: 200 });
      },
      flush: async () => true,
    }),
    beforeSend: (event) => sanitizeTelemetryEvent(event, { layer: 'next_server', channel: 'stable' }),
  });
  try {
    Object.assign(process.env, { NODE_ENV: 'development' });
    process.env.NEXT_PUBLIC_CODEPILOT_CHANNEL = 'stable';
    await reportChatCollectionFailure(new Error('private SQL dev secret-fixture'));
    await Sentry.flush(1_000);
    assert.equal(events.length, 0);
    assert.deepEqual(localLogs[0], ['[chat/route] background collection failed', 'CHAT_COLLECTION_FAILED']);
    Object.assign(process.env, { NODE_ENV: 'production' });
    process.env.NEXT_PUBLIC_CODEPILOT_CHANNEL = 'preview';
    await reportChatCollectionFailure(new Error('preview'));
    assert.equal(events.length, 0);
    process.env.NEXT_PUBLIC_CODEPILOT_CHANNEL = 'stable';
    const error = new Error('private SQL and message secret-fixture');
    let reporting = Promise.resolve();
    assert.equal(await observeChatCollection(Promise.reject(error), (failure) => {
      reporting = reportChatCollectionFailure(failure);
    }), false);
    await reporting;
    await Sentry.flush(1_000);
    assert.equal(events.length, 1);
    const serialized = JSON.stringify(events);
    assert.match(serialized, /chat.collection_failed/);
    assert.doesNotMatch(serialized, /private SQL|secret-fixture/);
    process.env.NEXT_PUBLIC_CODEPILOT_CHANNEL = 'preview';
    await reportChatCollectionFailure(new Error('CODEPILOT_MESSAGE_PERSISTENCE_FAILED'));
    assert.equal(localLogs.at(-1)?.[1], 'CODEPILOT_MESSAGE_PERSISTENCE_FAILED');
    assert.equal(localLogs.length, 4);
    assert.doesNotMatch(JSON.stringify(localLogs), /private SQL|secret-fixture|preview/);
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await Sentry.close(1_000);
    logMock.mock.restore();
  }
});
