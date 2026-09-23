/**
 * Built-in MCP capability catalog.
 *
 * Static descriptor of every in-process MCP server CodePilot ships
 * (see `src/lib/{memory-search,notification,cli-tools,dashboard,media-import,image-gen}-mcp.ts`
 * + `src/lib/widget-guidelines.ts`). The MCP Tab renders this list as a
 * read-only section above the user-managed external servers (Phase 2D.2,
 * 2026-04-30).
 *
 * Important: the actual gating logic lives in `src/lib/claude-client.ts`
 * (around the queryOptions assembly). This catalog is purely descriptive
 * — we **don't** read it to decide registration. The drift unit test
 * (`src/__tests__/unit/builtin-mcp-catalog.test.ts`) keeps `toolNames`
 * in sync with each MCP file's `tool('codepilot_...')` calls so a new
 * tool can't ship without a catalog entry.
 *
 * Why no live registration status: keyword-gating is per-message dynamic.
 * Surfacing "registered for the current session" would need a new event
 * stream from claude-client → renderer. That's Phase 2E+ scope; for now
 * we explicitly tell users the gating condition and disclaim that we
 * don't promise the MCP is loaded for any specific message.
 */
export type BuiltInMcpTriggerCondition = "always" | "workspace" | "keyword";

export interface BuiltInMcpEntry {
  /** MCP server name as registered with the SDK (`codepilot-*`). */
  name: string;
  /** i18n key for a one-line capability description. */
  descriptionKey: string;
  /** All tools this server exposes (raw function names from `tool(...)` calls). */
  toolNames: readonly string[];
  /** When this MCP gets registered into the SDK Query. */
  triggerCondition: BuiltInMcpTriggerCondition;
  /**
   * Optional i18n key for additional context on the trigger condition,
   * e.g. "in conversations mentioning images / 画图 / generate image".
   */
  triggerHintKey?: string;
}

export const BUILTIN_MCP_CATALOG: readonly BuiltInMcpEntry[] = [
  {
    name: "codepilot-notify",
    descriptionKey: "mcp.builtin.notify.description",
    toolNames: [
      "codepilot_notify",
      "codepilot_schedule_task",
      "codepilot_list_tasks",
      "codepilot_cancel_task",
      "codepilot_hatch_buddy",
    ],
    triggerCondition: "always",
  },
  {
    name: "codepilot-memory",
    descriptionKey: "mcp.builtin.memory.description",
    toolNames: [
      "codepilot_memory_search",
      "codepilot_memory_get",
      "codepilot_memory_recent",
      "codepilot_memory_remember",
      "codepilot_memory_update",
      "codepilot_memory_forget",
    ],
    triggerCondition: "workspace",
    triggerHintKey: "mcp.builtin.memory.triggerHint",
  },
  {
    name: "codepilot-image-gen",
    descriptionKey: "mcp.builtin.imageGen.description",
    toolNames: ["codepilot_generate_image", "codepilot_generate_video"],
    triggerCondition: "keyword",
    triggerHintKey: "mcp.builtin.imageGen.triggerHint",
  },
  {
    name: "codepilot-media",
    descriptionKey: "mcp.builtin.media.description",
    toolNames: ["codepilot_import_media"],
    triggerCondition: "keyword",
    triggerHintKey: "mcp.builtin.media.triggerHint",
  },
  {
    name: "codepilot-widget",
    descriptionKey: "mcp.builtin.widget.description",
    toolNames: ["codepilot_load_widget_guidelines"],
    triggerCondition: "keyword",
    triggerHintKey: "mcp.builtin.widget.triggerHint",
  },
  {
    name: "codepilot-cli-tools",
    descriptionKey: "mcp.builtin.cliTools.description",
    toolNames: [
      "codepilot_cli_tools_list",
      "codepilot_cli_tools_install",
      "codepilot_cli_tools_add",
      "codepilot_cli_tools_remove",
      "codepilot_cli_tools_check_updates",
      "codepilot_cli_tools_update",
    ],
    triggerCondition: "keyword",
    triggerHintKey: "mcp.builtin.cliTools.triggerHint",
  },
  {
    name: "codepilot-dashboard",
    descriptionKey: "mcp.builtin.dashboard.description",
    toolNames: [
      "codepilot_dashboard_pin",
      "codepilot_dashboard_list",
      "codepilot_dashboard_refresh",
      "codepilot_dashboard_update",
      "codepilot_dashboard_remove",
    ],
    triggerCondition: "keyword",
    triggerHintKey: "mcp.builtin.dashboard.triggerHint",
  },
];

/** Set of all server names registered as built-in (used by McpManager to skip
 *  rendering them in the user-editable section if they ever leak through). */
export const BUILTIN_MCP_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_MCP_CATALOG.map((e) => e.name),
);
