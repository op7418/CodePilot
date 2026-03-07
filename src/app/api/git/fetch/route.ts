/**
 * Git Fetch API
 * POST: Fetch from remote
 */

import { NextRequest, NextResponse } from 'next/server';
import { createGitService } from '@/lib/git';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: repoPath, remote } = body as { path: string; remote?: string };

    if (!repoPath) {
      return NextResponse.json(
        { error: 'Repository path is required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);
    const message = await git.fetch(remote || 'origin');

    return NextResponse.json({ success: true, message });
  } catch (error) {
    console.error('Failed to fetch:', error);
    return NextResponse.json(
      { error: 'Failed to fetch' },
      { status: 500 }
    );
  }
}
