import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyClaudeLaunchFailure } from '../../lib/claude-client';

describe('claude launch error messaging', () => {
  it('classifies spawn node ENOENT as missing node runtime', () => {
    assert.equal(
      classifyClaudeLaunchFailure('spawn node ENOENT', 'ENOENT'),
      'missing_node_runtime',
    );
  });

  it('classifies missing claude executable as missing cli', () => {
    assert.equal(
      classifyClaudeLaunchFailure('spawn claude ENOENT', 'ENOENT'),
      'missing_claude_cli',
    );
  });

  it('does not classify generic spawn failures without ENOENT', () => {
    assert.equal(
      classifyClaudeLaunchFailure('spawn node EPERM', 'EPERM'),
      null,
    );
  });
});
