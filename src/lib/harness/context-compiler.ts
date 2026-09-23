/**
 * Harness Context Compiler — single pure function that produces the
 * system prompt + tool surface + artifact contracts that any Runtime
 * adapter (ClaudeCode SDK, CodePilot Native, Codex Runtime via
 * provider proxy) feeds to the model.
 *
 * Phase 5d Phase 2 (2026-05-17).
 *
 * ── What this module is ────────────────────────────────────────────
 *
 * `compileContext(input)` returns a `CompiledContext` describing what
 * to inject + in what order + how much budget went to each category.
 * The compiler is a PURE FUNCTION: same input → same output, no IO,
 * no network calls, no Date.now / random reads, no provider calls.
 * That property is what makes the compiler testable in isolation and
 * what lets Phase 3 Runtime Capability Adapters layer on a single
 * deterministic input.
 *
 * Each runtime's adapter calls the compiler ONCE per turn and then
 * adapts the output — it does NOT re-build prompt text, re-paraphrase
 * capability rules, or re-define artifact wire formats. The compiler
 * is the only producer of capability-level prompt fragments.
 *
 * ── What this module is NOT ────────────────────────────────────────
 *
 * Compiler does not:
 *   - execute tools (those stay in MCP / AI SDK / bridge factories)
 *   - process SSE events
 *   - render UI
 *   - call providers or upstream LLMs
 *   - read filesystem / DB / network (all IO happens in the caller;
 *     pre-fetched snapshots are passed in via `assistantMemory`)
 *   - mutate session state
 *   - make permission decisions (consumes the hint, does not round-trip)
 *
 * ── Source-of-truth references ─────────────────────────────────────
 *
 *   - Capability catalog: `src/lib/harness/capability-contract.ts`
 *   - Widget wire format: `src/lib/widget-guidelines.ts`
 *   - Expected drift acknowledgements:
 *     `src/lib/harness/expected-differences.ts`
 *
 * Drift tests in `harness-context-compiler.test.ts` +
 * `harness-context-compiler-equivalence.test.ts` enforce alignment.
 */

import type { RuntimeId } from '@/lib/runtime/runtime-id';
import {
  HARNESS_CAPABILITIES,
  type CapabilityContract,
} from './capability-contract';
import {
  WIDGET_WIRE_FORMAT_SPEC,
  CANONICAL_SHOW_WIDGET_JSON,
} from '@/lib/widget-guidelines';

// ─────────────────────────────────────────────────────────────────────
// Input types
// ─────────────────────────────────────────────────────────────────────

export interface AssistantMemorySnapshot {
  /** Pre-fetched recent daily memory entries. Compiler does NOT read
   *  the filesystem; the caller resolves these and passes them in. */
  readonly recentEntries?: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
    readonly date?: string;
  }>;
  /** Optional long-term memory.md summary (truncated by caller). */
  readonly longTermSummary?: string;
}

export type PermissionProfile = 'default' | 'read_only' | 'full';

