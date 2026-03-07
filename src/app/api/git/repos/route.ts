/**
 * Git Repositories API
 * GET: List all repositories
 * POST: Add a repository
 * DELETE: Remove a repository
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getRepositoriesWithStatus,
  addRepository,
  removeRepository,
  setDefaultRepository,
} from '@/lib/git';
import { isGitRepo } from '@/lib/git';

export async function GET() {
  try {
    const repos = await getRepositoriesWithStatus();
    return NextResponse.json({ repos });
  } catch (error) {
    console.error('Failed to get repositories:', error);
    return NextResponse.json(
      { error: 'Failed to get repositories' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: repoPath, setAsDefault } = body;

    if (!repoPath) {
      return NextResponse.json(
        { error: 'Repository path is required' },
        { status: 400 }
      );
    }

    // Validate it's a git repo
    const isValid = await isGitRepo(repoPath);
    if (!isValid) {
      return NextResponse.json(
        { error: 'Not a valid Git repository' },
        { status: 400 }
      );
    }

    const repo = await addRepository(repoPath);

    if (setAsDefault) {
      await setDefaultRepository(repo.id);
    }

    return NextResponse.json({ repo });
  } catch (error) {
    console.error('Failed to add repository:', error);
    return NextResponse.json(
      { error: 'Failed to add repository' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { error: 'Repository ID is required' },
        { status: 400 }
      );
    }

    await removeRepository(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to remove repository:', error);
    return NextResponse.json(
      { error: 'Failed to remove repository' },
      { status: 500 }
    );
  }
}
