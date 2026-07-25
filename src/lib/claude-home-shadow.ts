/**
 * claude-home-shadow.ts — Per-request shadow ~/.claude/ for DB-provider isolation.
 *
 * ## Why
 *
 * When the user has selected an explicit DB-backed provider (Kimi, GLM,
 * OpenRouter, etc.) AND the host filesystem has a `~/.claude/settings.json`
 * with an `env` block (typically written by cc-switch or hand-edited), the
 * Claude Code SDK's settings loader (`qZq()`) writes that env block into the
 * subprocess's `process.env` AFTER our spawn-time auth injection. That
 * silently overrides the DB provider's `ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL`
 * with whatever cc-switch had configured for the global Claude Code group —
 * the request goes to the wrong endpoint with the wrong key.
 *
 * The naive fix (drop `'user'` from `settingSources`) also disables
 * user-level MCP servers, plugins, hooks, and CLAUDE.md, all of which
 * `claude-client.ts:652-654` and `plugin-discovery.ts` actively depend on.
 *
 * ## What this module does
 *
 * Build a per-request scratch directory that LOOKS like the user's
 * `~/.claude/` to the SDK subprocess, except `settings.json` and
 * `~/.claude.json` have their `ANTHROPIC_*` keys stripped from the `env` block:
 *
 *   <tmp>/codepilot-shadow-<uuid>/
 *       .claude.json               ← stripped copy (preserves user MCP servers,
 *                                     strips any auth env)
 *       .claude/
 *           settings.json          ← stripped copy (no ANTHROPIC_* in env)
 *           .credentials.json      ← copy (preserves user's OAuth tokens)
 *           CLAUDE.md              ← copy
 *           skills/        → symlink/junction to ~/.claude/skills/
 *           agents/        → symlink/junction to ~/.claude/agents/
 *           plugins/       → symlink/junction to ~/.claude/plugins/
 *           commands/      → symlink/junction to ~/.claude/commands/
 *           projects/      → symlink/junction to ~/.claude/projects/
 *           ... other entries: symlink/junction (default)
 *
 * Note on `~/.claude.json`: this root-level file holds user-scoped MCP
 * servers (per `mcp-loader.ts:46` and SDK docs). When HOME points at the
 * shadow root, the SDK looks for `<shadow-root>/.claude.json`, NOT the
 * user's real one. Without mirroring it, every DB-provider request would
 * silently lose the MCP servers defined there. We always materialize a
 * stripped copy in the shadow root when shadow mode is active.
 *
 * Spawn the SDK subprocess with `HOME=<tmp>/codepilot-shadow-<uuid>` (and
 * `USERPROFILE` on Windows). The SDK reads our stripped settings.json, the
 * `qZq()` env override loop sees no ANTHROPIC_* entries to apply, and the
 * provider's auth (which we set in spawn env) survives. Meanwhile, hooks,
 * MCP servers, plugins, skills, etc. are read through the live symlinks
 * exactly as they would be from the real `~/.claude/`.
 *
 * Cleanup is best-effort in a `finally` block. Each request gets its own
 * directory so concurrent requests don't conflict.
 *
 * ## Platform notes
 *
 * - Unix: file/dir symlinks both work without privilege.
 * - Windows: directory junctions (`fs.symlinkSync(target, path, 'junction')`)
 *   work without admin; file symlinks require admin or Developer Mode. We
 *   fall back to file copy for files on Windows when symlink fails.
 *
 * ## Non-goals
 *
 * - Not a security boundary. A misbehaving subprocess can still resolve
 *   symlinks back to the real `~/.claude/`. The goal is to control what
 *   the SDK's own settings loader sees, nothing more.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** Auth-related keys that DB-provider mode strips from settings.env. */
const AUTH_KEYS_TO_STRIP = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL', // model routing — provider's catalog must win
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  // Bedrock / Vertex routing — they switch the provider entirely
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]);

export interface ShadowHome {
  /** Absolute path to use as HOME / USERPROFILE for the SDK subprocess. */
  home: string;
  /** True when we actually built a shadow dir. False when we passed through real HOME. */
  isShadow: boolean;
  /** Best-effort recursive removal. Safe to call even on pass-through. */
  cleanup(): void;
}

const REAL_HOME = (): string => os.homedir();
const isWindows = process.platform === 'win32';

