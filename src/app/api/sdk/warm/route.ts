import { NextRequest, NextResponse } from 'next/server';
import { getCachedModels, getCapabilityCacheAge } from '@/lib/agent-sdk-capabilities';
import { warmCapabilitiesViaSdk } from '@/lib/claude-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 10 * 60 * 1000;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const providerId = typeof body.providerId === 'string' && body.providerId ? body.providerId : 'env';
    const workingDirectory = typeof body.workingDirectory === 'string' && body.workingDirectory
      ? body.workingDirectory
      : undefined;
    const force = body.force === true;

    const existingModels = getCachedModels(providerId);
    const cacheAge = getCapabilityCacheAge(providerId);
    const isFresh = existingModels.length > 0 && cacheAge < CACHE_TTL_MS;

    if (!force && isFresh) {
      return NextResponse.json({
        ok: true,
        providerId,
        warmed: false,
        reason: 'cache_fresh',
        models: existingModels.length,
        cacheAge,
      });
    }

    const result = await warmCapabilitiesViaSdk({
      providerId,
      workingDirectory,
    });

    return NextResponse.json({
      ok: true,
      providerId: result.providerId,
      warmed: result.warmed,
      models: getCachedModels(result.providerId).length,
      cacheAge: getCapabilityCacheAge(result.providerId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[sdk/warm] Failed to warm capabilities:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
