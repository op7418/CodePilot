/**
 * GitHub Token Verify API
 * POST: Verify GitHub Personal Access Token
 */

import { NextResponse } from 'next/server';
import { saveGitHubCredential, getGitHubUser } from '@/lib/github';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { token } = body;

    if (!token) {
      return NextResponse.json(
        { success: false, error: 'Token is required' },
        { status: 400 }
      );
    }

    // Verify token by fetching user info
    const user = await getGitHubUser(token);

    if (!user) {
      return NextResponse.json({
        success: false,
        error: 'Invalid token or insufficient permissions',
      });
    }

    // Save credential to database
    await saveGitHubCredential({
      access_token: token,
      token_type: 'Bearer',
      scope: 'repo,read:user,user:email',
      user_login: user.login,
      user_name: user.name,
      avatar_url: user.avatar_url,
    });

    return NextResponse.json({
      success: true,
      user: {
        login: user.login,
        name: user.name,
        avatar_url: user.avatar_url,
      },
    });
  } catch (error) {
    console.error('Failed to verify token:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to verify token' },
      { status: 500 }
    );
  }
}
