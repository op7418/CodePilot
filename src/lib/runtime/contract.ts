/**
 * Runtime Contract — internal event / session / permission union.
 *
 * Slice A of Phase 0.5 (Runtime Contract Hardening, 2026-05-13).
 *
 * Why these types exist:
 *   Before Codex Runtime lands, CodePilot only has two runtimes
 *   (ClaudeCode SDK + Native). They each emit different concrete
 *   events (SDK tool_use vs Native step output, SDK permission_request
 *   vs Native step approval, etc.). Today the SSE layer hands the
 *   raw shape through; chat UI and PreviewPanel branch on runtime-
 *   specific fields. Adding Codex on top would triple the surface.
 *
 *   This contract collapses the surface to:
 *   - 8 canonical run events + 1 fallback (`unknown_item`)
 *   - 4 canonical permission events
 *   - 1 opaque session reference (`RuntimeSessionRef`)
 *   - 1 capability matrix (`RuntimeCapabilities`)
 *
 *   Adapters (sdk-runtime / native-runtime / future codex-runtime)
 *   translate their concrete events into this union; UI consumes only
 *   the union. Unknown items must always land in `unknown_item` —
 *   never silently dropped.
 *
 *   Slice B-E migrate consumers; Slice A only defines the shapes +
 *   ships guardrail tests that lock the contract.
 */

import type { RuntimeId } from './runtime-id';
import type { MediaBlock } from '@/types';

// ─────────────────────────────────────────────────────────────────────
// Session reference
// ─────────────────────────────────────────────────────────────────────

/**
 * Opaque handle to a runtime-specific session / thread / agent state.
 *
 * Consumers (chat session row, RunCockpit, ChatView, PreviewPanel)
 * MUST NOT inspect `metadata`. The adapter that produced the ref is
 * the only code allowed to read it back — typically by checking
 * `runtimeId` against its own id and casting to the adapter's
 * private metadata type.
 *
 * Runtime switching MUST preserve the metadata of OTHER runtimes:
 * a session that has both an SDK ref and (later) a Codex ref keeps
 * both, so toggling runtime selection in the picker doesn't wipe
 * either ref. The persistence layer should store one ref per
 * runtime id, not a single global ref.
 */
