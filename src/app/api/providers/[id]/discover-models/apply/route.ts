import { NextRequest, NextResponse } from 'next/server';
import { getProvider, applyDiscoveryDiff } from '@/lib/db';
import { findMatchingPresetForRecord, isOpenRouterProviderRecord } from '@/lib/provider-catalog';
import { getProviderCompatFromApi } from '@/lib/runtime-compat';
import { isRecommendedModel } from '@/lib/catalog-recommend';
import type { ErrorResponse } from '@/types';

/**
 * POST /api/providers/[id]/discover-models/apply
 *
 * Commits a previously-shown discovery diff to provider_models. Body shape:
 *
 *   { upstreamModels: [{ modelId: string, upstreamModelId: string }, …] }
 *
 * Apply rules (enforced in `applyDiscoveryDiff`):
 *   - rows with `enable_source` ∈ {manual_enabled, manual_hidden} are
 *     NEVER touched (only `upstream_model_id` / `last_refreshed_at` move)
 *   - pristine rows (`recommended` / `discovered` / `catalog`) get
 *     re-evaluated against the catalog `isRecommended` callback. A model
 *     that the catalog/blacklist says is OK becomes `recommended` +
 *     enabled; everything else lands as `discovered` + hidden so the
 *     chat picker stays uncluttered. The user surfaces "discovered"
 *     rows from the Models page if they want them.
 *   - orphans (DB rows not in upstream) are NOT touched here; the user
 *     can review/delete them manually.
 *
 * Returns:
 *   {
 *     providerId, inserted,
 *     refreshedPristine, refreshedPreserved,
 *     recommendedEnabled, discoveredHidden
 *   }
 *
 * The two count fields drive the post-discovery toast — "X models discovered,
 * Y enabled by default, Z hidden" — so the user understands the conservative
 * apply policy without having to open the Models page.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const provider = getProvider(id);
  if (!provider) {
    return NextResponse.json<ErrorResponse>({ error: 'Provider not found' }, { status: 404 });
  }

  // OpenRouter 防御纵深：discover-models already returns `unsupported`
  // for OpenRouter so the apply path is unreachable through normal flows.
  // This block guards old front-end code or external scripts that might
  // POST upstream models directly. Reject with a pointer to the right route.
  if (isOpenRouterProviderRecord(provider)) {
    return NextResponse.json<ErrorResponse>(
      {
        error: 'OpenRouter providers do not support apply — use /search-models to add individual SKUs.',
        code: 'OPENROUTER_APPLY_DISABLED',
      },
      { status: 400 },
    );
  }

  const body = await request.json().catch(() => null) as
    | { upstreamModels?: { modelId: string; upstreamModelId: string }[] }
    | null;

  if (!body || !Array.isArray(body.upstreamModels)) {
    return NextResponse.json<ErrorResponse>(
      { error: 'Body must be { upstreamModels: [{ modelId, upstreamModelId }, …] }' },
      { status: 400 },
    );
  }

  // Build the auto-enable predicate. The preset (may be undefined for
  // unknown custom URLs) feeds the catalog whitelist; the runtime compat
  // tier feeds the Claude-alias fallback.
  const preset = findMatchingPresetForRecord(provider);
  const providerCompat = getProviderCompatFromApi(provider);
  const isRecommended = (modelId: string) => isRecommendedModel(modelId, preset, providerCompat);

  const stats = applyDiscoveryDiff(id, body.upstreamModels, isRecommended);
  return NextResponse.json({ providerId: id, ...stats });
}
