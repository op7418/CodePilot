/**
 * Git Pull API
 * POST: Pull from remote
 */

import { NextRequest, NextResponse } from 'next/server';
import { createGitService } from '@/lib/git';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: repoPath, remote, branch } = body as {
      path: string;
      remote?: string;
      branch?: string;
    };

    if (!repoPath) {
      return NextResponse.json(
        { error: 'Repository path is required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);
    const message = await git.pull(remote || 'origin', branch);

    return NextResponse.json({ success: true, message });
  } catch (error) {
    console.error('Failed to pull:', error);
    return NextResponse.json(
      { error: 'Failed to pull' },
      { status: 500 }
    );
  }
}
