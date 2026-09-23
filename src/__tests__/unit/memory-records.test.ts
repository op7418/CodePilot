import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentHarnessMachineId } from '../../lib/harness-home/repository/writer-lease';
import {
  correctMemoryRecord, isManagedMemoryRecordPath, MemoryRecordError,
  readActiveMemoryProjection, readMemoryRecords, revokeMemoryRecord,
  saveMemoryRecordCandidate, saveMemoryRecordCandidates,
} from '../../lib/memory-records';

function workspace(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-records-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const source = { kind: 'conversation' as const, sessionId: 'session-a', messageId: 'message-a', role: 'user' as const };

test('manual memory stores exact Markdown without an LLM and reads have no filesystem side effects', t => {
  const root = workspace(t);
  const before = readMemoryRecords(root);
  assert.deepEqual(fs.readdirSync(root), []);
  const content = '中文原文\n\n- Preserve spacing  \n<!-- memory-record arbitrary -->';
  const saved = saveMemoryRecordCandidate(root, { content, source: { kind: 'manual' }, idempotencyKey: 'one' }, before.revision);
  assert.equal(saved.result, 'saved');
  assert.equal(readMemoryRecords(root).records[0].content, content);
  assert.ok(fs.readFileSync(path.join(root, 'memory/records.md'), 'utf8').includes(content));
  assert.equal(readActiveMemoryProjection(root)[0].revision, saved.revision);
});

test('stable idempotency prevents duplicate writes, including batch retries', t => {
  const root = workspace(t);
  const candidates = [1, 2].map(index => ({ content: `Fact ${index}`, source, idempotencyKey: `message:${index}` }));
  const saved = saveMemoryRecordCandidates(root, candidates);
  const retry = saveMemoryRecordCandidates(root, candidates);
  assert.equal(retry.result, 'duplicate');
  assert.equal(retry.revision, saved.revision);
  assert.deepEqual(retry.records.map(record => record.id), saved.records.map(record => record.id));
});

test('reusing an idempotency key for different content or provenance fails without a false success', t => {
  const root = workspace(t);
  const saved = saveMemoryRecordCandidate(root, { content: 'Original', source, idempotencyKey: 'one' });
  for (const candidate of [
    { content: 'Different', source, idempotencyKey: 'one' },
    { content: 'Original', source: { ...source, messageId: 'other' }, idempotencyKey: 'one' },
  ]) assert.throws(() => saveMemoryRecordCandidate(root, candidate), /already used/);
  assert.equal(readMemoryRecords(root).revision, saved.revision);
  const manual = saveMemoryRecordCandidate(root, { content: 'Manual', source: { kind: 'manual' }, idempotencyKey: 'manual' });
  revokeMemoryRecord(root, manual.records[1].id, manual.revision);
  assert.equal(saveMemoryRecordCandidate(root, { content: 'Manual', source: { kind: 'manual' }, idempotencyKey: 'manual' }).result, 'blocked');
  const blockedBatch = saveMemoryRecordCandidates(root, [
    { content: 'Not persisted', source: { kind: 'manual' }, idempotencyKey: 'new' },
    { content: 'Manual', source: { kind: 'manual' }, idempotencyKey: 'manual' },
  ]);
  assert.equal(blockedBatch.result, 'blocked');
  assert.ok(!blockedBatch.records.some(record => record.content === 'Not persisted'));
  assert.deepEqual(blockedBatch.records, readMemoryRecords(root).records);
});

test('correction preserves provenance and old version but exposes only current memory', t => {
  const root = workspace(t);
  const saved = saveMemoryRecordCandidate(root, { content: 'Old choice', source, idempotencyKey: 'one' });
  const updated = correctMemoryRecord(root, saved.records[0].id, 'New choice', saved.revision);
  assert.equal(updated.records[0].status, 'superseded');
  assert.equal(updated.records[1].supersedes, saved.records[0].id);
  assert.deepEqual(updated.records[0].source, source);
  assert.deepEqual(updated.records[1].source, { kind: 'manual' });
  assert.deepEqual(readActiveMemoryProjection(root).map(record => record.content), ['New choice']);
  const reextract = saveMemoryRecordCandidate(root, { content: 'Old choice phrased differently', source, idempotencyKey: 'later-attempt' });
  assert.equal(reextract.result, 'blocked');
});

test('forget erases every version and tombstones the source message against rephrased extraction', t => {
  const root = workspace(t);
  const saved = saveMemoryRecordCandidate(root, { content: 'A secret preference', source, idempotencyKey: 'one' });
  const corrected = correctMemoryRecord(root, saved.records[0].id, 'Corrected preference', saved.revision);
  const forgotten = revokeMemoryRecord(root, corrected.records[1].id, corrected.revision);
  assert.ok(forgotten.records.every(record => record.status === 'revoked' && record.content === ''));
  assert.deepEqual(readActiveMemoryProjection(root), []);
  const raw = fs.readFileSync(path.join(root, 'memory/records.md'), 'utf8');
  assert.ok(!raw.includes('preference'));
  assert.equal(saveMemoryRecordCandidate(root, { content: 'Reworded fact', source, idempotencyKey: 'another-key' }).result, 'blocked');
  assert.equal(saveMemoryRecordCandidates(root, [
    { content: 'Reworded fact', source, idempotencyKey: 'another-key' },
    { content: 'Other fact', source: { ...source, messageId: 'different' }, idempotencyKey: 'two' },
  ]).result, 'blocked');
  assert.deepEqual(readActiveMemoryProjection(root), []);
});

test('CAS rejects stale edits and revisions from a different empty workspace', t => {
  const first = workspace(t), second = workspace(t);
  const revision = readMemoryRecords(first).revision;
  assert.throws(() => saveMemoryRecordCandidate(second, { content: 'Wrong root', source, idempotencyKey: 'one' }, revision),
    (error: unknown) => error instanceof MemoryRecordError && error.code === 'conflict');
  const saved = saveMemoryRecordCandidate(first, { content: 'First', source, idempotencyKey: 'one' }, revision);
  assert.throws(() => correctMemoryRecord(first, saved.records[0].id, 'Stale edit', revision), /Refresh/);
  assert.equal(readMemoryRecords(first).records[0].content, 'First');
});

test('unmanaged legacy files and externally changed snapshots are never overwritten', t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'memory'));
  fs.writeFileSync(path.join(root, 'memory/records.md'), '# My own memory\n');
  assert.throws(() => saveMemoryRecordCandidate(root, { content: 'Replace', source, idempotencyKey: 'one' }), /not a managed/);
  assert.equal(fs.readFileSync(path.join(root, 'memory/records.md'), 'utf8'), '# My own memory\n');
});

