import { NextResponse } from 'next/server';
import {
  cancelXaiOAuthFlow,
  clearXaiOAuthTokens,
  getXaiOAuthStatus,
} from '@/lib/xai-oauth-manager';

export async function GET() {
  return NextResponse.json(getXaiOAuthStatus());
}

export async function DELETE() {
  await cancelXaiOAuthFlow();
  clearXaiOAuthTokens();
  return NextResponse.json({ success: true, accountUrl: 'https://accounts.x.ai' });
}
