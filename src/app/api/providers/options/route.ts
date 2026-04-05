import { NextRequest, NextResponse } from 'next/server';
import { getProviderOptions, setProviderOptions } from '@/lib/db';
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
    const body = await request.json();
    const { providerId = 'env', options } = body as { providerId?: string; options: ProviderOptions };

    if (!options || typeof options !== 'object') {
      return NextResponse.json({ error: 'Invalid options' }, { status: 400 });
    }

    // Merge with existing options (partial update)
    const existing = getProviderOptions(providerId);
    const merged: ProviderOptions = { ...existing, ...options };
    setProviderOptions(providerId, merged);

    return NextResponse.json({ options: merged });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update options' },
      { status: 500 },
    );
  }
}
