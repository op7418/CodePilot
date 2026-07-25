/**
 * External Framework Harness scanner — Phase 5e Phase 1 (2026-05-17).
 *
 * Surfaces user-installed extensions in OTHER agent frameworks
 * (`~/.claude/*`, `~/.codex/*`) into CodePilot's HarnessBundle so:
 *
 *   - The model knows the user has e.g. a custom `~/.claude/mcp.json`
 *     even when running the current turn through Codex Runtime (the
 *     Codex side can't execute a ClaudeCode-only MCP, but it CAN
 *     mention "你在 ClaudeCode 里挂了 X，如果要用切回 ClaudeCode
 *     Runtime").
 *
 *   - Settings UI lists the user's external configuration cross-
 *     framework so they understand their full plugin surface in one
 *     place.
 *
 * ── Strict safety boundaries ──────────────────────────────────────
 *
 *   1. **Read-only.** Never writes any file.
 *
 *   2. **Filename allowlist.** Reads ONLY known-non-secret config
 *      files. Auth tokens / API keys are NEVER read. The forbidden
 *      list (`auth.json`, `*.token`, `*credentials*`, `*.key`) is
 *      enforced before any open.
 *
 *   3. **Best-effort.** A scan error on one framework degrades to
 *      "user has no external extensions in that framework" rather
 *      than throwing.
 *
 *   4. **No execution.** This file does NOT call shell, does NOT
 *      launch external CLIs, and does NOT spawn child processes. It
 *      reads small config files and infers what extensions exist.
 *
 * If a future scanner needs to inspect a file that COULD carry
 * secrets, the read must go through `readSafeConfig()` below which
 * rejects entire files (not field-level redaction — too fragile).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  ExternalFrameworkHarnessRef,
  ExternalFrameworkId,
} from './harness-bundle';

/** Filename patterns that are NEVER read by this scanner. Pre-check
 *  before every open. */
const FORBIDDEN_FILENAME_PATTERNS: readonly RegExp[] = [
  /auth\.json$/i,
  /^auth_/i,
  /\.token$/i,
  /credentials/i,
  /\.key$/i,
  /\.pem$/i,
  /\.crt$/i,
  /secret/i,
];

/** Verify a path is safe to read. Used by `readSafeConfig`. */
function isFilenameSafe(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  return !FORBIDDEN_FILENAME_PATTERNS.some((re) => re.test(basename));
}

/** Read a config file with safety pre-check. Returns null on any
 *  failure (missing / forbidden / unreadable / unparseable). */
