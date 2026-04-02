import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getSession } from '@/lib/db';

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

/**
 * Serve files from a session's working directory.
 * Security: baseDir is derived from the session's DB record, NOT from client input.
 * The client must provide a valid sessionId; the server resolves the working directory.
 */
export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get('path');
  const sessionId = request.nextUrl.searchParams.get('sessionId');

  if (!filePath || !sessionId) {
    return new Response(JSON.stringify({ error: 'path and sessionId parameters are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Derive baseDir from the session's DB record — never trust client-provided paths
  const session = getSession(sessionId);
  if (!session?.working_directory) {
    return new Response(JSON.stringify({ error: 'Session not found or has no working directory' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const resolvedBase = path.resolve(session.working_directory);

  // Resolve file path relative to session working directory
  const resolved = path.resolve(resolvedBase, filePath);

  // Security: ensure the resolved path is strictly within the session's working directory
  if (!resolved.startsWith(resolvedBase + path.sep)) {
    return new Response(JSON.stringify({ error: 'Access denied: path outside working directory' }), {
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

  const buffer = await fs.readFile(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=60',
    },
  });
}
