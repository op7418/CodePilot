import '../db-isolation.setup';
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindAssistantMemory } from '../../lib/memory-binding';
import { collectStreamResponse } from '../../lib/chat-collect-stream-response';
import { createSession, acquireSessionLock, releaseSessionLock, isLockOwner, getMessages, getDb, createProvider, activateProvider, setSetting } from '../../lib/db';
import { CHAT_SAVE_UNCONFIRMED, createChatCollectionResponse, createChatPersistenceSignal, observeChatCollection } from '../../lib/chat-collection-response';
import { localizeModelSelectionError } from '../../lib/model-selection-error-i18n';
import { translate } from '../../i18n';

function source(text = 'reply to preserve') {
  return new ReadableStream<string>({ start(c) {
    c.enqueue(`data: ${JSON.stringify({ type: 'text', data: text })}\n\n`);
    c.enqueue(`data: ${JSON.stringify({ type: 'done', data: '' })}\n\n`);
    c.close();
  } });
}
async function readAll(stream: ReadableStream<string>) {
  const reader = stream.getReader();
  let output = '';
  while (true) { const { done, value } = await reader.read(); if (done) return output; output += value; }
}

for (const failing of [false, true]) {
  it(`real collector ${failing ? 'owns failed insert and failed fallback' : 'saves normally'} before response closes`, async () => {
    const sid = createSession('collection-response').id;
    const lock = `lock-${failing}`;
    acquireSessionLock(sid, lock, 'test', 600);
    const db = getDb();
    if (failing) db.exec("CREATE TRIGGER collection_failure_probe AFTER INSERT ON messages WHEN NEW.role = 'assistant' BEGIN DELETE FROM messages WHERE id = NEW.id; END;");
    let cleaned = 0;
    const failures: unknown[] = [];
    const [client, server] = source().tee();
    try {
      const persistence = createChatPersistenceSignal();
      const collection = observeChatCollection(collectStreamResponse(server, sid, lock, {}, () => {
        cleaned++; releaseSessionLock(sid, lock);
      }, { suppressNotifications: true, onPersistenceSettled: persistence.settle }), (error) => {
        persistence.settle(false); failures.push(error);
      });
      const output = await readAll(createChatCollectionResponse(client, persistence.settled));
      await collection;
      assert.match(output, /reply to preserve/);
      assert.equal(output.includes(CHAT_SAVE_UNCONFIRMED), failing);
      assert.equal(failures.length, failing ? 1 : 0);
      assert.equal(cleaned, 1);
      assert.equal(isLockOwner(sid, lock), false);
      assert.equal(getMessages(sid).messages.length, failing ? 0 : 1);
      if (failing) assert.match(String(failures[0]), /CODEPILOT_MESSAGE_PERSISTENCE_FAILED/);
    } finally { if (failing) db.exec('DROP TRIGGER collection_failure_probe'); }
  });
}

it('does not close on runtime done before persistence settles; sends only one save failure', async () => {
  let finish!: (saved: boolean) => void;
  const completion = new Promise<boolean>((resolve) => { finish = resolve; });
  const reader = createChatCollectionResponse(source(), completion, 'preface\n').getReader();
  assert.equal((await reader.read()).value, 'preface\n');
  await reader.read(); // text
  await reader.read(); // done
  let settled = false;
  const final = reader.read().then((r) => { settled = true; return r; });
  await Promise.resolve();
  assert.equal(settled, false);
  finish(false);
  assert.match((await final).value!, /CODEPILOT_CHAT_SAVE_UNCONFIRMED/);
  assert.equal((await reader.read()).done, true);
});

