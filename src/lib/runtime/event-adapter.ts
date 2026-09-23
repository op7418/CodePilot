/**
 * Event adapter — Phase 0.5 Slice E (2026-05-13).
 *
 * Each runtime adapter translates its concrete native events into
 * the canonical 9-type `RuntimeRunEvent` union (8 main types +
 * `unknown_item` fallback). UI consumers (SSE channel, chat surface,
 * stream manager) consume only the canonical union.
 *
 * Mapping table — Claude Code SDK SSE → canonical:
 *
 *   SDK SSEEventType          Canonical RuntimeRunEvent
 *   --------------------------  ----------------------------------
 *   text                      → assistant_delta
 *   thinking                  → assistant_delta (different category;
 *                               consumer can branch on payload, not type)
 *   tool_use                  → tool_started
 *   tool_result               → tool_completed
 *   tool_output (stderr)      → tool_started (intermediate output;
 *                               not a separate canonical type)
 *   tool_timeout              → tool_completed (with error)
 *   status                    → unknown_item (UI metadata, not a run
 *                               event in the canonical sense)
 *   result                    → run_completed (terminal)
 *   error                     → run_failed (terminal)
 *   permission_request        → flows through RuntimePermissionEvent
 *                               (separate union — see permission-adapter.ts)
 *   mode_changed              → unknown_item (SDK-specific UI signal)
 *   task_update               → unknown_item (TodoWrite sync — UI signal)
 *   keep_alive                → ignored at canonical level (transport)
 *   rewind_point              → unknown_item (SDK feature)
 *   rate_limit                → unknown_item (telemetry; not a usage event)
 *   context_usage             → usage_updated
 *   done                      → run_completed
 *
 * Notes:
 *   - `command_started` in the canonical 8 is forward-looking for
 *     runtimes (Codex) that explicitly distinguish "a shell command
 *     started" from "a tool started". Claude Code SDK collapses both
 *     into tool_use, so we don't emit command_started for SDK today.
 *   - `file_changed` flows through the `codepilot:file-changed`
 *     window event channel (see `src/lib/file-changed-event.ts`),
 *     not the SSE stream. The canonical `file_changed` event is the
 *     logical contract that channel implements — adapters emit it
 *     into the channel, not into the SSE stream.
 *   - When Codex Runtime adds its own translators alongside
 *     `translateClaudeCodeRunEvent`, the SSE layer + chat UI don't
 *     need to change — they already consume the canonical union.
 */

import type { RuntimeRunEvent } from './contract';
import type { RuntimeId } from './runtime-id';

interface BaseInput {
  runtimeId: RuntimeId;
  sessionId: string;
}

// ─────────────────────────────────────────────────────────────────────
// Constructor helpers — adapters call these instead of inline literals
// so the canonical shapes have a single source of truth.
// ─────────────────────────────────────────────────────────────────────

export function makeAssistantDelta(
  base: BaseInput,
  text: string,
): Extract<RuntimeRunEvent, { type: 'assistant_delta' }> {
  return { type: 'assistant_delta', ...base, text };
}

export function makeToolStarted(
  base: BaseInput,
  args: { toolId: string; name: string; input?: unknown },
): Extract<RuntimeRunEvent, { type: 'tool_started' }> {
  return { type: 'tool_started', ...base, ...args };
}

export function makeToolCompleted(
  base: BaseInput,
  args: {
    toolId: string;
    output?: unknown;
    error?: string;
    /** See `tool_completed` discussion in `runtime/contract.ts` —
     *  optional MediaBlock list for image/audio/video tool results
     *  (Codex imageGeneration / imageView etc.). Drives the SSE
     *  `tool_result.media` channel that `MediaPreview` renders. */
    media?: readonly import('@/types').MediaBlock[];
    /** Provider-reported citations for hosted search tools. */
    sources?: readonly import('@/types').ExternalSource[];
  },
): Extract<RuntimeRunEvent, { type: 'tool_completed' }> {
  return { type: 'tool_completed', ...base, ...args };
}

export function makeCommandStarted(
  base: BaseInput,
  args: { commandId: string; command: string; cwd?: string },
): Extract<RuntimeRunEvent, { type: 'command_started' }> {
  return { type: 'command_started', ...base, ...args };
}

export function makeFileChanged(
  base: BaseInput,
  args: { paths: readonly string[]; operation?: 'created' | 'modified' | 'deleted' },
): Extract<RuntimeRunEvent, { type: 'file_changed' }> {
  return { type: 'file_changed', ...base, ...args };
}

export function makeUsageUpdated(
  base: BaseInput,
  args: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; contextWindow?: number },
): Extract<RuntimeRunEvent, { type: 'usage_updated' }> {
  return { type: 'usage_updated', ...base, ...args };
}

