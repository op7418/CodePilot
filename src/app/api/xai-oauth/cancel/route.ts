import { NextResponse } from 'next/server';
import { cancelXaiOAuthFlow } from '@/lib/xai-oauth-manager';

export async function POST() {
  await cancelXaiOAuthFlow();
  return NextResponse.json({ success: true });
}
