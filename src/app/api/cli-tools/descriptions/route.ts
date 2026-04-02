import { NextResponse } from 'next/server';
import { bulkUpsertCliToolDescriptions } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * POST /api/cli-tools/descriptions/migrate
 * Bulk-import descriptions from the client's localStorage migration.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const descriptions = body.descriptions as Record<string, { zh: string; en: string }> | undefined;

    if (!descriptions || typeof descriptions !== 'object') {
      return NextResponse.json({ error: 'Invalid descriptions payload' }, { status: 400 });
    }

    const entries = Object.entries(descriptions)
      .filter(([, v]) => v && typeof v.zh === 'string' && typeof v.en === 'string')
      .map(([toolId, v]) => ({ toolId, zh: v.zh, en: v.en }));

    if (entries.length > 0) {
      bulkUpsertCliToolDescriptions(entries);
    }

    return NextResponse.json({ migrated: entries.length });
  } catch (error) {
    console.error('[cli-tools/descriptions] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Migration failed' },
      { status: 500 }
    );
  }
}
