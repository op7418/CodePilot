/**
 * Unit tests for Feishu webhook mode.
 *
 * Run with: npx tsx --test src/__tests__/unit/feishu-webhook.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Event parsing (extracted logic, no adapter instantiation needed) ──

/** Verify a Lark event's token matches the expected verification token. */
function verifyEventToken(payload: { header?: { token?: string }; token?: string }, expected: string): boolean {
  const token = payload.header?.token ?? payload.token ?? '';
  return token === expected;
}

/** Extract the event data from a Lark webhook payload. */
function extractEventData(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (payload.event && typeof payload.event === 'object') {
    return payload.event as Record<string, unknown>;
  }
  return null;
}

/** Check if a payload is a URL verification challenge. */
function isUrlVerification(payload: Record<string, unknown>): payload is { type: 'url_verification'; challenge: string; token: string } {
  return payload.type === 'url_verification' && typeof payload.challenge === 'string';
}

describe('Lark webhook: URL verification', () => {
  it('detects url_verification type', () => {
    const payload = { challenge: 'abc123', token: 'tok', type: 'url_verification' };
    assert.strictEqual(isUrlVerification(payload), true);
  });

  it('rejects non-verification payload', () => {
    const payload = { schema: '2.0', header: {}, event: {} };
    assert.strictEqual(isUrlVerification(payload), false);
  });
});

describe('Lark webhook: token verification', () => {
  it('verifies schema 2.0 header token', () => {
    const payload = { header: { token: 'secret123' }, event: {} };
    assert.strictEqual(verifyEventToken(payload, 'secret123'), true);
    assert.strictEqual(verifyEventToken(payload, 'wrong'), false);
  });

  it('verifies v1 top-level token', () => {
    const payload = { token: 'secret123', event: {} };
    assert.strictEqual(verifyEventToken(payload, 'secret123'), true);
  });

  it('rejects empty token', () => {
    const payload = { header: {} };
    assert.strictEqual(verifyEventToken(payload, 'secret123'), false);
  });
});

describe('Lark webhook: event extraction', () => {
  it('extracts event from schema 2.0 payload', () => {
    const payload = {
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', token: 'tok' },
      event: {
        sender: { sender_id: { open_id: 'ou_xxx' }, sender_type: 'user' },
        message: { message_id: 'om_xxx', chat_id: 'oc_xxx', message_type: 'text', content: '{"text":"hi"}' },
      },
    };
    const event = extractEventData(payload);
    assert.ok(event);
    assert.ok('sender' in event);
    assert.ok('message' in event);
  });

  it('returns null for missing event', () => {
    const payload = { schema: '2.0', header: {} };
    assert.strictEqual(extractEventData(payload), null);
  });
});
