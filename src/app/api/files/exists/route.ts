import { NextResponse } from 'next/server';
import { findMissingDirectories } from '@/lib/directory-existence';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const dirs = Array.isArray(body?.dirs)
      ? body.dirs.filter((dir: unknown): dir is string => typeof dir === 'string')
      : [];

    const missingDirs = await findMissingDirectories(dirs);
    return NextResponse.json({ missingDirs });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to check directories' },
      { status: 500 }
    );
  }
}
