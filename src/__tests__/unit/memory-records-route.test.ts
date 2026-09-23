import '../db-isolation.setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSetting, setSetting } from '../../lib/db';
import { GET, POST } from '../../app/api/workspace/memory/route';

function request(body: unknown, origin = 'http://localhost:3000') {
  return new Request('http://localhost:3000/api/workspace/memory', { method: 'POST',
    headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
}

test('workspace memory API rejects cross-origin writes, caller paths and fabricated provenance', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-route-'));
  const prior = getSetting('assistant_workspace_path');
  setSetting('assistant_workspace_path', root);
  t.after(() => { setSetting('assistant_workspace_path', prior || ''); fs.rmSync(root, { recursive: true, force: true }); });
  const read = await GET(new Request('http://localhost:3000/api/workspace/memory'));
  assert.equal(read.status, 200);
  const initial = await read.json();
  assert.deepEqual(initial.records, []);
  assert.deepEqual(fs.readdirSync(root), []);
  const body = { action: 'remember', content: 'Original text', expectedRevision: initial.revision, idempotencyKey: 'manual-one' };
  assert.equal((await POST(request(body, 'https://attacker.example'))).status, 403);
  assert.equal((await POST(request({ ...body, workspacePath: '/tmp/outside' }))).status, 400);
  assert.equal((await POST(request({ ...body, source: { kind: 'conversation', sessionId: 'fake', messageId: 'fake' } }))).status, 400);
  assert.deepEqual(fs.readdirSync(root), []);
  const save = await POST(request(body));
  assert.equal(save.status, 200);
  const saved = await save.json();
  assert.equal(saved.records[0].source.kind, 'manual');
  assert.equal(saved.records[0].content, 'Original text');
  assert.equal((await POST(request({ action: 'correct', id: saved.records[0].id, content: 'Stale', expectedRevision: initial.revision }))).status, 409);
  const corrected = await (await POST(request({ action: 'correct', id: saved.records[0].id, content: 'Correction', expectedRevision: saved.revision }))).json();
  const forgotten = await POST(request({ action: 'forget', id: corrected.records[1].id, expectedRevision: corrected.revision }));
  assert.equal(forgotten.status, 200);
  assert.ok((await forgotten.json()).records.every((record: { content: string; status: string }) => record.content === '' && record.status === 'revoked'));
});

test('a corrupt extraction ledger does not block manual memory management', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-route-status-'));
  const prior = getSetting('assistant_workspace_path');
  setSetting('assistant_workspace_path', root);
  t.after(() => { setSetting('assistant_workspace_path', prior || ''); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, '.assistant'));
  fs.writeFileSync(path.join(root, '.assistant/memory-jobs.json'), 'broken');
  const response = await GET(new Request('http://localhost:3000/api/workspace/memory'));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.enhancement.error, 'unavailable');
  const save = await POST(request({ action: 'remember', content: 'Still works', expectedRevision: data.revision, idempotencyKey: 'without-model' }));
  assert.equal(save.status, 200);
});

test('GET and POST distinguish corrupt storage, capacity, and input errors without replacing user files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-route-errors-'));
  const prior = getSetting('assistant_workspace_path');
  setSetting('assistant_workspace_path', root);
  t.after(() => { setSetting('assistant_workspace_path', prior || ''); fs.rmSync(root, { recursive: true, force: true }); });
  const initial = await (await GET(new Request('http://localhost:3000/api/workspace/memory'))).json();
  fs.mkdirSync(path.join(root, 'memory'));
  const file = path.join(root, 'memory/records.md');
  fs.writeFileSync(file, 'My original notes');
  const corrupt = await GET(new Request('http://localhost:3000/api/workspace/memory'));
  assert.equal(corrupt.status, 422);
  assert.deepEqual(await corrupt.json(), { error: 'corrupt' });
  const save = await POST(request({ action: 'remember', content: 'New fact', expectedRevision: initial.revision, idempotencyKey: 'attempt' }));
  assert.equal(save.status, 422);
  assert.deepEqual(await save.json(), { error: 'corrupt' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'My original notes');
  fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 1));
  const capacity = await GET(new Request('http://localhost:3000/api/workspace/memory'));
  assert.equal(capacity.status, 507);
  assert.deepEqual(await capacity.json(), { error: 'capacity' });
  assert.equal(fs.statSync(file).size, 2 * 1024 * 1024 + 1);
});
