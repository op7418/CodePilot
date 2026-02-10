import { NextRequest, NextResponse } from 'next/server';
import { scanDirectory, isPathSafe, isBaseDirUnsafe } from '@/lib/files';
import type { FileTreeResponse, ErrorResponse } from '@/types';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const dir = searchParams.get('dir');
  const depth = parseInt(searchParams.get('depth') || '3', 10);

  if (!dir) {
    return NextResponse.json<ErrorResponse>(
      { error: 'Missing dir parameter' },
      { status: 400 }
    );
  }

  const path = require('path');
  const os = require('os');
  const resolvedDir = path.resolve(dir);
  const homeDir = os.homedir();

  // Use baseDir (the session's working directory) as the trust boundary.
  // The baseDir must not be a filesystem root (e.g. / or C:\) to prevent
  // attackers from setting baseDir=/ to bypass all restrictions.
  // If no baseDir is provided, fall back to the user's home directory
  // to prevent scanning arbitrary system directories.
  const baseDir = searchParams.get('baseDir');
  if (baseDir) {
    const resolvedBase = path.resolve(baseDir);
    // Prevent overly broad baseDir (root paths or shallow system dirs like /etc)
    if (isBaseDirUnsafe(resolvedBase)) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Base directory is too broad (must be at least 2 levels deep)' },
        { status: 403 }
      );
    }
    if (!isPathSafe(resolvedBase, resolvedDir)) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Directory is outside the project scope' },
        { status: 403 }
      );
    }
  } else {
    // Fallback: without a baseDir, restrict to the user's home directory
    // to prevent scanning arbitrary system directories like /etc
    if (!isPathSafe(homeDir, resolvedDir)) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Directory is outside the allowed scope' },
        { status: 403 }
      );
    }
  }

  try {
    const tree = scanDirectory(resolvedDir, Math.min(depth, 5));
    return NextResponse.json<FileTreeResponse>({ tree, root: resolvedDir });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to scan directory' },
      { status: 500 }
    );
  }
}
