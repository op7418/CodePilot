// ==========================================
// Database Models
// ==========================================

import type { TitleOrigin } from '@/lib/conversation-title';
import type { SessionPermissionProfile } from '@/lib/permission/profile';
import type { PermissionReviewNotice } from '@/lib/permission/review-event';

export type { TitleOrigin };
export type { SessionPermissionProfile };

/**
 * Phase 3 Step 4 — chat session origin. Default `'user'` for normal
 * user-opened conversations; `'task'` for sessions created by the
 * agent task runner (one per ai_task). Used by `ChatListPanel` to
 * filter task-bound sessions out of the main list (only reachable
 * from `/settings/tasks` or notification click). Heartbeat doesn't
 * create new sessions — it reuses the user's buddy session — so
 * heartbeat does NOT introduce an `'assistant'` value here; that
 * dimension lives on the heartbeat task itself (`source` field).
 */
export type ChatSessionSource = 'user' | 'task';

export interface ChatSession {
  id: string;
  title: string;
  /**
   * Provenance of `title` — who wrote it and therefore who may overwrite it.
   * See `TitleOrigin` in `src/lib/conversation-title.ts` for the state machine;
   * `src/lib/db.ts#updateSessionTitle` is the only writer. Optional here because
   * rows read back from a pre-migration DB snapshot may predate the column.
   */
  title_origin?: TitleOrigin;
  created_at: string;
  updated_at: string;
  model: string;
  system_prompt: string;
  working_directory: string;
  sdk_session_id: string; // Claude Agent SDK session ID for resume
  /**
   * Phase 5 Phase 3 (2026-05-13) — Codex Runtime thread id for
   * `thread/resume`. Mirrors `sdk_session_id` semantics but scoped
   * to the codex_runtime adapter. Empty string = no Codex thread
   * established yet. UI / API code MUST NOT read this directly —
   * route through `src/lib/runtime/session-store.ts`.
   */
  codex_thread_id?: string;
  /**
   * Phase 5b (2026-05-15) — provider id the Codex thread was bound
   * to at start time. `thread/start` injects `model_providers.
   * codepilot_proxy` for one specific CodePilot provider; resuming
   * under a different provider would smuggle a stale injection back
   * in. Empty string = unknown (legacy thread or codex_account).
   * Same access discipline as `codex_thread_id`.
   */
  codex_thread_provider_id?: string;
  /**
   * Phase 8 Phase 2 (2026-05-27) — fingerprint of the `config.mcp_servers`
   * the Codex thread was started with. Resume re-checks it; a changed
   * fingerprint forces a fresh thread so a continuation can't bind to a
   * stale MCP tool set. Empty string = no MCP injected / legacy thread.
   */
  codex_thread_mcp_fingerprint?: string;
  project_name: string;
  /**
   * Phase 3 Step 4 — see `ChatSessionSource`. Stored as TEXT (default
   * `'user'`); ChatListPanel filters out `'task'` by default so
   * task-bound sessions don't pollute the user-facing list.
   */
  source?: ChatSessionSource;
  status: 'active' | 'archived';
  mode?: 'code' | 'plan' | 'ask';
  needs_approval?: boolean;
  provider_name: string;
  provider_id: string;
  /**
   * Phase 2 Step 2: per-session execution-engine pin. Empty string =
   * "follow global agent_runtime setting" (the today-default behavior).
   * `'claude_code'` / `'codepilot_runtime'` = "this session is locked
   * to that runtime regardless of subsequent global changes". The
   * send route / streamClaude / picker hook will start consuming this
   * in subsequent Phase 2 steps; today only the schema, accessor, and
   * `resolveRuntimeForSession` wrapper read it.
   */
  runtime_pin: string;
  sdk_cwd: string;
  runtime_status: string;
  runtime_updated_at: string;
  runtime_error: string;
  permission_profile?: SessionPermissionProfile;
  context_summary?: string;
  context_summary_updated_at?: string;
}

// ==========================================
// Project / File Types
// ==========================================

export interface ProjectInfo {
  path: string;
  name: string;
  files_count: number;
  last_modified: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
  size?: number;
  extension?: string;
}

export interface FilePreview {
  path: string;
  content: string;
  language: string;
  line_count: number;
  /** When true, line_count is exact; when false it is a best-effort estimate. */
  line_count_exact: boolean;
  /** When true, content is only the first N lines/bytes of a larger file. */
  truncated: boolean;
  /** Actual bytes read into content (UTF-8 byte length). */
  bytes_read: number;
  /** Total file size in bytes (from fs.stat). */
  bytes_total: number;
}

// ==========================================
// Skill / Command Types
// ==========================================

export type SkillKind = 'agent_skill' | 'slash_command' | 'sdk_command' | 'codepilot_command';

// ==========================================
// Popover / Command Input Types
// ==========================================

import type { TranslationKey } from '@/i18n';
import type { ComponentType, SVGAttributes, RefAttributes } from 'react';
import type { CodePilotIconName } from '@/components/ui/semantic-icon';

/** Generic icon component type — compatible with Phosphor, Lucide, or any SVG icon. */
export type IconComponent = ComponentType<
  SVGAttributes<SVGSVGElement> & RefAttributes<SVGSVGElement> & { size?: number | string; className?: string }
>;

export type MentionNodeType = 'file' | 'directory';

/** Shared model for popover items (slash commands, file mentions, skills). */
export interface PopoverItem {
  label: string;
  value: string;
  display?: string;
  description?: string;
  descriptionKey?: TranslationKey;
  builtIn?: boolean;
  immediate?: boolean;
  installedSource?: 'agents' | 'claude';
  source?: 'global' | 'project' | 'plugin' | 'installed' | 'sdk';
  kind?: SkillKind;
  /**
   * Phase 7 (2026-05-21): replaced `icon: IconComponent` (Phosphor
   * function reference) with `iconName: CodePilotIconName` (semantic
   * alias string). Keeps the vendor identity out of the data layer and
   * funnels rendering through CodePilotIcon → HugeIcons.
   */
  iconName?: CodePilotIconName;
  nodeType?: MentionNodeType;
}

/** Which popover is currently active in the command input. */
export type PopoverMode = 'file' | 'skill' | 'cli' | null;

/** Active slash-command badge shown above the textarea. */
export interface CommandBadge {
  command: string;
  label: string;
  description: string;
  kind: SkillKind;
  installedSource?: 'agents' | 'claude';
}

/** Active CLI tool badge shown above the textarea. */
export interface CliBadge {
  id: string;
  name: string;
}

/** A detected CLI tool available for use. */
export interface CliToolItem {
  id: string;
  name: string;
  version: string | null;
  summary: string;
}

// ==========================================
// Task Types
// ==========================================

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface TaskItem {
  id: string;
  session_id: string;
  title: string;
  status: TaskStatus;
  description: string | null;
  source: 'user' | 'sdk';
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string; // JSON string of MessageContentBlock[] for structured content
  created_at: string;
  token_usage: string | null; // JSON string of TokenUsage
  is_heartbeat_ack?: number; // 1 = heartbeat ack (prunable from transcript), 0 = normal
  /**
   * Phase 3 Step 4 — link this message to a `task_run_logs` row. When
   * non-null the message was authored by a scheduled task / heartbeat
   * run; MessageList uses this to render an inline TaskRunMarker
   * before the run's first message. Critically NOT included in the
   * LLM prompt context — it's a render-side join only, never written
   * into `content`. NULL for normal user-authored messages.
   */
  task_run_id?: string | null;
  /**
   * SQLite rowid, monotonically increasing per insert — used as the compact
   * coverage boundary (see `context_summary_boundary_rowid`). Populated by
   * `getMessages()` which does `SELECT *, rowid as _rowid`. Optional here
   * because some code paths synthesize Message-like objects without DB origin.
   */
  _rowid?: number;
}

