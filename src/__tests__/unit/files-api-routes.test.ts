/**
 * Route-level security tests for file tree and preview APIs.
 *
 * Run with: npx tsx src/__tests__/unit/files-api-routes.test.ts
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

import { GET as getFilesRoute } from '../../app/api/files/route';
import { GET as getPreviewRoute } from '../../app/api/files/preview/route';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-files-api-'));
const projectDir = path.join(tmpDir, 'project');
const sourceDir = path.join(projectDir, 'src');
const insideFile = path.join(sourceDir, 'index.ts');
const outsideDir = path.join(tmpDir, 'outside');
const outsideFile = path.join(outsideDir, 'secret.txt');

fs.mkdirSync(sourceDir, { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });
fs.writeFileSync(insideFile, 'export const answer = 42;\n');
fs.writeFileSync(outsideFile, 'TOP SECRET\n');

function request(url: string): NextRequest {
  return new NextRequest(url);
}

describe('/api/files route', () => {
  it('rejects relative dir when baseDir is not provided', async () => {
    const res = await getFilesRoute(request('http://localhost/api/files?dir=..'));
    const body = await res.json();

    assert.equal(res.status, 400);
    assert.equal(body.error, 'Directory must be an absolute path');
  });

  it('allows absolute dir when baseDir is not provided', async () => {
    const params = new URLSearchParams({ dir: projectDir, depth: '2' });
    const res = await getFilesRoute(request(`http://localhost/api/files?${params.toString()}`));
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.root, path.resolve(projectDir));
    assert.ok(Array.isArray(body.tree));
  });

  it('rejects dir outside project scope when baseDir is provided', async () => {
    const params = new URLSearchParams({ dir: outsideDir, baseDir: projectDir });
    const res = await getFilesRoute(request(`http://localhost/api/files?${params.toString()}`));
    const body = await res.json();

    assert.equal(res.status, 403);
    assert.equal(body.error, 'Directory is outside the project scope');
  });
});

describe('/api/files/preview route', () => {
  it('rejects relative path when baseDir is not provided', async () => {
    const res = await getPreviewRoute(request('http://localhost/api/files/preview?path=relative.ts'));
    const body = await res.json();

    assert.equal(res.status, 400);
    assert.equal(body.error, 'File path must be absolute');
  });

  it('allows absolute path when baseDir is not provided', async () => {
    const params = new URLSearchParams({ path: insideFile, maxLines: '10' });
    const res = await getPreviewRoute(request(`http://localhost/api/files/preview?${params.toString()}`));
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.preview.path, path.resolve(insideFile));
    assert.match(body.preview.content, /answer = 42/);
  });

  it('rejects file outside project scope when baseDir is provided', async () => {
    const params = new URLSearchParams({ path: outsideFile, baseDir: projectDir });
    const res = await getPreviewRoute(request(`http://localhost/api/files/preview?${params.toString()}`));
    const body = await res.json();

    assert.equal(res.status, 403);
    assert.equal(body.error, 'File is outside the project scope');
  });
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
