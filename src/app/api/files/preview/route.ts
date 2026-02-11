import { NextRequest, NextResponse } from 'next/server';
import { readFilePreview, isPathSafe } from '@/lib/files';
import type { FilePreviewResponse, ErrorResponse } from '@/types';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const filePath = searchParams.get('path');
  const maxLines = parseInt(searchParams.get('maxLines') || '200', 10);

  if (!filePath) {
    return NextResponse.json<ErrorResponse>(
      { error: 'Missing path parameter' },
      { status: 400 }
    );
  }

  const path = require('path');

  // When baseDir is provided, ensure the file stays within that project scope
  // to prevent directory traversal. No homeDir restriction - this is a
  // desktop Electron app and users may have projects on any drive.
  const baseDir = searchParams.get('baseDir');
  if (!baseDir && !path.isAbsolute(filePath)) {
    return NextResponse.json<ErrorResponse>(
      { error: 'File path must be absolute' },
      { status: 400 }
    );
  }

  const resolvedPath = path.resolve(filePath);
  if (baseDir) {
    const resolvedBase = path.resolve(baseDir);
    if (!isPathSafe(resolvedBase, resolvedPath)) {
      return NextResponse.json<ErrorResponse>(
        { error: 'File is outside the project scope' },
        { status: 403 }
      );
    }
  }

  try {
    const preview = readFilePreview(resolvedPath, Math.min(maxLines, 1000));
    return NextResponse.json<FilePreviewResponse>({ preview });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to read file' },
      { status: 500 }
    );
  }
}
