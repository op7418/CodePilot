import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeTelemetryEvent } from '../../lib/telemetry/sanitize';

describe('telemetry default-deny sanitizer', () => {
  it('removes credentials, user identity, content, dynamic URLs, and unsafe grouping', () => {
    const event = sanitizeTelemetryEvent({
      user: { id: 'installation-id', email: 'person@example.com' },
      server_name: 'Alice-MacBook',
      message: 'authorization=Bearer-secret-token https://api.example.com/v1?q=prompt /Users/alice/project',
      request: {
        method: 'POST',
        url: 'https://127.0.0.1/api/chat/sessions/abcdefabcdefabcdefabcdef?prompt=secret',
        headers: { authorization: 'secret' },
        data: { prompt: 'private' },
      },
      tags: {
        'runtime.id': 'codepilot_runtime',
        'model.id': 'private-model-name',
        'provider.baseUrl': 'https://private.example',
      },
      extra: {
        callScene: 'title_generation',
        rawMessage: 'private prompt',
        sessionId: 'private-session',
      },
      breadcrumbs: [
        { category: 'console', message: 'secret' },
        { category: 'ui.input', message: 'typed prompt' },
        { category: 'fetch', data: { method: 'POST', status_code: 500, url: 'https://x.test/api/items/abcdefabcdefabcdefabcdef?q=secret' } },
      ],
      contexts: {
        device: { name: 'Alice Mac', arch: 'arm64' },
        react: { componentStack: 'private tree' },
      },
      fingerprint: ['secret-message'],
    }, {
      layer: 'renderer',
      channel: 'stable',
      platform: 'MacIntel',
    });

    assert.deepEqual(event.user, { ip_address: null });
    assert.match(JSON.stringify(event), /"user":\{"ip_address":null\}/);
    assert.doesNotMatch(JSON.stringify(event.user), /installation-id|person@example\.com/);
    assert.equal('server_name' in event, false);
    assert.doesNotMatch(event.message, /secret-token|api\.example|alice/i);
    assert.match(event.message, /\[local-path\]/);
    assert.deepEqual(event.request, { method: 'POST', url: '/api/chat/sessions/[id]' });
    assert.deepEqual(event.tags, {
      'app.channel': 'stable',
      'runtime.layer': 'renderer',
      'os.platform': 'MacIntel',
      'runtime.id': 'codepilot_runtime',
    });
    assert.deepEqual(event.extra, { callScene: 'title_generation' });
    assert.equal(event.breadcrumbs.length, 1);
    assert.deepEqual(event.breadcrumbs[0].data, {
      method: 'POST',
      status_code: 500,
      url: '/api/items/[id]',
    });
    assert.deepEqual(event.contexts, { device: { arch: 'arm64' } });
    assert.equal('fingerprint' in event, false);
  });

  it('canonicalizes stack and debug-meta paths while retaining source-map coordinates', () => {
    const event = sanitizeTelemetryEvent({
      tags: { 'grouping.strategy': 'normalized', needs_classification: 'yes' },
      fingerprint: ['normalized-v1', 'empty_response'],
      exception: { values: [{
        value: 'failed at /Users/alice/project',
        stacktrace: { frames: [{
          filename: '/Users/alice/project/.next/server/chunk.js',
          abs_path: 'C:\\Users\\Alice\\app\\.next\\server\\chunk.js',
          module: 'C:\\Users\\Alice\\app\\.next\\server\\chunk.js',
          lineno: 10,
          colno: 7,
          vars: { prompt: 'secret' },
          pre_context: ['secret'],
        }] },
      }] },
      debug_meta: { images: [{ code_file: 'C:\\Users\\Alice\\app\\.next\\server\\chunk.js', debug_file: 'C:\\Users\\Alice\\app\\.next\\server\\chunk.js', debug_id: 'safe-debug-id' }] },
    }, { layer: 'next_server', channel: 'stable' });

    const frame = event.exception.values[0].stacktrace.frames[0];
    assert.equal(event.exception.values[0].value, 'failed at [local-path]');
    assert.equal(frame.filename, '/Users/<user>/project/.next/server/chunk.js');
    assert.equal(frame.abs_path, 'C:\\Users\\<user>\\app\\.next\\server\\chunk.js');
    assert.equal(frame.module, 'C:\\Users\\<user>\\app\\.next\\server\\chunk.js');
    assert.equal(frame.lineno, 10);
    assert.equal(frame.colno, 7);
    assert.equal('vars' in frame, false);
    assert.equal('pre_context' in frame, false);
    assert.equal(event.debug_meta.images[0].code_file, frame.abs_path);
    assert.equal(event.debug_meta.images[0].debug_file, frame.abs_path);
    assert.equal(event.tags.needs_classification, 'yes');
    assert.deepEqual(event.fingerprint, ['normalized-v1', 'empty_response']);
  });

  it('removes the entire user-directory suffix, including spaces and multilingual names', () => {
    const event = sanitizeTelemetryEvent({
      message: 'File not found: /Users/alice/Desktop/动画 目录/private-project/input.png',
      exception: { values: [{
        value: 'Copy failed: C:\\Users\\Alice\\Desktop\\客户 资料\\secret.png',
      }] },
    }, { layer: 'next_server', channel: 'stable' });

    assert.equal(event.message, 'File not found: [local-path]');
    assert.equal(event.exception.values[0].value, 'Copy failed: [local-path]');
    assert.doesNotMatch(JSON.stringify(event), /动画|private-project|客户|secret\.png|Alice|alice/);
  });

  it('serializes the null IP tombstone through a real Node Sentry transport', async () => {
    const Sentry = await import('@sentry/node');
    const envelopes: unknown[] = [];
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
      beforeSend(event) {
        return sanitizeTelemetryEvent(event, {
          layer: 'next_server',
          channel: 'stable',
          platform: process.platform,
          arch: process.arch,
        });
      },
    });
    try {
      Sentry.setUser({ id: 'must-not-survive', email: 'private@example.test' });
      Sentry.captureException(new Error('tombstone transport probe'));
      await Sentry.flush(1_000);
      const eventPayload = envelopes.flatMap((envelope) => {
        if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) return [];
        return envelope[1]
          .filter((item) => Array.isArray(item) && (item[0] as { type?: unknown })?.type === 'event')
          .map((item) => item[1] as { user?: unknown });
      })[0];
      assert.ok(eventPayload, 'expected a real Sentry event envelope');
      assert.deepEqual(eventPayload.user, { ip_address: null });
      assert.doesNotMatch(JSON.stringify(eventPayload.user), /must-not-survive|private@example\.test/);
    } finally {
      Sentry.setUser(null);
      await Sentry.close(1_000);
    }
  });
});
