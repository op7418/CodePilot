import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getProviderOptions, setProviderOptions, getSetting, setSetting } from '../../lib/db';

describe('Provider options', () => {
  let savedThinking: string | undefined;
  let savedContext1m: string | undefined;
  let savedEffort: string | undefined;

  beforeEach(() => {
    savedThinking = getSetting('thinking_mode');
    savedContext1m = getSetting('context_1m');
    savedEffort = getSetting('effort');
    setSetting('thinking_mode', '');
    setSetting('context_1m', '');
    setSetting('effort', '');
  });

  afterEach(() => {
    setSetting('thinking_mode', savedThinking || '');
    setSetting('context_1m', savedContext1m || '');
    setSetting('effort', savedEffort || '');
  });

  it('env provider options round-trip effort persistence', () => {
    setProviderOptions('env', {
      thinking_mode: 'enabled',
      context_1m: true,
      effort: 'max',
    });

    const options = getProviderOptions('env');
    assert.equal(options.thinking_mode, 'enabled');
    assert.equal(options.context_1m, true);
    assert.equal(options.effort, 'max');
  });
});
