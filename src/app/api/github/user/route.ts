/**
 * GitHub User API
 * GET: Get current authenticated user
 * DELETE: Logout
 */

import { NextResponse } from 'next/server';
import { getGitHubCredential, deleteGitHubCredential } from '@/lib/github';

export async function GET() {
  try {
    const credential = await getGitHubCredential();

    if (!credential) {
      return NextResponse.json({ authenticated: false, user: null });
    }

    return NextResponse.json({
      authenticated: true,
      user: {
        login: credential.user_login,
        name: credential.user_name,
        avatar_url: credential.avatar_url,
      },
    });
  } catch (error) {
    console.error('Failed to get user:', error);
    return NextResponse.json(
      { error: 'Failed to get user info' },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    await deleteGitHubCredential();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to logout:', error);
    return NextResponse.json(
      { error: 'Failed to logout' },
      { status: 500 }
    );
  }
}