it('real onboarding model work does not hold the client response open after persistence', { timeout: 10_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'collection-onboarding-'));
  const provider = createProvider({ name: 'onboarding fixture', provider_type: 'anthropic',
    protocol: 'anthropic', base_url: 'https://example.invalid', api_key: 'fake-test-key' });
  activateProvider(provider.id);
  const session = createSession('onboarding', 'sonnet', '', workspace, 'code', provider.id);
  setSetting('assistant_workspace_path', workspace);
  bindAssistantMemory(session.id);
  acquireSessionLock(session.id, 'slow-finally', 'test', 600);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    requests++;
    await blocked;
    return new Response('fixture failure', { status: 400 });
  });
  const persistence = createChatPersistenceSignal();
  let cleaned = false;
  const [client, server] = source('```onboarding-complete\n{"q1":"test"}\n```').tee();
  const collection = observeChatCollection(collectStreamResponse(server, session.id, 'slow-finally', {}, () => {
    cleaned = true;
    releaseSessionLock(session.id, 'slow-finally');
  }, { suppressNotifications: true, onPersistenceSettled: persistence.settle }), () => persistence.settle(false));
  try {
    const output = await readAll(createChatCollectionResponse(client, persistence.settled));
    assert.doesNotMatch(output, /CODEPILOT_CHAT_SAVE_UNCONFIRMED/);
    assert.equal(getMessages(session.id).messages.length, 1);
    // Allow dynamic imports/provider setup to reach the blocked model calls.
    for (let i = 0; i < 100 && requests === 0; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(requests > 0, 'the real onboarding processor must reach model generation');
    assert.equal(cleaned, false, 'collector finally is still running after client EOF');
  } finally {
    release();
    await collection;
    fetchMock.mock.restore();
    setSetting('assistant_workspace_path', '');
    rmSync(workspace, { recursive: true, force: true });
  }
  assert.equal(cleaned, true);
});

it('finally failure before onComplete is owned and cannot revoke a confirmed save', async () => {
  const session = createSession('cleanup-failure');
  acquireSessionLock(session.id, 'cleanup-lock', 'test', 600);
  const persistence = createChatPersistenceSignal();
  const db = getDb();
  const prepare = db.prepare.bind(db);
  let afterPersistence = false;
  const prepareMock = mock.method(db, 'prepare', (sql: string) => {
    if (afterPersistence && sql === 'SELECT * FROM chat_sessions WHERE id = ?') throw new Error('finalize fixture');
    return prepare(sql);
  });
  let cleanupCalls = 0;
  let reports = 0;
  const [client, server] = source().tee();
  const collection = observeChatCollection(collectStreamResponse(server, session.id, 'cleanup-lock', {}, () => {
    cleanupCalls++;
  }, {
    suppressNotifications: true,
    titleGeneration: { userText: 'fixture', runtime: 'codex_runtime', providerId: 'missing-fixture' },
    onPersistenceSettled: (saved) => { persistence.settle(saved); afterPersistence = true; },
  }), () => {
    reports++;
    persistence.settle(false);
    releaseSessionLock(session.id, 'cleanup-lock');
  });
  try {
    const output = await readAll(createChatCollectionResponse(client, persistence.settled));
    assert.equal(await collection, false);
    assert.equal(reports, 1);
    assert.equal(cleanupCalls, 0);
    assert.equal(isLockOwner(session.id, 'cleanup-lock'), false);
    assert.doesNotMatch(output, /CODEPILOT_CHAT_SAVE_UNCONFIRMED/);
  } finally { prepareMock.mock.restore(); }
});

it('renderer detach leaves the server branch running and still observes collection failure', async () => {
  let upstream!: ReadableStreamDefaultController<string>;
  let cancelled = false;
  const original = new ReadableStream<string>({ start(c) { upstream = c; }, cancel() { cancelled = true; } });
  const [client, server] = original.tee();
  let reports = 0;
  const collection = observeChatCollection(readAll(server).then(() => { throw new Error('save failed'); }), () => { reports++; });
  const reader = createChatCollectionResponse(client, collection).getReader();
  await reader.cancel();
  assert.equal(cancelled, false);
  upstream.enqueue('still running');
  upstream.close();
  assert.equal(await collection, false);
  assert.equal(reports, 1);
});

it('reporter failure cannot escape the rejection owner', async () => {
  assert.equal(await observeChatCollection(Promise.reject(new Error('save')), () => { throw new Error('reporter'); }), false);
});

it('both chat entry points share a localized, actionable save warning without raw wire codes', () => {
  for (const locale of ['en', 'zh'] as const) {
    const output = localizeModelSelectionError(CHAT_SAVE_UNCONFIRMED, (key) => translate(locale, key));
    assert.equal(output, translate(locale, 'chat.error.saveUnconfirmed'));
    assert.doesNotMatch(output, /CODEPILOT/);
    assert.match(output, locale === 'en' ? /Copy/ : /复制/);
  }
});
