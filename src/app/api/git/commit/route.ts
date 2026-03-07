/**
 * Git Commit API
 * POST: Commit staged changes
 */

import { NextRequest, NextResponse } from 'next/server';
import { createGitService } from '@/lib/git';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: repoPath, message } = body as { path: string; message: string };

    if (!repoPath) {
      return NextResponse.json(
        { error: 'Repository path is required' },
        { status: 400 }
      );
    }

    if (!message || message.trim() === '') {
      return NextResponse.json(
        { error: 'Commit message is required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);
    const hash = await git.commit(message);

    return NextResponse.json({ hash, message });
  } catch (error) {
    console.error('Failed to commit:', error);
    return NextResponse.json(
      { error: 'Failed to commit' },
      { status: 500 }
    );
  }
}
