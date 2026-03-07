/**
 * GitHub Create Repository API
 * POST: Create a new repository on GitHub
 */

import { NextRequest, NextResponse } from 'next/server';
import { createGitHubRepo, getGitHubCredential } from '@/lib/github';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, isPrivate } = body as {
      name: string;
      description?: string;
      isPrivate?: boolean;
    };

    if (!name) {
      return NextResponse.json(
        { error: 'Repository name is required' },
        { status: 400 }
      );
    }

    // Get stored credential
    const credential = await getGitHubCredential();
    if (!credential) {
      return NextResponse.json(
        { error: 'Not authenticated with GitHub. Please login first.' },
        { status: 401 }
      );
    }

    // Create repo on GitHub
    const repo = await createGitHubRepo(credential.access_token, {
      name,
      description,
      private: isPrivate ?? false,
      auto_init: false, // Don't auto-init, we'll push existing code
    });

    if (!repo) {
      return NextResponse.json(
        { error: 'Failed to create repository on GitHub' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      repo: {
        name: repo.name,
        full_name: repo.full_name,
        html_url: repo.html_url,
        clone_url: repo.clone_url,
        ssh_url: repo.ssh_url,
        private: repo.private,
      },
    });
  } catch (error) {
    console.error('Failed to create GitHub repo:', error);
    return NextResponse.json(
      { error: 'Failed to create repository' },
      { status: 500 }
    );
  }
}
