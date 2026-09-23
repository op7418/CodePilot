/**
 * Session permission profile — the canonical three-way semantic
 * contract behind the composer's permission chip.
 *
 * `runtime-permission-modes.md` Phase 0. The three profiles are NOT
 * interchangeable and must never share an implementation switch:
 *
 *   - `default`      请求批准 — safe work runs, risky work asks the user.
 *   - `auto_review`  替我审批    — requests that would have asked the user go to a
 *                                 constrained reviewer instead. Still bounded by
 *                                 workspace/sandbox; deny / timeout / reviewer
 *                                 unavailable all fail closed. NOT a blanket allow.
 *   - `full_access`  完全访问    — skips confirmation entirely. Dangerous.
 *
 * The load-bearing distinction: **auto_review is a reviewer, full_access is a
 * bypass.** Any code that treats them as the same "elevated" bucket is a bug —
 * that is precisely the confusion this module exists to prevent.
 */

import { getMutationLevel, shouldSkipPermission } from '@/lib/harness/mutation-level';
import type { ExternalMcpStatus } from './external-mcp';

export const PERMISSION_PROFILES = ['default', 'auto_review', 'full_access'] as const;

export type SessionPermissionProfile = (typeof PERMISSION_PROFILES)[number];

export const DEFAULT_PERMISSION_PROFILE: SessionPermissionProfile = 'default';

export function isPermissionProfile(value: unknown): value is SessionPermissionProfile {
  return typeof value === 'string' && (PERMISSION_PROFILES as readonly string[]).includes(value);
}

/**
 * Fail-closed coercion for values coming out of the DB / an old client /
 * an unvalidated payload. Anything unrecognised collapses to the most
 * restrictive profile rather than inheriting an elevated one.
 */
export function normalizePermissionProfile(value: unknown): SessionPermissionProfile {
  return isPermissionProfile(value) ? value : DEFAULT_PERMISSION_PROFILE;
}

// ─────────────────────────────────────────────────────────────────────
// Human-only categories (a04)
// ─────────────────────────────────────────────────────────────────────

/**
 * Operations a generic reviewer must never approve on the user's behalf,
 * regardless of profile. These are not "risky" in the mutationLevel sense —
 * they're operations where the *user's own judgement* is the point:
 *
 *   - `interactive_question` — the answer carries semantic meaning, not consent.
 *   - `credential` — touching secrets is never delegable to a model.
 *   - `billing` — spends the user's money.
 *   - `external_publish` — visible outside the machine; hard to walk back.
 *   - `high_impact` — shell/system-level mutation with broad blast radius.
 */
export type HumanOnlyCategory =
  | 'interactive_question'
  | 'credential'
  | 'billing'
  | 'external_publish'
  | 'high_impact';

export const HUMAN_ONLY_CATEGORIES: readonly HumanOnlyCategory[] = [
  'interactive_question',
  'credential',
  'billing',
  'external_publish',
  'high_impact',
];

/**
 * Explicit per-tool human-only classification. Tools absent from this table
 * may still be human-only by derivation — see {@link getHumanOnlyCategory}.
 */
const HUMAN_ONLY_TOOLS: Readonly<Record<string, HumanOnlyCategory>> = {
  // The user picking an option IS the product behaviour. A reviewer
  // answering for them isn't "approval", it's impersonation.
  AskUserQuestion: 'interactive_question',

  // Bills the user's third-party media API on every call.
  codepilot_generate_image: 'billing',
  codepilot_generate_video: 'billing',

  // Shell-executes / installs system packages.
  codepilot_cli_tools_install: 'high_impact',
  codepilot_cli_tools_add: 'high_impact',
  codepilot_cli_tools_remove: 'high_impact',
  codepilot_cli_tools_update: 'high_impact',

  // Leaves the machine — IM/push delivery to other humans.
  codepilot_notify: 'external_publish',
};

/**
 * Substrings that mark a tool as credential-touching. Deliberately a
 * name check on OUR OWN tool surface only — this is a belt-and-braces
 * net for future codepilot_* tools, NOT a revival of the Phase 5e
 * `codepilot_*`-prefix hole (that one *allowed* on prefix match; this
 * one only ever *restricts*).
 */
