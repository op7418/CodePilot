/**
 * Git Branches API
 * GET: Get all branches
 * POST: Create a new branch
 * DELETE: Delete a branch
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
    const branches = await git.getBranches();

    return NextResponse.json(branches);
  } catch (error) {
    console.error('Failed to get branches:', error);
    return NextResponse.json(
      { error: 'Failed to get branches' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: repoPath, name, startPoint } = body as { path: string; name: string; startPoint?: string };

    if (!repoPath || !name) {
      return NextResponse.json(
        { error: 'Repository path and branch name are required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);
    await git.createBranch(name, startPoint);

    return NextResponse.json({ success: true, branch: name });
  } catch (error) {
    console.error('Failed to create branch:', error);
    return NextResponse.json(
      { error: 'Failed to create branch' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const repoPath = searchParams.get('path');
    const name = searchParams.get('name');
    const force = searchParams.get('force') === 'true';

    if (!repoPath || !name) {
      return NextResponse.json(
        { error: 'Repository path and branch name are required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);
    await git.deleteBranch(name, force);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete branch:', error);
    return NextResponse.json(
      { error: 'Failed to delete branch' },
      { status: 500 }
    );
  }
}
