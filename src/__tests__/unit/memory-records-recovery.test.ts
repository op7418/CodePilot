import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { assertMemoryStorageWritable, MemoryRecordError, readMemoryRecords, revokeMemoryRecord, saveMemoryRecordCandidate, saveMemoryRecordCandidates } from '@/lib/memory-records';

function workspace(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const manual = { kind: 'manual' as const };
const candidate = (key: string, content = key) => ({ content, source: manual, idempotencyKey: key });
const isCode = (code: string) => (error: unknown) => error instanceof MemoryRecordError && error.code === code;

test('capacity is distinct from invalid input; forgetting frees space without removing tombstones', t => {
  const root = workspace(t);
  for (let batch = 0; batch < 3; batch++) saveMemoryRecordCandidates(root, Array.from({ length: 40 }, (_, i) => candidate(`${batch}-${i}`, 'x'.repeat(16000))));
  const before = readMemoryRecords(root);
  assert.throws(() => saveMemoryRecordCandidates(root, Array.from({ length: 20 }, (_, i) => candidate(`overflow-${i}`, 'x'.repeat(16000)))), isCode('capacity'));
  assert.equal(readMemoryRecords(root).revision, before.revision);
  assert.throws(() => assertMemoryStorageWritable(root, { reserveBytes: 300000 }), isCode('capacity'));
  const forgotten = revokeMemoryRecord(root, before.records[0].id, before.revision);
  assert.equal(forgotten.records[0].status, 'revoked');
  assert.equal(saveMemoryRecordCandidate(root, candidate('after-forget', 'y'.repeat(16000))).result, 'saved');
  assert.equal(saveMemoryRecordCandidate(root, candidate('0-0', 'x'.repeat(16000))).result, 'blocked');
});

test('malformed storage reports corrupt and preflight never overwrites it', t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'memory'));
  const file = path.join(root, 'memory/records.md');
  fs.writeFileSync(file, '# My original notes');
  assert.throws(() => readMemoryRecords(root), isCode('corrupt'));
  assert.throws(() => assertMemoryStorageWritable(root), isCode('corrupt'));
  assert.throws(() => saveMemoryRecordCandidate(root, candidate('attempt')), isCode('corrupt'));
  assert.equal(fs.readFileSync(file, 'utf8'), '# My original notes');
  fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 1));
  assert.throws(() => readMemoryRecords(root), isCode('capacity'));
});

/** Pause a real child after fsync of staged bytes and immediately before atomic rename. */
async function stagedWriter(root: string, t: { after(fn: () => void): void }) {
  const script = `
    const fs = require('node:fs');
    const rename = fs.renameSync;
    fs.renameSync = (...args) => {
      process.send('staged');
      process.kill(process.pid, 'SIGSTOP');
      return rename(...args);
    };
    import(${JSON.stringify(path.resolve('src/lib/memory-records.ts'))}).then((module) => {
      const {saveMemoryRecordCandidate} = module.default || module;
      saveMemoryRecordCandidate(process.env.MEMORY_TEST_ROOT, {content:'second', source:{kind:'manual'}, idempotencyKey:'second'});
      process.exit(0);
    }).catch(error => { console.error(error); process.exit(1); });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
    env: { ...process.env, MEMORY_TEST_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(([code]) => { throw new Error(`Writer exited before staging: ${code}: ${stderr}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Writer did not stage within 10 seconds')), 10000); timer.unref(); }),
  ]);
  return child;
}

test('two live writers cannot overwrite each other and stale revision remains a conflict', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const root = workspace(t);
  const initial = saveMemoryRecordCandidate(root, candidate('first'));
  const writer = await stagedWriter(root, t);
  assert.throws(() => saveMemoryRecordCandidate(root, candidate('contender')), isCode('busy'));
  assert.equal(readMemoryRecords(root).revision, initial.revision, 'staged data is invisible before rename');
  const exit = once(writer, 'exit');
  writer.kill('SIGCONT');
  assert.equal((await exit)[0], 0);
  assert.throws(() => saveMemoryRecordCandidate(root, candidate('stale'), initial.revision), isCode('conflict'));
  assert.deepEqual(readMemoryRecords(root).records.map(record => record.content), ['first', 'second']);
});

test('a crash after staging preserves the old snapshot and a new writer recovers the dead lease', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const root = workspace(t);
  const initial = saveMemoryRecordCandidate(root, candidate('first'));
  const writer = await stagedWriter(root, t);
  const exit = once(writer, 'exit');
  writer.kill('SIGKILL');
  await exit;
  assert.equal(readMemoryRecords(root).revision, initial.revision);
  assert.equal(saveMemoryRecordCandidate(root, candidate('recovered'), initial.revision).result, 'saved');
  assert.deepEqual(readMemoryRecords(root).records.map(record => record.content), ['first', 'recovered']);
  assert.equal(fs.existsSync(path.join(root, 'memory/.records-lock')), false);
});

test('preflight detects unverifiable writer locks before model work without deleting them', t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'memory'));
  const lock = path.join(root, 'memory/.records-lock');
  fs.writeFileSync(lock, 'invalid lease');
  assert.throws(() => assertMemoryStorageWritable(root), isCode('busy'));
  assert.equal(fs.readFileSync(lock, 'utf8'), 'invalid lease');
});
