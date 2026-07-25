import { NextRequest, NextResponse } from 'next/server';
import {
  getProvider,
  getModelsForProvider,
  getAllModelsForProvider,
  upsertProviderModel,
  deleteProviderModel,
  updateProviderModelUserFields,
  seedCatalogModelsIfEmpty,
} from '@/lib/db';
import { getCatalogDefaultModelsForRecord } from '@/lib/provider-catalog';
import type { ErrorResponse } from '@/types';

/**
 * GET /api/providers/[id]/models
 *
 * Default: enabled-only (back-compat for the chat layer).
 * `?all=1`: all rows including hidden — used by Settings > Models page.
 *
 * Backfill: when the table is empty for this provider, seed the matched
 * preset's catalog defaults (rows tagged source='catalog'). This covers
 * providers that can't be auto-discovered — e.g. Xiaomi MiMo / MiniMax /
 * DeepSeek with `/anthropic` subpaths that return 404 on /v1/models.
 * Idempotent: re-fetching after a row exists won't reseed.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const provider = getProvider(id);
  if (!provider) {
    return NextResponse.json<ErrorResponse>({ error: 'Provider not found' }, { status: 404 });
  }
  const catalogDefaults = getCatalogDefaultModelsForRecord(provider);
  if (catalogDefaults.length > 0) {
    seedCatalogModelsIfEmpty(id, catalogDefaults);
  }
  const includeHidden = request.nextUrl.searchParams.get('all') === '1';
  const models = includeHidden ? getAllModelsForProvider(id) : getModelsForProvider(id);
  return NextResponse.json({ models });
}

/**
 * POST /api/providers/[id]/models
 *
 * Add a manual model. Sets:
 *   - `source='manual'`         — data origin: hand-entered, not API
 *   - `user_edited=1`           — legacy "this row is user-owned" signal
 *   - `enable_source='manual_enabled'` — Phase B intent signal
 *
 * Both `user_edited` and `enable_source='manual_enabled'` independently
 * gate the row out of refresh apply / catalog align (defense in depth);
 * setting both keeps the badge in the Models page accurate ("手动启用"
 * tone instead of the silent default "recommended").
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

  const body = await request.json();
  const { model_id, upstream_model_id, display_name, capabilities_json, sort_order } = body;

  if (!model_id) {
    return NextResponse.json<ErrorResponse>({ error: 'model_id is required' }, { status: 400 });
  }

  upsertProviderModel({
    provider_id: id,
    model_id,
    upstream_model_id: upstream_model_id || model_id,
    display_name: display_name || model_id,
    capabilities_json: capabilities_json || '{}',
    sort_order: sort_order ?? 0,
    source: 'manual',
    user_edited: 1,
    enable_source: 'manual_enabled',
  });

  const models = getAllModelsForProvider(id);
  return NextResponse.json({ models });
}

/**
 * PATCH /api/providers/[id]/models
 *
 * Update user-controllable fields (display_name / enabled / sort_order /
 * capabilities) on an existing model. Sets `user_edited=1` so the next
 * refresh apply preserves these fields.
 *
 * Body: { model_id: string, display_name?, enabled?, sort_order?, capabilities_json? }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const provider = getProvider(id);
  if (!provider) {
    return NextResponse.json<ErrorResponse>({ error: 'Provider not found' }, { status: 404 });
  }

  const body = await request.json();
  const { model_id, display_name, enabled, sort_order, capabilities_json } = body;
  if (!model_id) {
    return NextResponse.json<ErrorResponse>({ error: 'model_id is required' }, { status: 400 });
  }

  const ok = updateProviderModelUserFields(id, model_id, {
    display_name,
    enabled,
    sort_order,
    capabilities_json,
  });
  if (!ok) {
    return NextResponse.json<ErrorResponse>({ error: 'Model not found' }, { status: 404 });
  }
  const models = getAllModelsForProvider(id);
  return NextResponse.json({ models });
}

/**
 * DELETE /api/providers/[id]/models
 *
 * Body: { model_id: string }
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const provider = getProvider(id);
  if (!provider) {
    return NextResponse.json<ErrorResponse>({ error: 'Provider not found' }, { status: 404 });
  }

  const body = await request.json();
  const { model_id } = body;

  if (!model_id) {
    return NextResponse.json<ErrorResponse>({ error: 'model_id is required' }, { status: 400 });
  }

  const deleted = deleteProviderModel(id, model_id);
  if (!deleted) {
    return NextResponse.json<ErrorResponse>({ error: 'Model not found' }, { status: 404 });
  }

  const models = getAllModelsForProvider(id);
  return NextResponse.json({ models });
}
