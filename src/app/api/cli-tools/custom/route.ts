import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { access, constants } from 'fs/promises';
import path from 'path';
import { getAllCustomCliTools, createCustomCliTool } from '@/lib/db';

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const tools = getAllCustomCliTools();
    return NextResponse.json({ tools });
  } catch (error) {
    console.error('[cli-tools/custom] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list custom tools' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { binPath, name } = body as { binPath?: string; name?: string };

    if (!binPath || typeof binPath !== 'string') {
      return NextResponse.json({ error: 'binPath is required' }, { status: 400 });
    }

    // Must be absolute path
    if (!path.isAbsolute(binPath)) {
      return NextResponse.json({ error: 'binPath must be an absolute path' }, { status: 400 });
    }

    // Verify file exists and is executable
    try {
      await access(binPath, constants.X_OK);
    } catch {
      return NextResponse.json({ error: 'File not found or not executable' }, { status: 400 });
    }

    // Extract version (best-effort)
    let version: string | null = null;
    try {
      const { stdout, stderr } = await execFileAsync(binPath, ['--version'], {
        timeout: 5000,
      });
      const versionText = (stdout || stderr).trim();
      const match = versionText.split('\n')[0]?.match(/(\d+\.\d+[\w.-]*)/);
      version = match ? match[1] : null;
    } catch {
      // Version extraction is optional
    }

    const binName = path.basename(binPath);
    const toolName = name?.trim() || binName;

    const tool = createCustomCliTool({
      name: toolName,
      binPath,
      binName,
      version,
    });

    return NextResponse.json({ tool });
  } catch (error) {
    console.error('[cli-tools/custom] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add custom tool' },
      { status: 500 }
    );
  }
}