function readSafeConfig(filePath: string): string | null {
  if (!isFilenameSafe(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    // Reject large files defensively — config files are small;
    // anything > 1MB is suspicious (could be a leaked secrets store).
    if (stat.size > 1024 * 1024) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Scan external framework user configurations.
 *
 * The current Runtime informs the `executable` field — extensions
 * that belong to the same framework as the active Runtime get
 * `executable: true` (subject to capability-contract); others get
 * `executable: false` + a perceptionHint telling the user / model
 * which Runtime to switch to.
 */
export function scanExternalFrameworkExtensions(opts: {
  /** Active Runtime — used to mark extensions belonging to the same
   *  framework as executable. */
  readonly activeFramework?: ExternalFrameworkId;
  /** Override home directory — used by tests with tmpdir. Defaults
   *  to `os.homedir()`. */
  readonly homeDir?: string;
} = {}): readonly ExternalFrameworkHarnessRef[] {
  const home = opts.homeDir ?? os.homedir();
  const out: ExternalFrameworkHarnessRef[] = [];

  // ── ClaudeCode (~/.claude/*) ──────────────────────────────────────
  out.push(...scanClaudeCodeFramework(home, opts.activeFramework));

  // ── Codex (~/.codex/*) ───────────────────────────────────────────
  out.push(...scanCodexFramework(home, opts.activeFramework));

  return out;
}

function scanClaudeCodeFramework(
  home: string,
  activeFramework: ExternalFrameworkId | undefined,
): ExternalFrameworkHarnessRef[] {
  const out: ExternalFrameworkHarnessRef[] = [];
  const claudeDir = path.join(/* turbopackIgnore: true */ home, '.claude');
  if (!existsSafe(claudeDir)) return out;

  const isActive = activeFramework === 'claude_code';
  const perceptionHintTpl = (kind: string) =>
    isActive
      ? undefined
      : `Detected in your ClaudeCode config (~/.claude/${kind}). Not callable in the current Runtime; switch to ClaudeCode SDK Runtime to use it.`;

  // ~/.claude/mcp.json (ClaudeCode user MCP servers)
  const mcpPath = path.join(claudeDir, 'mcp.json');
  const mcpContent = readSafeConfig(mcpPath);
  if (mcpContent) {
    try {
      // ClaudeCode mcp.json shape: { mcpServers: { name: { command, args, ... } } }
      const parsed = JSON.parse(mcpContent) as {
        mcpServers?: Record<string, unknown>;
      };
      const servers = parsed.mcpServers ?? {};
      for (const name of Object.keys(servers)) {
        out.push({
          framework: 'claude_code',
          kind: 'mcp_server',
          origin: mcpPath,
          id: `claude:mcp:${name}`,
          displayName: `${name} (ClaudeCode MCP)`,
          executable: isActive,
          ...(isActive
            ? {}
            : { perceptionHint: perceptionHintTpl('mcp.json') }),
        });
      }
    } catch {
      // JSON malformed — skip
    }
  }

  // ~/.claude/CLAUDE.md (ClaudeCode user-level memory / instructions)
  const userClaudeMd = path.join(claudeDir, 'CLAUDE.md');
  if (existsSafe(userClaudeMd) && isFilenameSafe(userClaudeMd)) {
    out.push({
      framework: 'claude_code',
      kind: 'memory',
      origin: userClaudeMd,
      id: 'claude:CLAUDE.md',
      displayName: '~/.claude/CLAUDE.md (user memory)',
      executable: isActive,
      ...(isActive
        ? {}
        : { perceptionHint: perceptionHintTpl('CLAUDE.md') }),
    });
  }

  // ~/.claude/skills/ (ClaudeCode user skills)
  const skillsDir = path.join(claudeDir, 'skills');
  for (const name of listSubdirsSafe(skillsDir)) {
    out.push({
      framework: 'claude_code',
      kind: 'skill',
      origin: path.join(skillsDir, name),
      id: `claude:skill:${name}`,
      displayName: `${name} (ClaudeCode Skill)`,
      executable: isActive,
      ...(isActive
        ? {}
        : { perceptionHint: perceptionHintTpl('skills/') }),
    });
  }

  // ~/.claude/commands/ (ClaudeCode user slash commands)
  const commandsDir = path.join(claudeDir, 'commands');
  for (const name of listFilenamesSafe(commandsDir, '.md')) {
    out.push({
      framework: 'claude_code',
      kind: 'plugin',
      origin: path.join(commandsDir, name),
      id: `claude:cmd:${name.replace(/\.md$/, '')}`,
      displayName: `/${name.replace(/\.md$/, '')} (ClaudeCode slash)`,
      executable: isActive,
      ...(isActive
        ? {}
        : { perceptionHint: perceptionHintTpl('commands/') }),
    });
  }

  return out;
}

function scanCodexFramework(
  home: string,
  activeFramework: ExternalFrameworkId | undefined,
): ExternalFrameworkHarnessRef[] {
  const out: ExternalFrameworkHarnessRef[] = [];
  const codexDir = path.join(/* turbopackIgnore: true */ home, '.codex');
  if (!existsSafe(codexDir)) return out;

  const isActive = activeFramework === 'codex';
  const perceptionHintTpl = (kind: string) =>
    isActive
      ? undefined
      : `Detected in your Codex config (~/.codex/${kind}). Not callable in the current Runtime; switch to Codex Runtime to use it.`;

  // ~/.codex/config.toml — Codex CLI config. We DON'T parse TOML
  // (no deps + secrets risk); we only confirm the file's existence
  // as evidence that the user uses Codex. Auth fields are not read.
  const configToml = path.join(codexDir, 'config.toml');
  if (existsSafe(configToml) && isFilenameSafe(configToml)) {
    out.push({
      framework: 'codex',
      kind: 'plugin',
      origin: configToml,
      id: 'codex:config.toml',
      displayName: '~/.codex/config.toml (Codex CLI config)',
      executable: isActive,
      ...(isActive ? {} : { perceptionHint: perceptionHintTpl('config.toml') }),
    });
  }

  // ~/.codex/plugins/ — directory of installed Codex plugins
  const pluginsDir = path.join(codexDir, 'plugins');
  for (const name of listSubdirsSafe(pluginsDir)) {
    out.push({
      framework: 'codex',
      kind: 'plugin',
      origin: path.join(pluginsDir, name),
      id: `codex:plugin:${name}`,
      displayName: `${name} (Codex plugin)`,
      executable: isActive,
      ...(isActive ? {} : { perceptionHint: perceptionHintTpl('plugins/') }),
    });
  }

  // ~/.codex/prompts/ — user prompt fragments (Codex 0.4+)
  const promptsDir = path.join(codexDir, 'prompts');
  for (const name of listFilenamesSafe(promptsDir, '.md')) {
    out.push({
      framework: 'codex',
      kind: 'memory',
      origin: path.join(promptsDir, name),
      id: `codex:prompt:${name.replace(/\.md$/, '')}`,
      displayName: `${name.replace(/\.md$/, '')} (Codex prompt)`,
      executable: isActive,
      ...(isActive ? {} : { perceptionHint: perceptionHintTpl('prompts/') }),
    });
  }

  return out;
}

function existsSafe(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function listSubdirsSafe(dir: string): readonly string[] {
  if (!existsSafe(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter(isFilenameSafe);
  } catch {
    return [];
  }
}

function listFilenamesSafe(dir: string, ext?: string): readonly string[] {
  if (!existsSafe(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .filter((n) => (ext ? n.endsWith(ext) : true))
      .filter(isFilenameSafe);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test helpers — exported so contract tests can verify the safety
// boundary directly without spawning fixtures.
// ─────────────────────────────────────────────────────────────────────

/** Exported for unit tests: verify the auth-token allowlist. */
export const __TEST_isFilenameSafe = isFilenameSafe;
export const __TEST_FORBIDDEN_PATTERNS: readonly RegExp[] =
  FORBIDDEN_FILENAME_PATTERNS;
