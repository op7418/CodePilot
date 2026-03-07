/**
 * Git Tags API
 * GET: Get tag list
 * POST: Create a tag
 * DELETE: Delete a tag
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
    const result = await git.getTags();

    return NextResponse.json(result);
  } catch (error) {
    console.error('Failed to get tags:', error);
    return NextResponse.json(
      { error: 'Failed to get tags' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: repoPath, name, message, push } = body as {
      path: string;
      name: string;
      message?: string;
      push?: boolean;
    };

    if (!repoPath || !name) {
      return NextResponse.json(
        { error: 'Repository path and tag name are required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);
    await git.createTag(name, message);

    if (push) {
      await git.pushTags();
    }

    return NextResponse.json({ success: true, name });
  } catch (error) {
    console.error('Failed to create tag:', error);
    return NextResponse.json(
      { error: 'Failed to create tag' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const repoPath = searchParams.get('path');
    const name = searchParams.get('name');

    if (!repoPath || !name) {
      return NextResponse.json(
        { error: 'Repository path and tag name are required' },
        { status: 400 }
      );
    }

    const git = createGitService(repoPath);
    await git.deleteTag(name);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete tag:', error);
    return NextResponse.json(
      { error: 'Failed to delete tag' },
      { status: 500 }
    );
  }
}
