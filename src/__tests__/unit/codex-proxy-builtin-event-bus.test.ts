/**
 * Phase 5c (2026-05-16) — side-channel event bus contract.
 *
 * The bus is the only path through which CodePilot built-in tool
 * execution results reach the ChatView when Codex Runtime is the
 * active orchestrator. Anything that subtly changes its semantics
 * (silent buffering, cross-session leakage, dropped emit on listener
 * throw) creates the kind of "tool ran but UI didn't update" bug
 * that took multiple rounds of round-9/10 work to surface before.
 * Pin the invariants explicitly.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  subscribeBuiltinEvents,
  emitBuiltinEvent,
  __resetBuiltinEventBusForTests,
  __subscriberCountForTests,
} from '@/lib/harness/builtin-event-bus';
import type { RuntimeRunEvent } from '@/lib/runtime/contract';

/** Build a canonical `assistant_delta` event with the required base
 *  fields. The bus is event-shape-agnostic; we just need any valid
 *  RuntimeRunEvent to pass through. */
function ev(sessionId: string, text: string): RuntimeRunEvent {
  return { type: 'assistant_delta', runtimeId: 'codex_runtime', sessionId, text };
}

beforeEach(() => {
  __resetBuiltinEventBusForTests();
});

describe('subscribeBuiltinEvents — registration + cleanup', () => {
  it('registers and fires on emit for the same sessionId', () => {
    const received: RuntimeRunEvent[] = [];
    subscribeBuiltinEvents('s-1', (e) => received.push(e));
    emitBuiltinEvent('s-1', ev('s-1', 'hi'));
    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'assistant_delta');
    if (received[0].type !== 'assistant_delta') return;
    assert.equal(received[0].text, 'hi');
  });

  it('returns an unsubscribe function that detaches the listener', () => {
    const received: RuntimeRunEvent[] = [];
    const unsub = subscribeBuiltinEvents('s-1', (e) => received.push(e));
    unsub();
    emitBuiltinEvent('s-1', ev('s-1', 'gone'));
    assert.equal(received.length, 0);
    assert.equal(__subscriberCountForTests('s-1'), 0, 'unsubscribe must clear the per-session bucket entirely');
  });

  it('isolates sessions: emit to one does not reach another', () => {
    const a: RuntimeRunEvent[] = [];
    const b: RuntimeRunEvent[] = [];
    subscribeBuiltinEvents('s-A', (e) => a.push(e));
    subscribeBuiltinEvents('s-B', (e) => b.push(e));
    emitBuiltinEvent('s-A', ev('s-A', 'for A'));
    assert.equal(a.length, 1);
    assert.equal(b.length, 0);
  });

  it('allows multiple subscribers per session (test probe alongside real runtime listener)', () => {
    const a: RuntimeRunEvent[] = [];
    const b: RuntimeRunEvent[] = [];
    subscribeBuiltinEvents('s-1', (e) => a.push(e));
    subscribeBuiltinEvents('s-1', (e) => b.push(e));
    emitBuiltinEvent('s-1', ev('s-1', 'broadcast'));
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
  });

  it('empty sessionId on subscribe → no-op + warn', () => {
    // We don't pin the warn (console output is incidental) but we
    // DO pin the "returns a no-op unsubscribe + listener never
    // fires" behaviour so an empty id can't accidentally subscribe
    // to "all sessions".
    const received: RuntimeRunEvent[] = [];
    const unsub = subscribeBuiltinEvents('', (e) => received.push(e));
    emitBuiltinEvent('', ev('', 'nope'));
    emitBuiltinEvent('s-1', ev('s-1', 'nope-2'));
    assert.equal(received.length, 0);
    assert.doesNotThrow(() => unsub());
  });
});

describe('emitBuiltinEvent — drop semantics + listener safety', () => {
  it('emit-before-subscribe is dropped (no buffering, no cross-turn leak)', () => {
    emitBuiltinEvent('s-1', ev('s-1', 'pre-sub'));
    const received: RuntimeRunEvent[] = [];
    subscribeBuiltinEvents('s-1', (e) => received.push(e));
    assert.equal(received.length, 0, 'subscriber must not see events emitted before it attached');
  });

  it('emit to a session with no listeners is a no-op (no throw)', () => {
    assert.doesNotThrow(() => emitBuiltinEvent('s-nobody-home', ev('s-nobody-home', 'x')));
  });

  it('one listener throwing does NOT stop other listeners from receiving', () => {
    const reached: string[] = [];
    subscribeBuiltinEvents('s-1', () => { throw new Error('boom'); });
    subscribeBuiltinEvents('s-1', () => reached.push('second'));
    subscribeBuiltinEvents('s-1', () => reached.push('third'));
    // Should not throw out of emit even though listener-1 explodes.
    assert.doesNotThrow(() =>
      emitBuiltinEvent('s-1', ev('s-1', 'survive')),
    );
    // The other two still got the event.
    assert.deepEqual(reached, ['second', 'third']);
  });
});

describe('__resetBuiltinEventBusForTests + __subscriberCountForTests — hermetic test helpers', () => {
  it('reset removes every subscriber across sessions', () => {
    subscribeBuiltinEvents('s-1', () => {});
    subscribeBuiltinEvents('s-2', () => {});
    assert.equal(__subscriberCountForTests('s-1'), 1);
    assert.equal(__subscriberCountForTests('s-2'), 1);
    __resetBuiltinEventBusForTests();
    assert.equal(__subscriberCountForTests('s-1'), 0);
    assert.equal(__subscriberCountForTests('s-2'), 0);
  });
});