// Media content block (MCP-compatible: image/audio/video in tool results)
export interface MediaBlock {
  type: 'image' | 'audio' | 'video';
  data?: string;        // base64 (transit only, cleared after save to disk)
  mimeType: string;     // e.g. 'image/png', 'video/mp4'
  localPath?: string;   // local file path (after save to .codepilot-media/)
  mediaId?: string;     // media_generations.id (after DB save)
  /**
   * Source-of-origin metadata captured at block-emit time. Used by the
   * media-import layer (`materializeCodexEventMedia`) to populate the
   * library's prompt + model with the REAL generation context (e.g.
   * Codex's `revisedPrompt`) instead of defaulting to the filename.
   * Renderers ignore this field.
   */
  sourceMetadata?: {
    /** Human-readable prompt used to generate the media. */
    prompt?: string;
    /** Provider/model identifier (e.g. 'codex-image'). */
    model?: string;
  };
}

// Structured message content blocks (stored as JSON in messages.content)
export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; media?: MediaBlock[] }
  | { type: 'code'; language: string; code: string };

// Helper to parse message content - returns blocks or wraps plain text
export function parseMessageContent(content: string): MessageContentBlock[] {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON, treat as plain text
  }
  return [{ type: 'text', text: content }];
}

export interface Setting {
  id: number;
  key: string;
  value: string;
}

// ==========================================
// API Provider Types
// ==========================================

