import { NextResponse } from 'next/server';

/**
 * Retained as an explicit tombstone for older Renderer bundles. CLI updates
 * are now Main-owned and only accept a provider enum over authenticated IPC;
 * this same-origin HTTP surface must never execute an installer again.
 */
export async function POST() {
  return NextResponse.json(
    { success: false, errorCode: 'deprecated_cli_update_endpoint' },
    { status: 410 },
  );
}
