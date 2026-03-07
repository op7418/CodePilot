/**
 * Git Unstage API
 * POST: Unstage files
 */

import { NextRequest, NextResponse } from 'next/server';
import { createGitService } from '@/lib/git';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: repoPath, files, all } = body as { path: string; files?: string[]; all?: boolean };

    if (!repoPath) {
      return NextResponse.json(
        { error: 'Repository path is required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);

    if (all) {
      await git.unstageAll();
    } else if (files && files.length > 0) {
      await git.unstage(files);
    } else {
      return NextResponse.json(
        { error: 'Either files or all flag is required' },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to unstage files:', error);
    return NextResponse.json(
      { error: 'Failed to unstage files' },
      { status: 500 }
    );
  }
}