export function makeRunCompleted(
  base: BaseInput,
  args?: { finishReason?: string },
): Extract<RuntimeRunEvent, { type: 'run_completed' }> {
  return args?.finishReason !== undefined
    ? { type: 'run_completed', ...base, finishReason: args.finishReason }
    : { type: 'run_completed', ...base };
}

export function makeRunFailed(
  base: BaseInput,
  args: { code: string; message: string },
): Extract<RuntimeRunEvent, { type: 'run_failed' }> {
  return { type: 'run_failed', ...base, ...args };
}

/**
 * Mandatory fallback channel — adapters use this for any native item
 * shape they can't classify into the 8 canonical types. `sourceType`
 * is adapter-defined (e.g. `'sdk.mode_changed'` / `'codex.plugin.x'`);
 * `payload` is opaque to the UI.
 *
 * Adapter contract: NEVER silently drop an unknown item. Always
 * surface it through this fallback so the UI can render a generic
 * block — that's how new plugin / extension items stay visible
 * before bespoke renderers are added.
 */
export function makeUnknownItem(
  base: BaseInput,
  args: { sourceType: string; payload?: unknown },
): Extract<RuntimeRunEvent, { type: 'unknown_item' }> {
  return { type: 'unknown_item', ...base, ...args };
}

// ─────────────────────────────────────────────────────────────────────
// SDK SSEEventType → canonical type mapping helper.
//
// Three return categories, intentionally distinct (P2 fix from Codex
// review 2026-05-13 — earlier revision conflated "known transport-
// only" with "unknown to the adapter", which silently dropped new
// SDK / Codex item types):
//
//   - Canonical type ('assistant_delta', 'tool_started', ...) — the
//     SDK type has a direct mapping; adapter emits that canonical
//     event.
//   - `null` — known transport-only types (e.g. `keep_alive`,
//     `permission_request` which is handled through the separate
//     permission channel). Caller can safely ignore.
//   - `'unknown_item'` — the SDK type is not in the mapping table
//     at all (new SDK release, custom event, drift). Caller MUST
//     surface it via `makeUnknownItem` so the user sees a generic
//     block instead of silent drop.
//
// Adding a new known SDK type requires extending the table here; new
// types automatically fall into 'unknown_item' so they're never lost.
// ─────────────────────────────────────────────────────────────────────

const SDK_SSE_TO_CANONICAL: Record<string, RuntimeRunEvent['type'] | null> = {
  text: 'assistant_delta',
  thinking: 'assistant_delta',
  tool_use: 'tool_started',
  tool_result: 'tool_completed',
  tool_output: 'tool_started',
  tool_timeout: 'tool_completed',
  status: 'unknown_item',
  result: 'run_completed',
  error: 'run_failed',
  // permission_request flows through RuntimePermissionEvent — not in
  // RuntimeRunEvent. The translator for permissions lives in
  // permission-adapter.ts. Mapped to null here so the caller knows
  // it's handled, not lost.
  permission_request: null,
  mode_changed: 'unknown_item',
  task_update: 'unknown_item',
  keep_alive: null,
  rewind_point: 'unknown_item',
  rate_limit: 'unknown_item',
  context_usage: 'usage_updated',
  done: 'run_completed',
};

/**
 * Look up the canonical mapping for an SDK SSE event type.
 *
 * - Returns a canonical `RuntimeRunEvent['type']` when the SDK type
 *   has a direct mapping.
 * - Returns `null` for known transport-only types (`keep_alive` /
 *   `permission_request`) — caller can safely ignore.
 * - Returns `'unknown_item'` for any SDK type not in the table.
 *   Caller MUST surface this via `makeUnknownItem({ sourceType })`
 *   rather than dropping — adapters never silently lose items.
 */
export function mapSdkSseToCanonicalType(
  sdkType: string,
): RuntimeRunEvent['type'] | null {
  if (sdkType in SDK_SSE_TO_CANONICAL) {
    return SDK_SSE_TO_CANONICAL[sdkType];
  }
  return 'unknown_item';
}

/**
 * Helper for the unknown branch — wraps an unrecognized SDK item in
 * a canonical `unknown_item` event. Adapter calls this when
 * `mapSdkSseToCanonicalType(sdkType)` returns `'unknown_item'`.
 *
 * `sourceType` should be a short adapter-prefixed string (e.g.
 * `'sdk.<sdkType>'` / `'codex.plugin.<sdkType>'`) so telemetry /
 * UI can show users where the item came from.
 */
export function translateUnknownSdkEvent(
  base: BaseInput,
  args: { sdkType: string; payload?: unknown },
): Extract<RuntimeRunEvent, { type: 'unknown_item' }> {
  return makeUnknownItem(base, {
    sourceType: `sdk.${args.sdkType}`,
    payload: args.payload,
  });
}

/**
 * Exhaustive list of SDK SSE event types known to the adapter. Used
 * by tests to pin the mapping table.
 */
export const SDK_SSE_TYPES = Object.keys(SDK_SSE_TO_CANONICAL) as readonly string[];
