import { NextRequest, NextResponse } from 'next/server';
import { startXaiBrowserFlow, startXaiDeviceFlow } from '@/lib/xai-oauth-manager';

export async function GET(request: NextRequest) {
  try {
    const method = request.nextUrl.searchParams.get('method') || 'browser';
    if (method === 'device') {
      const { authorization, completion } = await startXaiDeviceFlow();
      completion.catch(error => {
        if (!String(error).includes('cancelled')) console.warn('[xai-oauth] Device login did not complete:', error);
      });
      return NextResponse.json({
        method: 'device',
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        verificationUriComplete: authorization.verificationUriComplete,
        expiresIn: authorization.expiresIn,
        interval: authorization.interval,
      });
    }
    if (method !== 'browser') {
      return NextResponse.json({ error: 'method must be browser or device' }, { status: 400 });
    }
    const { authUrl, completion } = await startXaiBrowserFlow();
    completion.catch(error => {
      if (!String(error).includes('cancelled')) console.warn('[xai-oauth] Browser login did not complete:', error);
    });
    return NextResponse.json({ method: 'browser', authUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start xAI OAuth';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
