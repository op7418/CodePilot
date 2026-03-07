/**
 * Git Show API
 * GET: Get commit detail
 */

import { NextRequest, NextResponse } from 'next/server';
import { createGitService } from '@/lib/git';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const repoPath = searchParams.get('path');
    const hash = searchParams.get('hash');

    if (!repoPath || !hash) {
      return NextResponse.json(
        { error: 'Repository path and commit hash are required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);
    const commit = await git.getCommitDetail(hash);

    return NextResponse.json({ commit });
  } catch (error) {
    console.error('Failed to get commit detail:', error);
    return NextResponse.json(
      { error: 'Failed to get commit detail' },
      { status: 500 }
    );
  }
}