const CREDENTIAL_NAME_MARKERS = ['credential', 'secret', 'api_key', 'apikey', 'token', 'oauth', 'password'];

/**
 * Returns the human-only category for a tool, or `undefined` if the tool
 * may be handled by a reviewer.
 *
 * Derivation order:
 *   1. explicit table
 *   2. credential name markers
 *   3. `mutationLevel === 'mutating_external'` (shell exec / installs /
 *      billed third-party APIs / writes outside the media library)
 */
export function getHumanOnlyCategory(toolName: string): HumanOnlyCategory | undefined {
  const bare = toBareToolName(toolName);

  const explicit = HUMAN_ONLY_TOOLS[bare] ?? HUMAN_ONLY_TOOLS[toolName];
  if (explicit) return explicit;

  const lowered = bare.toLowerCase();
  if (CREDENTIAL_NAME_MARKERS.some((marker) => lowered.includes(marker))) {
    return 'credential';
  }

  if (getMutationLevel(bare) === 'mutating_external') {
    return 'high_impact';
  }

  return undefined;
}

export function isHumanOnlyTool(toolName: string): boolean {
  return getHumanOnlyCategory(toolName) !== undefined;
}

/**
 * Every tool CodePilot exposes to the Claude path through an in-process MCP
 * server, mapped to the `mcpServers` record KEY claude-client registers it
 * under (the SDK builds tool names as `mcp__<recordKey>__<tool>`, so the key —
 * not the server's own `name:` — is what appears on the wire; `codepilot-widget`
 * is registered under a key that differs from its declared name, which is
 * exactly why this maps keys).
 *
 * This exists so the auto_review deny list can be DERIVED rather than
 * hand-copied. Review round #3, P1: the previous hand-written table listed six
 * fully-qualified names, so a tool that became human-only by *derivation*
 * (`getHumanOnlyCategory`'s credential markers or `mutating_external`) — a new
 * `codepilot_rotate_api_key`, say — would be classified human-only everywhere
 * EXCEPT the one place that runs before the SDK classifier. The tables agreed
 * by coincidence, not by construction.
 *
 * `permission-profile-contract.test.ts` introspects the real server instances
 * and fails if this map drifts from what claude-client actually registers.
 *
 * Native-harness tools (`codepilot_session_search`) are deliberately absent:
 * they never reach the Claude MCP surface.
 */
export const CODEPILOT_MCP_TOOL_SERVERS: Readonly<Record<string, string>> = {
  // codepilot-memory — shared reads and permission-gated local mutations.
  codepilot_memory_search: 'codepilot-memory',
  codepilot_memory_get: 'codepilot-memory',
  codepilot_memory_recent: 'codepilot-memory',
  codepilot_memory_remember: 'codepilot-memory',
  codepilot_memory_update: 'codepilot-memory',
  codepilot_memory_forget: 'codepilot-memory',
  // codepilot-widget — registered under this key, though the server declares
  // itself 'codepilot-widget-guidelines'.
  codepilot_load_widget_guidelines: 'codepilot-widget',
  // codepilot-notify — delivery + task rows.
  codepilot_notify: 'codepilot-notify',
  codepilot_schedule_task: 'codepilot-notify',
  codepilot_list_tasks: 'codepilot-notify',
  codepilot_cancel_task: 'codepilot-notify',
  codepilot_hatch_buddy: 'codepilot-notify',
  // codepilot-media / codepilot-image-gen.
  codepilot_import_media: 'codepilot-media',
  codepilot_generate_image: 'codepilot-image-gen',
  codepilot_generate_video: 'codepilot-image-gen',
  // codepilot-cli-tools — read-only list/check + shell-exec mutators.
  codepilot_cli_tools_list: 'codepilot-cli-tools',
  codepilot_cli_tools_check_updates: 'codepilot-cli-tools',
  codepilot_cli_tools_install: 'codepilot-cli-tools',
  codepilot_cli_tools_add: 'codepilot-cli-tools',
  codepilot_cli_tools_remove: 'codepilot-cli-tools',
  codepilot_cli_tools_update: 'codepilot-cli-tools',
  // codepilot-dashboard.
  codepilot_dashboard_list: 'codepilot-dashboard',
  codepilot_dashboard_refresh: 'codepilot-dashboard',
  codepilot_dashboard_pin: 'codepilot-dashboard',
  codepilot_dashboard_update: 'codepilot-dashboard',
  codepilot_dashboard_remove: 'codepilot-dashboard',
  // codepilot-subagent — separate read-only Claude Code model call.
  codepilot_spawn_subagent: 'codepilot-subagent',
};

