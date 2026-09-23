import { getDb } from '@/lib/db';
import type { MediaBlock } from '@/types';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { registerMediaGenerationAsset } from '@/lib/assets/service';
import { resolveCodePilotDataDir } from '@/lib/codepilot-data-dir';
import { MediaUserActionError } from '@/lib/media-error';

/**
 * Resolve `<dataDir>/.codepilot-media` PER-CALL so test setups that
 * override `CLAUDE_GUI_DATA_DIR` after module load still see the
 * redirected path. Pre-fix this was a module-level const captured at
 * import time, so any test that imported `@/lib/media-saver` before
 * setting the env var ended up writing into the real
 * `~/.codepilot/.codepilot-media`. The `/api/media/serve` route uses
 * the same per-call pattern.
 */
export function getMediaDir(): string {
  return path.join(resolveCodePilotDataDir(), '.codepilot-media');
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/x-matroska': '.mkv',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'audio/aac': '.aac',
};

const EXT_TO_MIME: Record<string, string> = {};
for (const [mime, ext] of Object.entries(MIME_TO_EXT)) {
  EXT_TO_MIME[ext] = mime;
}

export interface SaveMediaOptions {
  sessionId?: string;
  source?: string;   // e.g. 'mcp', 'jimeng-cli'
  prompt?: string;    // description / title
  tags?: string[];
  model?: string;     // e.g. 'seedance-2.0', 'gemini-3.1-flash-image-preview'
  aspectRatio?: string; // e.g. '1:1', '16:9'
  imageSize?: string; // e.g. '1K', '2K', '4096x4096'
  producerId?: string;
  runtimeId?: string;
  methodRef?: string;
  parentAssetIds?: string[];
}

export interface SaveMediaResult {
  localPath: string;
  mediaId: string;
  assetId: string;
}

function ensureMediaDir(): string {
  const mediaDir = getMediaDir();
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }
  return mediaDir;
}

function resolveSourcePath(
  filePath: string,
  cwd?: string,
): string {
  return path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(cwd || process.cwd(), filePath);
}

