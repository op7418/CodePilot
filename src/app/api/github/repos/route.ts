/**
 * GitHub Repos API
 * GET: Get user's GitHub repositories
 */

import { NextRequest, NextResponse } from 'next/server';
import { getGitHubCredential, getUserRepos, searchRepos } from '@/lib/github';

export async function GET(request: NextRequest) {
  try {
    const credential = await getGitHubCredential();

    if (!credential) {
      return NextResponse.json(
        { error: 'Not authenticated with GitHub' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') as 'all' | 'owner' | 'public' | 'private' | 'member' | null;
    const sort = searchParams.get('sort') as 'created' | 'updated' | 'pushed' | 'full_name' | null;
    const search = searchParams.get('search');

    // If search query provided, use search API
    if (search) {
      const result = await searchRepos(credential.access_token, search, {
        per_page: 50,
      });
      return NextResponse.json({
        repos: result.items,
        total_count: result.total_count,
      });
    }

    // Otherwise get user's repos
    const repos = await getUserRepos(credential.access_token, {
      type: type || 'owner',
      sort: sort || 'updated',
      per_page: 100,
    });

    return NextResponse.json({ repos });
  } catch (error) {
    console.error('Failed to get repos:', error);
    return NextResponse.json(
      { error: 'Failed to get repositories' },
      { status: 500 }
    );
  }
}
