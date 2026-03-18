import { NextRequest, NextResponse } from 'next/server';
import { runDiagnosis, runLiveProbe, setLastDiagnosisResult } from '@/lib/provider-doctor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/doctor — run diagnostic probes.
 * ?live=true — also run the live probe (spawns CLI, takes up to 15s).
 * Without ?live, only runs fast static probes (~1s).
 */
export async function GET(request: NextRequest) {
  try {
    const result = await runDiagnosis();

    // Live probe is opt-in to avoid blocking the Doctor UI
    const wantLive = request.nextUrl.searchParams.get('live') === 'true';
    if (wantLive) {
      const liveResult = await runLiveProbe();
      result.probes.push(liveResult);
      // Recalculate overall severity
      if (liveResult.severity === 'error') result.overallSeverity = 'error';
      else if (liveResult.severity === 'warn' && result.overallSeverity === 'ok') result.overallSeverity = 'warn';
      result.durationMs = Date.now() - new Date(result.timestamp).getTime();
      // Update cache so export includes the live probe result
      setLastDiagnosisResult(result);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[doctor] Diagnosis failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
