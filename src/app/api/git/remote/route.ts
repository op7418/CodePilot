/**
 * Git Remote API
 * GET: List remotes
 * POST: Add a remote
 * DELETE: Remove a remote
 */

import { NextRequest, NextResponse } from 'next/server';
import { createGitService } from '@/lib/git';
import { validatePath, validateGitUrl, validateRemoteName } from '@/lib/git/security';

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

    // Validate path
    const pathValidation = validatePath(repoPath);
    if (!pathValidation.valid) {
      return NextResponse.json(
        { error: pathValidation.error },
        { status: 400 }
      );
    }

    const git = createGitService(pathValidation.normalized!);
    const remotes = await git.getRemotes();

    return NextResponse.json({ remotes });
  } catch (error) {
    console.error('Failed to get remotes:', error);
    return NextResponse.json(
      { error: 'Failed to get remotes' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: repoPath, name, url } = body as {
      path: string;
      name: string;
      url: string;
    };

    if (!repoPath || !name || !url) {
      return NextResponse.json(
        { error: 'Repository path, name, and url are required' },
        { status: 400 }
      );
    }

    // Validate path
    const pathValidation = validatePath(repoPath);
    if (!pathValidation.valid) {
      return NextResponse.json(
        { error: pathValidation.error },
        { status: 400 }
      );
    }

    // Validate remote name
    const nameValidation = validateRemoteName(name);
    if (!nameValidation.valid) {
      return NextResponse.json(
        { error: nameValidation.error },
        { status: 400 }
      );
    }

    // Validate URL
    const urlValidation = validateGitUrl(url);
    if (!urlValidation.valid) {
      return NextResponse.json(
        { error: urlValidation.error },
        { status: 400 }
      );
    }

    const git = createGitService(pathValidation.normalized!);
    await git.addRemote(name.trim(), url.trim());

    return NextResponse.json({ success: true, message: `Remote "${name}" added` });
  } catch (error) {
    console.error('Failed to add remote:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to add remote';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: repoPath, name } = body as {
      path: string;
      name: string;
    };

    if (!repoPath || !name) {
      return NextResponse.json(
        { error: 'Repository path and name are required' },
        { status: 400 }
      );
    }

    // Validate path
    const pathValidation = validatePath(repoPath);
    if (!pathValidation.valid) {
      return NextResponse.json(
        { error: pathValidation.error },
        { status: 400 }
      );
    }

    // Validate remote name
    const nameValidation = validateRemoteName(name);
    if (!nameValidation.valid) {
      return NextResponse.json(
        { error: nameValidation.error },
        { status: 400 }
      );
    }

    const git = createGitService(pathValidation.normalized!);
    await git.removeRemote(name.trim());

    return NextResponse.json({ success: true, message: `Remote "${name}" removed` });
  } catch (error) {
    console.error('Failed to remove remote:', error);
    return NextResponse.json(
      { error: 'Failed to remove remote' },
      { status: 500 }
    );
  }
}
