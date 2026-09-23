/**
 * Tool mutation level — Phase 5e Phase 5 (2026-05-17).
 *
 * Replaces the Phase 5e Phase 0.5 P0 止血 hand-written
 * `PERMISSION_SAFE_TOOLS` allowlist with an explicit per-tool
 * declaration. Same fail-safe semantics:
 *
 *   - `safe_read` → may skip the permission wrapper
 *   - `mutating_local` / `mutating_external` / `side_effect` →
 *     wrapper asks the user unless `bypassPermissions` is on
 *   - any tool the table does NOT classify → wrapper falls back to
 *     ask (fail-safe; no silent execution)
 *
 * Why mutationLevel and not the old prefix shortcut:
 *
 *   `name.startsWith('codepilot_')` waved through dangerous tools
 *   (`codepilot_cli_tools_install`, `codepilot_notify`, etc.). The
 *   Phase 0.5 P0 patch replaced it with a hand-maintained allowlist
 *   that listed every read-only tool. That's correct but doesn't
 *   scale — new codepilot tools have to remember to be added to the
 *   right list. mutationLevel pushes the classification onto the
 *   tool author at the point they declare the tool, which is exactly
 *   where the read/write knowledge lives.
 *
 * The actual classification table for the CURRENT tools is in
 * `CODEPILOT_TOOL_MUTATION_LEVELS` below. Phase 5 follow-up work can
 * move these declarations into each tool factory; for Phase 5e P0
 * we keep them centralised so the migration is a single review
 * point.
 */

export type MutationLevel =
  /** Reads filesystem / DB / network state; no writes, no shell, no
   *  side effects visible to the user. Wrapper skips permission
   *  check. Example: `codepilot_memory_search`. */
  | 'safe_read'
  /** Mutates state local to CodePilot (DB row, in-memory cache, UI
   *  surface). No filesystem writes outside the user's media
   *  library; no shell execution; no external API calls beyond
   *  CodePilot's own backend. Example: `codepilot_dashboard_pin`,
   *  `codepilot_schedule_task`. */
  | 'mutating_local'
  /** Shell executes, installs/uninstalls system packages, calls
   *  third-party APIs that bill the user, writes files outside the
   *  media library. The most dangerous bucket. Example:
   *  `codepilot_cli_tools_install`, `codepilot_generate_image`. */
  | 'mutating_external'
  /** User-perceivable but not state-mutating (visible
   *  notification / toast / Telegram bridge / Electron banner).
   *  Wrapper asks because the user may not want it. Example:
   *  `codepilot_notify`. */
  | 'side_effect';

/**
 * Authoritative classification of every CodePilot built-in tool.
 *
 * Adding a new `codepilot_*` tool: add an entry here. The wrapper's
 * fail-safe default + the contract test (`mutation-level-contract.test.ts`)
 * make missing entries a deterministic failure, not a silent regression.
 */
export const CODEPILOT_TOOL_MUTATION_LEVELS: Readonly<Record<string, MutationLevel>> = {
  // Memory — read-only assistant_workspace/memory/ access.
  codepilot_memory_recent: 'safe_read',
  codepilot_memory_search: 'safe_read',
  codepilot_memory_get: 'safe_read',
  codepilot_memory_remember: 'mutating_external',
  codepilot_memory_update: 'mutating_external',
  codepilot_memory_forget: 'mutating_external',

  // Widget — loads static design spec; no model state mutation.
  codepilot_load_widget_guidelines: 'safe_read',

  // Tasks/notify — read-only LIST + mutating writes.
  codepilot_list_tasks: 'safe_read',
  codepilot_schedule_task: 'mutating_local',
  codepilot_cancel_task: 'mutating_local',
  codepilot_notify: 'side_effect',
  codepilot_hatch_buddy: 'mutating_local',

  // Dashboard — read-only LIST + REFRESH; mutating pin/update/remove.
  codepilot_dashboard_list: 'safe_read',
  codepilot_dashboard_refresh: 'safe_read',
  codepilot_dashboard_pin: 'mutating_local',
  codepilot_dashboard_update: 'mutating_local',
  codepilot_dashboard_remove: 'mutating_local',

  // CLI tools — read-only LIST + CHECK; install/add/remove/update
  // shell-exec.
  codepilot_cli_tools_list: 'safe_read',
  codepilot_cli_tools_check_updates: 'safe_read',
  codepilot_cli_tools_install: 'mutating_external',
  codepilot_cli_tools_add: 'mutating_external',
  codepilot_cli_tools_remove: 'mutating_external',
  codepilot_cli_tools_update: 'mutating_external',

  // Media — generation calls third-party API + writes file;
  // import writes user file into media library.
  codepilot_generate_image: 'mutating_external',
  codepilot_generate_video: 'mutating_external',
  codepilot_import_media: 'mutating_local',

  // Session search — reads SQLite messages table.
  codepilot_session_search: 'safe_read',

  // Managed Sub Agent — spawning itself does not mutate host state. The child
  // inherits the parent permission profile, so every mutating child tool still
  // reaches the normal approval/sandbox boundary (or the user's explicit
  // full-access profile); recursive delegation is removed.
  codepilot_list_subagent_runs: 'safe_read',
  codepilot_spawn_subagent: 'safe_read',
};

/**
 * Core (non-codepilot_) read-only tools that are also safe to skip
 * the wrapper. Kept separate from the codepilot table so the
 * mutation-level audit doesn't have to know about ai-sdk built-ins.
 */
export const CORE_SAFE_READ_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'Skill',
]);

/**
 * Returns true iff the wrapper should skip the permission check for
 * this tool name. Fail-safe: unknown tools return false (route
 * through ask flow).
 */
export function shouldSkipPermission(toolName: string): boolean {
  if (CORE_SAFE_READ_TOOLS.has(toolName)) return true;
  const level = CODEPILOT_TOOL_MUTATION_LEVELS[toolName];
  return level === 'safe_read';
}

/**
 * Look up a tool's classification. Returns `undefined` for unknown
 * tools so callers can surface "uncategorised tool, fail-safe to
 * ask" to logs / observability without losing the unknown-vs-known
 * distinction.
 */
export function getMutationLevel(toolName: string): MutationLevel | undefined {
  if (CORE_SAFE_READ_TOOLS.has(toolName)) return 'safe_read';
  return CODEPILOT_TOOL_MUTATION_LEVELS[toolName];
}
