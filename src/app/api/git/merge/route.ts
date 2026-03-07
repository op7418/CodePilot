/**
 * Git Merge API
 * POST: Merge a branch
 */

import { NextRequest, NextResponse } from 'next/server';
import { createGitService } from '@/lib/git';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: repoPath, branch, noFastForward, message } = body as {
      path: string;
      branch: string;
      noFastForward?: boolean;
      message?: string;
    };

    if (!repoPath || !branch) {
      return NextResponse.json(
        { error: 'Repository path and branch name are required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);
    const result = await git.merge(branch, { noFastForward, message });

    return NextResponse.json(result);
  } catch (error) {
    console.error('Failed to merge branch:', error);
    return NextResponse.json(
      { error: 'Failed to merge branch' },
      { status: 500 }
    );
  }
}
