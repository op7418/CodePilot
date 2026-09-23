/**
 * Capability display text — Phase 5e Phase 3 review round 7 fix
 * (2026-05-18 user feedback).
 *
 * **User-facing layer.** Settings UI MUST read from here, NOT from
 * `capability-contract.ts` `displayName` / `deferredReason` /
 * `statusLine`. Those fields are the engineering contract (machine
 * identifiers, drift-detection references) and would leak words
 * like "MCP" / "bridge not yet implemented" / "permission round-trip
 * design" / "Phase 5d slice 7" into the user-visible clipboard.
 *
 * Rules baked in:
 *
 *   1. Two-language strings (zh + en). UI picks via the active i18n
 *      locale. No template interpolation server-side — keeps the
 *      strings server-rendered + browser-safe.
 *
 *   2. **Capability ids exactly mirror `capability-contract.ts`.**
 *      The contract test in
 *      `capability-display-text-coverage.test.ts` walks
 *      `HARNESS_CAPABILITIES` and asserts every id has display text.
 *      Adding a new capability is a two-file change.
 *
 *   3. **Reasons describe outcomes, not architecture.** "当前引擎不
 *      能直接调用 CodePilot 的看板工具，请切到 CodePilot 使用"
 *      — that's the shape. NOT "Codex bridge not yet implemented",
 *      NOT "permission contract pending". The user doesn't care
 *      about our wire layering; they care whether the button works.
 *
 *   4. Client-safe: this file does NOT import any module that pulls
 *      Node-only deps (MCP factories, db, fs). Server + client both
 *      load it.
 */

import type { RuntimeId } from '@/lib/runtime/runtime-id';
import { getRuntimeDisplayName } from '@/lib/runtime/runtime-catalog';

export interface BilingualText {
  readonly zh: string;
  readonly en: string;
}

export interface CapabilityDisplay {
  /** Short label shown next to the status icon. Action-oriented when
   *  natural (e.g. "生成 Widget" not "Widget System"). */
  readonly label: BilingualText;
  /** Optional one-liner shown under the label inside the Dialog. */
  readonly description?: BilingualText;
}

function runtimeLabel(runtimeId: RuntimeId, lang: 'zh' | 'en'): string {
  return getRuntimeDisplayName(runtimeId, lang);
}

const CAPABILITY_DISPLAY: Readonly<Record<string, CapabilityDisplay>> = {
  widget: {
    label: { zh: '生成 Widget', en: 'Generate Widget' },
    description: {
      zh: '让模型生成交互卡片或图表，直接在对话里展示。',
      en: 'Generates interactive cards or charts inline in chat.',
    },
  },
  memory: {
    label: { zh: '读取工作区记忆', en: 'Read workspace memory' },
    description: {
      zh: '搜索与读取当前工作区的记忆，并查看来源。',
      en: 'Search and read current workspace memories with sources.',
    },
  },
  memory_write: {
    label: { zh: '保存与修改记忆', en: 'Save and change memory' },
    description: {
      zh: '按当前权限保存、更正或遗忘工作区记忆；只读规划时不可写入。',
      en: 'Save, correct or forget workspace memories under the current permissions; unavailable in read-only planning.',
    },
  },
  tasks_and_notify: {
    label: { zh: '定时任务与提醒', en: 'Scheduled tasks & notifications' },
    description: {
      zh: '创建定时任务、发送系统通知 / Telegram 提醒。',
      en: 'Schedule tasks, send system notifications / Telegram alerts.',
    },
  },
  assistant_buddy: {
    label: { zh: '助理伙伴', en: 'Assistant buddy' },
    description: {
      zh: '孵化或命名你的助理伙伴。',
      en: 'Hatch or name your assistant buddy.',
    },
  },
  image_generation: {
    label: { zh: '生成媒体', en: 'Generate media' },
    description: {
      zh: '调用图像或视频生成模型，生成结果直接出现在聊天里。',
      en: 'Calls an image or video generation model; results appear inline in chat.',
    },
  },
  media_import: {
    label: { zh: '导入媒体', en: 'Import media' },
    description: {
      zh: '把本地图片 / 视频 / 音频导入媒体库，后续可引用。',
      en: 'Import a local image / video / audio file into the media library.',
    },
  },
  dashboard: {
    label: { zh: '看板操作', en: 'Dashboard operations' },
    description: {
      zh: '把 Widget 固定到看板、列出 / 刷新 / 移除已固定项。',
      en: 'Pin widgets to dashboard, list / refresh / remove pinned items.',
    },
  },
  cli_tools: {
    label: { zh: 'CLI 工具管理', en: 'CLI tools management' },
    description: {
      zh: '查看、安装、更新或卸载本机 CLI 工具。',
      en: 'List, install, update, or remove local CLI tools.',
    },
  },
};

