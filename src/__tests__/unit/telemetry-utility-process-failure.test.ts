import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeTelemetryEvent } from '../../lib/telemetry/sanitize';
import {
  buildUtilityProcessFailureEvent,
  isExpectedUtilityProcessExit,
} from '../../lib/telemetry/utility-process-failure';

describe('utility process failure telemetry', () => {
  it('builds a stable fatal product-fault bucket with numeric observations only', () => {
    const event = buildUtilityProcessFailureEvent({
      reason: 'utility_fatal_error',
      exitCode: 5,
      utilityRssBytes: 170_000_000,
      utilityHeapUsedBytes: 9_000_000,
      hostAvailableKb: 1_000_000,
    });

    assert.ok(event);
    assert.equal(event.message, 'server.utility_process_failed');
    assert.equal(event.level, 'fatal');
    assert.deepEqual(event.tags, {
      'error.category': 'UTILITY_PROCESS_FATAL_ERROR',
      'error.outcome': 'product_fault',
      'grouping.strategy': 'normalized',
      'runtime.id': 'packaged_server',
    });
    assert.deepEqual(event.extra, {
      lifecycleReason: 'utility_fatal_error',
      exitCode: 5,
      utilityRssBytes: 170_000_000,
      utilityHeapUsedBytes: 9_000_000,
      hostAvailableKb: 1_000_000,
    });
    assert.deepEqual(event.fingerprint, [
      'normalized-v1',
      'utility_process_fatal_error',
      'electron_main',
      'packaged_server',
      'unknown',
      'unknown',
      'none',
    ]);
  });

  it('normalizes arbitrary exit reasons, preserves signed platform exit codes, and drops invalid metrics', () => {
    const event = buildUtilityProcessFailureEvent({
      reason: 'server_exit_-1 /Users/private --token=secret',
      exitCode: -1,
      utilityRssBytes: Number.NaN,
      utilityHeapUsedBytes: Number.POSITIVE_INFINITY,
      hostFreeKb: 0,
    });

    assert.ok(event);
    assert.equal(event.tags['error.category'], 'UTILITY_PROCESS_NONZERO_EXIT');
    assert.deepEqual(event.extra, {
      lifecycleReason: 'unexpected_exit',
      exitCode: -1,
      hostFreeKb: 0,
    });
  });

  it('accepts only bounded integer POSIX/Windows exit-code representations', () => {
    for (const exitCode of [-0x8000_0000, -1, 0, 0x7fff_ffff, 0xffff_ffff]) {
      const event = buildUtilityProcessFailureEvent({ reason: 'utility_error', exitCode });
      assert.ok(event);
      assert.equal(event.extra.exitCode, exitCode);
    }

    for (const exitCode of [
      -0x8000_0001,
      0x1_0000_0000,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const event = buildUtilityProcessFailureEvent({ reason: 'utility_error', exitCode });
      assert.ok(event);
      assert.equal('exitCode' in event.extra, false);
    }
  });

  it('survives the default-deny sanitizer without admitting arbitrary extras', () => {
    const built = buildUtilityProcessFailureEvent({
      reason: 'utility_error',
      exitCode: 9,
      utilityHeapLimitBytes: 500_000_000,
      hostSwapFreeKb: 42,
    });
    assert.ok(built);
    const sanitized = sanitizeTelemetryEvent({
      ...built,
      extra: {
        ...built.extra,
        diagnosticReport: 'argv=/Users/private token=secret',
      },
    }, {
      layer: 'electron_main',
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
    });

    assert.deepEqual(sanitized.extra, {
      lifecycleReason: 'utility_error',
      exitCode: 9,
      utilityHeapLimitBytes: 500_000_000,
      hostSwapFreeKb: 42,
    });
    assert.deepEqual(sanitized.fingerprint, built.fingerprint);
    assert.equal(JSON.stringify(sanitized).includes('diagnosticReport'), false);
    assert.equal(JSON.stringify(sanitized).includes('/Users/private'), false);
  });

  it('drops known Windows shutdown exits and keeps real failures separated by exit class', () => {
    for (const exitCode of [0x4001_0004, 0xc000_026b]) {
      const input = { reason: 'unexpected_exit', exitCode, platform: 'win32' } as const;
      assert.equal(isExpectedUtilityProcessExit(input), true);
      assert.equal(buildUtilityProcessFailureEvent(input), null);
    }

    const ordinary = buildUtilityProcessFailureEvent({
      reason: 'unexpected_exit',
      exitCode: 1,
      platform: 'win32',
    });
    assert.ok(ordinary);
    assert.equal(ordinary.tags['error.category'], 'UTILITY_PROCESS_NONZERO_EXIT');

    const platformStatus = buildUtilityProcessFailureEvent({
      reason: 'unexpected_exit',
      exitCode: 0xffff_7003,
      platform: 'win32',
    });
    assert.ok(platformStatus);
    assert.equal(platformStatus.tags['error.category'], 'UTILITY_PROCESS_PLATFORM_TERMINATION');
    assert.notDeepEqual(ordinary.fingerprint, platformStatus.fingerprint);
  });
});
