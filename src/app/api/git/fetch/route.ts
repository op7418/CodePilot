import { NextRequest, NextResponse } from 'next/server';
import * as gitService from '@/lib/git/service';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const cwd = body.cwd;

  if (!cwd) {
    return NextResponse.json({ error: 'cwd is required' }, { status: 400 });
  }

  try {
    await gitService.fetchRemotes(cwd);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch remotes' },
      { status: 500 }
    );
  }
}
