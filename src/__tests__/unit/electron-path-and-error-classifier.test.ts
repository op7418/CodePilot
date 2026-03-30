import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildExpandedShellPath } from '../../../electron/path-utils';
import { classifyError } from '../../lib/error-classifier';

describe('buildExpandedShellPath', () => {
  it('keeps the user shell PATH ahead of system fallback paths on macOS/Linux', () => {
    const shellPath = '/Users/test/.nvm/versions/node/v22.22.1/bin:/usr/local/bin:/usr/bin';
    const expanded = buildExpandedShellPath({
      shellPath,
      home: '/Users/test',
      platform: 'darwin',
    });

    const parts = expanded.split(':');
    assert.equal(parts[0], '/Users/test/.nvm/versions/node/v22.22.1/bin');
    assert.ok(parts.indexOf('/usr/local/bin') > parts.indexOf('/Users/test/.nvm/versions/node/v22.22.1/bin'));
  });
});

describe('classifyError', () => {
  it('does not misclassify a generic Node.js version string as CLI_VERSION_TOO_OLD', () => {
    const result = classifyError({
      error: new Error('Claude Code process exited with code 1'),
      stderr: 'Node.js v18.16.0\n    at file:///path/to/cli.js:1:1',
      providerName: '联通云',
    });

    assert.equal(result.category, 'PROCESS_CRASH');
  });

  it('still classifies genuine minimum-version errors as CLI_VERSION_TOO_OLD', () => {
    const result = classifyError({
      error: new Error('upgrade required'),
      stderr: 'Claude Code CLI upgrade required: minimum supported version is 2.2.0',
    });

    assert.equal(result.category, 'CLI_VERSION_TOO_OLD');
  });
});
