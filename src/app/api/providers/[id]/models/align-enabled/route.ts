import { NextRequest, NextResponse } from 'next/server';
import { getProvider, alignEnabledWithCatalog, getAllModelsForProvider } from '@/lib/db';
import { getCatalogDefaultModelsForRecord } from '@/lib/provider-catalog';
import type { ErrorResponse } from '@/types';

/**
 * POST /api/providers/[id]/models/align-enabled
 *
 * Non-destructive bulk-flip of `enabled` against the matched preset's
 * `defaultModels`. Rows whose model_id is in the catalog → enabled=1;
 * the rest → enabled=0. Doesn't delete anything, doesn't change names
 * or capabilities. Use to dig out from "200 API models, all enabled,
 * picker is a wall of text".
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const provider = getProvider(id);
  if (!provider) {
    return NextResponse.json<ErrorResponse>({ error: 'Provider not found' }, { status: 404 });
  }
  const catalog = getCatalogDefaultModelsForRecord(provider);
  if (catalog.length === 0) {
    return NextResponse.json({
      providerId: id,
      catalogSize: 0,
      enabled: 0,
      disabled: 0,
      unchanged: 0,
      models: getAllModelsForProvider(id),
      skipped: true,
    });
  }
  const stats = alignEnabledWithCatalog(id, catalog);
  return NextResponse.json({
    providerId: id,
    catalogSize: catalog.length,
    ...stats,
    models: getAllModelsForProvider(id),
  });
}
