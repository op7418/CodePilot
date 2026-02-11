import { NextRequest, NextResponse } from 'next/server';
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

  const path = require('path');

  // When baseDir is provided, ensure dir stays within that project scope
  // to prevent directory traversal. No homeDir restriction - this is a
  // desktop Electron app and users may have projects on any drive.
  const baseDir = searchParams.get('baseDir');
  if (!baseDir && !path.isAbsolute(dir)) {
    return NextResponse.json<ErrorResponse>(
      { error: 'Directory must be an absolute path' },
      { status: 400 }
    );
  }

  const resolvedDir = path.resolve(dir);
  if (baseDir) {
    const resolvedBase = path.resolve(baseDir);
    if (!isPathSafe(resolvedBase, resolvedDir)) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Directory is outside the project scope' },
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
