import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { detectAllCliTools } from '@/lib/cli-tools-detect';
import { getExpandedPath } from '@/lib/platform';
import { getAllCliToolDescriptions, getAllCustomCliTools } from '@/lib/db';

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';

async function detectBrew(): Promise<boolean> {
  try {
    await execFileAsync('/usr/bin/which', ['brew'], {
      timeout: 3000,
      env: { ...process.env, PATH: getExpandedPath() },
    });
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    const [{ catalog, extra }, hasBrew] = await Promise.all([
      detectAllCliTools(),
      detectBrew(),
    ]);
    const descriptions = getAllCliToolDescriptions();
    const allCustom = getAllCustomCliTools();
    // Filter out custom rows that shadow catalog tools (same binary path).
    // These rows exist only to store install metadata for update commands.
    const catalogBinPaths = new Set(catalog.filter(c => c.binPath).map(c => c.binPath!));
    const custom = allCustom.filter(ct => !catalogBinPaths.has(ct.binPath));
    return NextResponse.json({
      tools: catalog,
      extra,
      custom,
      descriptions,
      platform: process.platform,
      hasBrew,
    });
  } catch (error) {
    console.error('[cli-tools/installed] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Detection failed' },
      { status: 500 }
    );
  }
}
