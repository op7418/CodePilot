import '../db-isolation.setup';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryMutationTools, createMemoryQueryService } from '@/lib/memory-service';
import { createSession, getDb, setSetting } from '@/lib/db';
import { canWriteSessionMemory, bindAssistantMemory } from '@/lib/memory-binding';
import { readMemoryRecords, saveMemoryRecordCandidate } from '@/lib/memory-records';
import { searchWorkspaceSnapshot } from '@/lib/workspace-retrieval';
import type { ManifestEntry } from '@/types';

const roots: string[] = [];
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-security-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('reads every character of a long single-line source and managed projection through continuation', () => {
  const root = fixture();
  const text = '前文'.repeat(3200) + 'TAIL_IS_REACHABLE';
  fs.writeFileSync(path.join(root, 'long.md'), text);
  const saved = saveMemoryRecordCandidate(root, { content: text, source: { kind: 'manual' }, idempotencyKey: 'long' });
  const query = createMemoryQueryService(root);
  for (const file_path of ['long.md', `memory/records/${saved.records[0].id}.md`]) {
    let actual = '';
    let char_start = 0;
    do {
      const response = query.get({ file_path, line_start: 1, line_end: 1, char_start });
      const body = response.slice(response.indexOf('\n') + 1);
      const match = /\n\[\.\.\.truncated; next_char_start=(\d+);.*\]$/.exec(body);
      actual += match ? body.slice(0, match.index) : body;
      if (!match) break;
      assert.ok(Number(match[1]) > char_start);
      char_start = Number(match[1]);
    } while (char_start <= text.length);
    assert.equal(actual, text);
  }
  assert.match(query.get({ file_path: 'long.md', char_start: -1 }), /Memory read failed/);
});

it('reports partial search when the aggregate document limit is reached while managed records stay available', () => {
  const root = fixture();
  for (let i = 0; i < 514; i++) fs.writeFileSync(path.join(root, `${i}.md`), 'plain note');
  saveMemoryRecordCandidate(root, { content: 'cobalt preference', source: { kind: 'manual' }, idempotencyKey: 'managed' });
  const query = createMemoryQueryService(root);
  assert.match(query.search({ query: 'absentword' }), /Partial search:.*file or byte limit/);
  assert.match(query.search({ query: 'cobalt' }), /memory\/records\//);
});

it('caps aggregate source bytes and reports the partial result', () => {
  const root = fixture();
  for (let i = 0; i < 33; i++) fs.writeFileSync(path.join(root, `${i}.md`), 'a'.repeat(270000));
  assert.match(createMemoryQueryService(root).search({ query: 'absentword' }), /Partial search:.*byte limit/);
});

it('filters normalized internal and escaping paths from previously persisted index entries', () => {
  const paths = ['./memory/records.md', 'memory/temp/../records.md', 'memory/.records-lock', 'notes/.assistant/jobs.md', '.git/private.md', '../outside.md', 'C:\\private.md'];
  const manifest = paths.map((value, i): ManifestEntry => ({
    noteId: String(i), path: value, title: 'hiddenmarker', summary: 'hiddenmarker', tags: [], aliases: [], headings: [],
    mtime: 0, size: 0, hash: '', categoryIds: [],
  }));
  assert.deepEqual(searchWorkspaceSnapshot(manifest, [], 'hiddenmarker'), []);
});

it('enforces read access in the core even when a caller directly invokes a mutation definition', async () => {
  const root = fixture();
  const tools = createMemoryMutationTools(root, { access: 'read', sourceSessionId: 'test' });
  const response = JSON.parse(await tools.codepilot_memory_remember.execute({ content: 'must not save' }));
  assert.equal(response.type, 'memory_write_error');
  assert.equal(readMemoryRecords(root).records.length, 0);
});

it('rechecks session Plan mode and workspace scope at every mutation, after factory creation', async () => {
  const root = fixture();
  const other = fixture();
  setSetting('assistant_workspace_path', root);
  const session = createSession('permission review', '', '', root, 'code');
  assert.equal(canWriteSessionMemory(session.id, root), false, 'same cwd alone cannot authorize writes');
  bindAssistantMemory(session.id);
  const tools = createMemoryMutationTools(root, {
    sourceSessionId: session.id, authorizeWrite: () => canWriteSessionMemory(session.id, root),
  });
  const first = JSON.parse(await tools.codepilot_memory_remember.execute({ content: 'initial preference' }));
  assert.equal(first.status, 'saved');
  getDb().prepare('UPDATE chat_sessions SET mode = ? WHERE id = ?').run('plan', session.id);
  assert.equal(JSON.parse(await tools.codepilot_memory_forget.execute({ id: first.recordId, expected_revision: first.revision })).type, 'memory_write_error');
  getDb().prepare('UPDATE chat_sessions SET mode = ?, working_directory = ? WHERE id = ?').run('code', other, session.id);
  assert.equal(JSON.parse(await tools.codepilot_memory_update.execute({ id: first.recordId, content: 'unauthorized', expected_revision: first.revision })).type, 'memory_write_error');
  assert.equal(readMemoryRecords(root).records[0].content, 'initial preference');
  assert.equal(readMemoryRecords(other).records.length, 0);
});