/** Public lookup. Returns `undefined` for unknown capability ids so
 *  the caller can fall back gracefully (UI shows the raw id as
 *  fallback rather than crashing). Coverage test pins that every
 *  catalog id has an entry. */
export function getCapabilityDisplay(capabilityId: string): CapabilityDisplay | undefined {
  return CAPABILITY_DISPLAY[capabilityId];
}

/** Iterate all known capability ids — used by the coverage test. */
export function knownCapabilityIds(): readonly string[] {
  return Object.keys(CAPABILITY_DISPLAY);
}

/**
 * Build the user-facing reason string for a capability that is NOT
 * executable on the current Runtime. The output is plain user
 * language — no MCP / bridge / phase references.
 *
 * Examples (zh):
 *   "当前引擎 (Codex) 暂不支持「看板操作」。如需使用，请切到 CodePilot 或 Claude Code。"
 *   "当前引擎不支持「助理伙伴」。如需使用，请切到 Claude Code。"
 *   "当前引擎暂不支持「CLI 工具管理」。"
 */
export function buildUserReason(args: {
  readonly capabilityId: string;
  readonly currentRuntime: RuntimeId;
  /** Suggested Runtime that CAN execute the capability. `undefined`
   *  means no Runtime supports it (rare — most "unsupported" cells
   *  are perception-only somewhere). */
  readonly suggestedRuntimes: readonly RuntimeId[];
  readonly lang: 'zh' | 'en';
}): string {
  const display = CAPABILITY_DISPLAY[args.capabilityId];
  const labelText = display?.label[args.lang] ?? args.capabilityId;

  if (args.lang === 'zh') {
    const current = runtimeLabel(args.currentRuntime, 'zh');
    if (args.suggestedRuntimes.length === 0) {
      return `当前引擎（${current}）暂不支持「${labelText}」。`;
    }
    const list = args.suggestedRuntimes
      .map((r) => runtimeLabel(r, 'zh'))
      .join(' 或 ');
    return `当前引擎（${current}）不能直接调用「${labelText}」。如需使用，请切到 ${list}。`;
  }
  const current = runtimeLabel(args.currentRuntime, 'en');
  if (args.suggestedRuntimes.length === 0) {
    return `“${labelText}” isn’t available in the current engine (${current}).`;
  }
  const list = args.suggestedRuntimes
    .map((r) => runtimeLabel(r, 'en'))
    .join(' or ');
  return `The current engine (${current}) cannot call “${labelText}” directly. Switch to ${list} to use it.`;
}

/** Standard "callable" status line — kept here so the matrix
 *  derivation doesn't need to know about bilingual strings. */
export const CALLABLE_STATUS_LINE: BilingualText = {
  zh: '可调用',
  en: 'Callable',
};

/**
 * Codex Account override note for the dialog header — explains that
 * the Codex side has its OWN native plugins / Skills (managed by
 * Codex itself), and the list below ONLY describes whether CodePilot
 * Harness capabilities can be injected.
 */
export const CODEX_ACCOUNT_HEADER_NOTE: BilingualText = {
  zh:
    'Codex 自带的插件 / Skills 由 Codex 自己管理，下方清单仅展示 CodePilot 这一侧的内置能力是否能被注入或调用。当前默认服务商是 Codex Account，CodePilot 工具桥在这条路径上不可用。',
  en:
    'Codex’s own plugins / Skills are managed by Codex itself. The list below only describes whether CodePilot’s built-in Harness can be injected or called. Codex Account is your current default provider, so the CodePilot tool bridge is not active on this path.',
};

// ─────────────────────────────────────────────────────────────────────
// Phase 5e round 8 (2026-05-18) — user-extensions section.
//
// The built-in capability matrix above describes CodePilot's first-
// party capabilities (widget / memory / tasks / image / media /
// dashboard / cli_tools / assistant_buddy). User-defined extensions
// (MCP servers configured in CodePilot Settings or project .mcp.json,
// .claude/skills, .claude/commands slash commands, project CLAUDE.md
// workspace rules) are a SEPARATE concern — their executability per
// Runtime is summarized here for the Settings → Runtime dialog.
//
// We intentionally do NOT inject these into HARNESS_CAPABILITIES /
// the capability matrix: those structures are the engineering source
// of truth for tool-name → MCP/SDK exposure for the built-in tools,
// and a synthetic "extensions" row there would break the
// capability-matrix derivation contract test ("every cell references
// a real capability in HARNESS_CAPABILITIES").
// ─────────────────────────────────────────────────────────────────────

