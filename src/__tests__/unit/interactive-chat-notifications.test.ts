import '../db-isolation.setup';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectStreamResponse } from '../../lib/chat-collect-stream-response';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  acquireSessionLock,
  createSession,
  getDb,
  listNotificationDeliveries,
  releaseSessionLock,
  setSetting,
} from '../../lib/db';

function sse(type: string, data: unknown): string {
  const value = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${JSON.stringify({ type, data: value })}\n\n`;
}

function streamOf(chunks: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function notificationEvents(sessionId: string): Array<{
  event_id: string;
  title: string;
  body: string;
  action_type: string | null;
  action_payload: string | null;
}> {
  return getDb().prepare(`
    SELECT event_id, title, body, action_type, action_payload
    FROM notification_events
    WHERE session_id = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(sessionId) as Array<{
    event_id: string;
    title: string;
    body: string;
    action_type: string | null;
    action_payload: string | null;
  }>;
}

describe('interactive chat native notifications', () => {
  it('keeps owner check → durable native insert free of a dynamic-import await', () => {
    const managerSource = readFileSync(
      path.resolve(__dirname, '../../lib/notification-manager.ts'),
      'utf8',
    );
    assert.doesNotMatch(
      managerSource,
      /await\s+import\(['"]@\/lib\/db['"]\)/,
      'notification insertion must not yield after the collector owner check',
    );
    assert.match(managerSource, /insertNotificationEvent\(/);
  });

  it('queues one approval and one clean-completion event across the server collector', async () => {
    setSetting('locale', 'zh');
    const session = createSession('发布准备');
    const lockId = 'interactive-notify-owner';
    assert.equal(acquireSessionLock(session.id, lockId, 'test', 600), true);
    const permission = {
      permissionRequestId: 'permission-one',
      toolName: 'Bash',
      toolInput: { command: 'must-not-leak' },
    };

    await collectStreamResponse(
      streamOf([
        sse('permission_request', permission),
        sse('permission_request', permission),
        sse('text', '已完成'),
        sse('result', { is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }),
      ]),
      session.id,
      lockId,
      { sessionId: session.id, sessionTitle: session.title },
    );

    const events = notificationEvents(session.id);
    assert.equal(events.length, 2, 'duplicate permission frames must not duplicate native alerts');
    assert.equal(events[0].title, '需要你的确认');
    assert.match(events[0].body, /发布准备.*Bash/);
    assert.doesNotMatch(events[0].body, /must-not-leak/, 'tool input must stay out of lock-screen copy');
    assert.equal(events[1].title, '任务已完成');
    assert.match(events[1].body, /发布准备/);
    for (const event of events) {
      assert.equal(event.action_type, 'route');
      assert.equal(event.action_payload, `/chat/${session.id}`);
      assert.deepEqual(
        listNotificationDeliveries(event.event_id).map((row) => row.channel),
        ['electron-native'],
      );
    }
  });

  it('does not announce failed or auto-trigger turns as completed', async () => {
    const failed = createSession('failed-notify');
    const failedLock = 'failed-notify-lock';
    assert.equal(acquireSessionLock(failed.id, failedLock, 'test', 600), true);
    await collectStreamResponse(
      streamOf([
        sse('error', 'provider failed'),
        sse('result', { is_error: true, errors: ['provider failed'] }),
      ]),
      failed.id,
      failedLock,
      { sessionId: failed.id, sessionTitle: failed.title },
    );
    assert.equal(notificationEvents(failed.id).length, 0);

    const background = createSession('background-notify');
    const backgroundLock = 'background-notify-lock';
    assert.equal(acquireSessionLock(background.id, backgroundLock, 'test', 600), true);
    await collectStreamResponse(
      streamOf([
        sse('text', 'background result'),
        sse('result', { is_error: false }),
      ]),
      background.id,
      backgroundLock,
      { sessionId: background.id, sessionTitle: background.title },
      undefined,
      { suppressNotifications: true },
    );
    assert.equal(notificationEvents(background.id).length, 0);
  });

  it('does not turn a Codex interrupt plus usage frame into completion', async () => {
    const interrupted = createSession('codex-interrupted-notify');
    const interruptedLock = 'codex-interrupted-notify-lock';
    assert.equal(acquireSessionLock(interrupted.id, interruptedLock, 'test', 600), true);
    await collectStreamResponse(
      streamOf([
        sse('text', 'partial response before Stop'),
        sse('result', { finish_reason: 'interrupted' }),
        sse('result', { usage: { input_tokens: 4, output_tokens: 2 } }),
      ]),
      interrupted.id,
      interruptedLock,
      { sessionId: interrupted.id, sessionTitle: interrupted.title },
    );
    assert.equal(
      notificationEvents(interrupted.id).length,
      0,
      'usage accounting after an interrupted terminal result must not restore success',
    );

    const stillRunning = createSession('codex-in-progress-notify');
    const stillRunningLock = 'codex-in-progress-notify-lock';
    assert.equal(acquireSessionLock(stillRunning.id, stillRunningLock, 'test', 600), true);
    await collectStreamResponse(
      streamOf([
        sse('text', 'non-terminal snapshot'),
        sse('result', { finish_reason: 'inProgress' }),
        sse('result', { usage: { input_tokens: 3, output_tokens: 1 } }),
      ]),
      stillRunning.id,
      stillRunningLock,
      { sessionId: stillRunning.id, sessionTitle: stillRunning.title },
    );
    assert.equal(
      notificationEvents(stillRunning.id).length,
      0,
      'a conservative inProgress mapping is not a successful terminal result',
    );

    const completed = createSession('codex-completed-notify');
    const completedLock = 'codex-completed-notify-lock';
    assert.equal(acquireSessionLock(completed.id, completedLock, 'test', 600), true);
    await collectStreamResponse(
      streamOf([
        sse('text', 'natural completion'),
        sse('result', { finish_reason: 'end_turn' }),
        sse('result', { usage: { input_tokens: 4, output_tokens: 2 } }),
      ]),
      completed.id,
      completedLock,
      { sessionId: completed.id, sessionTitle: completed.title },
    );
    assert.deepEqual(
      notificationEvents(completed.id).map((event) => event.title),
      ['任务已完成'],
    );
  });

  it('drops notifications from a superseded lock owner', async () => {
    const session = createSession('stale-notify');
    const staleLock = 'stale-notify-lock';
    const currentLock = 'current-notify-lock';
    assert.equal(acquireSessionLock(session.id, staleLock, 'old', 600), true);
    assert.equal(releaseSessionLock(session.id, staleLock), true);
    assert.equal(acquireSessionLock(session.id, currentLock, 'new', 600), true);

    await collectStreamResponse(
      streamOf([
        sse('permission_request', {
          permissionRequestId: 'stale-permission',
          toolName: 'Write',
        }),
        sse('text', 'stale result'),
        sse('result', { is_error: false }),
      ]),
      session.id,
      staleLock,
      { sessionId: session.id, sessionTitle: session.title },
    );
    assert.equal(notificationEvents(session.id).length, 0);
  });
});
