import { NextRequest, NextResponse } from 'next/server';
import * as gitService from '@/lib/git/service';

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get('cwd');
  if (!cwd) {
    return NextResponse.json({ error: 'cwd is required' }, { status: 400 });
  }

  try {
    const remotes = await gitService.getRemotes(cwd);
    return NextResponse.json({ remotes });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to get remotes' },
      { status: 500 }
    );
  }
}