export type UserExtensionsStatus = 'executable' | 'partial' | 'perception_only';

export interface UserExtensionsSummary {
  readonly runtimeId: RuntimeId;
  readonly status: UserExtensionsStatus;
  readonly label: BilingualText;
  readonly description: BilingualText;
}

/**
 * Per-Runtime user-extensions executability summary. The runtime-
 * specific copy mirrors `user-codepilot-extensions.ts:executableForKind`
 * (which is the engineering source of truth) — both must agree.
 *
 * Tests pin that:
 *   - claude_code → executable (mcp_server + skill + slash_command + workspace_rule all wire)
 *   - codepilot_runtime → partial (mcp_server + workspace_rule wire; skill + slash are CC-only)
 *   - codex_runtime → perception_only (workspace_rule cross-runtime as text; mcp/skill/slash not on this path)
 */
export const USER_EXTENSIONS_SUMMARY: Record<RuntimeId, UserExtensionsSummary> = {
  claude_code: {
    runtimeId: 'claude_code',
    status: 'executable',
    label: { zh: '用户自定义 MCP / Skills', en: 'User MCP / Skills' },
    description: {
      zh: 'Settings 里配置的 MCP / 项目 .mcp.json / .claude/skills / .claude/commands 斜杠命令 / 项目 CLAUDE.md 都可被调用或读取。',
      en: 'Settings-configured MCP, project .mcp.json, .claude/skills, .claude/commands slash commands, and project CLAUDE.md are all available.',
    },
  },
  codepilot_runtime: {
    runtimeId: 'codepilot_runtime',
    status: 'partial',
    label: { zh: '用户自定义 MCP / Skills', en: 'User MCP / Skills' },
    description: {
      zh: 'Settings / 项目 .mcp.json 的 MCP 服务器与项目 CLAUDE.md 可用；.claude/skills 与 .claude/commands 斜杠命令是 Claude Code 专属，如需使用请切到 Claude Code。',
      en: 'Settings / project .mcp.json MCP servers and project CLAUDE.md are wired; .claude/skills and .claude/commands slash commands are Claude Code-only — switch to Claude Code to use them.',
    },
  },
  codex_runtime: {
    runtimeId: 'codex_runtime',
    status: 'perception_only',
    label: { zh: '用户自定义 MCP / Skills', en: 'User MCP / Skills' },
    description: {
      zh: '项目 CLAUDE.md 作为文本提示对模型仍可见；但用户自定义 MCP / Skills / 斜杠命令在 Codex 这条路径上无法调用。如需使用，请切到 Claude Code 或 CodePilot。',
      en: 'Project CLAUDE.md is still visible to the model as a text prompt, but user-defined MCP servers / Skills / slash commands cannot be called on the Codex path. Switch to Claude Code or CodePilot to use them.',
    },
  },
};

/** Convenience lookup with a defensive default — returns the codex
 *  variant as the conservative fallback if an unknown runtime id is
 *  passed (better to say "limited" than to overclaim). */
export function getUserExtensionsSummary(runtimeId: RuntimeId): UserExtensionsSummary {
  return USER_EXTENSIONS_SUMMARY[runtimeId] ?? USER_EXTENSIONS_SUMMARY.codex_runtime;
}

// ─────────────────────────────────────────────────────────────────────
// Phase 5e round 8 (2026-05-18) — inline tool-blocked hint.
//
// When the model tries to call a `codepilot_*` built-in tool that
// isn't available on the active Runtime (e.g. dashboard / cli_tools
// on Codex Runtime via provider proxy), the runtime layer surfaces
// the failure as a tool_result with is_error=true. The chat UI shows
// the error block, but without context the user has no idea WHY the
// tool isn't there or HOW to use it. This helper produces a one-line
// hint to attach below the tool result.
//
// Per user direction (round 8): "在聊天内容的下方用一个小字去提醒。
// 不要随便一个提醒都用一个非常大的弹窗" — small inline text, never a
// modal.
//
// Static map (NOT derived from HARNESS_CAPABILITIES at runtime —
// capability-contract.ts pulls server-only MCP factory imports and
// can't load in the browser). A coverage test pins this map against
// HARNESS_CAPABILITIES.toolNames at unit-test time, so adding a new
// tool fails CI without a display-text update.
// ─────────────────────────────────────────────────────────────────────