/** `mcp__<serverKey>__<bareTool>` — the name the SDK matches rules against. */
export function toMcpToolName(bareName: string, serverKey: string): string {
  return `mcp__${serverKey}__${bareName}`;
}

/**
 * Tools that must be denied outright under `auto_review`.
 *
 * ## Why a deny rule, and not our `canUseTool` human-only branch
 *
 * `canUseTool` is NOT a pre-review interception under `permissionMode: 'auto'`.
 * Verified by reading the shipped classifier in
 * `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` (0.2.111), whose
 * permission entry point resolves in this order:
 *
 *   1. deny rules            → `{behavior:'deny'}` returned immediately, and
 *                              the auto branch is only entered for `'ask'`
 *                              ⇒ **deny rules run before the classifier**
 *   2. `requiresUserInteraction()` tools → returned as `'ask'` before the
 *                              classifier (this is what protects
 *                              `AskUserQuestion`, which declares it `true`)
 *   3. non-`classifierApprovable` safety checks → `'ask'`
 *   4. otherwise → **the model classifier decides, and an approval returns
 *      `{behavior:'allow'}` without ever prompting** — `canUseTool` is the
 *      prompt, so it is never called.
 *
 * Our MCP tools hit case 4: nothing in the SDK marks them interactive, so
 * under `'auto'` the classifier could approve `codepilot_generate_image`
 * (spends money) or `codepilot_notify` (leaves the machine) with no human in
 * the loop. The `PermissionRequest` hook is no help either — it is dispatched
 * only in the `shouldAvoidPermissionPrompts` branch, i.e. after the classifier
 * has already run.
 *
 * That leaves deny rules as the only interception the SDK actually offers, so
 * under `auto_review` these tools are unavailable rather than reviewable. The
 * tradeoff is deliberate and fail-closed: 替我审批 means "a model may approve
 * the routine things", never "a model may spend your money or publish for
 * you". `default` / `full_access` still expose the tools normally.
 *
 * `AskUserQuestion` is intentionally NOT here: the SDK already routes it to a
 * human, and denying it would break the model's ability to ask anything.
 *
 * ## Derived, not listed (review round #3, P1)
 *
 * The set is computed by running {@link getHumanOnlyCategory} over the whole
 * in-process tool universe, so *every* rule that makes a tool human-only —
 * explicit table, credential name marker, or `mutating_external` — reaches the
 * pre-classifier boundary. A hand-maintained list could (and did) agree with
 * the classifier by coincidence while leaving derived categories enforced only
 * in `canUseTool`, which under `'auto'` may never be called.
 *
 * ## Scope, and why that is now sound (review round #4, P1)
 *
 * Only CodePilot's own in-process servers can be enumerated at options-build
 * time — a **user-configured external MCP server** ships its tool list at
 * connect time, after these options are built, so `mcp__vault__read_secret`
 * could never appear in this list and the auto-mode classifier could approve it.
 *
 * The previous round shipped that as a caveat. It is now closed at a different
 * layer instead: {@link buildClaudePermissionQueryOptions} refuses `'auto'`
 * outright when any external MCP server could load for the turn (see
 * `external-mcp.ts`). So by the time this function runs under `'auto'`, the
 * in-process universe IS the whole MCP universe, and enumerating it is a
 * complete answer rather than a partial one.
 */
export function resolveHumanOnlyDenyTools(
  permissionMode: ClaudePermissionMode,
  toolUniverse: Readonly<Record<string, string>> = CODEPILOT_MCP_TOOL_SERVERS,
): readonly string[] {
  if (permissionMode !== 'auto') return [];
  return Object.entries(toolUniverse)
    .filter(([bare]) => getHumanOnlyCategory(bare) !== undefined)
    .map(([bare, serverKey]) => toMcpToolName(bare, serverKey))
    .sort();
}

