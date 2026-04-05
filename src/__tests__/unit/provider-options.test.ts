import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

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

  it('drops invalid stored effort values when rehydrating env provider options', () => {
    setSetting('effort', 'invalid-effort');

    const options = getProviderOptions('env');
    assert.equal(options.effort, undefined);
  });

  it('rejects invalid effort values in the provider options route', async () => {
    const { PUT } = await import('../../app/api/providers/options/route');
    const request = new NextRequest('http://localhost/api/providers/options', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: 'env',
        options: { effort: 'invalid-effort' },
      }),
    });

    const response = await PUT(request);
    assert.equal(response.status, 400);
  });

  it('treats null effort as clearing the stored env effort', async () => {
    setSetting('effort', 'max');

    const { PUT } = await import('../../app/api/providers/options/route');
    const request = new NextRequest('http://localhost/api/providers/options', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: 'env',
        options: { effort: null },
      }),
    });

    const response = await PUT(request);
    const data = await response.json() as { options: { effort?: string } };

    assert.equal(response.status, 200);
    assert.equal(data.options.effort, undefined);
    assert.equal(getProviderOptions('env').effort, undefined);
    assert.equal(getSetting('effort'), '');
  });
});
