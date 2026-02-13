import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import os from 'os';
import { scanDirectory, isPathSafe } from '@/lib/files';
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

  const resolvedDir = path.resolve(dir);
  const homeDir = os.homedir();

  // Use baseDir (the session's working directory) as the trust boundary.
  // The baseDir itself must be under the user's home directory to prevent
  // attackers from setting baseDir=/ to bypass all restrictions.
  // If no baseDir is provided, fall back to the user's home directory
  // to prevent scanning arbitrary system directories.
  const baseDir = searchParams.get('baseDir');
  if (baseDir) {
    const resolvedBase = path.resolve(baseDir);
    // Ensure baseDir is within the home directory (prevent baseDir=/ bypass)
    if (!isPathSafe(homeDir, resolvedBase)) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Base directory is outside the allowed scope' },
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
    const tree = await scanDirectory(resolvedDir, Math.min(depth, 5));
    return NextResponse.json<FileTreeResponse>({ tree, root: resolvedDir });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to scan directory' },
      { status: 500 }
    );
  }
}
