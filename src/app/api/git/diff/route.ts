/**
 * Git Diff API
 * GET: Get diff for a file, all changes, or a specific commit
 */

import { NextRequest, NextResponse } from 'next/server';
import { createGitService } from '@/lib/git';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const repoPath = searchParams.get('path');
    const file = searchParams.get('file');
    const staged = searchParams.get('staged') === 'true';
    const commit = searchParams.get('commit');

    if (!repoPath) {
      return NextResponse.json(
        { error: 'Repository path is required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);
    let diff;

    if (commit) {
      // Get diff for a specific commit (compare with its parent)
      diff = await git.getCommitDiff(commit);
    } else {
      // Get diff for staged/unstaged changes
      diff = await git.getDiff(file || undefined, staged);
    }

    return NextResponse.json({ diff });
  } catch (error) {
    console.error('Failed to get diff:', error);
    return NextResponse.json(
      { error: 'Failed to get diff' },
      { status: 500 }
    );
  }
}
