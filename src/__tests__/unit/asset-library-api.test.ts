import '../db-isolation.setup';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { NextRequest } from 'next/server';
import { createSession, getDb } from '@/lib/db';
import {
  addAssetReference,
  getAssetRecord,
  registerMediaGenerationAsset,
  releaseAssetReference,
} from '@/lib/assets/service';
import { GET as getKinds } from '@/app/api/assets/kinds/route';
import { POST as archiveHtml } from '@/app/api/assets/html-bundles/route';
import { GET as getGallery } from '@/app/api/media/gallery/route';
import { GET as getAssetDetail } from '@/app/api/assets/[id]/route';
import {
  GET as getHtmlThumbnail,
  POST as storeHtmlThumbnail,
} from '@/app/api/assets/[id]/thumbnail/route';
import {
  GET as getAssetTags,
  PUT as updateAssetTags,
} from '@/app/api/assets/[id]/tags/route';
import { DELETE as deleteMedia } from '@/app/api/media/[id]/route';
import { PUT as toggleFavorite } from '@/app/api/media/[id]/favorite/route';
import { getMediaDir } from '@/lib/media-saver';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-api-workspace-'));
const pageDir = path.join(workspace, 'site');
fs.mkdirSync(pageDir, { recursive: true });
fs.writeFileSync(
  path.join(pageDir, 'index.html'),
  '<!doctype html><html><head><title>API Archive Title</title></head><body><h1>API archive</h1></body></html>',
  'utf8',
);
const session = createSession(
  'Asset API',
  'test-model',
  '',
  workspace,
  'code',
  'test-provider',
);

after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function request(
  url: string,
  init?: ConstructorParameters<typeof NextRequest>[1],
): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

