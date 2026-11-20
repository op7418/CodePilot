/**
 * Phase 6 — Context Usage Breakdown contract.
 *
 * Pure data layer for the upcoming dot-matrix Context UI (Phase 2-3).
 * Decomposes total token usage into 10 user-facing categories so the chat
 * input dot-matrix bar can show which source is heavy.
 *
 * Categories mirror Cursor's Context Usage Breakdown (System prompt / Tools /
 * Rules / Skills / MCP / Subagents → mapped to Memory) + CodePilot real
 * sources (files_attachments / conversation / pending_next_turn /
 * cache_or_previous).
 *
 * IMPORTANT: confidence labels (measured / estimated / derived) are
 * deliberately NOT exposed per user feedback on 2026-05-19. Only token
 * counts and an internal `source` breadcrumb flow.
 *
 * Invariants:
 * - Parts ordering is stable (matches CONTEXT_BREAKDOWN_KIND_ORDER).
 * - When known parts ≤ usedTokens: sum of "used" parts === usedTokens
 *   (conversation absorbs the residual).
 * - When known parts > usedTokens: conversation clamps to 0, so sum of
 *   "used" parts === knownParts > usedTokens. The contract intentionally
 *   trusts the known-part estimators rather than silently scaling them
 *   down; the clamp signals "compiler over-estimated" without rewriting
 *   inputs. UI may surface this via tooltip later. (Codex P2 finding
 *   2026-05-19.)
 * - pending parts (files_attachments + pending_next_turn) are NOT in
 *   usedTokens — they describe what would join the next turn.
 * - ratio and remainingTokens are undefined when contextWindow is unknown
 *   or non-positive.
 *
 * Related:
 * - docs/exec-plans/active/phase-6-context-visualization.md
 */

export type ContextBreakdownKind =
  | 'system_prompt'
  | 'tools'
  | 'rules'
  | 'skills'
  | 'mcp'
  | 'memory'
  | 'files_attachments'
  | 'conversation'
  | 'pending_next_turn'
  | 'cache_or_previous';

/** Stable order of parts for renderers and tests. */
export const CONTEXT_BREAKDOWN_KIND_ORDER: readonly ContextBreakdownKind[] = [
  'system_prompt',
  'tools',
  'rules',
  'skills',
  'mcp',
  'memory',
  'files_attachments',
  'conversation',
  'pending_next_turn',
  'cache_or_previous',
] as const;

/**
 * Fallback labels (Chinese-only) for tests / non-React consumers / debug.
 *
 * **Do NOT render these directly in user-facing UI.** The UI surface
 * (`ContextBreakdownList.tsx`) MUST use `useTranslation()` with
 * `runStatus.breakdown*` keys — see that component's LABEL_KEY map.
 *
 * Codex P1 finding (2026-05-19): rendering `part.label` directly mixed
 * Chinese DEFAULT_LABELS into the English UI. Labels are now wired through
 * i18n at the rendering boundary; DEFAULT_LABELS remains so `part.label`
 * stays populated for unit tests, JSON serialization, and console logging
 * where i18n isn't available.
 */
export const DEFAULT_LABELS: Record<ContextBreakdownKind, string> = {
  system_prompt: '系统提示',
  tools: '工具',
  rules: '规则',
  skills: 'Skills',
  mcp: 'MCP',
  memory: 'Memory',
  files_attachments: '文件与附件',
  conversation: '对话历史',
  pending_next_turn: '本次待加入',
  cache_or_previous: '缓存 / 上轮',
};

/**
 * Kinds that describe pending (composer-side, not yet sent) tokens.
 * Dot-matrix renderer uses these to decide dashed-outline vs. solid fill.
 */
export const PENDING_BREAKDOWN_KINDS: readonly ContextBreakdownKind[] = [
  'files_attachments',
  'pending_next_turn',
] as const;

export interface ContextBreakdownPart {
  kind: ContextBreakdownKind;
  /** User-facing label. */
  label: string;
  /** Token count. 0 when data source not wired or empty. */
  tokens: number;
  /** Internal debug breadcrumb — never rendered to user. */
  source: string;
  /** Optional sub-detail for popover (e.g. file name list). */
  detail?: string;
}

export interface ContextUsageBreakdown {
  /** Sum of all "used" (non-pending) parts; matches legacy usage.used. */
  usedTokens: number;
  /** Resolved model context window, or undefined when unknown / invalid. */
  contextWindow?: number;
  /** Window - usedTokens, clamped ≥ 0; undefined when window unknown. */
  remainingTokens?: number;
  /** usedTokens / contextWindow clamped to [0,1]; undefined when unknown. */
  ratio?: number;
  /** Always 10 entries, in CONTEXT_BREAKDOWN_KIND_ORDER. */
  parts: ContextBreakdownPart[];
}

