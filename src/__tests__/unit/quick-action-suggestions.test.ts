import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createQuickActionSuggestionsCache, type QuickActionGeneration } from '../../lib/quick-action-suggestions';
const success = (text: string): QuickActionGeneration => ({ suggestions: [text], enhancement: { status: 'completed' } });

it('honors the actual retry deadline and immediately invalidates a failure after a configuration change', async () => {
  let time = 0, calls = 0;
  const cache = createQuickActionSuggestionsCache(() => time);
  const failure = { suggestions: [], enhancement: { status: 'failed' as const, reason: 'request_failed' as const, retryAt: 90000 } };
  const generate = async () => { calls++; return failure; };
  assert.deepEqual(await cache.get('workspace', 'config-a', generate), failure);
  time = 70000;
  assert.deepEqual(await cache.get('workspace', 'config-a', generate, true), failure);
  assert.equal(calls, 1, 'retry does not override a provider deadline');
  assert.deepEqual(await cache.get('workspace', 'config-b', async () => success('recovered immediately')), success('recovered immediately'));
});

it('invalidates successes by configuration, expires at ten minutes, and explicitly refreshes on retry', async () => {
  let time = 0, calls = 0;
  const cache = createQuickActionSuggestionsCache(() => time);
  const generate = async () => success(`suggestion ${++calls}`);
  await cache.get('workspace', 'a', generate);
  time = 599999;
  assert.deepEqual(await cache.get('workspace', 'a', generate), success('suggestion 1'));
  assert.deepEqual(await cache.get('workspace', 'b', generate), success('suggestion 2'));
  assert.deepEqual(await cache.get('workspace', 'b', generate, true), success('suggestion 3'));
  time += 600000;
  assert.deepEqual(await cache.get('workspace', 'b', generate), success('suggestion 4'));
});

it('coalesces only matching configuration requests and ignores late completions for other identities', async () => {
  let finish!: (value: QuickActionGeneration) => void;
  let calls = 0;
  const cache = createQuickActionSuggestionsCache();
  const generate = () => { calls++; return new Promise<QuickActionGeneration>(resolve => { finish = resolve; }); };
  const a = cache.get('workspace', 'a', generate);
  const b = cache.get('workspace', 'a', generate);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.deepEqual(await cache.get('workspace', 'b', async () => success('new config')), success('new config'));
  finish(success('old config'));
  await Promise.all([a, b]);
  assert.deepEqual(await cache.get('workspace', 'b', async () => { throw new Error('must cache new'); }), success('new config'));
});

it('does not cache missing identity, invented fixed-duration failures, or another workspace', async () => {
  const cache = createQuickActionSuggestionsCache();
  let calls = 0;
  const generate = async () => success(`suggestion ${++calls}`);
  await cache.get('workspace', undefined, generate);
  await cache.get('workspace', undefined, generate);
  assert.equal(calls, 2);
  await cache.get('workspace', 'a', async () => { throw new Error('transient failure'); });
  assert.deepEqual(await cache.get('workspace', 'a', generate), success('suggestion 3'));
  assert.deepEqual(await cache.get('other-workspace', 'a', generate), success('suggestion 4'));
});