function passthrough(): ShadowHome {
  return { home: REAL_HOME(), isShadow: false, cleanup: () => { /* nothing */ } };
}

function readSettingsJson(realClaudeDir: string): { content: Record<string, unknown> | null; raw: string | null } {
  const candidates = [
    path.join(realClaudeDir, 'settings.json'),
    path.join(realClaudeDir, 'claude.json'), // legacy cc-switch name
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return { content: parsed, raw };
    } catch {
      // continue to next candidate
    }
  }
  return { content: null, raw: null };
}

function envBlockHasAnyAuthEntry(content: Record<string, unknown> | null): boolean {
  if (!content) return false;
  const env = (content.env && typeof content.env === 'object') ? content.env as Record<string, unknown> : null;
  if (!env) return false;
  for (const key of AUTH_KEYS_TO_STRIP) {
    const v = env[key];
    if (typeof v === 'string' && v.length > 0) return true;
  }
  return false;
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Returns true when EITHER `~/.claude/settings.json` OR `~/.claude.json` has
 * at least one auth-related env entry that would override our DB provider's
 * auth at spawn time. If false, no shadow is needed — the real HOME is fine.
 *
 * Both files are documented user-scoped config sources (mcp-loader.ts:46),
 * and either can carry an `env` block, so we have to inspect both before
 * declaring the request bleed-free.
 */
export function settingsJsonHasAuthOverride(): boolean {
  const settingsContent = readSettingsJson(
    path.join(/* turbopackIgnore: true */ REAL_HOME(), '.claude'),
  ).content;
  if (envBlockHasAnyAuthEntry(settingsContent)) return true;

  const dotClaudeJson = readJsonFile(
    path.join(/* turbopackIgnore: true */ REAL_HOME(), '.claude.json'),
  );
  if (envBlockHasAnyAuthEntry(dotClaudeJson)) return true;

  return false;
}

/**
 * Strip auth-related keys from a settings object's `env` block. Mutates the
 * input shallowly and returns it. Other top-level fields (mcpServers, hooks,
 * permissions, enabledPlugins, apiKeyHelper, etc.) are left untouched.
 */
function stripAuthEnv(settings: Record<string, unknown>): Record<string, unknown> {
  const env = settings.env;
  if (!env || typeof env !== 'object') return settings;
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (AUTH_KEYS_TO_STRIP.has(k)) continue;
    cleaned[k] = v;
  }
  return { ...settings, env: cleaned };
}

/**
 * Mirror one entry from real `~/.claude/<name>` into the shadow `.claude/<name>`.
 * Tries symlink first; on Windows file-symlink failure, copies. Skips errors.
 */
function mirrorEntry(realPath: string, shadowPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(realPath);
  } catch {
    return; // entry vanished between readdir and now — skip
  }

  // For directories on Windows, use junction (no privilege required).
  // For everything else, plain symlink (Unix or symlinks-enabled Windows).
  try {
    if (isWindows && stat.isDirectory()) {
      fs.symlinkSync(realPath, shadowPath, 'junction');
    } else {
      fs.symlinkSync(realPath, shadowPath);
    }
    return;
  } catch {
    // Symlink failed (most likely Windows file symlink without admin).
    // Fall back to copy for files; for directories we can't easily recover.
  }

  if (stat.isDirectory()) {
    // Last-resort recursive copy. Slow but better than missing the directory.
    try {
      fs.cpSync(realPath, shadowPath, { recursive: true, dereference: false });
    } catch {
      // Give up on this entry. The subprocess just won't see it.
    }
  } else {
    try {
      fs.copyFileSync(realPath, shadowPath);
    } catch {
      // Give up on this entry.
    }
  }
}

/**
 * Build a shadow HOME for the SDK subprocess.
 *
 * @param opts.stripAuth - true when the caller is a DB-provider request and
 *   wants settings.env's ANTHROPIC_* keys removed. False (or omitted) for
 *   env-mode where settings.json should pass through verbatim.
 * @returns Either a real shadow directory + cleanup callback, or a
 *   pass-through (real HOME) when no shadow is needed (no settings.json,
 *   no auth keys to strip, or stripAuth=false).
 */