export interface ApiProvider {
  id: string;
  name: string;
  provider_type: string; // legacy: 'anthropic' | 'openrouter' | 'bedrock' | 'vertex' | 'custom'
  /** Stable catalog identity selected by the user. Empty only for legacy/ambiguous rows. */
  preset_key: string;
  /** Wire protocol — new field, takes precedence over provider_type for dispatch */
  protocol: string; // 'anthropic' | 'openai-compatible' | 'xai' | 'openrouter' | 'bedrock' | 'vertex' | 'google' | 'gemini-image' | 'openai-image'
  base_url: string;
  api_key: string;
  is_active: number; // SQLite boolean: 0 or 1
  sort_order: number;
  extra_env: string; // JSON string of Record<string, string> (legacy, prefer env_overrides_json)
  /** Extra headers to send with API requests — JSON string of Record<string, string> */
  headers_json: string;
  /** Environment overrides for Claude Code SDK subprocess — JSON string of Record<string, string> */
  env_overrides_json: string;
  /** Semantic model role mapping — JSON string of { default?, reasoning?, small?, haiku?, sonnet?, opus? } */
  role_models_json: string;
  /** Per-provider options — JSON string of { thinking_mode?, context_1m? } */
  options_json: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface ProviderModelGroup {
  provider_id: string;       // provider DB id, or 'env' for environment variables
  provider_name: string;
  provider_type: string;
  preset_key: string;
  protocol: string;
  /** True if this provider only supports Claude Code SDK wire protocol, not standard Messages API */
  sdkProxyOnly?: boolean;
  /** Total models known for this provider (enabled + hidden in provider_models,
   * or catalog size when DB is empty). The Provider card surfaces this so the
   * user sees "synced model count" rather than the picker-visible subset. */
  total_count?: number;
  /** Most recent `last_refreshed_at` across this provider's `provider_models`
   *  rows. The Provider card formats this as a relative timestamp ("3 minutes
   *  ago") so the user can tell whether a stale picker reflects a stale
   *  refresh. Null/undefined = no rows (catalog-only) or refresh never run. */
  last_refreshed_at?: string | null;
  /** Provider-layer runtime compat. Computed from preset + protocol; a single
   * source of truth across Provider Card / Models page / chat picker. */
  compat?: ProviderRuntimeCompat;
  /**
   * #632 item 1 — whether a `token_usage.context_window` persisted for a
   * session on this provider reflects a REAL capacity. `false` only for an
   * anthropic-protocol provider on a third-party base_url: the Claude Agent
   * SDK reports a generic ~200K default there (the GLM "200K" the user
   * reported). Non-anthropic runtimes (Codex's modelContextWindow, etc.)
   * report their own real window, so they stay trusted. Undefined = trusted
   * (back-compat; consumers must gate on `=== false`, not falsiness).
   */
  reportedContextWindowTrusted?: boolean;
  models: Array<{
    value: string;           // internal/UI model ID
    label: string;           // display name
    upstreamModelId?: string; // actual API model ID (if different from value)
    contextWindow?: number;
    description?: string;
    supportsEffort?: boolean;
    supportedEffortLevels?: string[];
    /** i18n key for the effort menu's mapping note (see CatalogModel.capabilities). */
    effortNoteKey?: string;
    supportsAdaptiveThinking?: boolean;
    capabilities?: Record<string, unknown>;
    variants?: Record<string, unknown>;
    /**
     * Phase 6 UI收口 P2 (2026-05-14) — per-row runtime compat surfaced
     * to the chat picker so it can render incompatible rows disabled
     * + tooltip instead of hiding them. Empty array (or missing
     * field) = picker treats as unrestricted (legacy fallback).
     *
     * The data is computed server-side via `getModelCompat` and
     * always populated for the canonical chat-runtime model rows.
     * Settings models page (which still wants all rows visible for
     * management) ignores this and shows everything regardless.
     */
    supportedRuntimes?: string[];
    /**
     * Optional per-runtime "why" string. Key is a `RuntimeId`; value
     * is a short human-readable reason the picker tooltips. Matching
     * key absent → picker falls back to a generic "not supported by
     * current engine" message.
     */
    unsupportedReasonByRuntime?: Record<string, string>;
  }>;
}

/**
 * Runtime compatibility matrix — Provider layer.
 *
 * Drives consumer behavior across Provider Card / Models page / chat picker
 * / resolver:
 *  - `claude_code_ready`        Anthropic official + Bedrock/Vertex with
 *                               CLAUDE_CODE_USE_* env. Stable Claude Code path.
 *  - `claude_code_verified`     Anthropic-compat brand presets we have
 *                               actually verified end-to-end (GLM / Kimi /
 *                               Volcengine / MiniMax / Bailian / Xiaomi MiMo
 *                               / DeepSeek Coding Plans). Same wire path as
 *                               experimental, but tool calling / thinking /
 *                               alias mapping have been confirmed in practice.
 *                               UI uses "Claude Code 兼容" + info tone.
 *  - `claude_code_experimental` Anthropic-compat protocol but no verified
 *                               flag — generic third-party templates and
 *                               unverified custom URLs. UI uses "Claude Code
 *                               实验" + warning tone to flag uncertainty
 *                               around tool / thinking / alias behavior.
 *  - `openrouter_anthropic_skin` OpenRouter base_url WITHOUT `/v1`
 *                               (`https://openrouter.ai/api`). Per OpenRouter's
 *                               own Claude Code integration docs, this skin
 *                               speaks the Anthropic wire protocol — so it is
 *                               reachable from Claude Code Runtime even
 *                               though `protocol === 'openrouter'`. Keep it
 *                               distinct from `claude_code_verified` so the
 *                               label can mention OpenRouter explicitly and
 *                               nudge users toward `anthropic/claude-*` SKUs
 *                               (the skin is most reliable for those).
 *  - `codepilot_only`           Non-Anthropic protocol (OpenRouter `/v1`
 *                               OpenAI-compat skin, OpenAI-compat chat, Google
 *                               chat). Flows through CodePilot Runtime AND
 *                               Codex Runtime (via the provider proxy); not
 *                               Claude Code Runtime (Anthropic wire only).
 *  - `media_only`               Image / video / embedding services. Never enters
 *                               the chat picker.
 *  - `unknown`                  Custom URL with no matched preset. UI uses
 *                               "需验证" copy — not "不可用".
 */
export type ProviderRuntimeCompat =
  | 'claude_code_ready'
  | 'claude_code_verified'
  | 'claude_code_experimental'
  | 'openrouter_anthropic_skin'
  | 'codepilot_only'
  | 'codex_account'
  | 'media_only'
  | 'unknown';

/**
 * Runtime compatibility matrix — Model layer. A bag of capability flags;
 * a model can carry several at once.
 *
 * Phase 0.5 Slice A (2026-05-13) — new canonical contract is
 * `supportedRuntimes[] + unsupportedReasonByRuntime?`. The two boolean
 * fields (`claude_code_compatible` / `codepilot_runtime_compatible`)
 * are kept for back-compat input only — new code MUST write
 * `supportedRuntimes`. Slice B migrates all readers. Adding a third
 * `*_runtime_compatible` boolean is explicitly prohibited by
 * `runtime-contract-shape.test.ts`.
 */
export interface ModelRuntimeCompat {
  /** Usable as a chat / coding model. */
  chat?: boolean;
  /** Known to support tool calling. */
  tool_capable?: boolean;
  /** Known to support thinking / reasoning. */
  thinking_capable?: boolean;
  /**
   * @deprecated use `supportedRuntimes`. Kept for back-compat input.
   * Old code may still write this; new code MUST NOT.
   */
  claude_code_compatible?: boolean;
  /**
   * @deprecated use `supportedRuntimes`. Kept for back-compat input.
   * Old code may still write this; new code MUST NOT.
   */
  codepilot_runtime_compatible?: boolean;
  /** Image / video / embedding only — does NOT belong in chat pickers. */
  media?: boolean;
  /**
   * Phase 0.5 Slice A canonical compat field. The set of runtime ids
   * that can use this model. Source of truth for chat / model picker
   * filtering. Empty array = model not surfaced in any chat runtime
   * (still may be surfaced as image/embedding via `media`).
   *
   * Slice B populates this from existing boolean derivation; Slice E
   * makes consumers read this exclusively.
   */
  supportedRuntimes?: string[];
  /**
   * Optional per-runtime explanation for WHY a runtime is not in
   * `supportedRuntimes`. UI shows this in tooltips / unsupported
   * badges. Key is a `RuntimeId`; value is a short human-readable
   * reason (zh-CN preferred; i18n layer is responsible for en).
   */
  unsupportedReasonByRuntime?: Record<string, string>;
}

/** Where this model entry came from. Drives display badges + refresh policy. */
export type ProviderModelSource =
  | 'api'           // discovered via /discover-models live probe
  | 'catalog'       // shipped from VENDOR_PRESETS / role_models
  | 'manual'        // user hand-entered
  | 'role_mapping'  // implied by anthropic-thirdparty role_mapping
  | 'sdk_default';  // hard-coded SDK fallback (e.g. Claude Code env)

/**
 * Why this model row is currently `enabled` / hidden. Distinct from
 * `ProviderModelSource` (which records data origin) — this records the
 * intent layer: did the system pick this row for the user, or did the
 * user override it?
 *
 * Refresh apply uses this to decide what's safe to flip:
 *   - `recommended` / `discovered` / `catalog` → system-managed, may
 *     be re-evaluated on each refresh
 *   - `manual_enabled` / `manual_hidden` → user-managed, never touched
 *     by refresh (would otherwise silently undo the user's choice)
 */
export type ModelEnableSource =
  | 'recommended'      // system auto-enabled per catalog recommendation
  | 'manual_enabled'   // user explicitly toggled on
  | 'manual_hidden'    // user explicitly toggled off — never auto-enable again
  | 'discovered'       // discovery probe found it but recommended logic said "not by default"
  | 'catalog';         // initial seed from preset's defaultModels

export interface ProviderModel {
  id: string;
  provider_id: string;
  model_id: string;
  upstream_model_id: string;
  display_name: string;
  capabilities_json: string;
  variants_json: string;
  sort_order: number;
  enabled: number; // SQLite boolean
  created_at: string;
  source: ProviderModelSource;
  last_refreshed_at: string | null;
  /** 1 = user touched display_name/capabilities/enabled after import.
   *  Refresh apply must preserve those fields when this flag is set. */
  user_edited: number;
  /** Reason the row is in its current enabled state. Drives the "respect
   *  user overrides" rule in applyDiscoveryDiff. See ModelEnableSource. */
  enable_source: ModelEnableSource;
}

export interface CreateProviderRequest {
  name: string;
  /** Required for preset-backed create flows; generic/legacy callers pass ''. */
  preset_key?: string;
  provider_type?: string;
  protocol?: string;
  base_url?: string;
  api_key?: string;
  extra_env?: string;
  headers_json?: string;
  env_overrides_json?: string;
  role_models_json?: string;
  options_json?: string;
  notes?: string;
}

export interface UpdateProviderRequest {
  name?: string;
  /** Omit to preserve identity. Send only for an explicit user preset switch. */
  preset_key?: string;
  /**
   * Request catalog-managed model reconciliation for an explicit preset
   * choice. Merely adopting a stable identity on a legacy row must not imply
   * permission to rewrite its catalog rows.
   */
  reconcile_catalog?: boolean;
  provider_type?: string;
  protocol?: string;
  base_url?: string;
  api_key?: string;
  extra_env?: string;
  headers_json?: string;
  env_overrides_json?: string;
  role_models_json?: string;
  options_json?: string;
  notes?: string;
  sort_order?: number;
}

/** Provider options stored in options_json (per-provider) or settings (global) */
export interface ProviderOptions {
  thinking_mode?: 'adaptive' | 'enabled' | 'disabled';
  context_1m?: boolean;
  /**
   * Global default mode (Phase 2C contract).
   *
   * - `'auto'`  — system picks via the resolver's fallback chain. `default_model`
   *               and `default_model_provider` are unused; UI may show the
   *               last-resolved auto pick but it is not a promise.
   * - `'pinned'` — user explicitly committed to `default_model` + `default_model_provider`.
   *                If unavailable under the effective Runtime, the resolver
   *                returns `'invalid-default'` and chat must block the send;
   *                no silent substitution is allowed.
   *
   * Only meaningful for `__global__` provider id. Stored in `settings.global_default_mode`.
   */
  default_mode?: 'auto' | 'pinned';
  /** Global default model ID — used when `default_mode === 'pinned'`. */
  default_model?: string;
  /** Global default model's provider ID — used when `default_mode === 'pinned'`. */
  default_model_provider?: string;
}

export interface ProvidersResponse {
  providers: ApiProvider[];
}

export interface ProviderResponse {
  provider: ApiProvider;
}

// ==========================================
// Token Usage
// ==========================================

/**
 * @deprecated Phase 0 (Context Accounting Runtime Contract, 2026-05-20):
 * all fields made optional so the "假数据" code path that filled this in
 * `claude-client.ts` (commit a4fa2d4) can be safely deleted without
 * breaking persisted token_usage rows.
 *
 * Real-source per-Runtime accounting lives in
 * `src/lib/harness/context-accounting.ts` as
 * `RuntimeContextAccountingSnapshot` (Phase 1+). Old rows that still
 * carry this shape are fine — every field is now optional and the hook
 * treats undefined as "no data → hide row".
 */
export interface ContextBreakdownSnapshot {
  systemPromptTokens?: number;
  toolDescriptorTokens?: number;
  workspaceRuleTokens?: number;
  skillsHarnessTokens?: number;
  mcpDescriptorTokens?: number;
  memoryTokens?: number;
}

/**
 * Phase 1 — Context Accounting Runtime Contract (2026-05-20).
 *
 * Each Runtime adapter (ClaudeCode / CodePilot / Codex) produces a
 * RuntimeContextAccountingSnapshot during send-path; persisted alongside
 * the assistant message via `TokenUsage.context_accounting`.
 *
 * Why this exists: Phase 6 Tier 2 (a4fa2d4) persisted a JSON-uniform
 * `context_breakdown` snapshot that fed Skills/MCP/Tools rows from fixed
 * compiler outputs. Users saw "Skills 1.5K" on every message including
 * plain "你好" — same value as humanizer-zh invocation — because the
 * data source was hardcoded `capabilityFragments` not real Skill turn
 * injection. The contract here enforces:
 *
 *   1. `source` breadcrumb REQUIRED — distinguishes available (every
 *      turn) vs invoked (this turn's actual injection). UI uses source
 *      to decide whether the row counts as user-visible.
 *   2. `unsupported` is first-class — a Runtime says "I cannot count
 *      MCP tokens" rather than report 0; UI hides those rows.
 *   3. `producedBy: ContextAccountingRuntimeId` (no 'native' alias).
 *   4. `providerBackend` encodes Codex sub-modes (codex_account /
 *      codepilot_proxy / native_app_server).
 *
 * See `docs/exec-plans/active/context-accounting-runtime-contract.md`.
 */

export type ContextAccountingRuntimeId =
  | 'claude_code'
  | 'codepilot_runtime'
  | 'codex_runtime';

/** Kinds a Runtime adapter can report. Excludes conversation / cache /
 *  pending_next_turn — those come from baseline / composer, not the
 *  Runtime. */
export type ContextAccountingKind =
  | 'system_prompt'
  | 'tools'
  | 'rules'
  | 'skills'
  | 'mcp'
  | 'memory'
  | 'files_attachments';

export interface ContextAccountingEntry {
  /** Token count for this kind in THIS turn. */
  tokens: number;
  /**
   * Trace source — MUST distinguish "available" vs "loaded/invoked":
   *   'sdk-init/available-skills'    — every-turn list (NOT user-visible Skills)
   *   'sdk-turn/loaded-skill'        — this turn's actual injection
   *   'mcp-server-schemas/available' — all loaded schemas
   *   'mcp-turn/invoked-tool'        — this turn's MCP tool call
   *   'workspace-rules-fs/CLAUDE.md' — file-system source
   *   'sdk-actual-system-prompt'     — SDK's real system prompt char/4
   *   'assistant-memory-snapshot'    — adapter assistantMemory char/4
   *
   * NEVER use post-Phase-0:
   *   'compiled.budget.capabilityFragments' — hardcoded; Phase 6 Tier 2 假数据
   */
  source: string;
  /** Optional sub-detail (e.g. each loaded Skill name + size). */
  detail?: string;
}

export interface RuntimeContextAccountingSnapshot {
  /** Real entries — only kinds with verified source. */
  entries: Partial<Record<ContextAccountingKind, ContextAccountingEntry>>;
  /** Kinds this Runtime+backend cannot count. UI hides these rows. */
  unsupported: readonly ContextAccountingKind[];
  /** Project RuntimeId — no aliases (no 'native'). */
  producedBy: ContextAccountingRuntimeId;
  /**
   * Sub-classification for Runtimes with multiple backends.
   * - Codex Runtime split:
   *     'codex_account'    — OAuth登录态, many kinds unsupported
   *     'codepilot_proxy'  — user-supplied provider via CodePilot bridge (Phase 5e)
   *     'native_app_server' — app-server self-managed
   * - CodePilot / ClaudeCode: typically omitted (single backend)
   */
  providerBackend?: 'codex_account' | 'codepilot_proxy' | 'native_app_server' | string;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number;
  /**
   * Phase 1 — per-turn RuntimeContextAccountingSnapshot. Source of
   * truth for the popover breakdown. Older rows that carry the
   * deprecated `context_breakdown` field are ignored (those held Phase
   * 6 Tier 2 假数据; Phase 0 commit 4fcc09e stopped writing them).
   */
  context_accounting?: RuntimeContextAccountingSnapshot;
  /**
   * Phase 6 — per-turn context breakdown snapshot. Captured in the send
   * path, persisted JSON-nested. Optional for backward compatibility:
   * older assistant rows + non-ClaudeCode runtimes (native / codex) won't
   * carry this field, and the popover handles that by showing 0 across
   * the snapshot kinds (conversation absorbs the residual).
   */
  context_breakdown?: ContextBreakdownSnapshot;
  /**
   * Context window the SDK reports for the model that handled this turn.
   * Source: `SDKResultMessage.modelUsage[<key>].contextWindow` (Claude
   * Agent SDK ≥ 0.2.111) — but it's the SDK's BUNDLED-catalog value, not the
   * provider's API. #632: claude-client only persists this for a first-party
   * Anthropic endpoint; for third-party Anthropic-compatible proxies (GLM /
   * Bailian / Volcengine / MiniMax / Kimi via custom base_url) the SDK reports
   * a generic ~200K default, so this field is left ABSENT there and RunCockpit
   * shows used-tokens only (no fabricated %). Also absent for older DB rows and
   * adapters that don't populate modelUsage. When present, `useContextUsage`
   * treats it as the trusted window over the static `model-context.ts` lookup.
   */
  context_window?: number;
  /** Max output tokens reported by the SDK alongside contextWindow. */
  max_output_tokens?: number;
  /**
   * The model key matched in `modelUsage` when contextWindow was
   * extracted. Useful for debugging when the SDK reports usage under a
   * different name than the alias the user picked (e.g. third-party
   * proxy returns its upstream model id).
   */
  usage_model_id?: string;
  /**
   * Measured Claude Code turn latency. Persisted from Claude Agent SDK events
   * and result fields; absent for older rows and other runtimes. Values that
   * the SDK did not report stay absent rather than being displayed as fake 0s.
   */
  runtime_latency?: {
    source: 'claude-agent-sdk';
    /** SDK `SDKPartialAssistantMessage.ttft_ms`. */
    ttft_ms?: number;
    /** SDK result duration (whole SDK query). */
    duration_ms?: number;
    /** SDK result upstream API duration. */
    duration_api_ms?: number;
    /** CodePilot wall clock from stream start through the result. */
    wall_ms?: number;
    /** Number of real SDK `api_retry` events observed. */
    api_retry_count: number;
    /** SDK result subtype, e.g. success / error_during_execution. */
    terminal_type: string;
    resume_attempted: boolean;
    resume_fallback: boolean;
  };
}

// ==========================================
// API Request Types
// ==========================================

export interface CreateSessionRequest {
  title?: string;
  model?: string;
  system_prompt?: string;
  working_directory?: string;
  mode?: string;
  provider_id?: string;
  permission_profile?: SessionPermissionProfile;
}

export interface SendMessageRequest {
  session_id: string;
  content: string;
  model?: string;
  mode?: string;
  provider_id?: string;
  mentions?: MentionRef[];
}

export interface UpdateMCPConfigRequest {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface AddMCPServerRequest {
  name: string;
  server: MCPServerConfig;
}

export interface UpdateSettingsRequest {
  settings: SettingsMap;
}

// --- File API ---

export interface FileTreeRequest {
  dir: string;
  depth?: number; // default 3
}

export interface FilePreviewRequest {
  path: string;
  maxLines?: number; // default 200
}

// --- Task API ---

export interface CreateTaskRequest {
  session_id: string;
  title: string;
  description?: string;
}

export interface UpdateTaskRequest {
  title?: string;
  status?: TaskStatus;
  description?: string;
}

// --- Skill API ---

export interface SkillDefinition {
  name: string;
  description: string;
  prompt: string;
  enabled: boolean;
}

// --- Marketplace (Skills.sh) ---

export interface MarketplaceSkill {
  id: string;
  skillId: string;      // e.g. "git-commit"
  name: string;
  installs: number;
  source: string;       // e.g. "owner/repo"
  isInstalled?: boolean;
  installedAt?: string;
}

export interface SkillLockFile {
  version: number;
  skills: Record<string, SkillLockEntry>;
}

export interface SkillLockEntry {
  source: string;
  sourceType: string;
  sourceUrl: string;
  skillPath?: string;
  skillFolderHash: string;
  installedAt: string;
  updatedAt: string;
}

export interface CreateSkillRequest {
  name: string;
  description: string;
  prompt: string;
}

export interface UpdateSkillRequest {
  description?: string;
  prompt?: string;
  enabled?: boolean;
}

// ==========================================
// API Response Types
// ==========================================

export interface SessionsResponse {
  sessions: ChatSession[];
}

export interface SessionResponse {
  session: ChatSession;
}

export interface MessagesResponse {
  messages: Message[];
  hasMore?: boolean;
  /**
   * Phase 3 Step 4 — inline-join of `task_run_logs` for messages whose
   * `task_run_id` is non-null. Keyed by run id. Lets MessageList
   * render `<TaskRunMarker />` without per-marker N+1 fetches. Empty
   * (or omitted) when no message in this page has a task_run_id.
   */
  taskRuns?: Record<string, TaskRunSummary>;
}

export interface SuccessResponse {
  success: true;
}

export interface ErrorResponse {
  error: string;
  /** Machine-readable error code for client-side branching */
  code?: string;
  /** Extra recovery hints surfaced in UI */
  initialCard?: string;
}

export interface SettingsResponse {
  settings: SettingsMap;
}

export interface PluginsResponse {
  plugins: PluginInfo[];
}

export interface MCPConfigResponse {
  mcpServers: Record<string, MCPServerConfig>;
}

// --- File API Responses ---

export interface FileTreeResponse {
  tree: FileTreeNode[];
  root: string;
}

export interface FilePreviewResponse {
  preview: FilePreview;
}

// --- Task API Responses ---

export interface TasksResponse {
  tasks: TaskItem[];
}

export interface TaskResponse {
  task: TaskItem;
}

// --- Skill API Responses ---

export interface SkillsResponse {
  skills: SkillDefinition[];
}

export interface SkillResponse {
  skill: SkillDefinition;
}

// ==========================================
// SSE Event Types (streaming chat response)
// ==========================================

export type SSEEventType =
  | 'text'               // text content delta
  | 'thinking'           // extended thinking content delta
  | 'tool_use'           // tool invocation info
  | 'tool_result'        // tool execution result
  | 'tool_output'        // streaming tool output (stderr from SDK process)
  | 'tool_timeout'       // tool execution timed out
  | 'status'             // status update (compacting, etc.)
  | 'result'             // final result with usage stats
  | 'error'              // error occurred
  | 'permission_request' // permission approval needed
  | 'permission_resolved' // permission auto-resolved server-side (timeout) — A5 Step 2
  | 'permission_review'  // canonical review decision made WITHOUT a prompt —
                         // currently the auto_review classifier denying a tool
                         // (reviewerSource: 'sdk-reviewer'). Distinct from
                         // permission_resolved, which closes a prompt the user
                         // was actually shown. See lib/permission/review-event.ts.
  | 'mode_changed'       // SDK permission mode changed (e.g. plan → code)
  | 'task_update'        // SDK TodoWrite task sync
  | 'keep_alive'         // SDK keep-alive heartbeat (resets idle timer)
  | 'rewind_point'       // SDK user message with rewind checkpoint
  | 'rate_limit'         // SDK 0.2.111 subscription rate-limit telemetry
  | 'context_usage'      // SDK 0.2.111 post-turn context usage snapshot
  | 'file_changed'       // Phase 5 Phase 4 (2026-05-13) — Codex Runtime
                         // (and any future runtime) explicit file-change
                         // event. Routes to `codepilot:file-changed`
                         // window event so PreviewPanel quiet-refreshes.
                         // SDK doesn't emit this — file changes inside
                         // tool_result events still flow through the
                         // existing isWriteTool inspection path.
  | 'done';              // stream complete

export interface SSEEvent {
  type: SSEEventType;
  data: string;
}

// ==========================================
// Permission Types
// ==========================================

export interface PermissionSuggestion {
  type: string;
  rules?: Array<{ toolName: string; ruleContent?: string }>;
  behavior?: string;
  destination?: string;
}

export interface PermissionRequestEvent {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: PermissionSuggestion[];
  decisionReason?: string;
  blockedPath?: string;
  toolUseId: string;
  description?: string;
  /**
   * HMAC approval token issued by the server at request-creation time
   * (src/lib/permission-approval-token.ts). The renderer must echo it back
   * in PermissionResponseRequest; /api/chat/permission rejects responses
   * whose token is missing, tampered, or bound to a different request.
   */
  approvalToken?: string;
}

export interface PermissionResponseRequest {
  permissionRequestId: string;
  /** Echo of PermissionRequestEvent.approvalToken — required by the route. */
  approvalToken?: string;
  decision: {
    behavior: 'allow';
    updatedPermissions?: PermissionSuggestion[];
    updatedInput?: Record<string, unknown>;
  } | {
    behavior: 'deny';
    message?: string;
  };
}

// ==========================================
// Plugin / MCP Types
// ==========================================

export interface PluginInfo {
  name: string;
  description: string;
  author?: { name: string; url?: string };
  path: string;
  marketplace: string;
  location: 'plugins' | 'external_plugins';
  hasCommands: boolean;
  hasSkills: boolean;
  hasAgents: boolean;
  blocked: boolean;
  enabled: boolean;
}

export interface MCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: 'stdio' | 'sse' | 'http';
  url?: string;
  headers?: Record<string, string>;
  /** Persistent enable/disable. undefined or true = enabled; false = disabled. */
  enabled?: boolean;
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

// Backward-compatible alias
export type MCPServer = MCPServerConfig;

// ==========================================
// Settings Types
// ==========================================

export interface SettingsMap {
  [key: string]: string;
}

// Well-known setting keys
export const SETTING_KEYS = {
  DEFAULT_MODEL: 'default_model',
  DEFAULT_SYSTEM_PROMPT: 'default_system_prompt',
  THEME: 'theme',
  PERMISSION_MODE: 'permission_mode',
  MAX_THINKING_TOKENS: 'max_thinking_tokens',
  ASSISTANT_WORKSPACE_PATH: 'assistant_workspace_path',
} as const;

// ==========================================
// Setup Center Types
// ==========================================

export type SetupCardStatus = 'not-configured' | 'completed' | 'skipped' | 'needs-fix';
export interface SetupState {
  completed: boolean;
  claude: SetupCardStatus;
  provider: SetupCardStatus;
  project: SetupCardStatus;
  defaultProject?: string;
}

// ==========================================
// Assistant Workspace Types
// ==========================================

export interface AssistantWorkspaceState {
  onboardingComplete: boolean;
  /** @deprecated Use lastHeartbeatDate instead */
  lastCheckInDate?: string | null;
  lastHeartbeatDate: string | null;
  lastHeartbeatText?: string;
  lastHeartbeatSentAt?: number;
  /** @deprecated Use heartbeatEnabled instead */
  dailyCheckInEnabled?: boolean;
  heartbeatEnabled: boolean;
  /**
   * Phase 3 Step 4 — interval (in hours) between background heartbeat
   * runs when `heartbeatEnabled` is true. Drives `ensureHeartbeatTask`
   * to derive a cron expression. Default 24 (once daily). Zero or
   * undefined falls back to default; values < 1 are rejected at the
   * API layer (avoiding background polling tighter than 1 hour).
   */
  heartbeatIntervalHours?: number;
  schemaVersion: number;
  hookTriggeredSessionId?: string;
  hookTriggeredAt?: string;
  buddy?: {
    species: string;
    rarity: string;
    stats: Record<string, number>;
    emoji: string;
    peakStat: string;
    hatchedAt: string;
    buddyName?: string;
  };
}

export interface AssistantWorkspaceFiles {
  soul?: string;
  memory?: string;
  user?: string;
  claude?: string;
}

export interface AssistantWorkspaceFilesV2 extends AssistantWorkspaceFiles {
  rootDir?: string;
  heartbeatMd?: string;
}

// ==========================================
// Workspace Inspect Types
// ==========================================

export interface WorkspaceInspectResult {
  exists: boolean;
  isDirectory: boolean;
  readable: boolean;
  writable: boolean;
  hasAssistantData: boolean;
  workspaceStatus: 'empty' | 'normal_directory' | 'existing_workspace' | 'partial_workspace' | 'invalid';
  summary?: {
    onboardingComplete: boolean;
    lastHeartbeatDate: string | null;
    /** @deprecated Use lastHeartbeatDate instead */
    lastCheckInDate?: string | null;
    fileCount: number;
  };
}

// ==========================================
// Workspace Config Types
// ==========================================

export interface AssistantWorkspaceConfig {
  workspaceType: string;
  organizationStyle: 'project' | 'time' | 'topic' | 'mixed';
  captureDefault: string;
  archivePolicy: {
    completedTaskArchiveAfterDays: number;
    closedProjectArchive: boolean;
    dailyMemoryRetentionDays: number;
  };
  ignore: string[];
  index: {
    maxFileSizeKB: number;
    chunkSize: number;
    chunkOverlap: number;
    maxDepth: number;
    includeExtensions: string[];
  };
}

// ==========================================
// Taxonomy Types
// ==========================================

export interface TaxonomyCategory {
  id: string;
  label: string;
  paths: string[];
  role: string;
  confidence: number;
  source: 'user' | 'learned' | 'default';
  description: string;
  createdBy: string;
}

export interface TaxonomyFile {
  version: number;
  categories: TaxonomyCategory[];
  evolutionRules: {
    allowAutoCreateCategory: boolean;
    allowAutoArchive: boolean;
    requireConfirmationForMoves: boolean;
  };
}

// ==========================================
// Workspace Index Types
// ==========================================

export interface ManifestEntry {
  noteId: string;
  path: string;
  title: string;
  aliases: string[];
  tags: string[];
  headings: string[];
  mtime: number;
  size: number;
  hash: string;
  summary: string;
  categoryIds: string[];
}

export interface ChunkEntry {
  chunkId: string;
  noteId: string;
  path: string;
  heading: string;
  text: string;
  startLine: number;
  endLine: number;
}

export interface HotsetFile {
  pinned: string[];
  frequent: Array<{ path: string; count: number; lastAccessed: number }>;
  lastUpdated: number;
}

export interface SearchResult {
  path: string;
  heading: string;
  snippet: string;
  score: number;
  source: 'title' | 'heading' | 'tag' | 'content';
}

// ==========================================
// Reference Image Types (for image generation)
// ==========================================

export interface ReferenceImage {
  mimeType: string;
  data?: string;       // base64 (user upload)
  localPath?: string;  // file path (generated result)
}

export interface MentionRef {
  path: string;
  nodeType: MentionNodeType;
  display: string;
  sourceRange: {
    start: number;
    end: number;
  };
}

// ==========================================
// File Attachment Types
// ==========================================

export interface FileAttachment {
  id: string;
  name: string;
  type: string; // MIME type
  size: number;
  data: string; // base64 encoded content
  filePath?: string; // persisted disk path (for messages reloaded from DB)
  /** #628 — real in-tree source path for an @-mention of a project file
   *  (cwd-relative). When set AND server-validated inside cwd, the chat route
   *  references the real file instead of writing a `.codepilot-uploads` copy, so
   *  the AI's Read/Edit lands on the user's actual file. Absent for true uploads
   *  (no in-tree path) — those still get copied. Never trusted server-side: it is
   *  re-resolved + containment-checked against the working dir. */
  originPath?: string;
}

// Check if a MIME type is an image
export function isImageFile(type: string): boolean {
  return type.startsWith('image/');
}

// Check if a MIME type is a video
export function isVideoFile(type: string): boolean {
  return type.startsWith('video/');
}

// Check if a MIME type is any visual media (image or video)
export function isMediaFile(type: string): boolean {
  return type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/');
}

// Format bytes into human-readable size
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ==========================================
// Classified Error Types (from error-classifier)
// ==========================================

export type { ClaudeErrorCategory, ClassifiedError } from '@/lib/error-classifier';

// ==========================================
// Claude Client Types
// ==========================================

// ==========================================
// Batch Image Generation Types
// ==========================================

export type MediaJobStatus = 'draft' | 'planning' | 'planned' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
export type MediaJobItemStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface MediaJob {
  id: string;
  session_id: string | null;
  status: MediaJobStatus;
  doc_paths: string;       // JSON array of file paths
  style_prompt: string;
  batch_config: string;    // JSON of BatchConfig
  total_items: number;
  completed_items: number;
  failed_items: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface MediaJobItem {
  id: string;
  job_id: string;
  idx: number;
  prompt: string;
  aspect_ratio: string;
  image_size: string;
  model: string;
  tags: string;            // JSON array of strings
  source_refs: string;     // JSON array of strings
  status: MediaJobItemStatus;
  retry_count: number;
  result_media_generation_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface MediaContextEvent {
  id: string;
  session_id: string;
  job_id: string;
  payload: string;         // JSON object
  sync_mode: 'manual' | 'auto_batch';
  synced_at: string | null;
  created_at: string;
}

export interface BatchConfig {
  concurrency: number;     // max parallel image generations (default: 2)
  maxRetries: number;      // max retry attempts per item (default: 2)
  retryDelayMs: number;    // base delay for exponential backoff (default: 2000)
}

export interface PlannerItem {
  prompt: string;
  aspectRatio: string;
  resolution: string;
  tags: string[];
  sourceRefs: string[];
}

export interface PlannerOutput {
  summary: string;
  items: PlannerItem[];
}

export type JobProgressEventType =
  | 'item_started'
  | 'item_completed'
  | 'item_failed'
  | 'item_retry'
  | 'job_completed'
  | 'job_paused'
  | 'job_cancelled';

export interface JobProgressEvent {
  type: JobProgressEventType;
  jobId: string;
  itemId?: string;
  itemIdx?: number;
  progress: {
    total: number;
    completed: number;
    failed: number;
    processing: number;
  };
  error?: string;
  retryCount?: number;
  mediaGenerationId?: string;
  timestamp: string;
}

// --- Batch Image Gen API Types ---

export interface CreateMediaJobRequest {
  sessionId?: string;
  items: Array<{
    prompt: string;
    aspectRatio?: string;
    imageSize?: string;
    model?: string;
    tags?: string[];
    sourceRefs?: string[];
  }>;
  batchConfig?: Partial<BatchConfig>;
  stylePrompt?: string;
  docPaths?: string[];
}

export interface PlanMediaJobRequest {
  docPaths?: string[];
  docContent?: string;
  stylePrompt: string;
  sessionId?: string;
  count?: number;
}

export interface UpdateMediaJobItemsRequest {
  items: Array<{
    id: string;
    prompt?: string;
    aspectRatio?: string;
    imageSize?: string;
    tags?: string[];
  }>;
}

export interface MediaJobResponse {
  job: MediaJob;
  items: MediaJobItem[];
}

export interface MediaJobListResponse {
  jobs: MediaJob[];
}

// ==========================================
// Stream Session Manager Types
// ==========================================

export interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultInfo {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  media?: MediaBlock[];
}

export type StreamPhase = 'active' | 'completed' | 'error' | 'stopped';

export interface SessionStreamSnapshot {
  sessionId: string;
  phase: StreamPhase;
  streamingContent: string;
  streamingThinkingContent: string;
  toolUses: ToolUseInfo[];
  toolResults: ToolResultInfo[];
  streamingToolOutput: string;
  statusText: string | undefined;
  pendingPermission: PermissionRequestEvent | null;
  // 'timeout' = auto-denied because the user never responded within the
  // 5-minute window (codebase-health A5 Step 2). Rendered distinctly from a
  // manual 'deny' so the user knows they didn't click it.
  permissionResolved: 'allow' | 'deny' | 'timeout' | null;
  /**
   * Review decisions made without prompting the user — today, the auto_review
   * classifier denying a tool. Distinct from `pendingPermission` (a question
   * for the user) and `permissionResolved` (the answer to one). Carries
   * `reviewerSource` so the UI can say who decided. See
   * lib/permission/review-event.ts.
   */
  reviewNotices: PermissionReviewNotice[];
  tokenUsage: TokenUsage | null;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  /** Final message content built at stream completion for ChatView to consume */
  finalMessageContent: string | null;
  /**
   * Optional terminal reason emitted by SDK 0.2.111 on SDKResultMessage.
   * Used by ChatView to render a contextual end-of-turn chip (Phase 1 of
   * agent-sdk-0-2-111-adoption). Absent for error paths without a result
   * message — those continue to flow through error-classifier.ts.
   */
  terminalReason?: string;
  /**
   * SDK 0.2.111 subscription rate-limit telemetry (Phase 2 of
   * agent-sdk-0-2-111-adoption). Populated from rate_limit_event
   * stream messages; only present on claude.ai subscription paths.
   * ChatView consumes this to render warning / rejected UIs.
   */
  rateLimitInfo?: {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    resetsAt?: number;
    rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage';
    utilization?: number;
    overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
    overageResetsAt?: number;
    overageDisabledReason?: string;
    isUsingOverage?: boolean;
  };
  /**
   * Post-turn context-usage snapshot captured via Query.getContextUsage()
   * (SDK 0.2.111 Phase 5). Consumers should treat this as authoritative
   * for ~60s after capturedAt, then fall back to the char-based estimator.
   */
  contextUsageSnapshot?: {
    totalTokens: number;
    maxTokens: number;
    rawMaxTokens: number;
    percentage: number;
    model: string;
    /** Epoch ms at which the snapshot was taken */
    capturedAt: number;
  };
}

export interface StreamEvent {
  type: 'snapshot-updated' | 'phase-changed' | 'permission-request' | 'completed';
  sessionId: string;
  snapshot: SessionStreamSnapshot;
}

export type StreamEventListener = (event: StreamEvent) => void;

/**
 * One history row passed via ClaudeStreamOptions.conversationHistory.
 *
 * `_rowid` is the SQLite rowid of the original DB row, propagated so that
 * reactive compact (claude-client.ts) can write a correct
 * context_summary_boundary_rowid on CONTEXT_TOO_LONG retry. Synthesized /
 * non-DB-origin rows may omit it — callers that only have {role, content}
 * pairs (e.g. bridge transports, fallback paths) don't need to fabricate a
 * rowid; the boundary helper falls back to the existing session boundary.
 */
export type ConversationHistoryItem = {
  role: 'user' | 'assistant';
  content: string;
  _rowid?: number;
};

export interface ClaudeStreamOptions {
  prompt: string;
  /** Mandatory credential-use classification; unknown callers fail closed. */
  callScene: import('@/lib/provider-call-policy').ProviderCallScene;
  sessionId: string;
  sdkSessionId?: string; // SDK session ID for resuming conversations
  model?: string;
  systemPrompt?: string;
  workingDirectory?: string;
  mcpServers?: Record<string, MCPServerConfig>;
  abortController?: AbortController;
  permissionMode?: string;
  /**
   * Phase 2 — Context Accounting Runtime Contract (2026-05-20). Names of
   * Agent Skills selected via MessageInput badges. Producer looks up via
   * discoverSkills() to compute real SKILL.md filesizes; no prompt-text
   * guessing.
   */
  selectedSkills?: readonly string[];
  files?: FileAttachment[];
  toolTimeoutSeconds?: number;
  provider?: ApiProvider;
  /** Explicit provider ID (e.g. 'env') — passed to resolveForClaudeCode */
  providerId?: string;
  /** Session's stored provider ID — passed to resolveForClaudeCode */
  sessionProviderId?: string;
  /**
   * Phase 2 Step 3: session's `runtime_pin` value (chat-runtime label,
   * e.g. `'claude_code'` / `'codepilot_runtime'`). When non-empty, the
   * runtime selection in `streamClaude` prefers this over the global
   * `agent_runtime` setting — that's the headline immunity behavior
   * Phase 2 promises. Empty / undefined = "follow global", which is
   * the today-default for any session not explicitly pinned.
   */
  sessionRuntimePin?: string;
  /** Recent conversation history from DB — used as fallback context when SDK resume is unavailable or fails */
  conversationHistory?: ConversationHistoryItem[];
  /** Compressed session summary — used as context skeleton in fallback mode */
  sessionSummary?: string;
  /** Existing compact coverage boundary (rowid). Reactive compact preserves this
   *  rather than resetting to 0 when it cannot derive a new boundary from _rowid
   *  metadata in conversationHistory. */
  sessionSummaryBoundaryRowid?: number;
  /** Token budget for fallback history — messages beyond this budget are truncated */
  fallbackTokenBudget?: number;
  onRuntimeStatusChange?: (status: string) => void;
  /** Per-session bypass: when true, skip all permission checks for this session */
  bypassPermissions?: boolean;
  /** Thinking configuration for the query */
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens?: number } | { type: 'disabled' };
  /** Effort level for the query (Opus 4.7 adds 'xhigh') */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Sampling params for the query. Threaded into the shared sanitizer so the
   * adaptive family's "non-default temperature/top_p/top_k returns 400"
   * contract is enforced on the REAL request, and any drop is announced
   * (Codex review P2, 2026-07-18). No UI surface populates these today, so
   * live behavior is unchanged; see the AgentLoopOptions counterpart.
   */
  temperature?: number;
  topP?: number;
  topK?: number;
  /** Output format for structured responses */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  /** Custom agent definitions */
  agents?: Record<string, { description: string; prompt?: string; tools?: string[]; disallowedTools?: string[] }>;
  /** Agent name for the main thread */
  agent?: string;
  /** Enable file checkpointing for rewind support */
  enableFileCheckpointing?: boolean;
  /** When true, this is an auto-trigger turn (invisible to user) — skip rewind point emission */
  autoTrigger?: boolean;
  /** Enable 1M context window (beta header: context-1m-2025-08-07) */
  context1m?: boolean;
  /** Enable generative UI widget guidelines MCP server (default: true) */
  generativeUI?: boolean;
  /**
   * Codex P1 — Phase 3 Step 4 follow-up. Marks this run as a special-
   * purpose agent invocation so the runtime can apply tighter
   * defaults than a normal user chat. Today only one value is
   * defined:
   *
   *   - `'heartbeat'`: background heartbeat check. claude-client
   *     skips registering codepilot-notify / cli-tools / dashboard /
   *     media / image-gen / widget MCPs, drops external
   *     user-configured `mcpServers`, restricts `allowedTools` to
   *     `mcp__codepilot-memory` only, and sets `disallowedTools` to
   *     block dangerous SDK builtins (Bash / Edit / Write / Task /
   *     WebSearch / WebFetch). The agent-task-runner sets this on
   *     the heartbeat branch; nothing else should set it.
   *
   * Absence (the default) preserves the current full-tool experience
   * for normal user chats and ai_task / reminder runs.
   */
  agentMode?: 'heartbeat';
  /**
   * Session-lock ownership token (the per-request `lockId` minted in the chat
   * route via crypto.randomBytes). Plumbed through so this turn's Query is
   * registered under the token that owns the session lock, and unregister is
   * gated on it — the I1 ownership gate that keeps a superseded turn's late
   * teardown from evicting the turn that took over. Optional/additive: legacy
   * callers that omit it register/unregister under `undefined` as before.
   */
  lockId?: string;
}

// ==========================================
// CLI Tools Types
// ==========================================

export type CliToolStatus = 'not_installed' | 'installed' | 'needs_auth' | 'ready';
export type CliToolCategory = 'media' | 'data' | 'search' | 'download' | 'document' | 'productivity';
export type InstallMethod = 'brew' | 'npm' | 'pipx' | 'cargo';

export type CliToolPlatform = 'darwin' | 'linux' | 'win32';

export interface CliToolInstallMethod {
  method: InstallMethod;
  command: string;
  platforms: CliToolPlatform[];
}

export interface CliToolExamplePrompt {
  label: string;
  promptZh: string;
  promptEn: string;
}

export interface CliToolDefinition {
  id: string;
  name: string;
  binNames: string[];
  summaryZh: string;
  summaryEn: string;
  categories: CliToolCategory[];
  installMethods: CliToolInstallMethod[];
  setupType: 'simple' | 'needs_auth';
  detailIntro: { zh: string; en: string };
  useCases: { zh: string[]; en: string[] };
  guideSteps: { zh: string[]; en: string[] };
  examplePrompts: CliToolExamplePrompt[];
  /** Commands that MUST be run after install (e.g. skills install, dependency install).
   *  These are injected into the chat prefill — only include machine-executable commands,
   *  not human-readable guidance. */
  postInstallCommands?: string[];
  /** Tool is designed for AI agents (non-interactive flags, structured output, skills) */
  agentFriendly?: boolean;
  /** Tool supports --json or similar structured output flag */
  supportsJson?: boolean;
  /** Tool supports runtime schema introspection (e.g. "gws schema", "--help --json") */
  supportsSchema?: boolean;
  /** Tool supports --dry-run for previewing destructive actions */
  supportsDryRun?: boolean;
  /** Tool supports field masks or pagination to reduce context window usage */
  contextFriendly?: boolean;
  /** Command to check auth/health status (e.g. "stripe status", "lark-cli auth status") */
  healthCheckCommand?: string;
  homepage?: string;
  repoUrl?: string;
  officialDocsUrl?: string;
  supportsAutoDescribe: boolean;
}

export interface CliToolRuntimeInfo {
  id: string;
  status: CliToolStatus;
  version: string | null;
  binPath: string | null;
  autoDescription?: { zh: string; en: string } | null;
}

export interface CustomCliTool {
  id: string;
  name: string;
  binPath: string;
  binName: string;
  version: string | null;
  installMethod: string;
  installPackage: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CliToolAgentCompat {
  agentFriendly?: boolean;
  supportsJson?: boolean;
  supportsSchema?: boolean;
  supportsDryRun?: boolean;
  contextFriendly?: boolean;
}

export interface CliToolStructuredDesc {
  intro: { zh: string; en: string };
  useCases: { zh: string[]; en: string[] };
  guideSteps: { zh: string[]; en: string[] };
  examplePrompts: CliToolExamplePrompt[];
  agentCompat?: CliToolAgentCompat;
}

// ==========================================
// Git Types
// ==========================================

export interface GitStatus {
  isRepo: boolean;
  repoRoot: string;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  changedFiles: GitChangedFile[];
}

export interface GitChangedFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked';
  staged: boolean;
}

export interface GitBranch {
  name: string;
  isRemote: boolean;
  upstream: string;
  worktreePath: string;
}

export interface GitLogEntry {
  sha: string;
  authorName: string;
  authorEmail: string;
  timestamp: string;
  message: string;
}

export interface GitCommitDetail extends GitLogEntry {
  stats: string;
  diff: string;
}

export interface GitWorktree {
  path: string;
  head: string;
  branch: string;
  bare: boolean;
  dirty: boolean;
}

// ==========================================
// WeChat Bridge Types
// ==========================================

export interface WeixinAccount {
  accountId: string;
  userId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
  name: string;
  enabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeixinContextTokenRecord {
  accountId: string;
  peerUserId: string;
  contextToken: string;
  updatedAt: string;
}

// ==========================================
// Scheduled Tasks
// ==========================================

/**
 * Phase 3 Step 3 — task kind.
 *
 *   - 'reminder'  : the prompt text IS the notification body. Scheduler
 *                   does NOT call any AI provider; to-the-minute fire
 *                   works without a configured model. This is the
 *                   "5 分钟后提醒我喝水" path.
 *   - 'ai_task'   : the prompt is fed to the configured provider via
 *                   `generateTextFromProvider`; the AI's text reply
 *                   becomes the notification body. Original behavior.
 *
 * `kind` is REQUIRED on all newly-created tasks (server-side API + AI
 * tool schemas validate). Legacy DB rows missing the column are
 * defaulted to `'ai_task'` by the schema migration to preserve old
 * behavior, but new creations must specify.
 */
export type ScheduledTaskKind = 'reminder' | 'ai_task';

/**
 * Phase 3 Step 4 — `scheduled_tasks.source` distinguishes user-created
 * tasks from the system-injected assistant heartbeat task. Heartbeat is
 * NOT a separate `kind` (kind stays `'ai_task'`); only `source` differs.
 * The agent task runner branches on `source` to decide buddy-session vs
 * task-bound-session and silent-contract vs normal-output handling.
 */
export type ScheduledTaskSource = 'user' | 'assistant_heartbeat';

/**
 * Phase 3 Step 4 — `task_run_logs.status` is a 5-state app-layer enum.
 * Validated in `insertTaskRunLog` / `updateTaskRunLog` (no DB CHECK,
 * since SQLite doesn't support modifying CHECK on existing tables and
 * a table-rebuild migration is out of Step 4 scope). Legacy rows still
 * carry `'success'` / `'error'`; UI maps those to succeeded / failed
 * for display.
 *
 *   - `running` — the task is in flight.
 *   - `succeeded` — completed normally (replaces legacy `'success'`).
 *   - `failed` — terminated with an error (replaces legacy `'error'`).
 *   - `waiting_for_permission` — agent hit a permission gate while
 *     running headless; stream cleanly cancelled with partial output
 *     persisted. User must enter the task-bound session and choose
 *     "Re-run" or "Abandon" — there is no durable resume in v1.
 *   - `cancelled` — user explicitly abandoned a paused run.
 *
 * `scheduled_tasks.last_status` is INTENTIONALLY NOT extended to 5
 * states (the column has a SQLite CHECK constraint that would need a
 * table rebuild to relax). Tasks page derives display status from the
 * latest `task_run_logs` row; `last_status` keeps its legacy values.
 */
export type TaskRunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'waiting_for_permission'
  | 'cancelled';

export const TASK_RUN_STATUS_VALUES: ReadonlyArray<TaskRunStatus> = [
  'running',
  'succeeded',
  'failed',
  'waiting_for_permission',
  'cancelled',
];

export function isTaskRunStatus(value: unknown): value is TaskRunStatus {
  return typeof value === 'string' && (TASK_RUN_STATUS_VALUES as ReadonlyArray<string>).includes(value);
}

/**
 * Inline-join shape returned by `/api/chat/sessions/[id]/messages` for
 * messages with a non-null `task_run_id`. Lets MessageList render
 * `<TaskRunMarker />` without N+1 fetches per marker.
 */
export interface TaskRunSummary {
  id: string;
  task_id: string;
  status: TaskRunStatus | string; // string allows legacy values
  task_name?: string;
  task_kind?: ScheduledTaskKind;
  task_source?: ScheduledTaskSource;
  created_at: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  /** Phase 3 Step 3 — see ScheduledTaskKind. */
  kind: ScheduledTaskKind;
  /**
   * Phase 3 Step 4 — see ScheduledTaskSource. Optional on the type so
   * existing test fixtures and API callsites that don't care about
   * heartbeat distinction still type-check. DB column is `NOT NULL
   * DEFAULT 'user'`, so reads from DB always populate this field;
   * the type just lets create-shape inputs omit it.
   * `'assistant_heartbeat'` is reserved for `ensureHeartbeatTask`.
   */
  source?: ScheduledTaskSource;
  next_run: string;
  last_run?: string;
  last_status?: 'success' | 'error' | 'skipped' | 'running';
  last_error?: string;
  last_result?: string;
  consecutive_errors: number;
  status: 'active' | 'paused' | 'completed' | 'disabled';
  priority: 'low' | 'normal' | 'urgent';
  notify_on_complete: number;
  session_id?: string;
  /**
   * Phase 3 Step 4 follow-up — origin chat session this task was
   * created from (when the model called `codepilot_schedule_task` from
   * inside a user chat). Used by the runner to inherit working
   * directory + provider/model/runtime_pin/permission_profile into the
   * task-bound execution session on first fire. Distinct from
   * `session_id`, which is the runner's lazily-created execution
   * session. Undefined for legacy rows and for tasks created from
   * non-chat UI surfaces (Settings → Tasks → Add).
   */
  origin_session_id?: string;
  working_directory?: string;
  permanent: number;
  created_at: string;
  updated_at: string;
}

/**
 * Phase 3 Step 3 — notification delivery channels (canonical set).
 * The `notification_deliveries` table uses a string column so future
 * channels can be added without schema migrations, but the test
 * suite asserts these values against the canonical type to catch
 * typos.
 */
export type NotificationChannel =
  | 'renderer-toast'
  // `electron-native` covers BOTH the renderer-driven IPC path
  // (window visible → useNotificationPoll calls electronAPI.notification.show)
  // AND the bg-poller path (window hidden → main process drains the
  // queue and shows OS native). v6 P1 fix unified them: the OS-level
  // surface is identical from the user's POV, and tracking it as one
  // row prevents "permanent queued" leftovers in delivery log when
  // the window-hidden path acked under a separate channel name.
  // The retired `electron-bg-native` literal is intentionally NOT
  // listed here so a future regression can't smuggle it back in.
  | 'electron-native'
  | 'bridge-telegram'
  | 'bridge-feishu'
  | 'bridge-discord'
  | 'bridge-qq';

/**
 * Phase 3 Step 3 — delivery row state machine.
 *
 *   queued        → channel was a candidate, ack pending
 *   delivered     → channel ack'd success
 *   error         → channel ack'd failure (with `error` text)
 *   not_configured→ channel was a candidate but lacks credentials
 *                   (e.g. urgent + bridge-telegram with no token);
 *                   written immediately by `sendNotification`, no ack
 *   skipped       → channel was a candidate but user disabled it
 *                   (e.g. Bridge configured but Settings → Bridge off);
 *                   also written immediately
 */
export type NotificationDeliveryStatus =
  | 'queued'
  | 'delivered'
  | 'error'
  | 'not_configured'
  | 'skipped';

export interface NotificationEvent {
  id: string;
  event_id: string;
  task_id?: string;
  session_id?: string;
  source: 'codepilot' | 'external';
  title: string;
  body: string;
  priority: 'low' | 'normal' | 'urgent';
  status: 'queued';
  created_at: string;
}

export interface NotificationDelivery {
  id: string;
  event_id: string;
  channel: string;
  status: NotificationDeliveryStatus;
  error?: string | null;
  created_at: string;
  acked_at?: string | null;
}