function contentDigest(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const file = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let offset = 0;
    while (true) {
      const bytesRead = fs.readSync(file, buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(file);
  }
  return hash.digest('hex');
}

export function findReusableImportedFile(
  filePath: string,
  opts: {
    sessionId?: string;
    source?: string;
    cwd?: string;
  } = {},
): SaveMediaResult | undefined {
  const resolved = resolveSourcePath(filePath, opts.cwd);
  if (!fs.existsSync(resolved)) return undefined;
  const rows = getDb().prepare(
    `SELECT id, local_path
     FROM media_generations
     WHERE status = 'completed'
       AND provider = ?
       AND COALESCE(session_id, '') = ?
       AND (
         local_path = ?
         OR (
           json_valid(metadata)
           AND json_extract(metadata, '$.originalPath') IN (?, ?)
         )
       )
     ORDER BY created_at DESC`,
  ).all(
    opts.source || 'cli-import',
    opts.sessionId || '',
    resolved,
    resolved,
    filePath,
  ) as Array<{ id: string; local_path: string }>;
  if (rows.length === 0) return undefined;

  const sourceStat = fs.statSync(resolved);
  let sourceHash: string | undefined;
  for (const row of rows) {
    if (!row.local_path || !fs.existsSync(row.local_path)) continue;
    const destinationStat = fs.statSync(row.local_path);
    if (
      !sourceStat.isFile()
      || !destinationStat.isFile()
      || sourceStat.size !== destinationStat.size
    ) {
      continue;
    }
    sourceHash ??= contentDigest(resolved);
    if (contentDigest(row.local_path) !== sourceHash) continue;
    return {
      localPath: row.local_path,
      mediaId: row.id,
      assetId: row.id,
    };
  }
  return undefined;
}

export function stageFileForMediaPreview(
  filePath: string,
  opts: { mimeType: string; cwd?: string },
): { localPath: string } {
  const resolved = resolveSourcePath(filePath, opts.cwd);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new MediaUserActionError('MEDIA_SOURCE_NOT_FOUND', `File not found: ${resolved}`);
  }
  const mediaDir = ensureMediaDir();
  if (
    resolved === path.resolve(mediaDir)
    || resolved.startsWith(`${path.resolve(mediaDir)}${path.sep}`)
  ) {
    return { localPath: resolved };
  }
  const previewDir = path.join(mediaDir, '.previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const sourceExtension = path.extname(resolved).toLowerCase();
  const extension = EXT_TO_MIME[sourceExtension]
    ? sourceExtension
    : MIME_TO_EXT[opts.mimeType] || '.bin';
  const destination = path.join(
    previewDir,
    `${contentDigest(resolved)}${extension}`,
  );
  if (!fs.existsSync(destination)) {
    try {
      fs.copyFileSync(resolved, destination, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      // Two concurrent imageView events may compute the same content-addressed
      // preview path. The winner wrote the exact bytes we wanted; every other
      // failure still propagates.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return { localPath: destination };
}

function mimeToMediaType(mimeType: string): 'image' | 'video' | 'audio' {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'image';
}

function insertDbRecord(opts: {
  id: string;
  type: string;
  provider: string;
  prompt: string;
  localPath: string;
  sessionId?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  producerId: string;
  runtimeId?: string;
  methodRef?: string;
  parentAssetIds?: readonly string[];
}) {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.transaction(() => {
    db.prepare(
      `INSERT INTO media_generations (id, type, status, provider, model, prompt, aspect_ratio, image_size, local_path, thumbnail_path, session_id, message_id, tags, metadata, error, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      opts.id, opts.type, 'completed', opts.provider, opts.model || '',
      opts.prompt, opts.aspectRatio || '', opts.imageSize || '', opts.localPath, '',
      opts.sessionId || null, null,
      JSON.stringify(opts.tags), JSON.stringify(opts.metadata),
      null, now, now
    );
    registerMediaGenerationAsset({
      mediaGenerationId: opts.id,
      producerId: opts.producerId,
      runtimeId: opts.runtimeId,
      methodRef: opts.methodRef,
      parentAssetIds: opts.parentAssetIds,
    });
  })();
}

/**
 * Save a base64-encoded media block (from MCP tool result) to the library.
 * Writes file to ~/.codepilot/.codepilot-media/ and creates a DB record.
 */
export function saveMediaToLibrary(block: MediaBlock, opts: SaveMediaOptions = {}): SaveMediaResult {
  const mediaDir = ensureMediaDir();

  const ext = MIME_TO_EXT[block.mimeType] || '.bin';
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const localPath = path.join(mediaDir, filename);

  if (!block.data) {
    throw new Error('Base64 media block is missing data.');
  }
  const buffer = Buffer.from(block.data, 'base64');
  fs.writeFileSync(localPath, buffer);

  const id = crypto.randomBytes(16).toString('hex');
  try {
    insertDbRecord({
      id,
      type: mimeToMediaType(block.mimeType),
      provider: opts.source || 'mcp',
      prompt: opts.prompt || '',
      localPath,
      sessionId: opts.sessionId,
      tags: opts.tags || [],
      metadata: {
        mimeType: block.mimeType,
        source: opts.source || 'mcp',
        runtimeId: opts.runtimeId || '',
        methodRef: opts.methodRef || '',
      },
      model: opts.model,
      aspectRatio: opts.aspectRatio,
      imageSize: opts.imageSize,
      producerId: opts.producerId || 'media-saver:base64',
      runtimeId: opts.runtimeId,
      methodRef: opts.methodRef,
      parentAssetIds: opts.parentAssetIds,
    });
  } catch (error) {
    try { fs.unlinkSync(localPath); } catch { /* best effort rollback */ }
    throw error;
  }

  return { localPath, mediaId: id, assetId: id };
}

/**
 * Import an existing local file to the library (for CLI tool output).
 * Copies file to ~/.codepilot/.codepilot-media/ and creates a DB record.
 */
export function importFileToLibrary(
  filePath: string,
  opts: SaveMediaOptions & { mimeType?: string; cwd?: string } = {}
): SaveMediaResult {
  const mediaDir = ensureMediaDir();

  // Resolve relative paths against the provided cwd (session working directory),
  // not the app process cwd which is typically the project root.
  const resolved = resolveSourcePath(filePath, opts.cwd);
  if (!fs.existsSync(resolved)) {
    throw new MediaUserActionError('MEDIA_SOURCE_NOT_FOUND', `File not found: ${resolved}`);
  }

  const ext = path.extname(resolved).toLowerCase();
  const mimeType = opts.mimeType || EXT_TO_MIME[ext] || 'application/octet-stream';
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const destPath = path.join(mediaDir, filename);

  fs.copyFileSync(resolved, destPath);

  const id = crypto.randomBytes(16).toString('hex');
  try {
    insertDbRecord({
      id,
      type: mimeToMediaType(mimeType),
      provider: opts.source || 'cli-import',
      prompt: opts.prompt || path.basename(filePath),
      localPath: destPath,
      sessionId: opts.sessionId,
      tags: opts.tags || [],
      metadata: {
        mimeType,
        source: opts.source || 'cli-import',
        originalPath: resolved,
        runtimeId: opts.runtimeId || '',
        methodRef: opts.methodRef || '',
      },
      model: opts.model,
      aspectRatio: opts.aspectRatio,
      imageSize: opts.imageSize,
      producerId: opts.producerId || 'media-saver:file-import',
      runtimeId: opts.runtimeId,
      methodRef: opts.methodRef,
      parentAssetIds: opts.parentAssetIds,
    });
  } catch (error) {
    try { fs.unlinkSync(destPath); } catch { /* best effort rollback */ }
    throw error;
  }

  return { localPath: destPath, mediaId: id, assetId: id };
}
