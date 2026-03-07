/**
 * Git Stash API
 * GET: Get stash list
 * POST: Create a stash
 * DELETE: Drop a stash
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
    const stashes = await git.getStashList();

    return NextResponse.json({ stashes });
  } catch (error) {
    console.error('Failed to get stash list:', error);
    return NextResponse.json(
      { error: 'Failed to get stash list' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: repoPath, message, includeUntracked, action, index, pop } = body as {
      path: string;
      message?: string;
      includeUntracked?: boolean;
      action?: 'create' | 'apply';
      index?: number;
      pop?: boolean;
    };

    if (!repoPath) {
      return NextResponse.json(
        { error: 'Repository path is required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);

    if (action === 'apply' && typeof index === 'number') {
      await git.applyStash(index, pop);
    } else {
      await git.stash(message, includeUntracked);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to stash:', error);
    return NextResponse.json(
      { error: 'Failed to stash' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const repoPath = searchParams.get('path');
    const index = parseInt(searchParams.get('index') || '0', 10);

    if (!repoPath) {
      return NextResponse.json(
        { error: 'Repository path is required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);
    await git.dropStash(index);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to drop stash:', error);
    return NextResponse.json(
      { error: 'Failed to drop stash' },
      { status: 500 }
    );
  }
}
