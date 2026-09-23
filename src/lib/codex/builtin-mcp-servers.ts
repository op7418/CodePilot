/**
 * Registry of CodePilot built-in MCP servers that are served to Codex over
 * the streamable-HTTP route (`/api/codex/mcp/[server]`). Phase 8 #31.
 *
 * Each entry knows how to (a) build a fresh in-process MCP server instance
 * per request (stateless) by reusing the SAME `createSdkMcpServer` the
 * ClaudeCode path uses — no duplicated tool logic, (b) authorize the HTTP
 * request, and (c) declare the elicitation policy for the model's
 * autonomous tool-call approval.
 *
 * Two independent per-server policies:
 *   - `authorize` (HTTP serving): memory reads workspace files → MUST be
 *     scoped to the configured assistant workspace; widget/tasks read no
 *     files → localhost trust.
 *   - `elicitationPolicy` (tool-call approval, Phase 8 #31): Codex sends an
 *     `mcpServer/elicitation/request` to approve each model-initiated tool
 *     call. Safe-read servers (memory, widget) `auto_accept`; servers with
 *     mutating / side-effecting tools (tasks: schedule/cancel/notify) need
 *     `user_approval` — route to the user, never auto-run.
 */

import { createMemorySearchMcpServer } from '@/lib/memory-search-mcp';
import { createWidgetMcpServer } from '@/lib/widget-guidelines';
import { createNotificationMcpServer } from '@/lib/notification-mcp';
import { createDashboardMcpServer } from '@/lib/dashboard-mcp';
import { createCliToolsMcpServer } from '@/lib/cli-tools-mcp';
import { getSetting, getSession } from '@/lib/db';
import { getSessionMemoryWorkspace, canWriteSessionMemory } from '@/lib/memory-binding';
import { sameRealPath } from './mcp-config';

/** The connectable MCP server (the `.instance` of a `createSdkMcpServer`). */
type CodexBuiltinMcpInstance = ReturnType<typeof createWidgetMcpServer>['instance'];

export type BuiltinMcpAuth =
  | { ok: true }
  | { ok: false; status: number; message: string };

/** Tool-call approval policy for a built-in server's elicitation. */
export type ElicitationPolicy = 'auto_accept' | 'user_approval';

export interface BuiltinMcpRouteCtx {
  workspacePath: string;
  sessionId: string;
}

export interface BuiltinMcpServerEntry {
  /** Codex `mcp_servers` namespace + route path segment. */
  readonly serverName: string;
  /** Tool-call approval policy (see module doc). */
  readonly elicitationPolicy: ElicitationPolicy;
  /** Build a fresh server instance for one stateless request. */
  create(ctx: BuiltinMcpRouteCtx): CodexBuiltinMcpInstance;
  /** Authorize the HTTP request before serving. */
  authorize(ctx: BuiltinMcpRouteCtx): BuiltinMcpAuth;
}

function authorizeAssistantWorkspace(workspacePath: string): BuiltinMcpAuth {
  const configured = getSetting('assistant_workspace_path');
  if (!configured || configured.trim() === '') {
    return { ok: false, status: 403, message: 'No assistant workspace configured' };
  }
  return sameRealPath(workspacePath, configured)
    ? { ok: true }
    : { ok: false, status: 403, message: 'Workspace not authorized for this MCP' };
}

