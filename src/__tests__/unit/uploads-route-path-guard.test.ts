/**
 * /api/uploads path guard: only files whose real path stays inside an
 * allowed `.codepilot-*` directory segment may be served.
 *
 * Run: CODEX_DISABLED=1 npx tsx --test src/__tests__/unit/uploads-route-path-guard.test.ts
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { GET } from '../../app/api/uploads/route';

const testRoot = path.join(os.tmpdir(), 'codepilot-uploads-route-' + randomUUID());
const uploadsDir = path.join(testRoot, 'proj', '.codepilot-uploads');
const siblingDir = path.join(testRoot, 'proj', '.codepilot-uploads-evil');
const outsideDir = path.join(testRoot, 'outside');

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(siblingDir, { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });
fs.writeFileSync(path.join(uploadsDir, 'note.txt'), 'ok');
fs.writeFileSync(path.join(siblingDir, 'secret.txt'), 'sibling-secret');
fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside-secret');
fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(uploadsDir, 'link.txt'));

after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

async function call(filePath: string): Promise<Response> {
  const url = new URL('http://localhost/api/uploads');
  url.searchParams.set('path', filePath);
  return GET(new NextRequest(url.toString()));
}

describe('/api/uploads path guard', () => {
  it('serves a regular file inside .codepilot-uploads', async () => {
    const res = await call(path.join(uploadsDir, 'note.txt'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });

  it('rejects a sibling directory whose name only starts with .codepilot-uploads', async () => {
    const res = await call(path.join(siblingDir, 'secret.txt'));
    assert.equal(res.status, 403);
  });

  it('rejects ".." escapes out of the uploads directory', async () => {
    const res = await call(`${uploadsDir}${path.sep}..${path.sep}..${path.sep}outside${path.sep}secret.txt`);
    assert.equal(res.status, 403);
  });

  it('rejects a symlink inside uploads that points outside', async () => {
    const res = await call(path.join(uploadsDir, 'link.txt'));
    assert.equal(res.status, 403);
  });

  it('rejects requesting the allowed directory itself as a file', async () => {
    const res = await call(uploadsDir);
    assert.equal(res.status, 403);
  });

  it('returns 404 for a missing file inside an allowed directory', async () => {
    const res = await call(path.join(uploadsDir, 'missing.txt'));
    assert.equal(res.status, 404);
  });
});
