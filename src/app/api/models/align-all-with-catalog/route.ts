import { NextRequest, NextResponse } from 'next/server';
import { getDb, alignEnabledWithCatalog } from '@/lib/db';
import { getCatalogDefaultModelsForRecord } from '@/lib/provider-catalog';
import type { ApiProvider } from '@/types';

/**
 * POST /api/models/align-all-with-catalog[?dryRun=1]
 *
 * One-shot global cleanup: for every configured provider that has catalog
 * defaults, flip its `enabled` flags so only catalog-matched models are
 * visible. Providers with no catalog defaults (custom URL anthropic-thirdparty,
 * etc.) are skipped — there's no truth to align against.
 *
 * `?dryRun=1` returns the same per-provider counts as a real apply but
 * without writing — used by the UI to render an "x will be enabled, y
 * hidden, z catalog seeds pruned" preview before the user confirms.
 */
export async function POST(request: NextRequest) {
  const dryRun = request.nextUrl.searchParams.get('dryRun') === '1';
  const db = getDb();
  const providers = db.prepare('SELECT * FROM api_providers').all() as ApiProvider[];

  const results: Array<{
    providerId: string;
    providerName: string;
    catalogSize: number;
    enabled: number;
    disabled: number;
    unchanged: number;
    inserted: number;
    pruned: number;
    skipped?: boolean;
  }> = [];

  for (const p of providers) {
    const catalog = getCatalogDefaultModelsForRecord(p);
    if (catalog.length === 0) {
      results.push({
        providerId: p.id,
        providerName: p.name,
        catalogSize: 0,
        enabled: 0,
        disabled: 0,
        unchanged: 0,
        inserted: 0,
        pruned: 0,
        skipped: true,
      });
      continue;
    }
    const stats = alignEnabledWithCatalog(p.id, catalog, { dryRun });
    results.push({
      providerId: p.id,
      providerName: p.name,
      catalogSize: catalog.length,
      ...stats,
    });
  }

  return NextResponse.json({ results, dryRun });
}