export interface RuntimeSessionRef {
  readonly runtimeId: RuntimeId;
  /**
   * Stable token identifying the runtime-side session. For SDK
   * runtime this is the Claude SDK session id; for Native runtime
   * it's the internal session id; for Codex Runtime it will be the
   * Codex thread id. Adapter-defined string.
   */
  readonly token: string;
  /**
   * Adapter-private metadata. Opaque to consumers. Use this for any
   * additional state the adapter needs to resume / track the session
   * (e.g. SDK's tool_use_id queue, Codex's turn id pointer).
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────
// Run event union (8 canonical events + 1 fallback)
// ─────────────────────────────────────────────────────────────────────

/**
 * Canonical run-event types each adapter must translate its concrete
 * events into. The 8 main types cover the assistant turn lifecycle;
 * `unknown_item` is the explicit fallback for adapter-side payloads
 * that don't fit the main set (most often plugin / extension events
 * Codex emits). The fallback path is mandatory — adapters that drop
 * unknown items silently violate the contract.
 */
export type RuntimeRunEventType =
  | 'assistant_delta'
  | 'tool_started'
  | 'tool_completed'
  | 'command_started'
  | 'file_changed'
  | 'usage_updated'
  | 'run_completed'
  | 'run_failed'
  | 'unknown_item';

interface RuntimeRunEventBase {
  readonly runtimeId: RuntimeId;
  readonly sessionId: string;
}

export type RuntimeRunEvent =
  | (RuntimeRunEventBase & {
      type: 'assistant_delta';
      text: string;
    })
  | (RuntimeRunEventBase & {
      type: 'tool_started';
      toolId: string;
      name: string;
      input?: unknown;
    })
  | (RuntimeRunEventBase & {
      type: 'tool_completed';
      toolId: string;
      output?: unknown;
      error?: string;
      /**
       * Optional media payload for tools whose output is an image /
       * audio / video file (Codex `imageGeneration`, `imageView`, MCP
       * tool results carrying image data, etc.). Surfaced through the
       * SSE `tool_result.media` channel so `useSSEStream.ts` →
       * `SSECallbacks.onToolResult` → `MediaPreview` can render the
       * file inline. Pre-Phase-5b-smoke-round-8 this field didn't
       * exist; Codex image generation completed but the result hid
       * inside the JSON-stringified `output` and was never rendered.
       */
      media?: readonly MediaBlock[];
      /** Provider-reported citations for hosted search tools. */
      sources?: readonly import('@/types').ExternalSource[];
    })
  | (RuntimeRunEventBase & {
      type: 'command_started';
      commandId: string;
      command: string;
      cwd?: string;
    })
  | (RuntimeRunEventBase & {
      type: 'file_changed';
      paths: readonly string[];
      operation?: 'created' | 'modified' | 'deleted';
    })
  | (RuntimeRunEventBase & {
      type: 'usage_updated';
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      contextWindow?: number;
    })
  | (RuntimeRunEventBase & {
      type: 'run_completed';
      finishReason?: string;
    })
  | (RuntimeRunEventBase & {
      type: 'run_failed';
      code: string;
      message: string;
    })
  | (RuntimeRunEventBase & {
      /**
       * Fallback for adapter-side payloads that don't fit the 8 main
       * event types. UI MUST render this as a generic block (e.g.
       * "Codex item: <sourceType>"), never drop it. `sourceType` is
       * adapter-defined and used only for display + telemetry.
       */
      type: 'unknown_item';
      sourceType: string;
      payload?: unknown;
    });

// ─────────────────────────────────────────────────────────────────────
// Permission event union (4 canonical events)
// ─────────────────────────────────────────────────────────────────────

/**
 * Canonical permission-event types. Adapter translates its native
 * approval / sandbox / confirm events into one of these. UI
 * (PermissionPrompt, RunCheckpoint banners) consumes only this union.
 *
 * Conservative default: if the adapter can't determine semantics,
 * emit `permission_unavailable` (not `permission_granted`).
 */
export type RuntimePermissionEventType =
  | 'permission_request'
  | 'permission_granted'
  | 'permission_denied'
  | 'permission_unavailable';

interface RuntimePermissionEventBase {
  readonly runtimeId: RuntimeId;
  readonly sessionId: string;
  readonly requestId: string;
}

/**
 * Generic permission hint shape — adapters translate native
 * suggestion structures (SDK `PermissionSuggestion`, Codex approval
 * proposals, …) into this. UI renders one chip / button per hint.
 *
 * Shape kept identical to SDK `PermissionSuggestion` for back-compat
 * with PermissionPrompt's current rendering; Codex adapter will map
 * its approval proposals into the same fields.
 */
export interface PermissionHint {
  /** Adapter-defined kind. SDK examples: 'addRule', 'addToAllowlist'. */
  type: string;
  /** Optional structured rules (used by SDK rule-based suggestions). */
  rules?: ReadonlyArray<{ readonly toolName: string; readonly ruleContent?: string }>;
  /** Optional intent — typically 'allow' / 'deny'. */
  behavior?: string;
  /** Optional destination scope ('session' / 'project' / etc.). */
  destination?: string;
}

/**
 * Adapter-private round-trip ref. UI MUST NOT inspect `raw`. The
 * adapter that produced the permission event is the only code
 * allowed to read it back — typically to echo the same id / shape
 * to the upstream resume / approval API.
 */
export interface NativeRequestRef {
  readonly runtimeId: RuntimeId;
  readonly raw: unknown;
}

export type RuntimePermissionEvent =
  | (RuntimePermissionEventBase & {
      type: 'permission_request';
      /** Tool / action being requested (e.g. 'Bash', 'Edit', 'codex.shell_exec'). */
      toolName: string;
      /** Arguments / payload the tool was invoked with. */
      toolInput?: Record<string, unknown>;
      /** SDK tool_use id, used for round-trip on resume. */
      toolUseId?: string;
      /** Human-readable summary for compact display. */
      subject: string;
      /** Longer human-readable explanation (multi-line allowed). */
      details?: string;
      /** Adapter-translated UI hints (e.g. SDK "Allow for session"). */
      permissionHints?: readonly PermissionHint[];
      /** Adapter-private shape carried through for resume / echo. */
      nativeRequestRef?: NativeRequestRef;
    })
  | (RuntimePermissionEventBase & {
      type: 'permission_granted';
    })
  | (RuntimePermissionEventBase & {
      type: 'permission_denied';
      reason?: string;
    })
  | (RuntimePermissionEventBase & {
      type: 'permission_unavailable';
      reason: string;
    });

// ─────────────────────────────────────────────────────────────────────
// Capability matrix
// ─────────────────────────────────────────────────────────────────────

/**
 * What an adapter can produce. Used by the UI to decide whether to
 * render certain affordances (e.g. don't show a "view tool input"
 * button for a runtime that doesn't emit `tool_started`).
 *
 * Adapters declare their capabilities once at registration; the
 * runtime registry / picker reads this without invoking the adapter.
 */
export interface RuntimeCapabilities {
  readonly streamingDelta: boolean;
  readonly toolCalling: boolean;
  readonly fileChanges: boolean;
  readonly permissionEvents: boolean;
  readonly commands: boolean;
  /**
   * Adapter can report the model context window dynamically (e.g. via
   * a token-usage event). When false, UI shows context as "unknown".
   */
  readonly contextWindowReportable: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Exhaustiveness helpers — used by tests + adapters
// ─────────────────────────────────────────────────────────────────────

/**
 * The complete set of run-event types, frozen. Tests assert against
 * this so adding a new run-event type is a single-place edit (this
 * array + the union above) that the test grep then verifies.
 */
export const RUNTIME_RUN_EVENT_TYPES: readonly RuntimeRunEventType[] = [
  'assistant_delta',
  'tool_started',
  'tool_completed',
  'command_started',
  'file_changed',
  'usage_updated',
  'run_completed',
  'run_failed',
  'unknown_item',
] as const;

export const RUNTIME_PERMISSION_EVENT_TYPES: readonly RuntimePermissionEventType[] = [
  'permission_request',
  'permission_granted',
  'permission_denied',
  'permission_unavailable',
] as const;
