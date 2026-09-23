/**
 * builtin-tools/index.ts — Registry of built-in MCP-equivalent tools for Native Runtime.
 *
 * These tools provide the same capabilities as the 7 built-in MCP servers
 * (notification, memory, dashboard, cli-tools, media, image-gen, widget)
 * but packaged as Vercel AI SDK tools for the Native Runtime.
 *
 * Phase 5d Phase 2 slice 2d (2026-05-17) — `getBuiltinTools` now
 * delegates system-prompt assembly to the Harness Context Compiler.
 * Per-group `systemPrompt` fields stay declared (they document the
 * canonical fragment for that group) but are NOT directly returned
 * to callers; the compiler produces the final ordered + de-duplicated
 * prompt string from the capability catalog. This keeps Native
 * adapter "only adapt compiler output" — gating decisions stay in
 * this file (workspace / keyword / always), prompt text comes from
 * the compiler.
 *
 * Migration status:
 * ✅ notification (4 tools) — fully migrated
 * ✅ memory-search (3 tools) — fully migrated
 * ✅ dashboard (5 tools) — fully migrated
 * ✅ media (2 tools: import + generate) — fully migrated
 * ✅ widget-guidelines (1 tool) — fully migrated
 * ✅ cli-tools (6 tools) — fully migrated
 */

import type { ToolSet } from 'ai';
import { canWriteSessionMemory, getSessionMemoryWorkspace } from '@/lib/memory-binding';
import { adaptForNative } from '@/lib/harness/runtime-adapter';
import { shouldSkipPermission } from '@/lib/harness/mutation-level';
import { createMediaTools, MEDIA_SYSTEM_PROMPT } from './media';
import { createMemorySearchTools, MEMORY_SEARCH_SYSTEM_PROMPT } from './memory-search';

export interface BuiltinToolGroup {
  name: string;
  systemPrompt: string;
  condition: 'always' | 'workspace' | { keywords: RegExp };
  tools: ToolSet;
}

export interface GetBuiltinToolsOptions {
  workspacePath?: string;
  prompt?: string;
  /**
   * Originating chat session id — plumbed through to
   * `createNotificationTools` so codepilot_schedule_task knows which
   * chat session the task is being created from. Mirrors the SDK
   * MCP variant in claude-client.ts.
   */
  sessionId?: string;
  /** Active chat provider. Grok Build OAuth routes image generation to Imagine. */
  providerId?: string;
  /** Test seam; production resolves this from the current OAuth bundle. */
  grokVideoAvailable?: boolean;
  /**
   * #26: when true, mount only permission-safe (read-only) tools and emit
   * only their capability prompts. Plan / read-only mode uses this so the
   * Native Agent keeps safe_read Harness capabilities (widget guidelines,
   * memory reads) WITHOUT mutating tools (image gen / dashboard / schedule /
   * notify / media import). See assembleTools('plan').
   */
  safeReadOnly?: boolean;
}

/**
 * Map a builtin-tool group `name` to the capability ids from
 * `src/lib/harness/capability-contract.ts`. Drives the
 * `enabledCapabilities` set the compiler consumes when this function
 * decides a group is active.
 *
 * Returns an array because one group can mount tools that belong to
 * multiple capabilities (e.g. `codepilot-media` mounts both
 * `codepilot_import_media` → media_import AND
 * `codepilot_generate_image` → image_generation). The compiler then
 * emits fragments + tool descriptors for every returned id.
 *
 * Empty array = the group is not capability-tracked yet (Phase 4
 * candidates like session-search / ask-user-question whose prompts
 * haven't earned a capability contract entry).
 */
