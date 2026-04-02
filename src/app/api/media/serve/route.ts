import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import { createReadStream, statSync } from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_TYPES: Record<string, string> = {
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
};

const VIDEO_AUDIO_TYPES = new Set(
  Object.values(MIME_TYPES).filter(t => t.startsWith('video/') || t.startsWith('audio/'))
);

/**
 * Serve media files from .codepilot-media/ directory.
 * Only allows reading from paths that contain '.codepilot-media' to prevent directory traversal.
 * Supports HTTP Range requests for video/audio seeking.
 */
export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get('path');

  if (!filePath) {
    return new Response(JSON.stringify({ error: 'path parameter is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Security: only allow files within the canonical .codepilot-media directory.
  // Use path.resolve to canonicalize, then verify it starts with the real media dir.
  const resolved = path.resolve(filePath);
  const os = await import('os');
  const dataDir = process.env.CLAUDE_GUI_DATA_DIR || path.join(os.homedir(), '.codepilot');
  const canonicalMediaDir = path.resolve(dataDir, '.codepilot-media');
  if (!resolved.startsWith(canonicalMediaDir + path.sep) && resolved !== canonicalMediaDir) {
    return new Response(JSON.stringify({ error: 'Access denied' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await fs.access(resolved);
  } catch {
    return new Response(JSON.stringify({ error: 'File not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const stat = statSync(resolved);
  const fileSize = stat.size;

  // Handle Range requests for video/audio seeking
  const rangeHeader = request.headers.get('range');
  if (rangeHeader && VIDEO_AUDIO_TYPES.has(contentType)) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const stream = createReadStream(resolved, { start, end });
      const readable = new ReadableStream({
        start(controller) {
          stream.on('data', (chunk: Buffer | string) => {
            controller.enqueue(new Uint8Array(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
          });
          stream.on('end', () => controller.close());
          stream.on('error', (err) => controller.error(err));
        },
        cancel() {
          stream.destroy();
        },
      });

      return new Response(readable, {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Length': String(chunkSize),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }
  }

  // Full file response for images and non-range requests
  const buffer = await fs.readFile(resolved);

  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(fileSize),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
