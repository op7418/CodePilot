import { NextRequest, NextResponse } from 'next/server';
import { getProviderOptions, setProviderOptions } from '@/lib/db';
import { normalizeProviderEffort, sanitizeProviderOptions } from '@/lib/provider-options';
import type { ProviderOptions } from '@/types';

/**
 * GET /api/providers/options?providerId=xxx
 * Returns per-provider options (thinking_mode, context_1m, effort).
 */
export async function GET(request: NextRequest) {
  const providerId = request.nextUrl.searchParams.get('providerId') || 'env';
  const options = getProviderOptions(providerId);
  return NextResponse.json({ options });
}

/**
 * PUT /api/providers/options
 * Update per-provider options. Body: { providerId, options: { thinking_mode?, context_1m?, effort? } }
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json() as { providerId?: string; options?: Record<string, unknown> };
    const providerId = body.providerId || 'env';
    const options = body.options;

    if (!options || typeof options !== 'object') {
      return NextResponse.json({ error: 'Invalid options' }, { status: 400 });
    }

    const existing = getProviderOptions(providerId);
    const hasExplicitEffort = Object.prototype.hasOwnProperty.call(options, 'effort');
    const rawEffort = options.effort;

    if (hasExplicitEffort && rawEffort !== '' && rawEffort !== null && rawEffort !== undefined) {
      if (!normalizeProviderEffort(rawEffort)) {
        return NextResponse.json({ error: 'Invalid effort value' }, { status: 400 });
      }
    }

    const merged: ProviderOptions = sanitizeProviderOptions({ ...existing, ...options } as ProviderOptions);
    if (hasExplicitEffort && (rawEffort === '' || rawEffort === null || rawEffort === undefined)) {
      delete (merged as { effort?: unknown }).effort;
      setProviderOptions(providerId, { ...merged, effort: undefined });
    } else {
      setProviderOptions(providerId, merged);
    }

    return NextResponse.json({ options: merged });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update options' },
      { status: 500 },
    );
  }
}