/**
 * The SDK prefixes in-process MCP tools as `mcp__<server>__<tool>`.
 * Classification tables are keyed by the bare tool name.
 */
export function toBareToolName(toolName: string): string {
  const idx = toolName.lastIndexOf('__');
  return idx === -1 ? toolName : toolName.slice(idx + 2);
}

// ─────────────────────────────────────────────────────────────────────
// Host tool auto-approval (a05)
// ─────────────────────────────────────────────────────────────────────

/**
 * CodePilot's own in-process MCP tools that stay prompt-free even though they
 * mutate something. All are `mutating_local`: they write a CodePilot DB row or
 * the user's own media library, and the user already opted in by using the
 * feature that offers them. Prompting here would be noise, not consent.
 *
 * This list is deliberately per-TOOL, not per-server. The bare `allowedTools`
 * entries it replaced were per-server, which is how `codepilot_cli_tools_install`
 * (shell exec) rode in on the same pass as `codepilot_cli_tools_list`.
 *
 * Anything `mutating_external`, `side_effect`, or human-only is absent by
 * construction — see {@link isHostAutoApproved}.
 */
export const HOST_AUTO_APPROVED_TOOLS: readonly string[] = [
  // Writes a file into the user's own media library.
  'codepilot_import_media',
  // Mutate the user's dashboard — a CodePilot-local surface.
  'codepilot_dashboard_pin',
  'codepilot_dashboard_update',
  'codepilot_dashboard_remove',
  // CodePilot-local task rows.
  'codepilot_schedule_task',
  'codepilot_cancel_task',
];

/**
 * Whether CodePilot's own rule engine approves a tool without asking anyone.
 *
 * Precedence matters and is asserted in tests:
 *   1. human-only → never (outranks every other rule, and every profile)
 *   2. `safe_read` → yes (mutationLevel-derived; no writes, no shell)
 *   3. explicit host list → yes
 *   4. anything else, including unknown tools → no (fail-safe: ask)
 */
export function isHostAutoApproved(toolName: string): boolean {
  const bare = toBareToolName(toolName);
  if (getHumanOnlyCategory(bare)) return false;
  if (shouldSkipPermission(bare)) return true;
  return HOST_AUTO_APPROVED_TOOLS.includes(bare);
}

// ─────────────────────────────────────────────────────────────────────
// Capability gate (a07)
// ─────────────────────────────────────────────────────────────────────

/**
 * First Agent SDK release whose `PermissionMode` union carries `'auto'`
 * (verified in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
 * at 0.2.111). Below this the option is disabled with a reason — it is
 * never silently rewritten to acceptEdits or full_access.
 */
export const AUTO_REVIEW_MIN_SDK_VERSION = '0.2.111';

/** Semver-ish compare limited to the `major.minor.patch` prefix. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map((n) => parseInt(n, 10));
  const pb = b.split('-')[0].split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const na = Number.isFinite(pa[i]) ? pa[i] : 0;
    const nb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

/**
 * Fail-closed: an unparseable / missing version means "not supported",
 * so the UI disables the option instead of shipping a wire value the
 * installed SDK may reject.
 */
export function isAutoReviewSupportedForVersion(version: string | undefined | null): boolean {
  if (!version || !/^\d+\.\d+/.test(version)) return false;
  return compareVersions(version, AUTO_REVIEW_MIN_SDK_VERSION) >= 0;
}

// ─────────────────────────────────────────────────────────────────────
// Claude Code wire options (a03 / a06)
// ─────────────────────────────────────────────────────────────────────

export type ClaudePermissionMode = 'plan' | 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions';

export interface ClaudeWireOptions {
  /** Value handed to the Agent SDK `Options.permissionMode`. */
  readonly permissionMode: ClaudePermissionMode;
  /**
   * Whether the dangerous bypass path is taken. ONLY `full_access` outside
   * Plan mode may set this — `auto_review` must never reach it.
   */
  readonly bypassPermissions: boolean;
  /**
   * Tools appended to `Options.disallowedTools` for this turn. Non-empty only
   * under `auto_review` — see {@link resolveHumanOnlyDenyTools} for why a deny
   * rule (not `canUseTool`) is the only interception the SDK offers here.
   */
  readonly disallowedTools: readonly string[];
  /**
   * Set when the requested profile could not be honoured. Non-null means
   * the UI owes the user an explanation; it is never a silent rewrite.
   */
  readonly degradedReason?: AutoReviewDegradedReason;
}

