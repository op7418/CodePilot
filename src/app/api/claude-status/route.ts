import { NextResponse } from 'next/server';
import { findClaudeBinary, getClaudeVersion } from '@/lib/platform';
import { getActiveProvider } from '@/lib/db';

export async function GET() {
  try {
    // If a non-anthropic provider is active, the Claude CLI subprocess is
    // not used at all. Return connected=true immediately with provider info
    // so the UI reflects the real connection state.
    const activeProvider = getActiveProvider();
    if (activeProvider && activeProvider.provider_type !== 'anthropic') {
      return NextResponse.json({
        connected: true,
        version: null,
        provider_name: activeProvider.name,
        provider_type: activeProvider.provider_type,
      });
    }

    const claudePath = findClaudeBinary();
    if (!claudePath) {
      return NextResponse.json({ connected: false, version: null });
    }
    const version = await getClaudeVersion(claudePath);
    return NextResponse.json({ connected: !!version, version });
  } catch {
    return NextResponse.json({ connected: false, version: null });
  }
}
