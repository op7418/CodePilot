import { NextRequest, NextResponse } from 'next/server';
import { setDefaultProviderId, getProvider } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    const { provider_id } = await request.json();

    if (!provider_id || typeof provider_id !== 'string') {
      return NextResponse.json({ error: 'provider_id is required' }, { status: 400 });
    }

    // Verify provider exists
    const provider = getProvider(provider_id);
    if (!provider) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    }

    setDefaultProviderId(provider_id);
    return NextResponse.json({ success: true, provider_id });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to set default provider';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