/**
 * Why `auto_review` could not run. Each value is a distinct fact with a
 * distinct remedy, so they never collapse into one "unavailable" string:
 *
 *   - `auto_review_unsupported` — the installed SDK has no `'auto'` mode.
 *     Remedy: upgrade.
 *   - `auto_review_external_mcp` — an external MCP server could load this turn,
 *     and its tools cannot be pre-classified. Remedy: disable it, or use
 *     `default`.
 */
export type AutoReviewDegradedReason = 'auto_review_unsupported' | 'auto_review_external_mcp';

export interface ResolveClaudeWireInput {
  readonly profile: SessionPermissionProfile;
  /** Session mode — 'plan' is read-only and outranks every profile. */
  readonly effectiveMode: string;
  /** Result of the capability gate; false ⇒ auto_review degrades loudly. */
  readonly autoReviewSupported: boolean;
  /** Global `dangerously_skip_permissions` setting. */
  readonly globalSkip?: boolean;
}

/**
 * Preserve Codex's reviewer capability at the profile-to-wire boundary.
 *
 * `resolveClaudeWireOptions` predates the Codex Runtime and therefore accepts
 * a Claude-shaped capability boolean. A Codex turn uses app-server's own
 * reviewer and must never depend on whether the separately installed Claude
 * Agent SDK supports `permissionMode:'auto'`.
 *
 * Native intentionally keeps the existing SDK answer here. Its final,
 * authoritative fail-closed decision still happens after runtime resolution in
 * `resolveRuntimeAutoReview`; this helper only stops the Claude SDK probe from
 * erasing Codex's profile before it reaches that boundary.
 */
export function resolveProfileAutoReviewSupport(input: {
  readonly runtime: string | undefined;
  readonly claudeSdkSupported: boolean;
}): boolean {
  return input.runtime === 'codex_runtime' || input.claudeSdkSupported;
}

/**
 * The single place profile → SDK wire options is decided, for both the
 * route and the client. Precedence, highest first:
 *
 *   1. **Plan mode** — read-only, always. No profile and no global setting
 *      grants execution.
 *   2. `auto_review` — `'auto'`, bypass explicitly false. Deliberately ranked
 *      ABOVE the global skip setting: see the note below.
 *   3. `full_access` (or the legacy global skip setting) — bypassPermissions.
 *   4. `default` — `'acceptEdits'` (status quo; see the plan's decision log
 *      for the semantic review of this choice).
 *
 * **Why `auto_review` outranks `globalSkip`** (review round #2, P1): the
 * `dangerously_skip_permissions` setting predates the three-profile contract.
 * When it was written, the only profiles were "ask" and "full access", so
 * "skip everything" was an unambiguous widening. It is not unambiguous any
 * more: a user who picks 替我审批 on *this session* is making a narrower,
 * later, more specific choice than a global toggle they flipped once. Letting
 * the old global setting collapse the reviewer into a blanket allow would make
 * the session picker a lie. Both Plan and auto_review are therefore
 * fail-closed against it — the global skip may only widen `default`.
 *
 * Unsupported `auto_review` degrades to `'default'` (ask for everything),
 * NOT to `acceptEdits` — the point of the profile is more review, so the
 * fail-closed direction is more asking, not less.
 */
