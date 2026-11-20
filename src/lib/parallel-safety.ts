/**
 * parallel-safety.ts — Safe parallel tool execution judgment.
 *
 * Ported from Hermes Agent's run_agent.py:213-336 four-layer judgment.
 * Design philosophy: **default serial, parallelize only when proven safe**
 * (whitelist-first, not blacklist-first).
 *
 * Four-layer judgment:
 *   1. Batch size <= 1 → serial (nothing to parallelize)
 *   2. Any tool in NEVER_PARALLEL_TOOLS → serial
 *   3. Path-scoped tools with overlapping paths → serial
 *   4. Any tool not in PARALLEL_SAFE_TOOLS and not path-scoped → serial
 *
 * Integration status: this module provides the judgment helpers and is
 * exported for use by a future integration layer. Full wiring into
 * AI SDK's `streamText` tool execution requires batch-level visibility
 * that `tool({ execute })` does not currently provide — the model's
 * batch of tool calls is fanned out to individual execute calls inside
 * streamText without a pre-batch hook. Integrating will likely require
 * either (a) a shared per-session mutex for non-safe tools, or (b) a
 * wrapper layer that intercepts the fullStream's tool-call events
 * before dispatching to tool.execute.
 *
 * Reference: docs/research/hermes-agent-analysis.md §1.3, §3.1
 * Upstream:  Hermes Agent run_agent.py:213-336
 */

import path from 'path';

/**
 * Tools that must NEVER run in parallel because they require user
 * interaction or have strong serialization semantics.
 *
 * Intentionally small — mirrors Hermes' `_NEVER_PARALLEL_TOOLS` which
 * contains only `clarify`. Callers that need to add project-specific
 * interactive tools can extend this set at runtime via the options
 * parameter on `shouldParallelizeToolBatch`.
 */
export const NEVER_PARALLEL_TOOLS: ReadonlySet<string> = new Set<string>([]);

/**
 * Read-only tools with no shared mutable state — always safe to
 * parallelize. Matches CodePilot's core tool names plus built-in
 * read-side MCP tools from `codepilot_*`.
 */
export const PARALLEL_SAFE_TOOLS: ReadonlySet<string> = new Set<string>([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'codepilot_memory_search',
  'codepilot_memory_get',
  'codepilot_memory_recent',
]);

/**
 * Tools that scope their operations to a specific filesystem path.
 * These can run in parallel when their paths don't overlap.
 *
 * Note that `Read` appears here as well as in `PARALLEL_SAFE_TOOLS` —
 * this mirrors Hermes' `read_file` which is in both sets. The
 * path-scoped check is applied first; Hermes' semantic is that two
 * reads of the exact same path still serialize (conservative).
 */
export const PATH_SCOPED_TOOLS: ReadonlySet<string> = new Set<string>([
  'Read',
  'Write',
  'Edit',
]);

/** Maximum concurrent workers mirrors Hermes' `_MAX_TOOL_WORKERS`. */
export const MAX_PARALLEL_TOOL_WORKERS = 8;

/**
 * Regex matching terminal commands that modify or delete files.
 * Ported from Hermes' `_DESTRUCTIVE_PATTERNS`.
 */
const DESTRUCTIVE_PATTERNS = new RegExp(
  [
    '(?:^|\\s|&&|\\|\\||;|`)(?:',
    'rm\\s|rmdir\\s|',
    'mv\\s|',
    'sed\\s+-i|',
    'truncate\\s|',
    'dd\\s|',
    'shred\\s|',
    'git\\s+(?:reset|clean|checkout)\\s',
    ')',
  ].join(''),
);

/**
 * Output redirects that overwrite files (`>` but not `>>`).
 * Mirrors Hermes' `_REDIRECT_OVERWRITE`.
 */
const REDIRECT_OVERWRITE = /[^>]>[^>]|^>[^>]/;

/**
 * Heuristic: does this terminal command look like it modifies / deletes files?
 *
 * Exported as a standalone helper — not currently invoked by
 * `shouldParallelizeToolBatch` because CodePilot's `Bash` tool is not in
 * any of the parallel sets, so Bash calls always fall through to serial
 * execution via layer 4 regardless of destructiveness.
 *
 * Callers can use this for other purposes (permission prompts,
 * confirmation UIs, etc.).
 */
export function isDestructiveCommand(cmd: string): boolean {
  if (!cmd) return false;
  if (DESTRUCTIVE_PATTERNS.test(cmd)) return true;
  if (REDIRECT_OVERWRITE.test(cmd)) return true;
  return false;
}

/**
 * Split a filesystem path into non-empty components in a way that
 * handles both `/` and `\` separators so tests and real usage behave
 * consistently on macOS/Linux/Windows.
 */
function splitPath(p: string): string[] {
  return path.normalize(p).split(/[/\\]/).filter(Boolean);
}

