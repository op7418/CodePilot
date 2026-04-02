/**
 * Dashboard — Persisted generative UI widgets as project-level dashboard cards.
 * Storage: {projectDir}/.codepilot/dashboard/dashboard.json
 */

export type DashboardDataSource =
  | { type: 'file'; paths: string[]; query?: string }
  | { type: 'mcp_tool'; serverName: string; toolName: string; args?: Record<string, unknown>; query?: string }
  | { type: 'cli'; command: string; query?: string };

export interface DashboardWidget {
  /** Unique ID: "w_{timestamp}_{random}" */
  id: string;
  title: string;
  /** Raw HTML/SVG/JS — the widget code */
  widgetCode: string;
  /** Natural language: what this widget shows and how to extract it from source data */
  dataContract: string;
  dataSource: DashboardDataSource;
  /** Traceability: which chat message this widget was pinned from */
  pinnedFrom?: { sessionId: string; messageId: string };
  createdAt: string;
  updatedAt: string;
  order: number;
}

export interface DashboardSettings {
  autoRefreshOnOpen: boolean;
}

export interface DashboardConfig {
  version: 1;
  settings: DashboardSettings;
  widgets: DashboardWidget[];
}