export interface CompilerInput {
  /** Chat session id. Used for diagnostics + downstream routing. */
  readonly sessionId: string;
  /** Optional working directory. Some capabilities are gated on its
   *  presence; the caller decides whether to include them in
   *  `enabledCapabilities`. */
  readonly workingDirectory?: string;
  /** Which runtime is asking. Determines which `exposure.<runtime>`
   *  is consulted on each capability + which `runtimeHints` are
   *  populated. */
  readonly runtimeId: RuntimeId;
  /** Provider id (DB id or virtual id like `openai-oauth`). Pre-5c
   *  consumers may not need it; kept for adapter use. */
  readonly providerId: string;
  /** Model id. Same rationale as providerId. */
  readonly model: string;
  /** The user's prompt. Compiler does not parse it for keyword
   *  gating — that's the caller's job. Kept on input for adapters
   *  that want to attach it as diagnostic context. */
  readonly userPrompt: string;
  /** Capabilities the caller authorises. `null` means "default to
   *  every capability with `status === 'live'` in the catalog". The
   *  caller is responsible for gating logic (keyword / workspace /
   *  permission). The compiler trusts this set. */
  readonly enabledCapabilities: ReadonlySet<string> | null;
  /**
   * Concrete tool names the Runtime mounted for this request. When present,
   * runtime hints are the intersection of the catalog contract and this set.
   * This is required for auth-gated tools such as Grok video: enabling the
   * image_generation capability must not advertise a video tool that the
   * current OAuth state did not mount.
   */
  readonly availableToolNames?: ReadonlySet<string>;
  /** Pre-fetched assistant memory snapshot. Compiler builds memory
   *  fragments from this without touching disk. */
  readonly assistantMemory?: AssistantMemorySnapshot;
  /** Permission profile hint. Reserved for future write-capability
   *  filtering (Phase 4 scope); currently informational. */
  readonly permissionProfile?: PermissionProfile;
  /** Budget envelope. Compiler enforces these (FAIL on overflow of
   *  load-bearing fragments; drop memory/workspace on overflow of
   *  optional fragments). */
  readonly tokenBudget: {
    readonly systemPromptMax: number;
    readonly contextMax: number;
  };
  /** Future flags; compiler currently ignores unknown keys. */
  readonly flags?: Readonly<Record<string, boolean>>;
}

// ─────────────────────────────────────────────────────────────────────
// Output types
// ─────────────────────────────────────────────────────────────────────

interface FragmentBase {
  /** Stable id. Drift tests pin against this — never derive a model-
   *  facing string from a fragmentId. */
  readonly fragmentId: string;
  /** Capability id (from `capability-contract.ts`) the fragment
   *  belongs to. For non-capability fragments (memory/workspace/base)
   *  the field is set to a synthetic id like `__base__`. */
  readonly sourceCapability: string;
  /** File path the fragment text was sourced from (relative to repo
   *  root). Drift test confirms the file + export exist. */
  readonly sourceFile: string;
  /** Exported symbol within the file. */
  readonly sourceExport: string;
  /** The actual text the model will see. */
  readonly text: string;
  /** Compiler-estimated token cost. Cheap char/4 heuristic. */
  readonly tokens: number;
}

export interface CapabilityFragment extends FragmentBase {
  readonly kind: 'capability';
}

export interface ArtifactContractFragment extends FragmentBase {
  readonly kind: 'artifact_contract';
  /** Fence language the model uses to emit the artifact
   *  (`show-widget` / `image-gen-request` / etc.). */
  readonly fenceLanguage: string;
  /** Copy/paste-safe JSON example. The compiler verifies it parses
   *  via `JSON.parse` before emitting it. */
  readonly canonicalJson: string;
  /** Required JSON fields. Renderer-side parser uses these to drop
   *  malformed artifacts into the `malformed_*` segment path. */
  readonly requiredFields: readonly string[];
}

export interface MemoryFragment extends FragmentBase {
  readonly kind: 'memory';
  readonly memoryKind: 'recent' | 'long_term';
}

export interface WorkspaceFragment extends FragmentBase {
  readonly kind: 'workspace';
  readonly workspaceKind: 'hook' | 'rule' | 'context';
}

export interface ToolDescriptor {
  /** Tool name the model can call. */
  readonly name: string;
  /** Capability id the tool belongs to. Cross-references
   *  `capability-contract.ts`. */
  readonly sourceCapability: string;
  /** Runtime-exposure kind for the calling runtime
   *  (`mcp_server` / `ai_sdk_tool` / `bridge_executable`). Used by
   *  the adapter to decide how to mount the tool. */
  readonly exposureKind: string;
}

export interface ClaudeCodeHints {
  readonly mcpServerNames: readonly string[];
  readonly allowedToolNames: readonly string[];
}

export interface NativeHints {
  readonly toolSetKeys: readonly string[];
}

