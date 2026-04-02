import { NextRequest, NextResponse } from 'next/server';
import { readDashboard, updateWidget } from '@/lib/dashboard-store';
import { resolveGlobs, readSourceFiles } from '@/lib/dashboard-file-reader';
import { executeCLISource } from '@/lib/dashboard-cli-reader';
import { generateTextViaSdk } from '@/lib/claude-client';
import type { DashboardWidget } from '@/types/dashboard';

const REFRESH_SYSTEM_PROMPT = `You are updating a dashboard widget with fresh data. Your job is to preserve the visual design, layout, colors, and style of the original widget EXACTLY, and only update the data-driven content.

Rules:
1. Output ONLY the raw HTML string. No markdown fences, no explanation, no wrapping.
2. Keep all CSS, SVG structure, JavaScript logic, and visual styling identical.
3. Only change text content, numbers, data points, labels — things that reflect the underlying data.
4. If the data hasn't meaningfully changed, output the original HTML unchanged.`;

async function refreshWidget(workDir: string, widget: DashboardWidget): Promise<DashboardWidget | null> {
  // MCP tool data sources can only be refreshed via conversation MCP tools
  if (widget.dataSource.type === 'mcp_tool') return null;

  // CLI data source: user approved this command when pinning the widget in conversation.
  // Button-triggered refresh is safe — the command is already persisted and visible.
  // (MCP auto-approval path doesn't execute commands — it delegates to bash tool.)
  if (widget.dataSource.type === 'cli') {
    const { content: cliOutput, exitCode } = executeCLISource(widget.dataSource.command, workDir);
    if (exitCode !== 0) return null;
    const prompt = `Original widget HTML:\n\`\`\`\n${widget.widgetCode.slice(0, 8000)}\n\`\`\`\n\nData contract: ${widget.dataContract}\n\nCurrent CLI output (${widget.dataSource.command}):\n${cliOutput.slice(0, 40000)}\n\nProduce the updated widget HTML. Output ONLY the raw HTML string.`;
    const result = await generateTextViaSdk({ system: REFRESH_SYSTEM_PROMPT, prompt });
    let updatedCode = result.trim();
    if (updatedCode.startsWith('```')) {
      updatedCode = updatedCode.replace(/^```(?:html)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    if (updatedCode.length < 10) return null;
    const now = new Date().toISOString();
    updateWidget(workDir, widget.id, { widgetCode: updatedCode, updatedAt: now });
    return { ...widget, widgetCode: updatedCode, updatedAt: now };
  }

  // File data source
  // No file paths → skip
  if (!widget.dataSource.paths.length) return null;

  // Resolve globs
  const resolvedPaths = resolveGlobs(workDir, widget.dataSource.paths);
  if (resolvedPaths.length === 0) return null;

  // Read source files
  const { content: fileContent, latestMtime } = readSourceFiles(workDir, resolvedPaths);

  // mtime check: skip if source files haven't changed since last update
  const widgetUpdatedAt = new Date(widget.updatedAt).getTime();
  if (latestMtime <= widgetUpdatedAt) return null;

  // Call model to update widget
  const prompt = `Original widget HTML:\n\`\`\`\n${widget.widgetCode.slice(0, 8000)}\n\`\`\`\n\nData contract: ${widget.dataContract}\n\nCurrent data from source files:\n${fileContent.slice(0, 40000)}\n\nProduce the updated widget HTML. Output ONLY the raw HTML string.`;

  const result = await generateTextViaSdk({
    system: REFRESH_SYSTEM_PROMPT,
    prompt,
  });

  // Strip markdown fences if model adds them
  let updatedCode = result.trim();
  if (updatedCode.startsWith('```')) {
    updatedCode = updatedCode.replace(/^```(?:html)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  if (updatedCode.length < 10) return null; // sanity check

  const now = new Date().toISOString();
  updateWidget(workDir, widget.id, { widgetCode: updatedCode, updatedAt: now });

  return { ...widget, widgetCode: updatedCode, updatedAt: now };
}

/** POST /api/dashboard/refresh — refresh one or all widgets */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { workingDirectory, widgetId } = body;

    if (!workingDirectory) {
      return NextResponse.json({ error: 'Missing workingDirectory' }, { status: 400 });
    }

    const config = readDashboard(workingDirectory);
    const widgetsToRefresh = widgetId
      ? config.widgets.filter(w => w.id === widgetId)
      : config.widgets;

    const results: { id: string; updated: boolean; widget?: DashboardWidget }[] = [];

    for (const widget of widgetsToRefresh) {
      try {
        const updated = await refreshWidget(workingDirectory, widget);
        results.push({
          id: widget.id,
          updated: !!updated,
          widget: updated || widget,
        });
      } catch (e) {
        console.warn(`[dashboard/refresh] Failed to refresh widget ${widget.id}:`, e);
        results.push({ id: widget.id, updated: false, widget });
      }
    }

    // Re-read the config after all updates
    const updatedConfig = readDashboard(workingDirectory);
    return NextResponse.json({ config: updatedConfig, results });
  } catch (e) {
    console.error('[dashboard/refresh] POST failed:', e);
    return NextResponse.json({ error: 'Failed to refresh dashboard' }, { status: 500 });
  }
}
