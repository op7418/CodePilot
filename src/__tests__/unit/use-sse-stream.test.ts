import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { consumeSSEStream, formatSSEError } from '../../hooks/useSSEStream';

describe('formatSSEError', () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('should localize structured working directory errors with provided translator', () => {
    const formatted = formatSSEError(
      JSON.stringify({
        error_code: 'WORKING_DIR_NOT_FOUND',
        working_directory: '/tmp/demo',
      }),
      (key, params) => `${key}:${params?.dir}`
    );

    assert.equal(formatted, 'error.workingDirNotFound:/tmp/demo');
  });

  it('should fall back to locale detection when translator is omitted', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'zh-CN' },
      configurable: true,
    });

    const formatted = formatSSEError(
      JSON.stringify({
        error_code: 'WORKING_DIR_NOT_FOUND',
        working_directory: '/tmp/demo',
      })
    );

    assert.equal(formatted, '项目目录不存在：/tmp/demo');
  });

  it('should return plain error text unchanged', () => {
    assert.equal(formatSSEError('plain error text'), 'plain error text');
  });
});

describe('consumeSSEStream', () => {
  it('should localize structured error events in the full consume path', async () => {
    const encoder = new TextEncoder();
    let errorText = '';

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: 'error',
              data: JSON.stringify({
                error_code: 'WORKING_DIR_NOT_FOUND',
                working_directory: '/tmp/project',
              }),
            })}\n\n`
          )
        );
        controller.close();
      },
    });

    const result = await consumeSSEStream(stream.getReader(), {
      onText: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onToolOutput: () => {},
      onToolProgress: () => {},
      onStatus: () => {},
      onResult: () => {},
      onPermissionRequest: () => {},
      onToolTimeout: () => {},
      onModeChanged: () => {},
      onTaskUpdate: () => {},
      onKeepAlive: () => {},
      onError: (accumulated) => {
        errorText = accumulated;
      },
    }, (key, params) => `${key}:${params?.dir}`);

    assert.equal(errorText, '\n\n**Error:** error.workingDirNotFound:/tmp/project');
    assert.equal(result.accumulated, '\n\n**Error:** error.workingDirNotFound:/tmp/project');
  });
});