export function createShadowClaudeHome(opts: { stripAuth: boolean }): ShadowHome {
  if (!opts.stripAuth) return passthrough();

  // Check both user-scoped settings files for any auth env entries. If neither
  // has any, we don't need to build a shadow at all — pass through real HOME.
  const realClaudeDir = path.join(/* turbopackIgnore: true */ REAL_HOME(), '.claude');
  const settingsContent = fs.existsSync(realClaudeDir)
    ? readSettingsJson(realClaudeDir).content
    : null;
  const dotClaudeJsonPath = path.join(
    /* turbopackIgnore: true */ REAL_HOME(),
    '.claude.json',
  );
  const dotClaudeJsonContent = readJsonFile(dotClaudeJsonPath);

  const settingsHasAuth = envBlockHasAnyAuthEntry(settingsContent);
  const dotClaudeHasAuth = envBlockHasAnyAuthEntry(dotClaudeJsonContent);
  if (!settingsHasAuth && !dotClaudeHasAuth) return passthrough();

  // Build the shadow tree.
  const shadowRoot = fs.mkdtempSync(
    path.join(/* turbopackIgnore: true */ os.tmpdir(), 'codepilot-shadow-claude-'),
  );
  const shadowClaudeDir = path.join(
    /* turbopackIgnore: true */ shadowRoot,
    '.claude',
  );

  try {
    fs.mkdirSync(shadowClaudeDir, { recursive: true });

    // Mirror everything inside ~/.claude/ except settings.json (we'll write a
    // stripped copy below). Subdirectories preserve user-level skills, agents,
    // commands, plugins via symlinks/junctions.
    if (fs.existsSync(realClaudeDir)) {
      let entries: string[];
      try {
        entries = fs.readdirSync(realClaudeDir);
      } catch {
        entries = [];
      }
      for (const name of entries) {
        if (name === 'settings.json' || name === 'claude.json') continue;
        mirrorEntry(
          path.join(/* turbopackIgnore: true */ realClaudeDir, name),
          path.join(/* turbopackIgnore: true */ shadowClaudeDir, name),
        );
      }
    }

    // Stripped ~/.claude/settings.json. If real one was missing/unreadable,
    // we still write a minimal `{}` so the SDK doesn't error on absent file.
    const settingsToWrite = settingsContent ? stripAuthEnv(settingsContent) : {};
    fs.writeFileSync(
      path.join(/* turbopackIgnore: true */ shadowClaudeDir, 'settings.json'),
      JSON.stringify(settingsToWrite, null, 2),
    );

    // Mirror ~/.claude.json (root-level, not inside .claude/). This is the
    // documented home for user-scoped MCP servers (mcp-loader.ts:46). When
    // HOME points at the shadow root, the SDK looks for <shadow>/.claude.json,
    // not the user's real one — without this mirror, every DB-provider
    // request silently loses MCP servers defined here. Strip auth env in case
    // it contains one too.
    if (dotClaudeJsonContent) {
      const dotClaudeToWrite = stripAuthEnv(dotClaudeJsonContent);
      fs.writeFileSync(
        path.join(/* turbopackIgnore: true */ shadowRoot, '.claude.json'),
        JSON.stringify(dotClaudeToWrite, null, 2),
      );
    }
    // If `~/.claude.json` doesn't exist on disk at all, we don't create one —
    // matches real-HOME semantics where SDK just doesn't see a file.
  } catch (err) {
    // If we can't even write the shadow files, the whole shadow is useless.
    // Clean up and pass through. The bleed will happen, but the alternative
    // (request fails entirely) is worse.
    console.warn('[shadow-home] Failed to materialize shadow tree, falling back to real HOME:',
      err instanceof Error ? err.message : err);
    try { fs.rmSync(shadowRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    return passthrough();
  }

  // Build short id from path for diagnostic logs (don't leak full tmp path)
  const id = crypto.createHash('sha1').update(shadowRoot).digest('hex').slice(0, 8);
  console.log(`[shadow-home] Built shadow HOME ${id} for DB-provider request — settings.json + .claude.json env stripped`);

  let cleanedUp = false;
  return {
    home: shadowRoot,
    isShadow: true,
    cleanup: () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        fs.rmSync(shadowRoot, { recursive: true, force: true });
      } catch (err) {
        // Best-effort cleanup; the OS will eventually GC tmpdir
        console.warn(`[shadow-home] Failed to clean up shadow dir ${id}:`, err instanceof Error ? err.message : err);
      }
    },
  };
}
