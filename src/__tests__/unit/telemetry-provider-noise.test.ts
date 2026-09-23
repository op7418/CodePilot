import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LoadAPIKeyError } from '@ai-sdk/provider';
import { normalizeTelemetryFailure } from '../../lib/telemetry/root-cause';
import { reportProviderFailure } from '../../lib/telemetry/provider-failure';
import { isTelemetryFailureHandled } from '../../lib/telemetry/provider-marker';
import { ProviderTransportError } from '../../lib/provider-transport-error';
import { createTelemetryReportBudget } from '../../lib/telemetry/report-budget';
import { sanitizeTelemetryEvent } from '../../lib/telemetry/sanitize';

const normalize = (error: unknown, retryExhausted = true) => normalizeTelemetryFailure('PROVIDER_FAILURE', error, { retryExhausted });

describe('provider noise classification and bounded reporting', () => {
  it('recognizes actual SDK missing-key errors and structured product auth failures through wrappers', () => {
    const errors = [
      new LoadAPIKeyError({ message: 'Anthropic API key is missing. Pass it using apiKey.' }),
      ...(['NATIVE_CREDENTIALS_REQUIRED', 'CLAUDE_SETTINGS_ONLY', 'PROVIDER_CREDENTIALS_UNAVAILABLE', 'PROVIDER_OAUTH_EXPIRED'] as const)
        .map(code => new ProviderTransportError(code, 'local UI text')),
    ];
    for (const error of errors) {
      const result = normalize(new Error('stream wrapper', { cause: error }));
      assert.equal(result.rootCause, 'credentials');
      assert.equal(result.shouldReport, false);
    }
  });

  it('classifies reset/refused/pipe/socket and coded timeout while retaining the exhausted-retry gate', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET', 'ENETUNREACH', 'EHOSTUNREACH']) {
      const error = new TypeError('fetch failed', { cause: Object.assign(new Error('transport'), { code }) });
      assert.equal(normalize(error).rootCause, 'transport');
      assert.equal(normalize(error).shouldReport, true);
      assert.equal(normalize(error, false).shouldReport, false);
    }
    assert.equal(normalize(new ProviderTransportError('PROVIDER_REQUEST_TIMEOUT', '连接超时')).rootCause, 'timeout');
    assert.equal(normalize(new Error('unexpected product invariant')).outcome, 'unknown');
  });

  it('preserves first transient events and carries bounded suppression counts into the next window', () => {
    let time = 0;
    const budget = createTelemetryReportBudget({ now: () => time, windowMs: 100, limit: 2, maxEntries: 2 });
    const input = { failure: normalize({ statusCode: 503 }), callScene: 'automatic_memory_extract' };
    assert.deepEqual(budget.take(input), { allowed: true, suppressed: 0 });
    assert.equal(budget.take(input).allowed, true);
    assert.deepEqual(budget.take(input), { allowed: false, suppressed: 1 });
    assert.deepEqual(budget.take(input), { allowed: false, suppressed: 2 });
    assert.equal(budget.take({ ...input, callScene: 'interactive_chat' }).allowed, true);
    for (let i = 0; i < 5; i++) assert.equal(budget.take({ failure: normalize(new Error('product invariant')) }).allowed, true);
    time = 100;
    assert.deepEqual(budget.take(input), { allowed: true, suppressed: 2 });
    assert.ok(budget.snapshot().groups <= 2);
    assert.equal(JSON.stringify(budget.snapshot()).includes('automatic_memory_extract'), false);
  });

  it('restricts the new dimensions to enums and suppression counts to bounded integers', () => {
    const result = sanitizeTelemetryEvent({ tags: { 'call.scene': 'secret-project', 'failure.kind': 'private payload' },
      extra: { telemetrySuppressedCount: { credential: 'secret' } } }, { layer: 'next_server', channel: 'stable' });
    assert.deepEqual(result.extra, {});
    assert.equal(result.tags['call.scene'], 'unknown');
    assert.equal(result.tags['failure.kind'], 'other');
  });

  it('sends zero credential events through the real Sentry carrier and retains an upstream positive control', async () => {
    const Sentry = await import('@sentry/node');
    const env = process.env as Record<string, string | undefined>;
    const oldNodeEnv = env.NODE_ENV;
    const oldChannel = env.NEXT_PUBLIC_CODEPILOT_CHANNEL;
    env.NODE_ENV = 'production';
    env.NEXT_PUBLIC_CODEPILOT_CHANNEL = 'stable';
    const events: Array<Record<string, unknown>> = [];
    let delivered!: () => void;
    const delivery = new Promise<void>(resolve => { delivered = resolve; });
    Sentry.init({ dsn: 'https://public@example.invalid/1', defaultIntegrations: false,
      transport: () => ({ send(envelope) {
        for (const item of envelope[1]) if (item[0].type === 'event') events.push(item[1] as Record<string, unknown>);
        delivered();
        return Promise.resolve({ statusCode: 200 });
      }, flush: async () => true }),
      beforeSend: (event, hint) => isTelemetryFailureHandled(hint.originalException) ? null
        : sanitizeTelemetryEvent(event, { layer: 'next_server', channel: 'stable' }),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const sdkError = new Error('wrapper', { cause: new LoadAPIKeyError({ message: 'API key is missing.' }) });
      reportProviderFailure(sdkError, { callScene: 'automatic_memory_extract' });
      Sentry.captureException(new Error('auto capture wrapper', { cause: sdkError }));
      reportProviderFailure(new ProviderTransportError('PROVIDER_OAUTH_EXPIRED', 'private local UI text'), { callScene: 'automatic_quick_actions' });
      reportProviderFailure(Object.assign(new Error('private upstream body'), { statusCode: 503 }), { callScene: 'active_turn_memory_rerank' });
      await Promise.race([delivery, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('missing positive control')), 2_000); })]);
      await Sentry.flush(1_000);
      assert.equal(events.length, 1);
      const event = events[0];
      assert.equal((event.tags as Record<string, unknown>)['failure.kind'], 'http_5xx');
      assert.equal((event.tags as Record<string, unknown>)['call.scene'], 'active_turn_memory_rerank');
      assert.doesNotMatch(JSON.stringify(events), /private local|private upstream|API key is missing/);
    } finally {
      if (timer) clearTimeout(timer);
      await Sentry.close(1_000);
      if (oldNodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = oldNodeEnv;
      if (oldChannel === undefined) delete env.NEXT_PUBLIC_CODEPILOT_CHANNEL; else env.NEXT_PUBLIC_CODEPILOT_CHANNEL = oldChannel;
    }
  });
});
