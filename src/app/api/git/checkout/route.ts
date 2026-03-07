/**
 * Git Checkout API
 * POST: Checkout a branch
 */

import { NextRequest, NextResponse } from 'next/server';
import { createGitService } from '@/lib/git';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: repoPath, branch } = body as { path: string; branch: string };

    if (!repoPath || !branch) {
      return NextResponse.json(
        { error: 'Repository path and branch name are required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);
    await git.checkout(branch);

    return NextResponse.json({ success: true, branch });
  } catch (error) {
    console.error('Failed to checkout branch:', error);
    return NextResponse.json(
      { error: 'Failed to checkout branch' },
      { status: 500 }
    );
  }
}