/** Map of every `codepilot_*` built-in tool name → its owning
 *  capability id. Coverage test pins this against
 *  `HARNESS_CAPABILITIES.toolNames`. */
export const TOOL_NAME_TO_CAPABILITY_ID: Readonly<Record<string, string>> = {
  // widget
  codepilot_load_widget_guidelines: 'widget',
  // memory
  codepilot_memory_recent: 'memory',
  codepilot_memory_search: 'memory',
  codepilot_memory_get: 'memory',
  codepilot_memory_remember: 'memory_write',
  codepilot_memory_update: 'memory_write',
  codepilot_memory_forget: 'memory_write',
  // tasks_and_notify
  codepilot_notify: 'tasks_and_notify',
  codepilot_schedule_task: 'tasks_and_notify',
  codepilot_list_tasks: 'tasks_and_notify',
  codepilot_cancel_task: 'tasks_and_notify',
  // assistant_buddy (ClaudeCode SDK only)
  codepilot_hatch_buddy: 'assistant_buddy',
  // image_generation
  codepilot_generate_image: 'image_generation',
  codepilot_generate_video: 'image_generation',
  // media_import
  codepilot_import_media: 'media_import',
  // dashboard (claude_code + codepilot_runtime only)
  codepilot_dashboard_pin: 'dashboard',
  codepilot_dashboard_list: 'dashboard',
  codepilot_dashboard_refresh: 'dashboard',
  codepilot_dashboard_update: 'dashboard',
  codepilot_dashboard_remove: 'dashboard',
  // cli_tools (claude_code + codepilot_runtime only)
  codepilot_cli_tools_list: 'cli_tools',
  codepilot_cli_tools_install: 'cli_tools',
  codepilot_cli_tools_add: 'cli_tools',
  codepilot_cli_tools_remove: 'cli_tools',
  codepilot_cli_tools_check_updates: 'cli_tools',
  codepilot_cli_tools_update: 'cli_tools',
};

/** Which Runtimes can execute each capability. Mirrors the matrix
 *  derivation in `capability-matrix.ts` (which derives from
 *  `capability-contract.ts:exposure.kind`). A coverage test pins
 *  this against the runtime matrix. */
export const CAPABILITY_EXECUTABLE_RUNTIMES: Readonly<Record<string, readonly RuntimeId[]>> = {
  widget: ['claude_code', 'codepilot_runtime', 'codex_runtime'],
  memory: ['claude_code', 'codepilot_runtime', 'codex_runtime'],
  memory_write: ['claude_code', 'codepilot_runtime', 'codex_runtime'],
  tasks_and_notify: ['claude_code', 'codepilot_runtime', 'codex_runtime'],
  image_generation: ['claude_code', 'codepilot_runtime', 'codex_runtime'],
  media_import: ['claude_code', 'codepilot_runtime', 'codex_runtime'],
  // Phase 5e round 8 follow-up (2026-05-18) — Native parity shipped;
  // assistant_buddy now executable on Claude Code + CodePilot Native.
  // Codex Runtime proxy still doesn't bridge the hatch flow.
  assistant_buddy: ['claude_code', 'codepilot_runtime'],
  // Codex review P1 (2026-05-28) — dashboard + cli_tools now reach
  // codex_runtime via the mutation-level MCP split (read auto / write
  // approval). The capability-matrix layer promotes the cells; the static
  // map mirrors that so the cross-check coverage test stays green.
  dashboard: ['claude_code', 'codepilot_runtime', 'codex_runtime'],
  cli_tools: ['claude_code', 'codepilot_runtime', 'codex_runtime'],
};

/**
 * Phase 8 Phase 4 (2026-05-27) — optional bilingual caveats shown under a
 * capability REGARDLESS of status (keyed by `CapabilityMatrixCell.noteKey`).
 * Used when a capability is executable at the Runtime layer but carries an
 * honest behavioral caveat. Outcome-oriented per this file's rules — no
 * internal wire vocabulary (no "MCP injection" / phase numbers in copy).
 */
