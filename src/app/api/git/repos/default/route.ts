/**
 * Git Repos Default API
 * POST: Set a repository as default
 */

import { NextRequest, NextResponse } from 'next/server';
import { setDefaultRepository } from '@/lib/git';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id } = body as { id: string };

    if (!id) {
      return NextResponse.json(
        { error: 'Repository ID is required' },
        { status: 400 }
      );
    }

    await setDefaultRepository(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to set default repository:', error);
    return NextResponse.json(
      { error: 'Failed to set default repository' },
      { status: 500 }
    );
  }
}
