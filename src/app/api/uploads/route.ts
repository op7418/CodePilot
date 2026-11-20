import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { assertRealPathInBase, FileIOError } from '@/lib/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

const ALLOWED_DIR_NAMES = new Set(['.codepilot-uploads', '.codepilot-media', '.codepilot-images']);

/**
 * Upload directories live under each session's working directory, so there is
 * no single base to anchor on. The innermost allowed directory segment (never
 * the file name itself) becomes the base for the realpath containment check.
 */
function findAllowedBase(resolved: string): string | null {
  const segments = resolved.split(path.sep);
  for (let i = segments.length - 2; i >= 0; i--) {
    if (ALLOWED_DIR_NAMES.has(segments[i])) {
      return segments.slice(0, i + 1).join(path.sep) || path.sep;
    }
  }
  return null;
}

/**
 * Serve files from .codepilot-uploads/, .codepilot-media/ and .codepilot-images/ directories.
 */
export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get('path');

  if (!filePath) {
    return new Response(JSON.stringify({ error: 'path parameter is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const resolved = path.resolve(filePath);
  const base = findAllowedBase(resolved);
  if (!base) {
    return new Response(JSON.stringify({ error: 'Access denied' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await assertRealPathInBase(resolved, base);
  } catch (err) {
    const notFound = err instanceof FileIOError && err.code === 'not_found';
    return new Response(JSON.stringify({ error: notFound ? 'File not found' : 'Access denied' }), {
      status: notFound ? 404 : 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const buffer = await fs.readFile(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
