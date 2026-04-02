/**
 * codepilot-dashboard MCP — in-process MCP server for dashboard widget management.
 *
 * Provides tools for the AI model to directly manage the project dashboard:
 * pin widgets, list/refresh/update/remove widgets — all with full conversation context.
 *
 * Keyword-gated: registered when the conversation involves dashboard/看板 topics.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  readDashboard,
  addWidget,
  updateWidget,
  removeWidget,
  generateWidgetId,
} from '@/lib/dashboard-store';
import { resolveGlobs, readSourceFiles } from '@/lib/dashboard-file-reader';
import type { DashboardWidget, DashboardDataSource } from '@/types/dashboard';

// ── System prompt ────────────────────────────────────────────────────────────

export const DASHBOARD_MCP_SYSTEM_PROMPT = `<dashboard-capability>
You can manage the project dashboard using these tools:
- codepilot_dashboard_pin: Pin a widget to the dashboard. Provide widgetCode, title, dataContract, and data source info.
- codepilot_dashboard_list: List all pinned widgets with metadata.
- codepilot_dashboard_refresh: Read source data for a widget. Returns data for you to regenerate the widget.
- codepilot_dashboard_update: Save updated widget code, title, or data contract.
- codepilot_dashboard_remove: Remove a widget from the dashboard.

Data source types:
- file: local project files (glob patterns). Used for code stats, config, data files.
- mcp_tool: external MCP tool (e.g. Linear, Notion). Set serverName + toolName. Refresh requires calling the MCP tool in conversation.
- cli: shell command output (e.g. "git log --oneline -10"). Set the command string.

RULES:
1. When pinning, infer dataContract and dataSource from conversation context.
2. Title must be human-readable in the user's language. Never use snake_case IDs.
3. For refresh: call refresh to read source data, generate updated HTML preserving the original design, then call update to save.
4. Preserve visual design exactly during refresh — only update data-driven content.
</dashboard-capability>`;

// ── MCP Server factory ───────────────────────────────────────────────────────

export function createDashboardMcpServer(sessionId?: string, workingDirectory?: string) {
  const workDir = workingDirectory || '';

  return createSdkMcpServer({
    name: 'codepilot-dashboard',
    version: '1.0.0',
    tools: [
      // ── Pin widget ─────────────────────────────────────────────────
      tool(
        'codepilot_dashboard_pin',
        'Pin a widget to the project dashboard for persistent access. The model provides all metadata from conversation context.',
        {
          widgetCode: z.string().describe('The raw HTML/SVG/JS widget code to pin'),
          title: z.string().describe('Human-readable title in the user\'s language'),
          dataContract: z.string().describe('Natural language description of what this widget displays and how to extract data'),
          dataSourceType: z.enum(['file', 'mcp_tool', 'cli']).default('file').describe('Type of data source'),
          dataSourcePaths: z.array(z.string()).default([]).describe('For file type: relative glob patterns'),
          dataSourceQuery: z.string().optional().describe('What to extract from the source'),
          mcpServerName: z.string().optional().describe('For mcp_tool type: MCP server name'),
          mcpToolName: z.string().optional().describe('For mcp_tool type: tool name to call'),
          mcpToolArgs: z.record(z.string(), z.unknown()).optional().describe('For mcp_tool type: tool arguments'),
          cliCommand: z.string().optional().describe('For cli type: shell command to execute'),
        },
        async ({ widgetCode, title, dataContract, dataSourceType, dataSourcePaths, dataSourceQuery, mcpServerName, mcpToolName, mcpToolArgs, cliCommand }) => {
          if (!workDir) {
            return { content: [{ type: 'text' as const, text: 'Error: No working directory set.' }], isError: true };
          }

          let dataSource: DashboardDataSource;
          if (dataSourceType === 'mcp_tool' && mcpServerName && mcpToolName) {
            dataSource = { type: 'mcp_tool', serverName: mcpServerName, toolName: mcpToolName, args: mcpToolArgs, query: dataSourceQuery };
          } else if (dataSourceType === 'cli' && cliCommand) {
            dataSource = { type: 'cli', command: cliCommand, query: dataSourceQuery };
          } else {
            dataSource = { type: 'file', paths: dataSourcePaths, query: dataSourceQuery };
          }

          const now = new Date().toISOString();
          const widget: DashboardWidget = {
            id: generateWidgetId(),
            title,
            widgetCode,
            dataContract,
            dataSource,
            pinnedFrom: sessionId ? { sessionId, messageId: '' } : undefined,
            createdAt: now,
            updatedAt: now,
            order: Date.now(),
          };

          addWidget(workDir, widget);
          return {
            content: [{ type: 'text' as const, text: `Widget "${title}" pinned to dashboard (id: ${widget.id}).` }],
          };
        },
      ),

      // ── List widgets ───────────────────────────────────────────────
      tool(
        'codepilot_dashboard_list',
        'List all widgets currently pinned to the project dashboard.',
        {},
        async () => {
          if (!workDir) {
            return { content: [{ type: 'text' as const, text: 'Error: No working directory set.' }], isError: true };
          }

          const config = readDashboard(workDir);
          const widgets = config.widgets;

          if (widgets.length === 0) {
            return { content: [{ type: 'text' as const, text: 'Dashboard is empty. No widgets pinned.' }] };
          }

          const summary = widgets.map((w, i) => {
            const ds = w.dataSource;
            const sourceInfo = ds.type === 'file' ? (ds.paths.join(', ') || 'none')
              : ds.type === 'mcp_tool' ? `MCP: ${ds.serverName}/${ds.toolName}`
              : ds.type === 'cli' ? `CLI: ${ds.command}`
              : 'unknown';
            return `${i + 1}. [${w.id}] "${w.title}"\n   Data: ${w.dataContract}\n   Source (${ds.type}): ${sourceInfo}\n   Updated: ${w.updatedAt}`;
          }).join('\n\n');

          return {
            content: [{ type: 'text' as const, text: `Dashboard has ${widgets.length} widget(s):\n\n${summary}` }],
          };
        },
      ),

      // ── Refresh (read source data) ─────────────────────────────────
      tool(
        'codepilot_dashboard_refresh',
        'Read source data for a dashboard widget. For file sources, reads files and returns content. For MCP sources, tells you which tool to call. For CLI sources, returns the command for you to run via bash. After getting data, generate updated HTML and call codepilot_dashboard_update.',
        {
          widgetId: z.string().describe('The widget ID to refresh'),
        },
        async ({ widgetId }) => {
          if (!workDir) {
            return { content: [{ type: 'text' as const, text: 'Error: No working directory set.' }], isError: true };
          }

          const config = readDashboard(workDir);
          const widget = config.widgets.find(w => w.id === widgetId);
          if (!widget) {
            return { content: [{ type: 'text' as const, text: `Error: Widget "${widgetId}" not found.` }], isError: true };
          }

          const ds = widget.dataSource;

          // ── MCP tool data source: can't call directly, tell the model to do it
          if (ds.type === 'mcp_tool') {
            const result = [
              `Widget: "${widget.title}" (${widgetId})`,
              `Data contract: ${widget.dataContract}`,
              `Data source: MCP tool ${ds.serverName}/${ds.toolName}`,
              ds.args ? `Arguments: ${JSON.stringify(ds.args)}` : '',
              '',
              `To refresh this widget, call the MCP tool "${ds.toolName}" from server "${ds.serverName}"${ds.args ? ' with the arguments above' : ''}.`,
              `Then generate updated widget HTML and call codepilot_dashboard_update.`,
              '',
              `Original widget HTML (${widget.widgetCode.length} chars):`,
              '```',
              widget.widgetCode.slice(0, 8000),
              '```',
            ].filter(Boolean).join('\n');
            return { content: [{ type: 'text' as const, text: result }] };
          }

          // ── CLI data source: DO NOT execute here. Return the command for the
          // model to run via bash tool (which has its own user-visible approval).
          if (ds.type === 'cli') {
            const result = [
              `Widget: "${widget.title}" (${widgetId})`,
              `Data contract: ${widget.dataContract}`,
              `Data source: CLI command`,
              '',
              `To refresh this widget, run the following command yourself using bash:`,
              '```',
              ds.command,
              '```',
              `Then use the output to generate updated widget HTML and call codepilot_dashboard_update.`,
              '',
              `Original widget HTML (${widget.widgetCode.length} chars):`,
              '```',
              widget.widgetCode.slice(0, 8000),
              '```',
            ].join('\n');
            return { content: [{ type: 'text' as const, text: result }] };
          }

          // ── File data source: resolve globs and read files
          if (!ds.paths.length) {
            return {
              content: [{ type: 'text' as const, text: `Widget "${widget.title}" has no data source paths. It's a static widget.` }],
            };
          }

          const resolvedPaths = resolveGlobs(workDir, ds.paths);
          if (resolvedPaths.length === 0) {
            return {
              content: [{ type: 'text' as const, text: `No files matched the data source patterns: ${ds.paths.join(', ')}` }],
              isError: true,
            };
          }

          const { content: fileContent, latestMtime } = readSourceFiles(workDir, resolvedPaths);
          const widgetUpdatedAt = new Date(widget.updatedAt).getTime();
          const dataChanged = latestMtime > widgetUpdatedAt;

          const result = [
            `Widget: "${widget.title}" (${widgetId})`,
            `Data contract: ${widget.dataContract}`,
            `Data changed since last update: ${dataChanged ? 'YES' : 'NO (files unchanged)'}`,
            `Files read (${resolvedPaths.length}):`,
            fileContent,
            '',
            `Original widget HTML (${widget.widgetCode.length} chars):`,
            '```',
            widget.widgetCode.slice(0, 8000),
            '```',
            '',
            dataChanged
              ? 'Please generate updated widget HTML preserving the exact visual design, only updating data-driven content. Then call codepilot_dashboard_update with the new HTML.'
              : 'Data has not changed. No update needed unless the user specifically requests it.',
          ].join('\n');

          return { content: [{ type: 'text' as const, text: result }] };
        },
      ),

      // ── Update widget ──────────────────────────────────────────────
      tool(
        'codepilot_dashboard_update',
        'Update a dashboard widget\'s code, title, or data contract. Use after refreshing to save new widget HTML.',
        {
          widgetId: z.string().describe('The widget ID to update'),
          widgetCode: z.string().optional().describe('New HTML code for the widget'),
          title: z.string().optional().describe('New title'),
          dataContract: z.string().optional().describe('Updated data contract description'),
        },
        async ({ widgetId, widgetCode, title, dataContract }) => {
          if (!workDir) {
            return { content: [{ type: 'text' as const, text: 'Error: No working directory set.' }], isError: true };
          }

          const config = readDashboard(workDir);
          const widget = config.widgets.find(w => w.id === widgetId);
          if (!widget) {
            return { content: [{ type: 'text' as const, text: `Error: Widget "${widgetId}" not found.` }], isError: true };
          }

          const updates: Partial<DashboardWidget> = { updatedAt: new Date().toISOString() };
          if (widgetCode) updates.widgetCode = widgetCode;
          if (title) updates.title = title;
          if (dataContract) updates.dataContract = dataContract;

          updateWidget(workDir, widgetId, updates);

          const changedFields = [widgetCode && 'code', title && 'title', dataContract && 'dataContract'].filter(Boolean).join(', ');
          return {
            content: [{ type: 'text' as const, text: `Widget "${widget.title}" updated (${changedFields}).` }],
          };
        },
      ),

      // ── Remove widget ──────────────────────────────────────────────
      tool(
        'codepilot_dashboard_remove',
        'Remove a widget from the project dashboard.',
        {
          widgetId: z.string().describe('The widget ID to remove'),
        },
        async ({ widgetId }) => {
          if (!workDir) {
            return { content: [{ type: 'text' as const, text: 'Error: No working directory set.' }], isError: true };
          }

          const config = readDashboard(workDir);
          const widget = config.widgets.find(w => w.id === widgetId);
          if (!widget) {
            return { content: [{ type: 'text' as const, text: `Error: Widget "${widgetId}" not found.` }], isError: true };
          }

          removeWidget(workDir, widgetId);
          return {
            content: [{ type: 'text' as const, text: `Widget "${widget.title}" removed from dashboard.` }],
          };
        },
      ),
    ],
  });
}