/** Baseline usage from latest assistant API response. */
export interface ContextBreakdownBaseline {
  used: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

/** Pending (composer) token estimates per source. */
export interface ContextBreakdownPending {
  /** PromptInput attachment pending tokens. */
  attachmentTokens?: number;
  /** @mention path estimates. */
  mentionTokens?: number;
  /** Directory reference estimates (file-tree "+" chip). */
  directoryTokens?: number;
  /** Plain composer text estimate (not yet wired in Phase 1a; defaults 0). */
  composerTextTokens?: number;
}

/**
 * Compiler / harness-side fragments. All fields optional — undefined means
 * "data source not yet wired" and the part shows 0 tokens.
 */
export interface ContextBreakdownCompiler {
  systemPromptTokens?: number;
  /** Tool descriptor estimates excluding MCP. */
  toolDescriptorTokens?: number;
  /** Workspace / project rule fragments. */
  workspaceRuleTokens?: number;
  /** Skill prompts + HarnessBundle user/external extension prompts. */
  skillsHarnessTokens?: number;
  /** MCP server tool definitions only. */
  mcpDescriptorTokens?: number;
  /** Memory fragments (recent + long_term + session summary). */
  memoryTokens?: number;
}

export interface ContextBreakdownInputs {
  baseline?: ContextBreakdownBaseline;
  contextWindow?: number;
  pending?: ContextBreakdownPending;
  compiler?: ContextBreakdownCompiler;
}

/**
 * Build the breakdown. Pure function — no React, no I/O, no side effects.
 *
 * @param inputs Optional baseline / contextWindow / pending / compiler.
 * @returns 10-part breakdown with stable ordering and clamped invariants.
 */
export function buildContextUsageBreakdown(
  inputs: ContextBreakdownInputs,
): ContextUsageBreakdown {
  const { baseline, contextWindow, pending, compiler } = inputs;

  const reportedUsedTokens = Math.max(0, Math.floor(baseline?.used ?? 0));
  const outputTokens = Math.max(0, Math.floor(baseline?.outputTokens ?? 0));

  // === Used parts (sum equals usedTokens after conversation residual) ===

  const systemPromptTokens = Math.max(0, compiler?.systemPromptTokens ?? 0);
  const toolsTokens = Math.max(0, compiler?.toolDescriptorTokens ?? 0);
  const rulesTokens = Math.max(0, compiler?.workspaceRuleTokens ?? 0);
  const skillsTokens = Math.max(0, compiler?.skillsHarnessTokens ?? 0);
  const mcpTokens = Math.max(0, compiler?.mcpDescriptorTokens ?? 0);
  const memoryTokens = Math.max(0, compiler?.memoryTokens ?? 0);
  const cacheTokens = Math.max(
    0,
    (baseline?.cacheReadTokens ?? 0) + (baseline?.cacheCreationTokens ?? 0),
  );

  const knownUsedNonConversation =
    systemPromptTokens +
    toolsTokens +
    rulesTokens +
    skillsTokens +
    mcpTokens +
    memoryTokens +
    cacheTokens;

  // Phase 7 fallback (2026-05-20): Native+Codex via provider proxies often
  // report input_tokens=0, so reportedUsedTokens is 0 even when entries
  // expose real per-turn token cost (entries.tools/skills/mcp + outputTokens).
  // Promote effective used to the floor of "what we DO know is in context".
  // No double-count risk on ClaudeCode where reportedUsedTokens already
  // includes everything — max() always picks the larger.
  const usedTokens = Math.max(
    reportedUsedTokens,
    knownUsedNonConversation + outputTokens,
  );

  const validWindow =
    typeof contextWindow === 'number' && contextWindow > 0
      ? contextWindow
      : undefined;
  const ratio =
    validWindow !== undefined
      ? Math.min(1, Math.max(0, usedTokens / validWindow))
      : undefined;
  const remainingTokens =
    validWindow !== undefined
      ? Math.max(0, validWindow - usedTokens)
      : undefined;

  // Conversation absorbs residual; clamps to 0 when known parts exceed used.
  const conversationTokens = Math.max(
    0,
    usedTokens - knownUsedNonConversation,
  );

  // === Pending parts (NOT in usedTokens) ===

  const filesAttachmentsTokens = Math.max(
    0,
    (pending?.attachmentTokens ?? 0) +
      (pending?.mentionTokens ?? 0) +
      (pending?.directoryTokens ?? 0),
  );
  const pendingNextTurnTokens = Math.max(0, pending?.composerTextTokens ?? 0);

  // === Assemble in stable order ===

  const tokensByKind: Record<ContextBreakdownKind, number> = {
    system_prompt: systemPromptTokens,
    tools: toolsTokens,
    rules: rulesTokens,
    skills: skillsTokens,
    mcp: mcpTokens,
    memory: memoryTokens,
    files_attachments: filesAttachmentsTokens,
    conversation: conversationTokens,
    pending_next_turn: pendingNextTurnTokens,
    cache_or_previous: cacheTokens,
  };

  const sourceByKind: Record<ContextBreakdownKind, string> = {
    system_prompt: 'context-compiler.systemPromptText',
    tools: 'context-compiler.toolDescriptors (excludes MCP)',
    rules: 'context-compiler.workspaceFragments',
    skills: 'harness-bundle.userCapabilities+externalExtensions(skill)',
    mcp: 'harness-bundle.builtinCapabilities(mcp_server)',
    memory: 'context-compiler.memoryFragments',
    files_attachments: 'message-input.pending(attachment+mention+directory)',
    conversation: 'context-usage-walk.baseline.used residual',
    pending_next_turn: 'composer text (not wired in Phase 1a)',
    cache_or_previous: 'context-usage-walk.baseline.cacheRead+Creation',
  };

  const parts: ContextBreakdownPart[] = CONTEXT_BREAKDOWN_KIND_ORDER.map(
    (kind) => ({
      kind,
      label: DEFAULT_LABELS[kind],
      tokens: tokensByKind[kind],
      source: sourceByKind[kind],
    }),
  );

  return {
    usedTokens,
    contextWindow: validWindow,
    remainingTokens,
    ratio,
    parts,
  };
}
