/**
 * Codex provider-proxy injection helper.
 *
 * Phase 5 Phase 5 (2026-05-13). Builds the `config` override passed
 * to Codex `thread/start` so Codex resolves the user's targeted
 * CodePilot provider through our local proxy route instead of trying
 * to call the upstream API directly.
 *
 * Codex schema: `ThreadStartParams.config?: { [key: string]: JsonValue }`
 * is a free-form override map. The proxy injection sets:
 *
 *   config.model_providers = {
 *     codepilot_proxy: {
 *       name: 'CodePilot via Codex',
 *       base_url: 'http://127.0.0.1:<port>/api/codex/proxy/v1',
 *       wire_api: 'responses',
 *       http_headers: { 'x-codepilot-target-provider': '<provider-id>' },
 *     }
 *   }
 *
 * The header is how the proxy route knows which CodePilot provider
 * the user picked. We use a header (not a query string) because
 * Codex's HTTP client adds them to every request to that provider
 * without needing per-request override plumbing.
 *
 * Phase 5b status: the proxy route is fully implemented for every
 * recognised compat tier via the unified translator at
 * `src/lib/codex/proxy/unified-adapter.ts`. CodexRuntime.stream()
 * threads provider id through to `buildCodexThreadParams`
 * below, so a non-codex_account provider's first message creates
 * a thread bound to the proxy injection; subsequent messages on the
 * same chat session resume that thread as long as the provider
 * binding still matches (mismatch detection in `runtime.ts`).
 */

import type { CodexMcpServersConfig } from './mcp-config';

const PROVIDER_KEY = 'codepilot_proxy' as const;

export interface CodexProxyInjection {
  modelProvider: typeof PROVIDER_KEY;
  config: {
    model_providers: {
      [PROVIDER_KEY]: {
        name: string;
        base_url: string;
        wire_api: 'responses';
        http_headers: Record<string, string>;
      };
    };
  };
}

/**
 * Build the Codex thread/start config override that routes a target
 * CodePilot provider through the local Responses proxy.
 *
 * @param targetProviderId — CodePilot provider DB id (used by the
 *   proxy route via x-codepilot-target-provider header to look up
 *   the provider record and decide compat / forwarding).
 * @param baseUrl — absolute URL CodePilot is reachable at from
 *   wherever Codex runs (usually `http://127.0.0.1:<port>` in dev,
 *   localhost in packaged Electron).
 * @param opts.sessionId — Phase 5c (2026-05-16). Chat session id so the
 *   proxy can mount CodePilot built-in tools (`codepilot_generate_image`
 *   etc.) and address the side-channel event bus that pipes tool
 *   results back to the running ChatView. Empty (default) leaves the
 *   bridge off — old chat-only behaviour preserved for back-compat
 *   smoke runs.
 * @param opts.workspacePath — Phase 5c. Working directory the chat
 *   was launched in; bridge tools that need a cwd (image gen
 *   reference paths, memory workspace lookup, scheduled-task origin
 *   record) receive it through this header.
 */
export function buildCodexProviderProxyInjection(
  targetProviderId: string,
  baseUrl: string,
  opts: { sessionId?: string; workspacePath?: string } = {},
): CodexProxyInjection {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'x-codepilot-target-provider': targetProviderId,
  };
  // Only emit the header when we actually have a value — Codex
  // copies http_headers verbatim onto every request, and an empty
  // string would confuse the proxy's "did the runtime tell us?"
  // check (which then re-mounts the bridge for a chat-less smoke).
  if (opts.sessionId && opts.sessionId.length > 0) {
    headers['x-codepilot-session-id'] = opts.sessionId;
  }
  if (opts.workspacePath && opts.workspacePath.length > 0) {
    headers['x-codepilot-workspace-path'] = opts.workspacePath;
  }
  return {
    modelProvider: PROVIDER_KEY,
    config: {
      model_providers: {
        [PROVIDER_KEY]: {
          name: 'CodePilot via Codex',
          base_url: `${trimmed}/api/codex/proxy/v1`,
          wire_api: 'responses',
          http_headers: headers,
        },
      },
    },
  };
}

