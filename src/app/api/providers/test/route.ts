import { NextRequest, NextResponse } from 'next/server';
import { testProviderConnection } from '@/lib/claude-client';
import { getPreset } from '@/lib/provider-catalog';
import { getProvider } from '@/lib/db';
import type { ErrorResponse } from '@/types';

/**
 * POST /api/providers/test
 *
 * Test a provider connection without saving to DB.
 * Sends a minimal SDK query and returns structured success/error.
 *
 * Body fields:
 * - providerId (optional) — if present, DB-stored api_key will be used when
 *   the caller sends no apiKey or a masked value ("***xxxx"). This fixes the
 *   edit-then-test flow where the UI shows masked keys (#449).
 * - apiKey (optional when providerId is given) — real or empty; masked
 *   ("***xxxx") is treated as "not modified, fall back to DB".
 * - other fields: presetKey, baseUrl, protocol, authStyle, envOverrides,
 *   providerName, modelName — all pass through to testProviderConnection.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      providerId,
      presetKey,
      apiKey: bodyApiKey,
      baseUrl,
      protocol,
      authStyle,
      envOverrides,
      providerName,
      modelName,
    } = body;

    // Step 1: back-fill real api_key from DB when the caller sends no key or a
    // masked placeholder. This must happen BEFORE the NO_CREDENTIALS check.
    let effectiveApiKey: string = typeof bodyApiKey === 'string' ? bodyApiKey : '';
    const isMasked = effectiveApiKey.startsWith('***');
    if (providerId && (!effectiveApiKey || isMasked)) {
      try {
        const stored = getProvider(providerId);
        if (stored?.api_key) {
          effectiveApiKey = stored.api_key;
        }
      } catch {
        // DB lookup failure → fall through; the NO_CREDENTIALS check below
        // will surface a clean error.
      }
    }

    // Step 2: credential check (after back-fill)
    if (!effectiveApiKey && authStyle !== 'env_only') {
      return NextResponse.json({
        success: false,
        error: {
          code: 'NO_CREDENTIALS',
          message: 'API Key is required',
          suggestion: 'Please enter your API key',
        },
      });
    }

    // Look up preset meta for recovery action URLs
    const preset = presetKey ? getPreset(presetKey) : undefined;
    const meta = preset?.meta;

    const result = await testProviderConnection({
      callScene: 'connection_test',
      apiKey: effectiveApiKey,
      baseUrl: baseUrl || '',
      protocol: protocol || 'anthropic',
      authStyle: authStyle || 'api_key',
      envOverrides: envOverrides || {},
      modelName: modelName || undefined,
      presetKey: presetKey || undefined,
      providerName: providerName || preset?.name || 'Unknown',
      providerMeta: meta ? { apiKeyUrl: meta.apiKeyUrl, docsUrl: meta.docsUrl, pricingUrl: meta.pricingUrl } : undefined,
    });

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to test connection', details: String(err) } as ErrorResponse,
      { status: 500 },
    );
  }
}
