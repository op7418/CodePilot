import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

function source(relative: string): string {
  return fs.readFileSync(path.resolve(__dirname, relative), 'utf8');
}

describe('native provider telemetry capture boundaries', () => {
  it('agent-loop defers onError capture to a one-shot terminal boundary', () => {
    const code = source('../../lib/agent-loop.ts');
    const onErrorStart = code.indexOf('onError: (event) => {');
    const onErrorEnd = code.indexOf('\n            },', onErrorStart);
    assert.ok(onErrorStart >= 0 && onErrorEnd > onErrorStart);
    const onError = code.slice(onErrorStart, onErrorEnd);
    assert.match(onError, /providerStreamTelemetry\.observe\(err\)/);
    assert.doesNotMatch(onError, /reportNativeError\(/);
    assert.match(code, /providerStreamTelemetry\.takeTerminalFailure\(\)/);
    assert.match(code, /providerStreamTelemetry\.takeCatchFailure\(err\)/);
    assert.match(code, /!providerStreamTelemetry\.hasReportedFailure/);
    assert.match(code, /retryExhausted: true/);
  });

  it('ToolLoop POC uses the same deferred structured-error boundary', () => {
    const code = source('../../lib/experimental/agent-loop-toolloop-poc.ts');
    const caseStart = code.indexOf("case 'error': {");
    const caseEnd = code.indexOf('\n            }', caseStart);
    assert.ok(caseStart >= 0 && caseEnd > caseStart);
    const errorCase = code.slice(caseStart, caseEnd);
    assert.match(errorCase, /providerStreamTelemetry\.observe\(err\)/);
    assert.doesNotMatch(errorCase, /reportNativeError\(/);
    assert.match(code, /case 'finish-step'/);
    assert.match(code, /providerStreamTelemetry\.takeTerminalFailure\(\)/);
    assert.match(code, /providerStreamTelemetry\.takeCatchFailure\(err\)/);
    assert.match(code, /retryExhausted: true/);
  });

  it('shared provider boundary owns the marker before rethrow/auto-capture', () => {
    const generator = source('../../lib/text-generator.ts');
    const boundary = source('../../lib/telemetry/provider-failure.ts');
    const streamBoundary = source('../../lib/telemetry/native-stream-boundary.ts');
    const instrumentation = source('../../instrumentation.ts');
    assert.match(generator, /toMarkableProviderFailure\(error\)/);
    assert.match(generator, /reportProviderFailure\(markableError/);
    assert.doesNotMatch(generator, /markProviderFailureHandled/);
    assert.match(boundary, /markProviderFailureHandled\(error\)/);
    assert.match(streamBoundary, /markProviderFailureHandled\(error\)/);
    assert.match(
      instrumentation,
      /if \(isTelemetryFailureHandled\(hint\.originalException\)\) return null/,
    );
  });
});