export function resolveClaudeWireOptions(input: ResolveClaudeWireInput): ClaudeWireOptions {
  const { profile, effectiveMode, autoReviewSupported, globalSkip = false } = input;

  // 1. Plan mode wins over everything, including the global skip setting.
  //    The user asked for a read-only turn; a permission profile is not a
  //    licence to execute.
  if (effectiveMode === 'plan') {
    return { permissionMode: 'plan', bypassPermissions: false, disallowedTools: [] };
  }

  // 2. Reviewer — ranked above the global skip on purpose (see the doc note).
  if (profile === 'auto_review') {
    if (!autoReviewSupported) {
      return {
        permissionMode: 'default',
        bypassPermissions: false,
        disallowedTools: [],
        degradedReason: 'auto_review_unsupported',
      };
    }
    return {
      permissionMode: 'auto',
      bypassPermissions: false,
      disallowedTools: resolveHumanOnlyDenyTools('auto'),
    };
  }

  // 3. Bypass — the only branch allowed to set the dangerous flag.
  if (profile === 'full_access' || globalSkip) {
    return { permissionMode: 'bypassPermissions', bypassPermissions: true, disallowedTools: [] };
  }

  // 4. Status quo.
  return { permissionMode: 'acceptEdits', bypassPermissions: false, disallowedTools: [] };
}

// ─────────────────────────────────────────────────────────────────────
// Cross-runtime capability gate (review round #6, P1)
// ─────────────────────────────────────────────────────────────────────

/**
 * Cross-runtime shipping gate for `auto_review`.
 *
 * `permissionMode: 'auto'` is the cross-runtime profile carrier. Native is the
 * only runtime that still cannot implement the profile:
 *
 *   - **Native (AI SDK)** reads only `explore | normal | trust`
 *     (`permission-checker.ts`). Its `getModeRules` maps every other string —
 *     `'auto'` included — to `NORMAL_RULES` (writes auto-allowed, bash asks). So
 *     a session persisted as `auto_review`, switched onto Native, or PATCHed
 *     directly would run as plain `normal` with **no reviewer at all**, while
 *     the profile chip claims a model is checking each request. That is the
 *     反假数据 failure this contract exists to prevent — Phase 3 has not built a
 *     Native reviewer yet.
 *   - **Codex** maps `'auto'` to its own app-server fields in
 *     `codex/permission.ts`: `approvalPolicy:on-request`,
 *     `approvalsReviewer:auto_review`, workspace sandbox. The universal
 *     permissionMode is only the profile carrier up to that adapter boundary.
 *
 * Native → `'explore'` (read-only: writes / bash denied). A reviewer that
 * cannot run must not silently become "auto-allow writes".
 *
 * The caller owes the user a canonical `unavailable` review event whenever this
 * degrades (`degraded === true`), so the session is not silently downgraded.
 *
 * `runtimeId` is the runtime REGISTRY id (`resolveRuntime().id`):
 * `'claude-code-sdk' | 'native' | 'codex_runtime'`.
 */
export const CLAUDE_RUNTIME_ID = 'claude-code-sdk';
export const NATIVE_RUNTIME_ID = 'native';

export interface RuntimeAutoReviewDecision {
  /** The permissionMode string to actually ship to the resolved runtime. */
  readonly permissionMode: ClaudePermissionMode | string | undefined;
  /** True iff `'auto'` was requested on a runtime that cannot honour it. */
  readonly degraded: boolean;
}