function capabilityIdsForGroup(groupName: string): readonly string[] {
  switch (groupName) {
    case 'codepilot-notify':
      // Phase 5e round 8 follow-up (2026-05-18) — same pattern as the
      // round 5 media fix below: `createNotificationTools` mounts
      // BOTH the task/notify quartet (notify / schedule_task /
      // list_tasks / cancel_task → tasks_and_notify) AND
      // `codepilot_hatch_buddy` (→ assistant_buddy). Returning only
      // `tasks_and_notify` would leak the same "tool exists at
      // runtime but the compiler doesn't know about its capability"
      // gap the media fix sealed: Settings would show Native as
      // supporting assistant_buddy, the Native ToolSet would actually
      // carry codepilot_hatch_buddy, but the Context Compiler would
      // never emit the assistant_buddy fragment / tool descriptor /
      // runtime hint. Two ids keeps the compiler contract aligned
      // with what Native actually mounts.
      return ['tasks_and_notify', 'assistant_buddy'];
    case 'codepilot-memory':
      return ['memory', 'memory_write'];
    case 'codepilot-widget-guidelines':
      return ['widget'];
    case 'codepilot-dashboard':
      return ['dashboard'];
    case 'codepilot-media':
      // Phase 5d Phase 2 P1 fix (2026-05-17) — pre-fix this returned
      // only 'media_import' but the underlying `createMediaTools()`
      // mounts BOTH the import tool AND `codepilot_generate_image`.
      // That meant the compiler's enabledCapabilities / toolDescriptors
      // / future runtimeHints.native.toolSetKeys never knew about
      // image_generation on the Native runtime even though the tool
      // was registered and callable. Returning both keeps the
      // compiler contract aligned with what Native actually exposes.
      return ['media_import', 'image_generation'];
    case 'codepilot-cli-tools':
      return ['cli_tools'];
    case 'codepilot-session-search':
    case 'codepilot-ask-user':
      // Native-only groups without a capability contract entry yet.
      // Their per-group `systemPrompt` was never canonicalised; the
      // caller (getBuiltinTools) routes them into `nonCapabilityPrompts`
      // so they don't disappear during Phase 2.
      return [];
    default:
      return [];
  }
}

/**
 * Get all built-in tools that should be registered for the current
 * context. Returns:
 *   - `tools`: the merged AI SDK ToolSet from gated-in groups
 *   - `systemPrompts`: legacy slot kept for back-compat; index 0 is
 *     the compiler-produced canonical prompt for capability-tracked
 *     groups; additional entries (if any) are non-capability groups
 *     whose prompt isn't in the harness contract yet (e.g. session-
 *     search, ask-user-question).
 *
 * Native Runtime callers should treat `systemPrompts` as a flat
 * list to concatenate — same shape as pre-Phase-5d.
 */
