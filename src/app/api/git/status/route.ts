/**
 * Git Status API
 * GET: Get repository status
 */

import { NextRequest, NextResponse } from 'next/server';
import { createGitService } from '@/lib/git';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const repoPath = searchParams.get('path');

    if (!repoPath) {
      return NextResponse.json(
        { error: 'Repository path is required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);
    const status = await git.getStatus();
    const hasRemotes = await git.hasRemotes();

    return NextResponse.json({ status: { ...status, hasRemotes } });
  } catch (error) {
    console.error('Failed to get git status:', error);
    return NextResponse.json(
      { error: 'Failed to get git status' },
      { status: 500 }
    );
  }
}