describe('Asset Library API', () => {
  let archivedAssetId = '';

  it('exposes only registered kinds', async () => {
    const response = await getKinds();
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(
      data.kinds.map((kind: { id: string }) => kind.id),
      ['image', 'video', 'audio', 'html_bundle'],
    );
    assert.equal(
      data.kinds.some((kind: { id: string }) => kind.id === 'component'),
      false,
    );
  });

  it('archives a workspace HTML bundle using session-derived scope and provenance', async () => {
    const response = await archiveHtml(request('/api/assets/html-bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.id,
        source: 'workspace',
        filePath: path.join(pageDir, 'index.html'),
        prompt: 'API-created archive',
      }),
    }));
    assert.equal(response.status, 200);
    const data = await response.json();
    archivedAssetId = data.asset.id;
    const asset = getAssetRecord(archivedAssetId)!;
    assert.equal(asset.project_id, path.basename(workspace));
    assert.equal(asset.provider_id, 'test-provider');
    assert.equal(asset.model_id, 'test-model');
    assert.equal(asset.session_id, session.id);
  });

  it('rejects a workspace path that the session does not own', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-api-outside-'));
    fs.writeFileSync(path.join(outside, 'index.html'), '<h1>outside</h1>');
    const response = await archiveHtml(request('/api/assets/html-bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.id,
        source: 'workspace',
        filePath: path.join(outside, 'index.html'),
      }),
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'materialization_failed');
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('orders the Gallery stably by Asset creation time and then id', async () => {
    fs.writeFileSync(
      path.join(pageDir, 'older.html'),
      '<!doctype html><title>Older archive</title>',
      'utf8',
    );
    fs.writeFileSync(
      path.join(pageDir, 'newer.html'),
      '<!doctype html><title>Newer archive</title>',
      'utf8',
    );
    const archive = async (fileName: string) => {
      const response = await archiveHtml(request('/api/assets/html-bundles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.id,
          source: 'workspace',
          filePath: path.join(pageDir, fileName),
        }),
      }));
      assert.equal(response.status, 200);
      return (await response.json()).asset.id as string;
    };
    const olderId = await archive('older.html');
    const newerId = await archive('newer.html');
    getDb().prepare(
      `UPDATE asset_records
       SET created_at = CASE id
         WHEN ? THEN '2026-01-01T00:00:00.000Z'
         WHEN ? THEN '2026-01-02T00:00:00.000Z'
         WHEN ? THEN '2026-01-03T00:00:00.000Z'
       END
       WHERE id IN (?, ?, ?)`,
    ).run(
      olderId,
      archivedAssetId,
      newerId,
      olderId,
      archivedAssetId,
      newerId,
    );

    const newest = await getGallery(request(
      '/api/media/gallery?kind=html_bundle&sort=newest',
    ));
    assert.deepEqual(
      (await newest.json()).items.map((item: { id: string }) => item.id),
      [newerId, archivedAssetId, olderId],
    );
    const oldest = await getGallery(request(
      '/api/media/gallery?kind=html_bundle&sort=oldest',
    ));
    assert.deepEqual(
      (await oldest.json()).items.map((item: { id: string }) => item.id),
      [olderId, archivedAssetId, newerId],
    );

    for (const id of [olderId, newerId]) {
      const deleted = await deleteMedia(
        request(`/api/media/${id}`, { method: 'DELETE' }),
        { params: Promise.resolve({ id }) },
      );
      assert.equal(deleted.status, 200);
    }
  });

  it('lists registry-backed Assets and returns strict HTML preview metadata', async () => {
    const gallery = await getGallery(request(
      '/api/media/gallery?kind=html_bundle&query=API%20Archive%20Title',
    ));
    assert.equal(gallery.status, 200);
    const galleryData = await gallery.json();
    assert.equal(galleryData.total, 1);
    assert.equal(galleryData.items[0].id, archivedAssetId);
    assert.equal(galleryData.items[0].type, 'html_bundle');
    assert.equal(galleryData.items[0].title, 'API Archive Title');
    assert.match(
      galleryData.items[0].previewUrl,
      /^\/api\/files\/html-preview\/ws\./,
    );
    assert.equal(galleryData.items[0].previewUrl.includes('interactive=1'), false);
    assert.equal(galleryData.items[0].thumbnailUrl, undefined);

    const detail = await getAssetDetail(
      request(`/api/assets/${archivedAssetId}`),
      { params: Promise.resolve({ id: archivedAssetId }) },
    );
    assert.equal(detail.status, 200);
    const detailData = await detail.json();
    assert.equal(detailData.typedRef.assetId, archivedAssetId);
    assert.deepEqual(detailData.consumers, []);

    const invalidKind = await getGallery(request(
      '/api/media/gallery?kind=component',
    ));
    assert.equal(invalidKind.status, 400);
    assert.equal((await invalidKind.json()).code, 'kind_unregistered');
  });

  it('stores and serves one bounded static PNG thumbnail for an HTML Asset', async () => {
    const rejected = await storeHtmlThumbnail(
      request(`/api/assets/${archivedAssetId}/thumbnail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pngBase64: Buffer.from('not a png').toString('base64'),
        }),
      }),
      { params: Promise.resolve({ id: archivedAssetId }) },
    );
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, 'thumbnail_invalid');

    const png = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 4,
        background: { r: 20, g: 30, b: 40, alpha: 1 },
      },
    }).png().toBuffer();
    const stored = await storeHtmlThumbnail(
      request(`/api/assets/${archivedAssetId}/thumbnail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pngBase64: png.toString('base64') }),
      }),
      { params: Promise.resolve({ id: archivedAssetId }) },
    );
    assert.equal(stored.status, 200);
    assert.equal(
      (await stored.json()).thumbnailUrl,
      `/api/assets/${archivedAssetId}/thumbnail`,
    );
    const asset = getAssetRecord(archivedAssetId)!;
    assert.equal(asset.width, 1280);
    assert.equal(asset.height, 720);
    assert.equal(path.basename(asset.preview_path), 'preview.png');
    assert.equal(fs.existsSync(asset.preview_path), true);

    const served = await getHtmlThumbnail(
      request(`/api/assets/${archivedAssetId}/thumbnail`),
      { params: Promise.resolve({ id: archivedAssetId }) },
    );
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);

    const gallery = await getGallery(request(
      '/api/media/gallery?kind=html_bundle&query=API%20Archive%20Title',
    ));
    const galleryData = await gallery.json();
    assert.equal(
      galleryData.items[0].thumbnailUrl,
      `/api/assets/${archivedAssetId}/thumbnail`,
    );
  });

  it('favorites HTML Assets through the existing Gallery action', async () => {
    const response = await toggleFavorite(
      request(`/api/media/${archivedAssetId}/favorite`, { method: 'PUT' }),
      { params: Promise.resolve({ id: archivedAssetId }) },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).favorited, 1);
    assert.equal(getAssetRecord(archivedAssetId)?.curation_state, 'selected');
  });

  it('persists bounded tags for every Asset kind and makes them searchable', async () => {
    const updated = await updateAssetTags(
      request(`/api/assets/${archivedAssetId}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: ['网页', '灵感', '网页'] }),
      }),
      { params: Promise.resolve({ id: archivedAssetId }) },
    );
    assert.equal(updated.status, 200);
    assert.deepEqual((await updated.json()).tags, ['网页', '灵感']);
    assert.deepEqual(
      JSON.parse(getAssetRecord(archivedAssetId)!.tags),
      ['网页', '灵感'],
    );

    const read = await getAssetTags(
      request(`/api/assets/${archivedAssetId}/tags`),
      { params: Promise.resolve({ id: archivedAssetId }) },
    );
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json()).tags, ['网页', '灵感']);

    const searched = await getGallery(request(
      `/api/media/gallery?query=${encodeURIComponent('灵感')}`,
    ));
    assert.equal(searched.status, 200);
    assert.equal(
      (await searched.json()).items.some(
        (item: { id: string }) => item.id === archivedAssetId,
      ),
      true,
    );
    const filtered = await getGallery(request(
      `/api/media/gallery?tags=${encodeURIComponent('网页')}`,
    ));
    assert.equal(filtered.status, 200);
    assert.equal(
      (await filtered.json()).items.some(
        (item: { id: string }) => item.id === archivedAssetId,
      ),
      true,
    );

    const rejected = await updateAssetTags(
      request(`/api/assets/${archivedAssetId}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: ['x'.repeat(33)] }),
      }),
      { params: Promise.resolve({ id: archivedAssetId }) },
    );
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, 'tags_invalid');
    assert.deepEqual(
      JSON.parse(getAssetRecord(archivedAssetId)!.tags),
      ['网页', '灵感'],
    );
  });

  it('rejects tag writes to trashed Assets through the canonical tag route', async () => {
    const mediaDir = getMediaDir();
    fs.mkdirSync(mediaDir, { recursive: true });
    const localPath = path.join(mediaDir, 'trashed-tag-route.png');
    fs.writeFileSync(localPath, Buffer.from('trashed tag bytes'));
    getDb().prepare(
      `INSERT INTO media_generations (
         id, type, status, provider, model, prompt, local_path,
         thumbnail_path, tags, metadata, created_at, completed_at
       ) VALUES (
         'trashed-tag-route', 'image', 'completed', 'test', 'test',
         'trashed tags', ?, '', '[]', '{"mimeType":"image/png"}',
         datetime('now'), datetime('now')
       )`,
    ).run(localPath);
    registerMediaGenerationAsset({
      mediaGenerationId: 'trashed-tag-route',
      producerId: 'legacy-media-backfill',
    });
    getDb().prepare(
      `UPDATE asset_records
       SET lifecycle_state = 'trashed', deleted_at = datetime('now')
       WHERE id = 'trashed-tag-route'`,
    ).run();

    const body = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['should-not-land'] }),
    } as const;
    const canonical = await updateAssetTags(
      request('/api/assets/trashed-tag-route/tags', body),
      { params: Promise.resolve({ id: 'trashed-tag-route' }) },
    );
    assert.equal(canonical.status, 409);
    assert.equal((await canonical.json()).code, 'asset_not_active');
    assert.equal(
      (getDb().prepare(
        'SELECT tags FROM media_generations WHERE id = ?',
      ).get('trashed-tag-route') as { tags: string }).tags,
      '[]',
    );

    getDb().prepare(
      `UPDATE asset_records SET lifecycle_state = 'active', deleted_at = NULL
       WHERE id = 'trashed-tag-route'`,
    ).run();
    const deleted = await deleteMedia(
      request('/api/media/trashed-tag-route', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'trashed-tag-route' }) },
    );
    assert.equal(deleted.status, 200);
  });

  it('keeps a legacy row listable when its file disappears before realpath', async () => {
    const missingPath = path.join(getMediaDir(), 'legacy-realpath-race.png');
    fs.rmSync(missingPath, { force: true });
    getDb().prepare(
      `INSERT INTO media_generations (
         id, type, status, provider, model, prompt, local_path,
         thumbnail_path, tags, metadata, error, created_at
       ) VALUES (
         'legacy-realpath-race', 'image', 'completed', 'legacy', '',
         'legacy realpath race', ?, '', '[]',
         '{"mimeType":"image/png"}', NULL, datetime('now')
       )`,
    ).run(missingPath);
    getDb().prepare(
      `INSERT INTO asset_backfill_failures (
         source_table, source_id, failure_revision, error
       ) VALUES (
         'media_generations', 'legacy-realpath-race', 'media-assets-v2',
         'permanent:test keeps the row on the legacy read path'
       )`,
    ).run();

    try {
      const response = await getGallery(request(
        '/api/media/gallery?query=legacy%20realpath%20race',
      ));
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.total, 1);
      assert.equal(data.items[0].integrityState, 'missing');
      assert.equal(data.items[0].legacyOnly, true);
    } finally {
      getDb().prepare(
        'DELETE FROM asset_backfill_failures WHERE source_id = ?',
      ).run('legacy-realpath-race');
      getDb().prepare(
        'DELETE FROM media_generations WHERE id = ?',
      ).run('legacy-realpath-race');
    }
  });

  it('keeps old media rows available during the additive migration', () => {
    const asset = getAssetRecord(archivedAssetId)!;
    assert.equal(asset.source_media_generation_id, null);
    assert.equal(
      (getDb().prepare(
        'SELECT COUNT(*) AS count FROM media_generations',
      ).get() as { count: number }).count,
      0,
    );
  });

  it('keeps failed ID-only legacy rows visible, taggable, searchable, and permanently deletable', async () => {
    const mediaDir = getMediaDir();
    fs.mkdirSync(mediaDir, { recursive: true });
    const legacyPath = path.join(mediaDir, 'legacy-failed-id-only.png');
    fs.writeFileSync(legacyPath, Buffer.from('legacy failed bytes'));
    getDb().prepare(
      `INSERT INTO media_generations (
         id, type, status, provider, model, prompt, local_path,
         thumbnail_path, tags, metadata, error, created_at
       ) VALUES (
         'legacy-failed-id-only', 'image', 'failed', 'codex', '', '', ?,
         '', '[]', '{"mimeType":"image/png"}', 'generation failed',
         '2026-07-30 00:00:00'
       )`,
    ).run(legacyPath);

    const listed = await getGallery(request(
      '/api/media/gallery?query=legacy-failed-id-only',
    ));
    assert.equal(listed.status, 200);
    const listedData = await listed.json();
    assert.equal(listedData.total, 1);
    assert.equal(listedData.items[0].id, 'legacy-failed-id-only');
    assert.equal(listedData.items[0].title, 'legacy-failed-id-only');
    assert.equal(listedData.items[0].legacyOnly, true);
    assert.equal(listedData.items[0].generationStatus, 'failed');
    assert.deepEqual(listedData.items[0].images, []);

    const tagged = await updateAssetTags(
      request('/api/assets/legacy-failed-id-only/tags', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: ['待整理', '待整理'] }),
      }),
      { params: Promise.resolve({ id: 'legacy-failed-id-only' }) },
    );
    assert.equal(tagged.status, 200);
    assert.deepEqual((await tagged.json()).tags, ['待整理']);
    const searched = await getGallery(request(
      `/api/media/gallery?tags=${encodeURIComponent('待整理')}`,
    ));
    assert.equal(
      (await searched.json()).items.some(
        (item: { id: string }) => item.id === 'legacy-failed-id-only',
      ),
      true,
    );

    const deleted = await deleteMedia(
      request('/api/media/legacy-failed-id-only', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'legacy-failed-id-only' }) },
    );
    assert.equal(deleted.status, 200);
    const deletedData = await deleted.json();
    assert.equal(deletedData.permanent, true);
    assert.equal(deletedData.fileDeleted, true);
    assert.equal(fs.existsSync(legacyPath), false);
    assert.equal(getDb().prepare(
      'SELECT id FROM media_generations WHERE id = ?',
    ).get('legacy-failed-id-only'), undefined);
  });

  it('removes an external legacy record without deleting the external file', async () => {
    const externalPath = path.join(workspace, 'legacy-external.png');
    fs.writeFileSync(externalPath, Buffer.from('external legacy bytes'));
    getDb().prepare(
      `INSERT INTO media_generations (
         id, type, status, provider, model, prompt, local_path,
         thumbnail_path, tags, metadata, created_at, completed_at
       ) VALUES (
         'legacy-external-record', 'image', 'completed', 'codex', '',
         'external legacy record', ?, '', '[]',
         '{"mimeType":"image/png"}', '2026-07-29 00:00:00',
         '2026-07-29 00:00:00'
       )`,
    ).run(externalPath);

    const listed = await getGallery(request(
      '/api/media/gallery?query=external%20legacy%20record',
    ));
    assert.equal(listed.status, 200);
    const listedData = await listed.json();
    assert.equal(listedData.total, 1);
    assert.equal(listedData.items[0].legacyOnly, true);
    assert.deepEqual(listedData.items[0].images, []);

    const deleted = await deleteMedia(
      request('/api/media/legacy-external-record', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'legacy-external-record' }) },
    );
    assert.equal(deleted.status, 200);
    const deletedData = await deleted.json();
    assert.equal(deletedData.fileDeleted, false);
    assert.deepEqual(deletedData.retainedExternalPaths, [
      path.resolve(externalPath),
    ]);
    assert.equal(fs.existsSync(externalPath), true);
    assert.equal(getDb().prepare(
      'SELECT id FROM media_generations WHERE id = ?',
    ).get('legacy-external-record'), undefined);
  });

  it('does not render a legacy HTML file as a broken image tile', async () => {
    const legacyHtml = path.join(workspace, 'legacy-image.html');
    fs.writeFileSync(legacyHtml, '<!doctype html><title>Not an image</title>');
    getDb().prepare(
      `INSERT INTO asset_records (
         id, kind, producer_id, stable_path, content_hash, mime_type,
         byte_size, prompt, metadata, materialization_key
       ) VALUES (
         'legacy-html-image', 'image', 'media:legacy-backfill', ?,
         'fixture-hash', 'image/png', ?, 'mime mismatch fixture', '{}',
         'legacy:mime-mismatch'
       )`,
    ).run(
      legacyHtml,
      fs.statSync(legacyHtml).size,
    );
    const gallery = await getGallery(request(
      '/api/media/gallery?kind=image&query=mime%20mismatch',
    ));
    assert.equal(gallery.status, 200);
    const data = await gallery.json();
    assert.equal(data.total, 1);
    assert.deepEqual(data.items[0].images, []);
  });

  it('blocks permanent deletion while referenced, then removes the record and owned bytes', async () => {
    addAssetReference({
      assetId: archivedAssetId,
      consumerType: 'harness_manifest',
      consumerId: 'harness:api-test',
    });
    const blocked = await deleteMedia(
      request(`/api/media/${archivedAssetId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: archivedAssetId }) },
    );
    assert.equal(blocked.status, 409);
    const blockedData = await blocked.json();
    assert.equal(blockedData.code, 'asset_in_use');
    assert.equal(blockedData.consumers.length, 1);

    releaseAssetReference({
      assetId: archivedAssetId,
      consumerType: 'harness_manifest',
      consumerId: 'harness:api-test',
    });
    const stablePath = getAssetRecord(archivedAssetId)!.stable_path;
    const assetRoot = path.dirname(path.dirname(stablePath));
    const deleted = await deleteMedia(
      request(`/api/media/${archivedAssetId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: archivedAssetId }) },
    );
    assert.equal(deleted.status, 200);
    const deletedData = await deleted.json();
    assert.equal(deletedData.permanent, true);
    assert.equal(deletedData.recoverable, false);
    assert.equal(deletedData.fileDeleted, true);
    assert.equal(fs.existsSync(stablePath), false);
    assert.equal(fs.existsSync(assetRoot), false);
    assert.equal(getAssetRecord(archivedAssetId), undefined);

    const activeGallery = await getGallery(request(
      '/api/media/gallery?kind=html_bundle',
    ));
    assert.equal((await activeGallery.json()).total, 0);
  });
});