export function getBuiltinTools(
  options: GetBuiltinToolsOptions,
): { tools: ToolSet; systemPrompts: string[] } {
  const tools: ToolSet = {};
  const enabledCapabilities = new Set<string>();
  const nonCapabilityPrompts: string[] = [];

  for (const group of getToolGroups(options)) {
    // Check condition (gating logic stays in the caller as the
    // compiler is a pure function and does not read filesystem /
    // keyword regex / mode state).
    if (group.condition === 'always') {
      // Always include
    } else if (group.condition === 'workspace') {
      if (!options.workspacePath) continue;
    } else if (typeof group.condition === 'object' && group.condition.keywords) {
      const text = (options.prompt || '').toLowerCase();
      if (!group.condition.keywords.test(text)) continue;
    }

    // #26: Plan / read-only mode keeps only permission-safe tools. A group
    // whose tools are all mutating contributes neither tools nor its
    // capability prompt — so Plan advertises safe_read caps (widget
    // guidelines / memory) but not image-gen / dashboard / schedule / notify.
    const groupTools = options.safeReadOnly
      ? Object.fromEntries(
          Object.entries(group.tools).filter(([name]) => shouldSkipPermission(name)),
        )
      : group.tools;
    if (Object.keys(groupTools).length === 0) continue;

    Object.assign(tools, groupTools);
    const capIds = capabilityIdsForGroup(group.name);
    if (capIds.length > 0) {
      for (const id of capIds) {
        if (id === 'memory_write' && !['codepilot_memory_remember', 'codepilot_memory_update', 'codepilot_memory_forget'].some(name => name in groupTools)) continue;
        enabledCapabilities.add(id);
      }
    } else if (group.systemPrompt) {
      // Non-capability group whose prompt hasn't been canonicalised
      // yet (session-search / ask-user-question). Keep its raw
      // systemPrompt in the legacy slot so we don't drop the
      // capability while Phase 4 is pending.
      nonCapabilityPrompts.push(group.systemPrompt);
    }
  }

  // Phase 5d Phase 3 (2026-05-17) — capability prompt assembly +
  // toolSet keys routed through the Runtime Capability Adapter.
  // Caller (this function) still owns:
  //   - tool MOUNTING (the AI SDK `ToolSet` instances live in
  //     per-group factories like `createNotificationTools`).
  //   - capability GATING (`group.condition === 'always' | 'workspace'
  //     | keyword`) — gating reads filesystem / regex / mode state
  //     which the adapter is forbidden from touching.
  //   - NON-CAPABILITY prompt slots (session-search /
  //     ask-user-question — these haven't earned a capability contract
  //     entry yet; their raw `systemPrompt` text flows through the
  //     legacy slot in the returned `systemPrompts` array).
  // Adapter owns: capability prompt text + toolSetKeys hint, both
  // sourced from the canonical capability catalog.
  //
  // Phase 5e review fix P1 #2 (2026-05-18) — scan User / External
  // Harness extensions and pass them through the adapter so the
  // Native Runtime's model sees the user's MCP / Skills / commands /
  // external framework configs in the system prompt. Scans are best-
  // effort + read-only.
  let userExtensions: ReturnType<
    typeof import('@/lib/harness/user-codepilot-extensions').scanUserCodePilotExtensions
  > = [];
  let externalExtensions: ReturnType<
    typeof import('@/lib/harness/external-framework-harness').scanExternalFrameworkExtensions
  > = [];
  let canonicalHarness: import(
    '@/lib/harness-home/runtime/repository-projection'
  ).CanonicalRuntimeHarness | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { scanUserCodePilotExtensions } = require('@/lib/harness/user-codepilot-extensions');
    userExtensions = scanUserCodePilotExtensions({
      workspacePath: options.workspacePath,
      runtimeId: 'codepilot_runtime',
    });
  } catch { /* best effort */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { scanExternalFrameworkExtensions } = require('@/lib/harness/external-framework-harness');
    // Native isn't ClaudeCode or Codex itself — flag external
    // extensions as perception-only (executable=false). Caller's
    // active framework hint is `undefined`, which the scanner
    // interprets as "no framework matches → all entries get
    // perceptionHint".
    externalExtensions = scanExternalFrameworkExtensions({});
  } catch { /* best effort */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadConfiguredHarnessHome } = require('@/lib/harness-home/runtime/configured');
    const configured = loadConfiguredHarnessHome('codepilot_runtime', {
      userPrompt: options.prompt || '',
      projectId: options.workspacePath || undefined,
    });
    if (configured.status === 'loaded') {
      canonicalHarness = configured.harness;
    } else if (configured.status === 'unavailable') {
      console.warn('[harness-home] Canonical projection unavailable', {
        runtimeId: 'codepilot_runtime',
        root: configured.root,
        reason: configured.reason,
      });
    }
  } catch (error) {
    console.warn('[harness-home] Canonical projection failed', {
      runtimeId: 'codepilot_runtime',
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const adapted = adaptForNative({
    sessionId: options.sessionId || 'native-anonymous',
    workingDirectory: options.workspacePath || undefined,
    providerId: '',
    model: '',
    userPrompt: options.prompt || '',
    enabledCapabilities,
    userExtensions,
    externalExtensions,
    canonicalHarness,
  });

  const systemPrompts: string[] = [];
  if (adapted.systemPromptText.length > 0) systemPrompts.push(adapted.systemPromptText);
  systemPrompts.push(...nonCapabilityPrompts);

  return { tools, systemPrompts };
}

function getToolGroups(options: GetBuiltinToolsOptions): BuiltinToolGroup[] {
  const groups: BuiltinToolGroup[] = [];

  const reportLoadFailure = (group: string, error: unknown) => {
    console.error('[builtin-tools] Failed to load built-in tool group', {
      group,
      reason: error instanceof Error ? error.message : String(error),
    });
  };

  // Notification tools — always available. Pass through the run
  // context so codepilot_schedule_task injects origin_session_id +
  // working_directory into /api/tasks/schedule POST body.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createNotificationTools, NOTIFICATION_SYSTEM_PROMPT } = require('./notification');
    groups.push({
      name: 'codepilot-notify',
      systemPrompt: NOTIFICATION_SYSTEM_PROMPT,
      condition: 'always',
      tools: createNotificationTools({
        sessionId: options.sessionId,
        workingDirectory: options.workspacePath,
      }),
    });
  } catch (error) { reportLoadFailure('codepilot-notify', error); }

  // Widget guidelines — keyword-gated
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createWidgetGuidelinesTools, WIDGET_SYSTEM_PROMPT } = require('./widget-guidelines');
    groups.push({
      name: 'codepilot-widget-guidelines',
      systemPrompt: WIDGET_SYSTEM_PROMPT,
      condition: 'always',
      tools: createWidgetGuidelinesTools(),
    });
  } catch (error) { reportLoadFailure('codepilot-widget-guidelines', error); }

  // Dashboard tools — keyword-gated
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createDashboardTools, DASHBOARD_SYSTEM_PROMPT } = require('./dashboard');
    groups.push({
      name: 'codepilot-dashboard',
      systemPrompt: DASHBOARD_SYSTEM_PROMPT,
      condition: 'always',
      tools: createDashboardTools(),
    });
  } catch (error) { reportLoadFailure('codepilot-dashboard', error); }

  // Media is a required, always-on Native capability. Keep this as a static
  // import so a bundling regression fails loudly at module/build time instead
  // of degrading into a model that believes it has no media tools.
  groups.push({
    name: 'codepilot-media',
    systemPrompt: MEDIA_SYSTEM_PROMPT,
    condition: 'always',
    tools: createMediaTools({
      sessionId: options.sessionId,
      workingDirectory: options.workspacePath,
      providerId: options.providerId,
      grokVideoAvailable: options.grokVideoAvailable,
    }),
  });

  // Built-in memory is assistant-bound; ordinary projects keep normal file tools.
  if (options.workspacePath && options.sessionId && getSessionMemoryWorkspace(options.sessionId, options.workspacePath)) {
    try {
      groups.push({
        name: 'codepilot-memory',
        systemPrompt: MEMORY_SEARCH_SYSTEM_PROMPT,
        condition: 'workspace',
        tools: createMemorySearchTools(options.workspacePath, { access: options.safeReadOnly ? 'read' : 'all', sourceSessionId: options.sessionId, providerId: options.providerId, authorizeWrite: () => canWriteSessionMemory(options.sessionId, options.workspacePath!) }),
      });
    } catch (error) { reportLoadFailure('codepilot-memory', error); }
  }

  // Session history search tool — always available (queries SQLite messages table)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createSessionSearchTools, SESSION_SEARCH_SYSTEM_PROMPT } = require('./session-search');
    groups.push({
      name: 'codepilot-session-search',
      systemPrompt: SESSION_SEARCH_SYSTEM_PROMPT,
      condition: 'always',
      tools: createSessionSearchTools(),
    });
  } catch (error) { reportLoadFailure('codepilot-session-search', error); }

  // AskUserQuestion — structured question UI for Native Runtime.
  // SDK Runtime has this built in; Native Runtime needs it as a builtin tool.
  // The tool goes through the permission wrapper which emits permission_request SSE,
  // and the existing AskUserQuestionUI in PermissionPrompt.tsx renders the UI.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createAskUserQuestionTools, ASK_USER_QUESTION_SYSTEM_PROMPT } = require('./ask-user-question');
    groups.push({
      name: 'codepilot-ask-user',
      systemPrompt: ASK_USER_QUESTION_SYSTEM_PROMPT,
      condition: 'always',
      tools: createAskUserQuestionTools(),
    });
  } catch (error) { reportLoadFailure('codepilot-ask-user', error); }

  // CLI tools — keyword-gated
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createCliToolsTools, CLI_TOOLS_SYSTEM_PROMPT } = require('./cli-tools');
    groups.push({
      name: 'codepilot-cli-tools',
      systemPrompt: CLI_TOOLS_SYSTEM_PROMPT,
      condition: 'always',
      tools: createCliToolsTools(),
    });
  } catch (error) { reportLoadFailure('codepilot-cli-tools', error); }

  return groups;
}
