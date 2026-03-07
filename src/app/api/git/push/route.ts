/**
 * Git Push API
 * POST: Push to remote
 */

import { NextRequest, NextResponse } from 'next/server';
import { createGitService } from '@/lib/git';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: repoPath, remote, branch, force, setUpstream } = body as {
      path: string;
      remote?: string;
      branch?: string;
      force?: boolean;
      setUpstream?: boolean;
    };

    if (!repoPath) {
      return NextResponse.json(
        { error: 'Repository path is required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);
    const message = await git.push(remote || 'origin', branch, { force, setUpstream });

    return NextResponse.json({ success: true, message });
  } catch (error) {
    console.error('Failed to push:', error);
    return NextResponse.json(
      { error: 'Failed to push' },
      { status: 500 }
    );
  }
}