export const CODEX_BUILTIN_MCP_SERVERS: Readonly<Record<string, BuiltinMcpServerEntry>> = {
  codepilot_memory: {
    serverName: 'codepilot_memory',
    elicitationPolicy: 'auto_accept', // read-only memo reads (auto_safe)
    create: ({ workspacePath, sessionId }) => createMemorySearchMcpServer(workspacePath, { access: 'read', sourceSessionId: sessionId, providerId: getSession(sessionId)?.provider_id }).instance,
    authorize: ({ workspacePath, sessionId }) => getSessionMemoryWorkspace(sessionId, workspacePath)
      ? { ok: true } : { ok: false, status: 403, message: 'Memory scope does not match session' },
  },
  codepilot_memory_write: {
    serverName: 'codepilot_memory_write',
    elicitationPolicy: 'user_approval',
    create: ({ workspacePath, sessionId }) => createMemorySearchMcpServer(workspacePath, { access: 'write', sourceSessionId: sessionId, authorizeWrite: () => canWriteSessionMemory(sessionId, workspacePath) }).instance,
    authorize: ({ workspacePath, sessionId }) => getSession(sessionId)?.mode !== 'plan' && getSessionMemoryWorkspace(sessionId, workspacePath)
      ? { ok: true } : { ok: false, status: 403, message: 'Memory write scope or permission denied' },
  },
  codepilot_widget: {
    serverName: 'codepilot_widget',
    elicitationPolicy: 'auto_accept', // static read-only guidelines text
    create: () => createWidgetMcpServer().instance,
    authorize: () => ({ ok: true }), // no file access, no workspace scope
  },
  codepilot_tasks: {
    serverName: 'codepilot_tasks',
    // schedule_task / cancel_task (mutating) + notify (side-effect) → the
    // model's call must be approved by the user, never auto-run.
    elicitationPolicy: 'user_approval',
    // `excludeTools: ['codepilot_hatch_buddy']` keeps the buddy tool off
    // Codex's tool surface. The SDK MCP also serves `codepilot_hatch_buddy`
    // to ClaudeCode SDK / Native callers; on Codex Account the capability
    // matrix says assistant_buddy = perception_only, so exposing it via this
    // route without an autonomous-call smoke would silently contradict the
    // matrix (the leak that Codex's exposure audit caught, 2026-05-28).
    create: ({ workspacePath, sessionId }) =>
      createNotificationMcpServer({
        sessionId,
        workingDirectory: workspacePath,
        excludeTools: ['codepilot_hatch_buddy'],
      }).instance,
    // No file reads; tasks are scoped by sessionId/workspace passed at create.
    authorize: () => ({ ok: true }),
  },
  // ── Dashboard split (Codex review next slice, 2026-05-28) ──────────────
  // The dashboard MCP exposes 5 tools mixing safe-read (list / refresh) and
  // mutating (pin / update / remove). Codex elicitation params identify the
  // server, not the individual tool, so per-tool policy via a single server
  // entry isn't possible — we instead expose the same factory under TWO
  // server names with disjoint `includeTools` allowlists, one auto_accept
  // and one user_approval. Both require workspace scope (dashboard reads
  // local source files via glob and writes widget state under the workspace
  // dashboard).
  codepilot_dashboard_read: {
    serverName: 'codepilot_dashboard_read',
    elicitationPolicy: 'auto_accept', // list / refresh — safe-read
    create: ({ workspacePath, sessionId }) =>
      createDashboardMcpServer(sessionId, workspacePath, {
        includeTools: ['codepilot_dashboard_list', 'codepilot_dashboard_refresh'],
      }).instance,
    authorize: ({ workspacePath }) => authorizeAssistantWorkspace(workspacePath),
  },
  codepilot_dashboard_write: {
    serverName: 'codepilot_dashboard_write',
    elicitationPolicy: 'user_approval', // pin / update / remove — mutating
    create: ({ workspacePath, sessionId }) =>
      createDashboardMcpServer(sessionId, workspacePath, {
        includeTools: [
          'codepilot_dashboard_pin',
          'codepilot_dashboard_update',
          'codepilot_dashboard_remove',
        ],
      }).instance,
    authorize: ({ workspacePath }) => authorizeAssistantWorkspace(workspacePath),
  },
  // ── CLI tools split ────────────────────────────────────────────────────
  // CLI tool management is system-wide (not workspace-scoped) so no
  // workspace authorize gate — but every mutating action (install / add /
  // remove / update) goes through user approval so the model can't silently
  // run package installs.
  codepilot_cli_tools_read: {
    serverName: 'codepilot_cli_tools_read',
    elicitationPolicy: 'auto_accept', // list / check_updates — safe-read
    create: () =>
      createCliToolsMcpServer({
        includeTools: ['codepilot_cli_tools_list', 'codepilot_cli_tools_check_updates'],
      }).instance,
    authorize: () => ({ ok: true }),
  },
  codepilot_cli_tools_write: {
    serverName: 'codepilot_cli_tools_write',
    elicitationPolicy: 'user_approval', // install / add / remove / update — mutating
    create: () =>
      createCliToolsMcpServer({
        includeTools: [
          'codepilot_cli_tools_install',
          'codepilot_cli_tools_add',
          'codepilot_cli_tools_remove',
          'codepilot_cli_tools_update',
        ],
      }).instance,
    authorize: () => ({ ok: true }),
  },
};

export function getBuiltinMcpServer(serverName: string): BuiltinMcpServerEntry | undefined {
  return CODEX_BUILTIN_MCP_SERVERS[serverName];
}