export const CAPABILITY_NOTES: Readonly<Record<string, BilingualText>> = {
  memory_codex_native: {
    zh: 'Memory 已接入 Codex，模型可在需要时调用。',
    en: 'Memory is wired into Codex; the model can call it when needed.',
  },
  widget_codex_native: {
    zh: 'Widget 已接入 Codex，模型可生成可渲染的 Widget（支持固定、导出 PNG、查看代码）。',
    en: 'Widget is wired into Codex; the model can generate renderable widgets (pin, export PNG, view code).',
  },
  tasks_codex_native: {
    zh: '任务与通知已接入 Codex，模型可在需要时调用；调用前会请你确认，拒绝则不会执行。',
    en: 'Tasks & notifications are wired into Codex; the model can use them when needed. It asks for your confirmation first — if you decline, nothing runs.',
  },
  dashboard_codex_native: {
    zh: '仪表盘已接入 Codex：查看与刷新自动可用；钉、修改、移除会请你确认。',
    en: 'Dashboard is wired into Codex: viewing and refreshing run automatically; pinning, updating, and removing ask for your confirmation first.',
  },
  cli_tools_codex_native: {
    zh: 'CLI 工具管理已接入 Codex：查看与检查更新自动可用；安装、添加、卸载、更新会请你确认。',
    en: 'CLI tools management is wired into Codex: listing and checking updates run automatically; install, add, remove, and update ask for your confirmation first.',
  },
};

export function getCapabilityNote(noteKey: string, lang: 'zh' | 'en'): string | undefined {
  return CAPABILITY_NOTES[noteKey]?.[lang];
}

/** Error-content patterns that the runtime layer emits when the
 *  model called a tool not in its toolset. Narrow on purpose —
 *  legitimate runtime errors (API key invalid, rate limit, etc.)
 *  should NOT trigger a "switch runtime" hint, so we only fire on
 *  patterns that genuinely mean "this tool isn't here". Each
 *  runtime emits slightly different copy; pattern keeps regex
 *  case-insensitive and tolerant of whitespace. */
const UNSUPPORTED_TOOL_ERROR_RE =
  /tool\s+(?:not\s+found|unsupported|not\s+available|not\s+registered)|unknown\s+tool|no\s+such\s+tool|tool\s+["'][^"']+["']\s+(?:not\s+found|is\s+not\s+available)/i;

/** Was this tool error caused by the tool not existing on the
 *  current Runtime? (vs a legitimate runtime error from the tool
 *  itself.) Returns false on undefined inputs so callers can
 *  defensively `??` without crashing. */
export function isToolUnsupportedError(args: {
  readonly toolName: string | undefined;
  readonly errorContent: string | undefined;
  readonly isError: boolean | undefined;
}): boolean {
  if (!args.isError) return false;
  if (!args.toolName || !args.errorContent) return false;
  // Only fire for our `codepilot_*` tools — the only ones whose
  // availability the matrix can speak to. Third-party MCP tool
  // errors are passed through unchanged.
  if (!TOOL_NAME_TO_CAPABILITY_ID[args.toolName]) return false;
  return UNSUPPORTED_TOOL_ERROR_RE.test(args.errorContent);
}

export interface ToolUnsupportedHint {
  readonly capabilityId: string;
  readonly capabilityLabel: BilingualText;
  readonly suggestedRuntimes: readonly RuntimeId[];
  readonly hint: BilingualText;
}

/** Build the inline hint shown below a tool result that errored
 *  because the tool isn't supported on the active Runtime. Returns
 *  `null` if the tool name isn't in our catalog (defensive — UI
 *  falls back to just the raw error). */
export function buildToolUnsupportedHint(toolName: string): ToolUnsupportedHint | null {
  const capabilityId = TOOL_NAME_TO_CAPABILITY_ID[toolName];
  if (!capabilityId) return null;
  const display = CAPABILITY_DISPLAY[capabilityId];
  if (!display) return null;
  const runtimes = CAPABILITY_EXECUTABLE_RUNTIMES[capabilityId] ?? [];

  const runtimeLabelsZh = runtimes.map((r) => runtimeLabel(r, 'zh')).join(' 或 ');
  const runtimeLabelsEn = runtimes.map((r) => runtimeLabel(r, 'en')).join(' or ');

  const hintZh = runtimes.length
    ? `这个工具属于「${display.label.zh}」，需要在 ${runtimeLabelsZh} 上才能调用。`
    : `这个工具属于「${display.label.zh}」，当前所有引擎都暂不支持。`;
  const hintEn = runtimes.length
    ? `This tool is part of “${display.label.en}” — switch to ${runtimeLabelsEn} to use it.`
    : `This tool is part of “${display.label.en}” and is not callable on any engine right now.`;

  return {
    capabilityId,
    capabilityLabel: display.label,
    suggestedRuntimes: runtimes,
    hint: { zh: hintZh, en: hintEn },
  };
}
