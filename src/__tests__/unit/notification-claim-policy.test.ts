import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateNotificationConsumerRequest,
  validateRendererNotificationTestRequest,
} from '../../lib/notification-claim-policy';

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/tasks/notify/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Host: '127.0.0.1:3000', ...headers },
  });
}

describe('notification consumer boundary', () => {
  it('allows Electron Main to claim electron-native without an Origin', () => {
    assert.deepEqual(
      validateNotificationConsumerRequest(
        request({ 'X-CodePilot-Consumer': 'electron-main' }),
        'electron-native',
      ),
      { ok: true, consumer: 'electron-main' },
    );
  });

  it('rejects renderer/native impersonation and browser Origin on native claims', () => {
    for (const candidate of [
      request(),
      request({ Origin: 'http://127.0.0.1:3000' }),
      request({ Origin: 'http://127.0.0.1:3000', 'X-CodePilot-Consumer': 'electron-main' }),
    ]) {
      assert.equal(validateNotificationConsumerRequest(candidate, 'electron-native').ok, false);
    }
  });

  it('retires renderer-toast from the claim/ack HTTP consumer surface', () => {
    assert.deepEqual(
      validateNotificationConsumerRequest(
        request({ Origin: 'http://127.0.0.1:3000', 'Sec-Fetch-Site': 'same-origin' }),
        'renderer-toast',
      ),
      { ok: false, status: 400, error: 'Unsupported notification channel.' },
    );
  });

  it('allows only same-origin Renderer requests for the test-notification action', () => {
    assert.equal(
      validateRendererNotificationTestRequest(
        request({ Origin: 'http://127.0.0.1:3000', 'Sec-Fetch-Site': 'same-origin' }),
      ).ok,
      true,
    );
    assert.equal(
      validateRendererNotificationTestRequest(request({ Origin: 'http://evil.example' })).ok,
      false,
    );
    assert.equal(
      validateRendererNotificationTestRequest(
        request({ Origin: 'http://127.0.0.1:3000', 'X-CodePilot-Consumer': 'electron-main' }),
      ).ok,
      false,
    );
  });

  it('rejects non-JSON, non-loopback hosts and unknown channels', () => {
    assert.equal(
      validateNotificationConsumerRequest(
        request({ 'Content-Type': 'text/plain', 'X-CodePilot-Consumer': 'electron-main' }),
        'electron-native',
      ).ok,
      false,
    );
    assert.equal(
      validateNotificationConsumerRequest(
        request({ Host: 'evil.example', 'X-CodePilot-Consumer': 'electron-main' }),
        'electron-native',
      ).ok,
      false,
    );
    assert.equal(validateNotificationConsumerRequest(request(), 'bridge-telegram').ok, false);
  });
});