/**
 * Build the shared `cwd / modelProvider / config` payload that BOTH
 * `thread/start` and `thread/resume` need. Codex's
 * `ThreadResumeParams` schema (codex-rs/.../v2/ThreadResumeParams.ts)
 * accepts `modelProvider`, `config`, and `cwd` exactly like
 * `ThreadStartParams`. Phase 5b previously passed these only on start
 * — the resume path inherited whatever the Codex server still had in
 * memory for the thread. That breaks when:
 *
 *   1. CodePilot's dev port changed between turns (proxy base_url is
 *      no longer valid in the cached config).
 *   2. The Codex app-server restarted between turns (in-memory thread
 *      metadata cleared; resume reload from disk may or may not
 *      include the codepilot_proxy entry depending on persistence).
 *   3. A future Codex version normalises thread state and prunes
 *      unknown model_providers across reloads.
 *
 * Always re-attaching the same payload on resume avoids all three
 * cases. Codex treats resume-time overrides as authoritative for the
 * resumed thread per the schema's "Configuration overrides for the
 * resumed thread" docstring.
 *
 *   - `'codex_account'` (virtual provider) → no injection. The thread
 *     uses Codex's own model_providers map keyed under its native
 *     OAuth account.
 *   - any non-empty non-`'env'` providerId → proxy injection so Codex
 *     routes upstream calls through `/api/codex/proxy/v1/responses`.
 *   - empty / `'env'` → caller MUST reject before reaching this fn;
 *     this is an unreachable contract violation that we surface as
 *     a thrown error rather than silently constructing a no-op.
 *
 * The return shape is intentionally a plain object the runtime
 * spreads into either `{ ...params }` (for thread/start) or
 * `{ threadId, ...params }` (for thread/resume).
 */
/**
 * The `config` override blob for a Codex thread. Both keys are optional
 * and merged independently — proxy routing lives under `model_providers`,
 * MCP injection under `mcp_servers` (Phase 8 Phase 2). They never
 * overwrite each other; a codex_account thread carries only `mcp_servers`.
 */
export interface CodexThreadConfig {
  model_providers?: CodexProxyInjection['config']['model_providers'];
  mcp_servers?: CodexMcpServersConfig;
}

export interface CodexThreadParams {
  cwd?: string;
  /** Optional model id. Codex's `thread_start_params_from_config` and
   *  `thread_resume_params_from_config` (codex-rs/tui/.../app_server_session.rs)
   *  both pass `model` alongside `modelProvider` + `config` because
   *  the modelProvider config refers to a `default_model` lookup
   *  inside its own map; we don't set `default_model` on the
   *  `codepilot_proxy` entry, so without `model` Codex resolves to
   *  null and rejects the turn before our adapter ever sees it. */
  model?: string;
  modelProvider?: string;
  config?: CodexThreadConfig;
}

export function buildCodexThreadParams(opts: {
  providerId: string;
  workingDirectory?: string;
  proxyBaseUrl: string;
  /** Model id the chat session selected. Forwarded to Codex's
   *  thread/start + thread/resume so the proxy injection resolves to
   *  the right model id before the turn runs. */
  model?: string;
  /** Phase 5c (2026-05-16) — CodePilot chat session id. Threaded into
   *  the proxy injection's `x-codepilot-session-id` header so the
   *  proxy can mount the CodePilot built-in tool bridge for this
   *  chat. Codex Account paths skip the injection entirely (see
   *  branch below); the field is silently ignored there. */
  sessionId?: string;
  /** Phase 8 Phase 2 (2026-05-27) — Codex-native MCP servers to inject
   *  under `config.mcp_servers`. Applied to BOTH provider branches
   *  (codex_account and codepilot_proxy) so Memory / user MCP is
   *  available regardless of how the upstream model is reached. The
   *  caller builds this via `buildCodexMcpServersConfig` /
   *  `buildCodexMemoryMcpConfig`. */
  mcpServers?: CodexMcpServersConfig;
}): CodexThreadParams {
  const providerId = opts.providerId.trim();
  if (!providerId || providerId === 'env') {
    throw new Error(
      'buildCodexThreadParams called with env / empty providerId — caller must reject the request before building thread params.',
    );
  }
  const hasMcp = opts.mcpServers && Object.keys(opts.mcpServers).length > 0;
  const base: CodexThreadParams = {};
  if (opts.workingDirectory) base.cwd = opts.workingDirectory;
  if (opts.model) base.model = opts.model;

  if (providerId === 'codex_account') {
    // No proxy injection — Codex uses its own OAuth account. MCP servers
    // (if any) are the only `config` entry on this branch.
    return hasMcp ? { ...base, config: { mcp_servers: opts.mcpServers } } : base;
  }

  const injection = buildCodexProviderProxyInjection(providerId, opts.proxyBaseUrl, {
    sessionId: opts.sessionId,
    workspacePath: opts.workingDirectory,
  });
  return {
    ...base,
    modelProvider: injection.modelProvider,
    // Merge — proxy routing AND MCP injection coexist; neither overwrites
    // the other.
    config: {
      ...injection.config,
      ...(hasMcp ? { mcp_servers: opts.mcpServers } : {}),
    },
  };
}

/**
 * Resolve the base URL CodePilot's Next server is reachable at from
 * the Codex app-server's perspective. In dev + Electron the
 * app-server is a child process on the same host, so 127.0.0.1
 * + the dev port works. The env var override is for unusual
 * deployments (containerized testing, remote Codex etc.).
 */
export function resolveCodexProxyBaseUrl(): string {
  return (
    process.env.CODEPILOT_PROXY_BASE_URL ??
    `http://127.0.0.1:${process.env.PORT ?? '3000'}`
  );
}

export const CODEX_PROXY_PROVIDER_KEY = PROVIDER_KEY;
