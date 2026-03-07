/**
 * Git Log API
 * GET: Get commit history
 */

import { NextRequest, NextResponse } from 'next/server';
import { createGitService } from '@/lib/git';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const repoPath = searchParams.get('path');
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const skip = parseInt(searchParams.get('skip') || '0', 10);

    if (!repoPath) {
      return NextResponse.json(
        { error: 'Repository path is required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);
    const result = await git.getLog(limit, skip);

    return NextResponse.json(result);
  } catch (error) {
    console.error('Failed to get log:', error);
    return NextResponse.json(
      { error: 'Failed to get log' },
      { status: 500 }
    );
  }
}
