import { NextRequest, NextResponse } from 'next/server';
import { readDashboard, removeWidget, updateSettings, moveWidget, reorderWidgets } from '@/lib/dashboard-store';

/** GET /api/dashboard?dir={workingDirectory} — read dashboard config */
export async function GET(req: NextRequest) {
  try {
    const dir = req.nextUrl.searchParams.get('dir');
    if (!dir) {
      return NextResponse.json({ error: 'Missing dir parameter' }, { status: 400 });
    }
    const config = readDashboard(dir);
    return NextResponse.json(config);
  } catch (e) {
    console.error('[dashboard] GET failed:', e);
    return NextResponse.json({ error: 'Failed to read dashboard' }, { status: 500 });
  }
}

/** PUT /api/dashboard — update settings or reorder widgets */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { workingDirectory, settings, widgetId, move, widgetOrder } = body;
    if (!workingDirectory) {
      return NextResponse.json({ error: 'Missing workingDirectory' }, { status: 400 });
    }
    // Absolute reorder (race-free)
    if (Array.isArray(widgetOrder)) {
      const config = reorderWidgets(workingDirectory, widgetOrder);
      return NextResponse.json(config);
    }
    // Relative reorder (legacy)
    if (widgetId && move) {
      const config = moveWidget(workingDirectory, widgetId, move);
      return NextResponse.json(config);
    }
    // Update settings
    if (settings) {
      const config = updateSettings(workingDirectory, settings);
      return NextResponse.json(config);
    }
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  } catch (e) {
    console.error('[dashboard] PUT failed:', e);
    return NextResponse.json({ error: 'Failed to update dashboard' }, { status: 500 });
  }
}

/** DELETE /api/dashboard?dir={workingDirectory}&widgetId={id} — remove a widget */
export async function DELETE(req: NextRequest) {
  try {
    const dir = req.nextUrl.searchParams.get('dir');
    const widgetId = req.nextUrl.searchParams.get('widgetId');
    if (!dir || !widgetId) {
      return NextResponse.json({ error: 'Missing dir or widgetId parameter' }, { status: 400 });
    }
    const config = removeWidget(dir, widgetId);
    return NextResponse.json(config);
  } catch (e) {
    console.error('[dashboard] DELETE failed:', e);
    return NextResponse.json({ error: 'Failed to delete widget' }, { status: 500 });
  }
}