/**
 * Prefix-compare two paths to detect overlap.
 *
 * Returns true when the two paths share a common ancestor chain —
 * meaning they may refer to the same subtree. This is the same
 * semantic as Hermes' `_paths_overlap`, implemented via component
 * prefix comparison. We intentionally do NOT call `fs.realpath`
 * because the target file may not exist yet (Write creates files).
 *
 * Examples:
 *   pathsOverlap('/a/b', '/a/b/c')     → true
 *   pathsOverlap('/a/b', '/a/c')       → false
 *   pathsOverlap('/a/b', '/a/b')       → true
 *   pathsOverlap('/a',   '/b')         → false
 */
export function pathsOverlap(left: string, right: string): boolean {
  const leftParts = splitPath(left);
  const rightParts = splitPath(right);
  if (leftParts.length === 0 || rightParts.length === 0) {
    return leftParts.length === rightParts.length && leftParts.length > 0;
  }
  const commonLen = Math.min(leftParts.length, rightParts.length);
  for (let i = 0; i < commonLen; i++) {
    if (leftParts[i] !== rightParts[i]) return false;
  }
  return true;
}

/**
 * Extract the normalized absolute path for a path-scoped tool call.
 * Returns null if the path cannot be determined.
 *
 * Mirrors Hermes' `_extract_parallel_scope_path`. Intentionally avoids
 * `fs.realpath` because the target file may not exist yet.
 *
 * CodePilot's Write / Edit tools use `file_path` as the arg key while
 * Read uses `path` — both are tried. If neither is present, returns
 * null and the caller will fall back to serial execution.
 */
export function extractScopePath(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string = process.cwd(),
): string | null {
  if (!PATH_SCOPED_TOOLS.has(toolName)) return null;

  const rawPath =
    (typeof args.file_path === 'string' ? (args.file_path as string) : null) ??
    (typeof args.path === 'string' ? (args.path as string) : null);

  if (rawPath === null || rawPath.trim() === '') return null;

  // Expand leading ~ to the user's home directory.
  let expanded = rawPath;
  if (expanded.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
      expanded = path.join(home, expanded.slice(1));
    }
  }

  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return path.normalize(path.join(cwd, expanded));
}

/**
 * A single tool call descriptor for batch judgment.
 * Keeps the shape minimal so callers can adapt from any tool-call
 * representation (AI SDK's `tool-call` event, OpenAI's function call,
 * or a custom structure).
 */
export interface ToolCallDescriptor {
  name: string;
  /** Parsed tool arguments. Use `{}` if unparseable or unknown. */
  args: Record<string, unknown>;
}

/**
 * Options for `shouldParallelizeToolBatch`.
 */
export interface ShouldParallelizeOptions {
  /** Working directory used to resolve relative paths. */
  cwd?: string;
  /**
   * Additional tool names that should never run in parallel. Merged
   * with the built-in `NEVER_PARALLEL_TOOLS` set at call time. Use
   * this to block project-specific interactive tools without
   * mutating the module-level set.
   */
  extraNeverParallelTools?: ReadonlySet<string>;
}

/**
 * Return true when a tool-call batch is safe to run concurrently.
 *
 * Four-layer judgment, mirrors Hermes' `_should_parallelize_tool_batch`:
 *
 *   Layer 1: batch size <= 1 → false (nothing to parallelize)
 *   Layer 2: any call in NEVER_PARALLEL_TOOLS → false
 *   Layer 3: per-call, path-scoped tools checked for path overlap
 *            against previously-reserved paths → false if any overlap
 *   Layer 4: any non-safe, non-path-scoped tool → false
 *            (whitelist-first — unknown tools default to serial)
 *
 * @param calls Tool calls in the current batch.
 * @param opts  Optional overrides.
 */
export function shouldParallelizeToolBatch(
  calls: readonly ToolCallDescriptor[],
  opts: ShouldParallelizeOptions = {},
): boolean {
  // Layer 1: singleton / empty batches don't benefit from parallelization.
  if (calls.length <= 1) return false;

  const cwd = opts.cwd ?? process.cwd();
  const extraNeverParallel = opts.extraNeverParallelTools;

  // Layer 2: any blacklisted tool → serialize whole batch.
  for (const call of calls) {
    if (NEVER_PARALLEL_TOOLS.has(call.name)) return false;
    if (extraNeverParallel && extraNeverParallel.has(call.name)) return false;
  }

  // Layers 3 + 4: per-call evaluation with reserved-paths tracking.
  const reservedPaths: string[] = [];
  for (const call of calls) {
    // Layer 3: path-scoped tools — extract path, check for overlap.
    if (PATH_SCOPED_TOOLS.has(call.name)) {
      const scope = extractScopePath(call.name, call.args, cwd);
      if (scope === null) return false; // unknown path → serial (conservative)
      for (const existing of reservedPaths) {
        if (pathsOverlap(scope, existing)) return false;
      }
      reservedPaths.push(scope);
      continue;
    }

    // Layer 4: not blacklisted, not path-scoped, must be in safe whitelist.
    if (!PARALLEL_SAFE_TOOLS.has(call.name)) return false;
  }

  return true;
}