test('symlinked memory directory and record file cannot escape the selected workspace', t => {
  const root = workspace(t), outside = workspace(t);
  fs.symlinkSync(outside, path.join(root, 'memory'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => saveMemoryRecordCandidate(root, { content: 'Escape', source, idempotencyKey: 'one' }), /regular workspace/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(root, 'memory'));
  fs.mkdirSync(path.join(root, 'memory'));
  fs.writeFileSync(path.join(outside, 'target.md'), 'Do not touch');
  fs.symlinkSync(path.join(outside, 'target.md'), path.join(root, 'memory/records.md'));
  assert.throws(() => readMemoryRecords(root), /regular workspace/);
  assert.equal(fs.readFileSync(path.join(outside, 'target.md'), 'utf8'), 'Do not touch');
});

test('a writer lease fails closed without deleting the other writer lock', t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'memory/.records-lock'), { recursive: true });
  assert.throws(() => saveMemoryRecordCandidate(root, { content: 'Busy', source, idempotencyKey: 'one' }),
    (error: unknown) => error instanceof MemoryRecordError && error.code === 'busy');
  assert.ok(fs.existsSync(path.join(root, 'memory/.records-lock')));
});

test('managed raw records and temporary metadata have explicit index exclusions', () => {
  assert.equal(isManagedMemoryRecordPath('memory/records.md'), true);
  assert.equal(isManagedMemoryRecordPath('memory\\.records-lock'), true);
  assert.equal(isManagedMemoryRecordPath('memory/records/id.md'), true);
  assert.equal(isManagedMemoryRecordPath('memory/user-note.md'), false);
});

test('invalid provenance or a bad batch never persists partial records', t => {
  const root = workspace(t);
  assert.throws(() => saveMemoryRecordCandidate(root, { content: 'No source', source: { kind: 'conversation' }, idempotencyKey: 'one' }), /session and message/);
  assert.throws(() => saveMemoryRecordCandidate(root, { content: 'No session', source: { kind: 'tool' }, idempotencyKey: 'one' }), /trusted session/);
  assert.throws(() => saveMemoryRecordCandidates(root, [
    { content: 'Valid', source, idempotencyKey: 'one' }, { content: '', source, idempotencyKey: 'two' },
  ]), /characters/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('credential patterns are rejected without blocking ordinary security discussion', t => {
  const root = workspace(t);
  assert.throws(() => saveMemoryRecordCandidate(root, { content: 'Use sk-abcdefghijklmnopqrstuvwxyz', source, idempotencyKey: 'bad' }),
    (error: unknown) => error instanceof MemoryRecordError && error.code === 'secret');
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(saveMemoryRecordCandidate(root, { content: 'Never log API keys; store passwords securely.', source, idempotencyKey: 'safe' }).result, 'saved');
});

test('dead same-machine locks recover, while foreign-machine locks fail closed', t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'memory'));
  const lock = path.join(root, 'memory/.records-lock');
  fs.writeFileSync(lock, JSON.stringify({ machineId: 'another-machine', pid: 2147483647, nonce: 'foreign' }));
  assert.throws(() => saveMemoryRecordCandidate(root, { content: 'Fact', source, idempotencyKey: 'one' }),
    (error: unknown) => error instanceof MemoryRecordError && error.code === 'busy');
  fs.writeFileSync(lock, JSON.stringify({ machineId: currentHarnessMachineId(), pid: 2147483647, nonce: 'dead' }));
  assert.equal(saveMemoryRecordCandidate(root, { content: 'Fact', source, idempotencyKey: 'one' }).result, 'saved');
  assert.equal(fs.existsSync(lock), false);
});

test('tool correction records its actual caller and forgetting still revokes the original source', t => {
  const root = workspace(t);
  const saved = saveMemoryRecordCandidate(root, { content: 'Original', source, idempotencyKey: 'one' });
  const updated = correctMemoryRecord(root, saved.records[0].id, 'Corrected', saved.revision, { kind: 'tool', sessionId: 'correction-session' });
  assert.deepEqual(updated.records[1].source, { kind: 'tool', sessionId: 'correction-session' });
  revokeMemoryRecord(root, updated.records[1].id, updated.revision);
  assert.equal(saveMemoryRecordCandidate(root, { content: 'Rephrased original', source, idempotencyKey: 'other' }).result, 'blocked');
});