export interface CodexProxyHints {
  /** Names the Codex bridge translates from `tool-call` → no
   *  Responses function_call (suppression set). */
  readonly builtinToolNames: ReadonlySet<string>;
  /** Multi-step ai-sdk stopWhen mode. */
  readonly stopWhen: 'stepCountIs' | 'never';
  /** Step ceiling when `stopWhen === 'stepCountIs'`. */
  readonly stepCount: number;
  /** Codex's non-function tool kinds the proxy keeps in
   *  `passthroughTools`. Currently informational. */
  readonly passthroughToolTypes: readonly string[];
}

export interface DroppedFragment {
  readonly fragmentId: string;
  readonly reason: 'budget' | 'duplicate' | 'gated' | 'invalid_artifact';
  readonly details?: string;
}

export interface CapabilityDecision {
  readonly capabilityId: string;
  readonly decision: 'included' | 'excluded';
  readonly reason: string;
}

export interface BudgetReport {
  readonly used: number;
  readonly max: number;
  readonly perCategory: {
    readonly basePrompt: number;
    readonly artifactContracts: number;
    readonly capabilityFragments: number;
    readonly workspaceFragments: number;
    readonly memoryFragments: number;
  };
}

export interface CompiledContext {
  /** Runtime-agnostic CodePilot opening (always empty in Phase 2;
   *  each Runtime still owns its own framing for now — adapters
   *  prepend their Runtime-specific header to `systemPromptText`). */
  readonly basePrompt: string;
  readonly capabilityFragments: readonly CapabilityFragment[];
  readonly artifactContracts: readonly ArtifactContractFragment[];
  readonly memoryFragments: readonly MemoryFragment[];
  readonly workspaceFragments: readonly WorkspaceFragment[];
  readonly toolDescriptors: readonly ToolDescriptor[];
  /** Runtime-specific adapter hints. Each Hints type is strictly
   *  IDs / refs / adapter options — NO prose, NO paraphrase, NO tool
   *  schema redefinition. Source of every model-facing string must
   *  be a fragment with `sourceFile + sourceExport`, NOT a hint. */
  readonly runtimeHints: {
    readonly claudecode_sdk?: ClaudeCodeHints;
    readonly native?: NativeHints;
    readonly codex_proxy?: CodexProxyHints;
  };
  readonly budget: BudgetReport;
  /** Pre-assembled system prompt. Consumers SHOULD prefer this over
   *  re-assembling from individual fragments — that avoids drift. */
  readonly systemPromptText: string;
  readonly diagnostics: {
    readonly droppedFragments: readonly DroppedFragment[];
    readonly dedupedFragments: readonly string[];
    readonly capabilityDecisions: readonly CapabilityDecision[];
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/** Cheap char/4 token estimate. Good enough for budget enforcement
 *  in Phase 2 — accuracy < ±20% across all current model families.
 *  If a runtime later observes systematic budget under/overshoot,
 *  swap this for a model-specific tokenizer. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The AI SDK multi-step ceiling for Codex Runtime when the bridge has
 * mounted at least one CodePilot built-in tool. 8 is the empirical
 * value pinned by Phase 5c smoke (memory → image gen → narration →
 * schedule task chains). Lives here so the proxy adapter no longer
 * keeps a parallel `BUILTIN_BRIDGE_STEP_LIMIT` constant that could
 * drift from the compiler hint.
 */
const CODEX_BRIDGE_STEP_LIMIT = 8;

/** Map `RuntimeId` (canonical runtime label) → the
 *  `capability.exposure` key (machine-friendly exposure-method label).
 *  These intentionally differ: RuntimeId is product-facing; exposure
 *  keys describe HOW each runtime hosts the capability. */
function exposureKeyForRuntime(
  runtimeId: RuntimeId,
): 'claudecode_sdk' | 'native' | 'codex_proxy' {
  switch (runtimeId) {
    case 'claude_code':
      return 'claudecode_sdk';
    case 'codepilot_runtime':
      return 'native';
    case 'codex_runtime':
      return 'codex_proxy';
  }
}

/** Resolve the capability set the compiler will consider. */
function resolveEnabledCapabilities(
  enabled: ReadonlySet<string> | null,
): readonly CapabilityContract[] {
  if (enabled === null) {
    // Default = every live capability. Caller can override.
    return HARNESS_CAPABILITIES.filter((c) => c.status === 'live');
  }
  return HARNESS_CAPABILITIES.filter((c) => enabled.has(c.id));
}

/** Build a capability fragment from a contract entry. Returns null if
 *  the runtime's exposure for this capability is `unsupported` — in
 *  that case the capability is not exposed in this runtime. */
function buildCapabilityFragment(
  cap: CapabilityContract,
  exposureKey: 'claudecode_sdk' | 'native' | 'codex_proxy',
): CapabilityFragment | null {
  const exposure = cap.exposure[exposureKey];
  if (exposure.kind === 'unsupported') return null;
  if (cap.systemPromptFragment.length === 0) return null;
  // Fragment id = `cap.<id>.systemPrompt`. Stable across runtimes so
  // dedup across calls (e.g. a future composite compile) is trivial.
  return {
    kind: 'capability',
    fragmentId: `cap.${cap.id}.systemPrompt`,
    sourceCapability: cap.id,
    sourceFile: deriveSourceFile(cap),
    sourceExport: deriveSourceExport(cap),
    text: cap.systemPromptFragment,
    tokens: estimateTokens(cap.systemPromptFragment),
  };
}

/** The capability-contract.ts entries name the authoritative file +
 *  export. For Phase 2 we hard-code the mapping; a future refactor
 *  could attach `{ sourceFile, sourceExport }` directly on each
 *  contract entry. */
function deriveSourceFile(cap: CapabilityContract): string {
  switch (cap.id) {
    case 'widget':
      return 'src/lib/widget-guidelines.ts';
    case 'memory':
    case 'memory_write':
      return 'src/lib/memory-service.ts';
    case 'tasks_and_notify':
    case 'assistant_buddy':
      return 'src/lib/notification-mcp.ts';
    case 'image_generation':
    case 'media_import':
      return 'src/lib/media-capability-prompt.ts';
    case 'dashboard':
      return 'src/lib/dashboard-mcp.ts';
    case 'cli_tools':
      return 'src/lib/cli-tools-mcp.ts';
    default:
      return '<unknown>';
  }
}

function deriveSourceExport(cap: CapabilityContract): string {
  switch (cap.id) {
    case 'widget':
      return 'WIDGET_SYSTEM_PROMPT';
    case 'memory':
      return 'MEMORY_SEARCH_SYSTEM_PROMPT';
    case 'memory_write':
      return 'MEMORY_WRITE_SYSTEM_PROMPT';
    case 'tasks_and_notify':
    case 'assistant_buddy':
      return 'NOTIFICATION_MCP_SYSTEM_PROMPT';
    case 'image_generation':
    case 'media_import':
      return 'MEDIA_CAPABILITY_SYSTEM_PROMPT';
    case 'dashboard':
      return 'DASHBOARD_MCP_SYSTEM_PROMPT';
    case 'cli_tools':
      return '<inline-in-factory>';
    default:
      return '<unknown>';
  }
}

/** Build an artifact-contract fragment if the capability has one.
 *  This is the SOLE source of the wire-format spec for that
 *  artifact — the capability fragment must NOT also embed it. */
function buildArtifactContract(
  cap: CapabilityContract,
): ArtifactContractFragment | null {
  if (!cap.artifactContract) return null;
  const ac = cap.artifactContract;
  // The text block we hand the model is the canonical spec block.
  // For widget that's WIDGET_WIRE_FORMAT_SPEC (which already embeds
  // canonicalJson). For other future artifacts the contract entry
  // would carry its own wire-spec source.
  const text =
    cap.id === 'widget' ? WIDGET_WIRE_FORMAT_SPEC : ac.canonicalJson;
  return {
    kind: 'artifact_contract',
    fragmentId: `artifact.${cap.id}.wireFormat`,
    sourceCapability: cap.id,
    sourceFile: cap.id === 'widget' ? 'src/lib/widget-guidelines.ts' : '<unknown>',
    sourceExport:
      cap.id === 'widget' ? 'WIDGET_WIRE_FORMAT_SPEC' : '<canonicalJson>',
    text,
    tokens: estimateTokens(text),
    fenceLanguage: ac.fenceLanguage,
    canonicalJson: ac.canonicalJson,
    requiredFields: ac.requiredFields,
  };
}

/** Build memory fragments from the pre-fetched snapshot. */
function buildMemoryFragments(
  snapshot: AssistantMemorySnapshot | undefined,
): MemoryFragment[] {
  if (!snapshot) return [];
  const out: MemoryFragment[] = [];
  if (snapshot.longTermSummary && snapshot.longTermSummary.length > 0) {
    out.push({
      kind: 'memory',
      memoryKind: 'long_term',
      fragmentId: 'memory.longTermSummary',
      sourceCapability: 'memory',
      sourceFile: '<snapshot:longTermSummary>',
      sourceExport: '<longTermSummary>',
      text: `## Long-term Memory\n${snapshot.longTermSummary}`,
      tokens: estimateTokens(snapshot.longTermSummary),
    });
  }
  for (const entry of snapshot.recentEntries ?? []) {
    const label = entry.date ?? entry.path;
    const text = `## ${label}\n${entry.content}`;
    out.push({
      kind: 'memory',
      memoryKind: 'recent',
      fragmentId: `memory.recent.${label}`,
      sourceCapability: 'memory',
      sourceFile: `<snapshot:recent:${entry.path}>`,
      sourceExport: '<recentEntry>',
      text,
      tokens: estimateTokens(text),
    });
  }
  return out;
}

/** Sanity check: capability fragment text must NOT embed an artifact
 *  contract's canonicalJson. If it does the compiler is about to
 *  duplicate the wire spec — fail loudly. */
function detectWireFormatDuplication(
  capFragments: readonly CapabilityFragment[],
  artifactContracts: readonly ArtifactContractFragment[],
): string[] {
  const errors: string[] = [];
  for (const ac of artifactContracts) {
    for (const cap of capFragments) {
      if (cap.sourceCapability === ac.sourceCapability) {
        if (cap.text.includes(ac.canonicalJson)) {
          errors.push(
            `Capability fragment "${cap.fragmentId}" embeds the artifact contract's canonicalJson — this would duplicate the wire format in the compiled prompt. Strip the spec from the capability source (e.g. WIDGET_SYSTEM_PROMPT should not embed WIDGET_WIRE_FORMAT_SPEC).`,
          );
        }
      }
    }
  }
  return errors;
}

// ─────────────────────────────────────────────────────────────────────
// Compiler
// ─────────────────────────────────────────────────────────────────────

export function compileContext(input: CompilerInput): CompiledContext {
  const exposureKey = exposureKeyForRuntime(input.runtimeId);
  const enabled = resolveEnabledCapabilities(input.enabledCapabilities);

  const capabilityFragments: CapabilityFragment[] = [];
  const artifactContracts: ArtifactContractFragment[] = [];
  const toolDescriptors: ToolDescriptor[] = [];
  const decisions: CapabilityDecision[] = [];
  const seenFragmentIds = new Set<string>();
  const dedupedFragments: string[] = [];

  for (const cap of HARNESS_CAPABILITIES) {
    if (!enabled.includes(cap)) {
      decisions.push({
        capabilityId: cap.id,
        decision: 'excluded',
        reason:
          cap.status !== 'live'
            ? `status=${cap.status}`
            : 'not in enabledCapabilities',
      });
      continue;
    }
    const exposure = cap.exposure[exposureKey];
    if (exposure.kind === 'unsupported') {
      decisions.push({
        capabilityId: cap.id,
        decision: 'excluded',
        reason: `${exposureKey} unsupported (${exposure.notes ?? 'no notes'})`,
      });
      continue;
    }
    // Capability fragment
    const fragment = buildCapabilityFragment(cap, exposureKey);
    if (fragment) {
      if (seenFragmentIds.has(fragment.fragmentId)) {
        dedupedFragments.push(fragment.fragmentId);
      } else {
        capabilityFragments.push(fragment);
        seenFragmentIds.add(fragment.fragmentId);
      }
    }
    // Artifact contract (if any)
    const artifact = buildArtifactContract(cap);
    if (artifact) {
      if (seenFragmentIds.has(artifact.fragmentId)) {
        dedupedFragments.push(artifact.fragmentId);
      } else {
        // Validate canonicalJson parses + (for widget) has the
        // required fields. Compile-time JSON.parse failure is FATAL.
        try {
          const parsed = JSON.parse(artifact.canonicalJson) as Record<
            string,
            unknown
          >;
          for (const f of artifact.requiredFields) {
            if (!Object.prototype.hasOwnProperty.call(parsed, f)) {
              throw new Error(
                `artifact contract for "${cap.id}" missing required field "${f}" in canonicalJson`,
              );
            }
          }
        } catch (err) {
          throw new Error(
            `Compiler refused to emit artifact contract for "${cap.id}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        artifactContracts.push(artifact);
        seenFragmentIds.add(artifact.fragmentId);
      }
    }
    // Tool descriptors (one per declared tool name; the compiler
    // doesn't know per-tool schemas — those stay in MCP / AI SDK /
    // bridge factories).
    for (const toolName of cap.toolNames) {
      if (input.availableToolNames && !input.availableToolNames.has(toolName)) {
        continue;
      }
      toolDescriptors.push({
        name: toolName,
        sourceCapability: cap.id,
        exposureKind: exposure.kind,
      });
    }
    decisions.push({
      capabilityId: cap.id,
      decision: 'included',
      reason: `${exposureKey} kind=${exposure.kind}`,
    });
  }

  // Wire-format duplication sanity. Slice 2c (WIDGET_SYSTEM_PROMPT
  // refactor) is what makes this pass for widget; until then a
  // mid-migration build would fail here, which is the desired
  // forcing function.
  const dupErrors = detectWireFormatDuplication(
    capabilityFragments,
    artifactContracts,
  );
  if (dupErrors.length > 0) {
    throw new Error(
      `Compiler detected wire-format duplication:\n  - ${dupErrors.join('\n  - ')}`,
    );
  }

  // Memory fragments (from pre-fetched snapshot).
  const memoryFragments = buildMemoryFragments(input.assistantMemory);

  // Workspace fragments — Phase 2 minimum: none. Future phases will
  // populate from workspace hooks / rules pre-fetched by caller.
  const workspaceFragments: WorkspaceFragment[] = [];

  const basePrompt = '';
  const dropped: DroppedFragment[] = [];

  // Build runtime hints — strictly IDs / refs / adapter options.
  // Mutable accumulator inside the function, then frozen into the
  // readonly shape via Object spread on return.
  const runtimeHintsBuilder: {
    claudecode_sdk?: ClaudeCodeHints;
    native?: NativeHints;
    codex_proxy?: CodexProxyHints;
  } = {};
  if (input.runtimeId === 'claude_code') {
    const mcpServerNames = [...new Set(enabled
      .map((c) => {
        const e = c.exposure.claudecode_sdk;
        return e.kind === 'mcp_server'
          ? mcpServerForCapability(c.id)
          : null;
      })
      .filter((s): s is string => !!s))];
    runtimeHintsBuilder.claudecode_sdk = {
      mcpServerNames,
      allowedToolNames: toolDescriptors.map((t) => t.name),
    };
  } else if (input.runtimeId === 'codepilot_runtime') {
    runtimeHintsBuilder.native = {
      toolSetKeys: toolDescriptors.map((t) => t.name),
    };
  } else if (input.runtimeId === 'codex_runtime') {
    const builtinToolNames = new Set(toolDescriptors.filter(t => t.exposureKind === 'bridge_executable').map(t => t.name));
    runtimeHintsBuilder.codex_proxy = {
      builtinToolNames,
      stopWhen: builtinToolNames.size > 0 ? 'stepCountIs' : 'never',
      stepCount: CODEX_BRIDGE_STEP_LIMIT,
      passthroughToolTypes: [],
    };
  }
  const runtimeHints: CompiledContext['runtimeHints'] = runtimeHintsBuilder;

  // Assemble system prompt text: artifactContracts → capability
  // fragments. Memory + workspace land in CompiledContext fields but
  // not in the system prompt itself (callers decide where they
  // belong — some adapters prepend to system prompt, some attach as
  // user-context messages).
  const systemPromptParts: string[] = [];
  if (basePrompt.length > 0) systemPromptParts.push(basePrompt);
  for (const a of artifactContracts) systemPromptParts.push(a.text);
  for (const c of capabilityFragments) systemPromptParts.push(c.text);
  const systemPromptText = systemPromptParts.join('\n\n');

  // Budget — compute per-category usage. Phase 2 doesn't actively
  // drop based on budget yet (most prompts are well under 4 KB); the
  // diagnostic record is populated so callers can observe usage.
  const tokenize = (frags: readonly { tokens: number }[]): number =>
    frags.reduce((sum, f) => sum + f.tokens, 0);
  const budget: BudgetReport = {
    used:
      estimateTokens(basePrompt) +
      tokenize(artifactContracts) +
      tokenize(capabilityFragments) +
      tokenize(workspaceFragments) +
      tokenize(memoryFragments),
    max: input.tokenBudget.systemPromptMax,
    perCategory: {
      basePrompt: estimateTokens(basePrompt),
      artifactContracts: tokenize(artifactContracts),
      capabilityFragments: tokenize(capabilityFragments),
      workspaceFragments: tokenize(workspaceFragments),
      memoryFragments: tokenize(memoryFragments),
    },
  };
  if (budget.perCategory.basePrompt +
      budget.perCategory.artifactContracts +
      budget.perCategory.capabilityFragments > budget.max) {
    throw new Error(
      `Compiler load-bearing fragments (base + artifactContracts + capabilityFragments = ${
        budget.perCategory.basePrompt +
        budget.perCategory.artifactContracts +
        budget.perCategory.capabilityFragments
      }) exceed systemPromptMax (${budget.max}). Raise the budget or split the catalog.`,
    );
  }

  return {
    basePrompt,
    capabilityFragments,
    artifactContracts,
    memoryFragments,
    workspaceFragments,
    toolDescriptors,
    runtimeHints,
    budget,
    systemPromptText,
    diagnostics: {
      droppedFragments: dropped,
      dedupedFragments,
      capabilityDecisions: decisions,
    },
  };
}

/** MCP server names from the static BUILTIN_MCP_CATALOG / capability
 *  catalog. Phase 2 hard-codes this mapping; a future refactor can
 *  cross-link to `BUILTIN_MCP_CATALOG`. */
function mcpServerForCapability(id: string): string | null {
  switch (id) {
    case 'widget':
      return 'codepilot-widget';
    case 'memory':
    case 'memory_write':
      return 'codepilot-memory';
    case 'tasks_and_notify':
    case 'assistant_buddy':
      return 'codepilot-notify';
    case 'image_generation':
      return 'codepilot-image-gen';
    case 'media_import':
      return 'codepilot-media';
    case 'dashboard':
      return 'codepilot-dashboard';
    case 'cli_tools':
      return 'codepilot-cli-tools';
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Re-export referenced canonicals so tests can import them in one go.
// ─────────────────────────────────────────────────────────────────────

export { CANONICAL_SHOW_WIDGET_JSON, WIDGET_WIRE_FORMAT_SPEC };