export function resolveRuntimeAutoReview(input: {
  readonly permissionMode: ClaudePermissionMode | string | undefined;
  readonly runtimeId: string;
}): RuntimeAutoReviewDecision {
  const { permissionMode, runtimeId } = input;
  // Only 'auto' on Native is affected. Claude consumes it directly; Codex maps
  // it at the adapter boundary. Every other mode passes through untouched.
  if (permissionMode !== 'auto' || runtimeId !== NATIVE_RUNTIME_ID) {
    return { permissionMode, degraded: false };
  }
  return {
    permissionMode: 'explore',
    degraded: true,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Claude query options — the real permission boundary (a05 / a09)
// ─────────────────────────────────────────────────────────────────────

/**
 * Servers whose tools are auto-approved at the SDK boundary for a normal turn.
 *
 * `allowedTools` is auto-approve, NOT a whitelist: an entry here means the
 * request never reaches `canUseTool`, so CodePilot's classifier, the human-only
 * interception and (under auto_review) the SDK reviewer are all skipped for a
 * whole server at a time. Only read-only servers may appear:
 *
 *   - memory            — exact read tool names only; the server also has writes
 *   - widget            — renders host UI; no model-visible state
 *   - widget-guidelines — loads a static design spec
 *
 * The mutating servers (cli-tools / media / image-gen / dashboard / notify)
 * were removed in Phase 1 (a05) — `codepilot_cli_tools_install` shell-executes
 * and was riding in on the same per-server pass as `codepilot_cli_tools_list`.
 * They now flow through `canUseTool`, which keeps the safe subset prompt-free
 * via the per-TOOL {@link HOST_AUTO_APPROVED_TOOLS} list.
 */
export const MEMORY_READ_MCP_TOOLS: readonly string[] = [
  'mcp__codepilot-memory__codepilot_memory_search',
  'mcp__codepilot-memory__codepilot_memory_get',
  'mcp__codepilot-memory__codepilot_memory_recent',
];

export const BARE_ALLOWED_MCP_SERVERS: readonly string[] = [
  ...MEMORY_READ_MCP_TOOLS,
  'mcp__codepilot-widget',
  'mcp__codepilot-widget-guidelines',
  'mcp__codepilot-subagent',
];

/** Heartbeat runs get memory only — see the heartbeat note in claude-client. */
export const HEARTBEAT_ALLOWED_MCP_SERVERS: readonly string[] = MEMORY_READ_MCP_TOOLS;

/**
 * SDK builtins hard-blocked for heartbeat runs. `allowedTools` is auto-approve,
 * not a whitelist, so builtins would otherwise remain callable; the system
 * prompt also says not to, but the SDK refusal is what makes "model ignores the
 * prompt and calls Bash anyway" a non-problem.
 */
export const HEARTBEAT_DISALLOWED_BUILTINS: readonly string[] = [
  'Bash', 'Edit', 'Write', 'NotebookEdit', 'Task', 'WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep',
];

export interface ClaudeQueryPermissionInput {
  /** Wire mode already decided by {@link resolveClaudeWireOptions}. */
  readonly permissionMode: ClaudePermissionMode | string | undefined;
  /** Set ONLY by the full_access profile. */
  readonly sessionBypassPermissions: boolean;
  /** Legacy global `dangerously_skip_permissions` setting. */
  readonly globalSkip: boolean;
  readonly isHeartbeatMode: boolean;
  /** Injectable for tests; defaults to the real in-process tool surface. */
  readonly toolUniverse?: Readonly<Record<string, string>>;
  /**
   * Whether an external MCP server could reach this turn (see `external-mcp.ts`).
   * Omitted is treated as "unknown", which is fail-closed for `'auto'` — a
   * caller that forgets to probe must not silently get the permissive answer.
   */
  readonly externalMcp?: ExternalMcpStatus;
}

export interface ClaudeQueryPermissionOptions {
  readonly permissionMode: ClaudePermissionMode;
  readonly allowedTools: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly allowDangerouslySkipPermissions?: true;
  /**
   * NOT a wire field. Set when `'auto'` was requested and refused; the caller
   * owes the user a canonical `unavailable` review event. claude-client
   * destructures this off before spreading the rest into SDK `Options`.
   */
  readonly degradedReason?: AutoReviewDegradedReason;
}

/**
 * Assembles the permission-bearing slice of the Agent SDK `Options`.
 *
 * Extracted from `claude-client` in review round #3 (P1) so tests assert the
 * SHIPPING assembly instead of re-implementing it — the previous tests read the
 * source with `readSource()` and matched strings, which proves the file
 * contains some text, not that the wire is correct. claude-client spreads the
 * result verbatim; this is the only place these four fields are decided.
 */
export function buildClaudePermissionQueryOptions(
  input: ClaudeQueryPermissionInput,
): ClaudeQueryPermissionOptions {
  const { permissionMode, sessionBypassPermissions, globalSkip, isHeartbeatMode, toolUniverse } = input;

  const skipPermissions = resolveEffectiveSkipPermissions({
    permissionMode,
    sessionBypassPermissions,
    globalSkip,
  });

  let effectiveMode: ClaudePermissionMode = skipPermissions
    ? 'bypassPermissions'
    : ((permissionMode as ClaudePermissionMode) || 'acceptEdits');

  // ── The external-MCP gate (review round #4, P1) ───────────────────────
  //
  // `'auto'` hands approval to the SDK's model classifier for anything we did
  // not deny up front. We can only deny what we can enumerate, and we can only
  // enumerate our own in-process servers — an external server's tools arrive at
  // connect time, after this. So under `'auto'` a third-party
  // `mcp__vault__read_secret` would be classifier-approvable with no human and
  // no `canUseTool` call.
  //
  // There is no SDK hook that lets us classify a connect-time tool list before
  // the classifier sees it (checked in cli.js 0.2.111 — see
  // resolveHumanOnlyDenyTools). Until there is, the only honest options are
  // "don't promise" or "don't offer". The profile's whole value IS the promise,
  // so: don't offer. Refuse `'auto'` and degrade to `'default'` — ask the user
  // about everything — rather than run a reviewer whose scope we can't state.
  //
  // Unknown (`externalMcp` omitted) counts as present: a caller that skipped
  // the probe has not established absence.
  const externalMcp = input.externalMcp ?? { present: true as const, certainty: 'undetectable' as const, sources: ['probe:not-run'] };
  let degradedReason: AutoReviewDegradedReason | undefined;
  if (effectiveMode === 'auto' && externalMcp.present) {
    effectiveMode = 'default';
    degradedReason = 'auto_review_external_mcp';
  }

  // Empty unless the mode is 'auto' — see resolveHumanOnlyDenyTools.
  const humanOnlyDenyTools = resolveHumanOnlyDenyTools(effectiveMode, toolUniverse);

  const disallowedTools = isHeartbeatMode
    ? [...HEARTBEAT_DISALLOWED_BUILTINS, ...humanOnlyDenyTools]
    : [...humanOnlyDenyTools];

  return {
    permissionMode: effectiveMode,
    allowedTools: isHeartbeatMode ? HEARTBEAT_ALLOWED_MCP_SERVERS : BARE_ALLOWED_MCP_SERVERS,
    ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
    ...(skipPermissions ? { allowDangerouslySkipPermissions: true as const } : {}),
    ...(degradedReason ? { degradedReason } : {}),
  };
}

/**
 * What CodePilot's own rule engine decides for a tool BEFORE any prompt.
 *
 * This is the decision head of `canUseTool`, extracted so the fail-closed
 * behaviour for unknown tools is provable at the real boundary rather than
 * asserted through `isHostAutoApproved(x) === false` (which shows one input to
 * one helper, not what the callback does).
 *
 *   - `rule-approved` → allowed without asking anyone; audited as `rule-engine`
 *   - `human-only`    → must reach the user, whatever the profile says
 *   - `ask`           → prompt the user (also where UNKNOWN tools land)
 */
export type HostToolDecision =
  | { readonly decision: 'rule-approved' }
  | { readonly decision: 'human-only'; readonly category: HumanOnlyCategory }
  | { readonly decision: 'ask' };

export function decideHostToolPermission(toolName: string): HostToolDecision {
  const category = getHumanOnlyCategory(toolName);
  if (category) return { decision: 'human-only', category };
  if (isHostAutoApproved(toolName)) return { decision: 'rule-approved' };
  return { decision: 'ask' };
}

/**
 * Whether the legacy global `dangerously_skip_permissions` setting may turn
 * into `allowDangerouslySkipPermissions` for an already-resolved wire mode.
 *
 * `claude-client` re-reads the global setting at query-build time, after
 * {@link resolveClaudeWireOptions} has already decided. Without this guard it
 * would re-widen exactly what the resolver just refused to widen (review round
 * #2, P1). Keep this the ONLY place the two inputs are combined.
 */
export function resolveEffectiveSkipPermissions(input: {
  readonly permissionMode: ClaudePermissionMode | string | undefined;
  readonly sessionBypassPermissions: boolean;
  readonly globalSkip: boolean;
}): boolean {
  const { permissionMode, sessionBypassPermissions, globalSkip } = input;

  // Modes whose whole point is that something still inspects each request.
  // The global skip setting must not reach them — a reviewer that can be
  // switched off by an unrelated toggle is not a reviewer.
  if (permissionMode === 'auto' || permissionMode === 'plan') return false;

  return globalSkip || sessionBypassPermissions;
}
