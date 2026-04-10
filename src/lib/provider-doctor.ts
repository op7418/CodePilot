/**
 * Provider Doctor — diagnostic engine for provider/CLI/auth health checks.
 *
 * Runs a series of probes and produces a structured diagnosis with
 * findings, severity levels, and suggested repair actions.
 */

import {
  findClaudeBinary,
  getClaudeVersion,
  findAllClaudeBinaries,
  isWindows,
  findGitBash,
  getExpandedPath,
} from '@/lib/platform';
import { resolveProvider, resolveForClaudeCode, toClaudeCodeEnv } from '@/lib/provider-resolver';
import {
  getAllProviders,
  getDefaultProviderId,
  getModelsForProvider,
  getProvider,
  getSetting,
} from '@/lib/db';
import {
  getDefaultModelsForProvider,
  inferProtocolFromLegacy,
  findPresetForLegacy,
  type Protocol,
} from '@/lib/provider-catalog';
import { classifyError, type ClassifiedError } from '@/lib/error-classifier';
import { getOAuthStatus } from '@/lib/openai-oauth-manager';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import os from 'os';
import path from 'path';
import fs from 'fs';

// ── Types ───────────────────────────────────────────────────────

export type Severity = 'ok' | 'warn' | 'error';

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  detail?: string;
  /** Repair actions applicable to this specific finding (populated after diagnosis) */
  repairActions?: Array<{ id: string; label: string; description: string; params?: Record<string, string> }>;
}

export interface ProbeResult {
  probe: string;
  severity: Severity;
  findings: Finding[];
  durationMs: number;
}

export type RepairActionType =
  | 'set-default-provider'
  | 'apply-provider-to-session'
  | 'clear-stale-resume'
  | 'switch-auth-style'
  | 'reimport-env-config';

export interface RepairAction {
  type: RepairActionType;
  label: string;
  description: string;
  /** Which finding codes this action addresses */
  addresses: string[];
}

export interface DiagnosisResult {
  overallSeverity: Severity;
  probes: ProbeResult[];
  repairs: RepairAction[];
  timestamp: string;
  durationMs: number;
}

// ── Helpers ─────────────────────────────────────────────────────

function maskKey(key: string | undefined | null): { exists: boolean; last4?: string } {
  if (!key) return { exists: false };
  return { exists: true, last4: key.slice(-4) };
}

function maxSeverity(a: Severity, b: Severity): Severity {
  const rank: Record<Severity, number> = { ok: 0, warn: 1, error: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function probeSeverity(findings: Finding[]): Severity {
  let sev: Severity = 'ok';
  for (const f of findings) sev = maxSeverity(sev, f.severity);
  return sev;
}

// ── CLI Probe ───────────────────────────────────────────────────

async function runCliProbe(): Promise<ProbeResult> {
  const findings: Finding[] = [];
  const start = Date.now();

  // Check primary binary
  const bin = findClaudeBinary();
  if (!bin) {
    findings.push({
      severity: 'error',
      code: 'cli.not-found',
      message: 'Claude CLI binary not found on this system',
      detail: 'Install Claude Code CLI: npm install -g @anthropic-ai/claude-code',
    });
  } else {
    const version = await getClaudeVersion(bin);
    if (version) {
      findings.push({
        severity: 'ok',
        code: 'cli.found',
        message: `Claude CLI found at ${bin}`,
        detail: `Version: ${version}`,
      });
    } else {
      findings.push({
        severity: 'warn',
        code: 'cli.version-failed',
        message: `Claude CLI found at ${bin} but --version failed`,
        detail: 'The binary may be corrupted or incompatible',
      });
    }
  }

  // Check for multiple installations
  const allBinaries = findAllClaudeBinaries();
  if (allBinaries.length > 1) {
    const paths = allBinaries.map(b => `${b.path} (${b.version || 'unknown'})`).join(', ');
    findings.push({
      severity: 'warn',
      code: 'cli.multiple-installs',
      message: `Multiple Claude CLI installations detected (${allBinaries.length})`,
      detail: paths,
    });
  }

  // Windows-specific: check Git Bash
  if (isWindows) {
    const gitBash = findGitBash();
    if (gitBash) {
      findings.push({
        severity: 'ok',
        code: 'cli.git-bash',
        message: `Git Bash found at ${gitBash}`,
      });
    } else {
      findings.push({
        severity: 'warn',
        code: 'cli.git-bash-missing',
        message: 'Git Bash not found (recommended for Claude CLI on Windows)',
      });
    }
  }

  return {
    probe: 'cli',
    severity: probeSeverity(findings),
    findings,
    durationMs: Date.now() - start,
  };
}

// ── Auth Probe ──────────────────────────────────────────────────

async function runAuthProbe(): Promise<ProbeResult> {
  const findings: Finding[] = [];
  const start = Date.now();

  // Check environment auth
  const envApiKey = process.env.ANTHROPIC_API_KEY;
  const envAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const dbAuthToken = getSetting('anthropic_auth_token');

  if (envApiKey) {
    findings.push({
      severity: 'ok',
      code: 'auth.env-api-key',
      message: 'ANTHROPIC_API_KEY set in environment',
      detail: JSON.stringify(maskKey(envApiKey)),
    });
  }
  if (envAuthToken) {
    findings.push({
      severity: 'ok',
      code: 'auth.env-auth-token',
      message: 'ANTHROPIC_AUTH_TOKEN set in environment',
      detail: JSON.stringify(maskKey(envAuthToken)),
    });
  }
  if (dbAuthToken) {
    findings.push({
      severity: 'ok',
      code: 'auth.db-auth-token',
      message: 'Auth token stored in DB settings',
      detail: JSON.stringify(maskKey(dbAuthToken)),
    });
  }

  // Warn if both API_KEY and AUTH_TOKEN are set — ambiguous auth style
  if (envApiKey && envAuthToken) {
    findings.push({
      severity: 'warn',
      code: 'auth.both-styles-set',
      message: 'Both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are set in environment — auth style is ambiguous',
      detail: 'Remove one of them from your shell profile or .env file to avoid auth header conflicts. AUTH_TOKEN uses Bearer, API_KEY uses x-api-key.',
    });
  }

  // Check OpenAI OAuth status
  let openaiOAuthOk = false;
  try {
    const oauthStatus = getOAuthStatus();
    if (oauthStatus.authenticated) {
      openaiOAuthOk = true;
      findings.push({
        severity: oauthStatus.needsRefresh ? 'warn' : 'ok',
        code: 'auth.openai-oauth',
        message: `OpenAI OAuth authenticated${oauthStatus.email ? ` (${oauthStatus.email})` : ''}${oauthStatus.plan ? ` — ${oauthStatus.plan}` : ''}`,
        ...(oauthStatus.needsRefresh ? { detail: 'Token is near expiry and will be refreshed on next use' } : {}),
      });
    }
  } catch { /* OpenAI OAuth not available */ }

  if (!envApiKey && !envAuthToken && !dbAuthToken) {
    // Check if there are any configured providers with keys
    const providers = getAllProviders();
    const withKeys = providers.filter(p => !!p.api_key);
    if (withKeys.length === 0 && !openaiOAuthOk) {
      findings.push({
        severity: 'error',
        code: 'auth.no-credentials',
        message: 'No API credentials found (environment, DB settings, providers, or OpenAI OAuth)',
      });
    } else if (withKeys.length === 0 && openaiOAuthOk) {
      findings.push({
        severity: 'ok',
        code: 'auth.openai-oauth-only',
        message: 'No Anthropic credentials, but OpenAI OAuth is available',
      });
    } else {
      findings.push({
        severity: 'ok',
        code: 'auth.provider-keys-only',
        message: `No environment credentials, but ${withKeys.length} provider(s) have API keys configured`,
      });
    }
  }

  // Check resolved provider auth
  try {
    const resolved = resolveProvider();
    if (resolved.hasCredentials) {
      findings.push({
        severity: 'ok',
        code: 'auth.resolved-ok',
        message: `Resolved provider has usable credentials (authStyle: ${resolved.authStyle})`,
      });
    } else {
      findings.push({
        severity: 'warn',
        code: 'auth.resolved-no-creds',
        message: resolved.provider
          ? `Provider "${resolved.provider.name}" is selected but has no usable credentials`
          : 'Resolver fell back to environment variables — no configured provider is active',
        detail: resolved.provider
          ? `Check the API key for "${resolved.provider.name}" in Settings → Providers`
          : 'This usually means the default provider was deleted or never set. Check the Provider/Model probe for details.',
      });
    }
    // Check for provider-level auth style conflict
    if (resolved.provider) {
      try {
        const pEnv = JSON.parse(resolved.provider.extra_env || '{}');
        if ('ANTHROPIC_API_KEY' in pEnv && 'ANTHROPIC_AUTH_TOKEN' in pEnv) {
          findings.push({
            severity: 'warn',
            code: 'auth.style-mismatch',
            message: `Provider "${resolved.provider.name}" has both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN in extra_env — auth style is ambiguous`,
          });
        }
      } catch { /* ignore parse errors */ }
    }
  } catch (err) {
    findings.push({
      severity: 'error',
      code: 'auth.resolve-failed',
      message: 'Failed to resolve provider for auth check',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    probe: 'auth',
    severity: probeSeverity(findings),
    findings,
    durationMs: Date.now() - start,
  };
}

// ── Provider Probe ──────────────────────────────────────────────

async function runProviderProbe(): Promise<ProbeResult> {
  const findings: Finding[] = [];
  const start = Date.now();

  const providers = getAllProviders();
  const defaultId = getDefaultProviderId();

  findings.push({
    severity: 'ok',
    code: 'provider.count',
    message: `${providers.length} provider(s) configured`,
  });

  if (defaultId) {
    const defaultProvider = getProvider(defaultId);
    if (defaultProvider) {
      findings.push({
        severity: 'ok',
        code: 'provider.default-set',
        message: `Default provider: "${defaultProvider.name}" (${defaultProvider.protocol || defaultProvider.provider_type})`,
      });

      // Check if default provider has a key
      if (!defaultProvider.api_key) {
        findings.push({
          severity: 'warn',
          code: 'provider.default-no-key',
          message: `Default provider "${defaultProvider.name}" has no API key`,
          detail: JSON.stringify(maskKey(defaultProvider.api_key)),
        });
      }
    } else {
      findings.push({
        severity: 'error',
        code: 'provider.default-missing',
        message: `Default provider points to a deleted record — resolver falls back to environment variables, bypassing your configured provider`,
        detail: providers.length > 0
          ? `${providers.length} valid provider(s) exist but none is selected as default. Click "Fix" to set the first one.`
          : 'No providers configured. Add a provider in Settings → Providers.',
      });
    }
  } else if (providers.length > 0) {
    findings.push({
      severity: 'warn',
      code: 'provider.no-default',
      message: 'Providers exist but no default is set — new conversations will use environment variables',
    });
  }

  // Check each provider for common issues
  for (const p of providers) {
    if (!p.base_url && p.protocol && !['anthropic'].includes(p.protocol)) {
      findings.push({
        severity: 'warn',
        code: 'provider.missing-base-url',
        message: `Provider "${p.name}" (${p.protocol}) has no base_url`,
        detail: `Provider ID: ${p.id}`,
      });
    }

    // Check if the provider has any available models
    const protocol: Protocol = (p.protocol as Protocol) ||
      inferProtocolFromLegacy(p.provider_type, p.base_url);
    let hasModels = false;
    try {
      const dbModels = getModelsForProvider(p.id);
      if (dbModels.length > 0) hasModels = true;
    } catch { /* table may not exist */ }
    if (!hasModels) {
      const catalogModels = getDefaultModelsForProvider(protocol, p.base_url);
      if (catalogModels.length > 0) hasModels = true;
    }
    // Also check role_models_json.default — it synthesizes a model entry at runtime
    let hasRoleDefault = false;
    try {
      const rm = JSON.parse(p.role_models_json || '{}');
      if (rm.default) hasRoleDefault = true;
    } catch { /* ignore */ }
    // Also check ANTHROPIC_MODEL in env overrides
    let hasEnvModel = false;
    try {
      const envOverrides = p.env_overrides_json || p.extra_env || '{}';
      const envObj = JSON.parse(envOverrides);
      if (envObj.ANTHROPIC_MODEL) hasEnvModel = true;
    } catch { /* ignore */ }

    if (!hasModels && !hasRoleDefault && !hasEnvModel) {
      findings.push({
        severity: 'warn',
        code: 'provider.no-models',
        message: `Provider "${p.name}" has no models configured — set a default model name in provider settings`,
        detail: `Provider ID: ${p.id}. This provider's catalog has no default models. Add at least one model via role_models_json.default or provider model settings.`,
      });
    }

    // Check A: Third-party Anthropic provider without explicit model
    if (
      protocol === 'anthropic' &&
      p.base_url &&
      p.base_url !== 'https://api.anthropic.com' &&
      !hasRoleDefault &&
      !hasEnvModel
    ) {
      // Check if a matched preset provides its own model names (not ANTHROPIC_DEFAULT_MODELS).
      // If the preset has sdkProxyOnly or has its own models, the preset itself handles naming.
      // But for generic anthropic-thirdparty or unmatched presets, warn.
      const matchedPreset = findPresetForLegacy(p.base_url, p.provider_type, protocol as Protocol);
      const presetHandlesModels = matchedPreset && (
        matchedPreset.key === 'anthropic-official' ||
        matchedPreset.defaultRoleModels?.default ||
        matchedPreset.defaultEnvOverrides?.ANTHROPIC_MODEL
      );
      if (!presetHandlesModels) {
        findings.push({
          severity: 'warn',
          code: 'provider.no-explicit-model',
          message: `Provider "${p.name}" uses a third-party Anthropic endpoint but relies on default model names (sonnet/opus/haiku) which may not be supported. Set an explicit model name in provider settings.`,
          detail: `Provider ID: ${p.id}. Base URL: ${p.base_url}. Third-party endpoints often use different model identifiers. Configure role_models_json.default or set ANTHROPIC_MODEL in env overrides.`,
        });
      }
    }

    // Check B: sdkProxyOnly provider warning
    const matchedPreset = findPresetForLegacy(p.base_url, p.provider_type, protocol as Protocol);
    if (matchedPreset?.sdkProxyOnly) {
      findings.push({
        severity: 'ok',
        code: 'provider.sdk-proxy-only',
        message: `Provider "${p.name}" uses an Anthropic-compatible proxy. Some Claude Code features (thinking, context1m, code mode) may not be fully supported.`,
        detail: `Matched preset: ${matchedPreset.name}. This provider proxies requests through the Anthropic wire protocol but the upstream model may not support all features.`,
      });
    }
  }

  // Check resolve path
  try {
    const resolved = resolveProvider();
    const label = resolved.provider
      ? `"${resolved.provider.name}" (${resolved.protocol})`
      : 'environment variables';
    const isEnvMode = !resolved.provider;
    const isOfficialAnthropic = resolved.provider?.base_url === 'https://api.anthropic.com';
    // Warn about missing model for non-env, non-official-Anthropic providers
    const modelMissingSeverity: Severity =
      !resolved.model && !isEnvMode && !isOfficialAnthropic ? 'warn' : 'ok';
    findings.push({
      severity: modelMissingSeverity,
      code: 'provider.resolve-ok',
      message: `Provider resolution path: ${label}`,
      detail: resolved.model
        ? `Model: ${resolved.model}`
        : isEnvMode || isOfficialAnthropic
          ? 'No model selected (will use provider defaults)'
          : 'No model selected — third-party providers may require an explicit model name',
    });
  } catch (err) {
    findings.push({
      severity: 'error',
      code: 'provider.resolve-failed',
      message: 'Provider resolution failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    probe: 'provider',
    severity: probeSeverity(findings),
    findings,
    durationMs: Date.now() - start,
  };
}

// ── Features Probe ──────────────────────────────────────────────

async function runFeaturesProbe(): Promise<ProbeResult> {
  const findings: Finding[] = [];
  const start = Date.now();

  try {
    const resolved = resolveProvider();
    const protocol = resolved.protocol;

    // Thinking support — only Anthropic native API supports extended thinking
    const thinkingMode = getSetting('thinking_mode');
    if (thinkingMode && thinkingMode !== 'disabled') {
      const supportsThinking = protocol === 'anthropic';
      if (!supportsThinking) {
        findings.push({
          severity: 'warn',
          code: 'features.thinking-unsupported',
          message: `Thinking mode "${thinkingMode}" is enabled but protocol "${protocol}" may not support it`,
          detail: 'Extended thinking is only supported on the Anthropic native API',
        });
      } else {
        findings.push({
          severity: 'ok',
          code: 'features.thinking-ok',
          message: `Thinking mode "${thinkingMode}" is compatible with protocol "${protocol}"`,
        });
      }
    }

    // Context 1M — check if enabled on unsupported providers
    const context1m = getSetting('context_1m');
    if (context1m === 'true') {
      const supportsContext1m = protocol === 'anthropic';
      if (!supportsContext1m) {
        findings.push({
          severity: 'warn',
          code: 'features.context1m-unsupported',
          message: `1M context is enabled but protocol "${protocol}" may not support it`,
          detail: '1M context window is only available on Anthropic native API with supported models',
        });
      } else {
        findings.push({
          severity: 'ok',
          code: 'features.context1m-ok',
          message: '1M context is enabled and compatible with current provider',
        });
      }
    }
  } catch (err) {
    findings.push({
      severity: 'error',
      code: 'features.check-failed',
      message: 'Failed to check feature compatibility',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Check for stale sdk_session_id in recent chat sessions
  // sdk_session_id is stored per-session in chat_sessions table, not in settings
  try {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    const staleSessions = db.prepare(
      `SELECT id, sdk_session_id FROM chat_sessions
       WHERE sdk_session_id != '' AND sdk_session_id IS NOT NULL
       ORDER BY updated_at DESC LIMIT 5`
    ).all() as Array<{ id: string; sdk_session_id: string }>;

    if (staleSessions.length > 0) {
      findings.push({
        severity: 'warn',
        code: 'features.stale-session-id',
        message: `${staleSessions.length} session(s) have stored sdk_session_id — may cause resume issues if stale`,
        detail: `Session: ${staleSessions[0].id.slice(0, 12)}..., sdk_session_id: ${staleSessions[0].sdk_session_id.slice(0, 8)}...`,
      });
    }
  } catch {
    // chat_sessions table might not have the column in very old DBs
  }

  if (findings.length === 0) {
    findings.push({
      severity: 'ok',
      code: 'features.all-ok',
      message: 'No feature compatibility issues detected',
    });
  }

  return {
    probe: 'features',
    severity: probeSeverity(findings),
    findings,
    durationMs: Date.now() - start,
  };
}

// ── Network Probe ───────────────────────────────────────────────

async function runNetworkProbe(): Promise<ProbeResult> {
  const findings: Finding[] = [];
  const start = Date.now();

  // Collect unique base URLs to check
  const urlsToCheck = new Map<string, string>(); // url -> label

  // Only check Anthropic API if the current resolution actually uses it
  // (env mode with no providers, or provider with anthropic base_url).
  // Avoid showing "Anthropic API unreachable" noise when user is on Kimi/GLM etc.
  const resolved = resolveProvider();
  const isEnvMode = !resolved.provider;
  if (isEnvMode) {
    urlsToCheck.set('https://api.anthropic.com', 'Anthropic API');
  }

  // Provider-specific URLs
  const providers = getAllProviders();
  for (const p of providers) {
    if (p.base_url) {
      try {
        const u = new URL(p.base_url);
        urlsToCheck.set(u.origin, `Provider "${p.name}"`);
      } catch {
        findings.push({
          severity: 'warn',
          code: 'network.invalid-url',
          message: `Provider "${p.name}" has invalid base_url`,
          detail: p.base_url,
        });
      }
    }
  }

  // HEAD request each URL (no API key sent)
  const TIMEOUT = 5000;
  const checks = Array.from(urlsToCheck.entries()).map(async ([url, label]) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT);
      const resp = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': 'CodePilot-ProviderDoctor/1.0' },
      });
      clearTimeout(timer);

      findings.push({
        severity: 'ok',
        code: 'network.reachable',
        message: `${label} (${url}) is reachable`,
        detail: `Status: ${resp.status}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('abort');
      findings.push({
        severity: 'warn',
        code: isTimeout ? 'network.timeout' : 'network.unreachable',
        message: `${label} (${url}) ${isTimeout ? 'timed out' : 'is unreachable'}`,
        detail: message,
      });
    }
  });

  await Promise.allSettled(checks);

  return {
    probe: 'network',
    severity: probeSeverity(findings),
    findings,
    durationMs: Date.now() - start,
  };
}

// ── Live Probe ──────────────────────────────────────────────────

/** Last classified error from the live probe, exposed for the export route. */
let lastLiveProbeError: ClassifiedError | null = null;

export function getLastLiveProbeError(): ClassifiedError | null {
  return lastLiveProbeError;
}

/** Cached last diagnosis result so export doesn't re-run (especially the live probe). */
let lastDiagnosisResult: DiagnosisResult | null = null;

export function getLastDiagnosisResult(): DiagnosisResult | null {
  return lastDiagnosisResult;
}

export function setLastDiagnosisResult(result: DiagnosisResult): void {
  lastDiagnosisResult = result;
}

/**
 * Sanitize env values: strip control chars and drop non-string values.
 */
function sanitizeEnvForProbe(env: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      clean[key] = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    }
  }
  return clean;
}

/**
 * On Windows, resolve .cmd wrapper to the underlying .js script.
 */
function resolveScriptFromCmd(cmdPath: string): string | undefined {
  try {
    const content = fs.readFileSync(cmdPath, 'utf-8');
    const cmdDir = path.dirname(cmdPath);
    const patterns = [
      /"%~dp0\\([^"]*claude[^"]*\.js)"/i,
      /%~dp0\\(\S*claude\S*\.js)/i,
      /"%dp0%\\([^"]*claude[^"]*\.js)"/i,
    ];
    for (const re of patterns) {
      const m = content.match(re);
      if (m) {
        const resolved = path.normalize(path.join(cmdDir, m[1]));
        if (fs.existsSync(resolved)) return resolved;
      }
    }
  } catch {
    // ignore read errors
  }
  return undefined;
}

/**
 * Live probe — spawns a minimal Claude Code process to verify the
 * provider actually works at runtime, not just in config.
 */
async function runLiveProbe(): Promise<ProbeResult> {
  const findings: Finding[] = [];
  const start = Date.now();
  lastLiveProbeError = null;

  // 1. Resolve the current provider
  let resolved;
  try {
    resolved = resolveForClaudeCode();
  } catch (err) {
    findings.push({
      severity: 'warn',
      code: 'live.resolve-failed',
      message: 'Live probe skipped — could not resolve provider',
      detail: err instanceof Error ? err.message : String(err),
    });
    return { probe: 'live', severity: probeSeverity(findings), findings, durationMs: Date.now() - start };
  }

  // 2. Skip if no credentials
  if (!resolved.hasCredentials) {
    findings.push({
      severity: 'ok',
      code: 'live.skipped',
      message: 'Live probe skipped — no credentials configured',
    });
    return { probe: 'live', severity: probeSeverity(findings), findings, durationMs: Date.now() - start };
  }

  // 3. Skip if no CLI binary
  const claudePath = findClaudeBinary();
  if (!claudePath) {
    findings.push({
      severity: 'warn',
      code: 'live.no-cli',
      message: 'Live probe skipped — Claude CLI binary not found',
    });
    return { probe: 'live', severity: probeSeverity(findings), findings, durationMs: Date.now() - start };
  }

  // 4. Build env
  const sdkEnv: Record<string, string> = { ...process.env as Record<string, string> };
  if (!sdkEnv.HOME) sdkEnv.HOME = os.homedir();
  if (!sdkEnv.USERPROFILE) sdkEnv.USERPROFILE = os.homedir();
  sdkEnv.PATH = getExpandedPath();
  delete sdkEnv.CLAUDECODE;

  if (process.platform === 'win32' && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    const gitBashPath = findGitBash();
    if (gitBashPath) sdkEnv.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath;
  }

  const resolvedEnv = toClaudeCodeEnv(sdkEnv, resolved);
  Object.assign(sdkEnv, resolvedEnv);

  // 5. Build query options
  const LIVE_PROBE_TIMEOUT = 15_000;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), LIVE_PROBE_TIMEOUT);

  // Capture stderr (last 500 chars)
  let stderrBuf = '';
  const stderrCallback = (data: string) => {
    stderrBuf += data;
    if (stderrBuf.length > 500) {
      stderrBuf = stderrBuf.slice(-500);
    }
  };

  const queryOptions: Options = {
    cwd: os.tmpdir(),
    abortController,
    permissionMode: 'default',
    env: sanitizeEnvForProbe(sdkEnv),
    maxTurns: 1,
    stderr: stderrCallback,
  };

  // Resolve executable path (handle Windows .cmd wrappers)
  const ext = path.extname(claudePath).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const scriptPath = resolveScriptFromCmd(claudePath);
    if (scriptPath) queryOptions.pathToClaudeCodeExecutable = scriptPath;
  } else {
    queryOptions.pathToClaudeCodeExecutable = claudePath;
  }

  // 6. Run the probe
  try {
    const conversation = query({
      prompt: 'Say OK',
      options: queryOptions,
    });

    let gotResult = false;
    for await (const msg of conversation) {
      if (msg.type === 'result' && 'result' in msg) {
        const result = (msg as SDKResultSuccess).result || '';
        gotResult = !!result;
      }
    }

    clearTimeout(timeoutId);

    if (gotResult) {
      findings.push({
        severity: 'ok',
        code: 'live.passed',
        message: 'Live test passed — model responded',
        detail: resolved.provider
          ? `Provider: "${resolved.provider.name}" (${resolved.protocol})`
          : `Environment mode (${resolved.protocol})`,
      });
    } else {
      findings.push({
        severity: 'warn',
        code: 'live.empty-response',
        message: 'Live test completed but model returned empty response',
        detail: stderrBuf ? `stderr: ${stderrBuf}` : undefined,
      });
    }
  } catch (err) {
    clearTimeout(timeoutId);

    // Check if it was our timeout
    const wasTimeout = abortController.signal.aborted;

    if (wasTimeout) {
      findings.push({
        severity: 'warn',
        code: 'live.timeout',
        message: `Live probe timed out after ${LIVE_PROBE_TIMEOUT / 1000}s`,
        detail: stderrBuf ? `stderr: ${stderrBuf}` : 'The provider may be slow or unresponsive',
      });
    } else {
      // Classify the error
      const classified = classifyError({
        error: err,
        stderr: stderrBuf,
        providerName: resolved.provider?.name,
        baseUrl: resolved.provider?.base_url,
      });
      lastLiveProbeError = classified;

      findings.push({
        severity: 'error',
        code: 'live.failed',
        message: `Live test failed — ${classified.category}: ${classified.userMessage}`,
        detail: [
          classified.actionHint,
          stderrBuf ? `stderr: ${stderrBuf}` : '',
        ].filter(Boolean).join('\n'),
      });
    }
  }

  return {
    probe: 'live',
    severity: probeSeverity(findings),
    findings,
    durationMs: Date.now() - start,
  };
}

// ── Repair Actions ──────────────────────────────────────────────

const REPAIR_ACTIONS: RepairAction[] = [
  {
    type: 'set-default-provider',
    label: 'Set first valid provider as default',
    description: 'Fix the stale default by pointing to an existing provider',
    addresses: ['provider.no-default', 'provider.default-missing', 'auth.no-credentials'],
  },
  {
    type: 'apply-provider-to-session',
    label: 'Apply provider to session',
    description: 'Assign the default provider to the current session to fix missing credentials',
    addresses: ['auth.resolved-no-creds'],
  },
  {
    type: 'clear-stale-resume',
    label: 'Clear stale session ID',
    description: 'Remove the stored sdk_session_id to prevent stale resume attempts',
    addresses: ['features.stale-session-id'],
  },
  {
    type: 'switch-auth-style',
    label: 'Switch auth style',
    description: 'Toggle between api_key and auth_token authentication for the current provider',
    // Only for provider-level conflicts (extra_env has both keys).
    // auth.both-styles-set is an env-var conflict — can't fix by editing a provider.
    addresses: ['auth.style-mismatch'],
  },
  {
    type: 'reimport-env-config',
    label: 'Re-import environment config',
    description: 'Re-read API keys and settings from environment variables into the database',
    addresses: ['auth.no-credentials', 'auth.env-api-key', 'auth.env-auth-token'],
  },
];

function computeRepairs(probes: ProbeResult[]): RepairAction[] {
  const allCodes = new Set<string>();
  for (const probe of probes) {
    for (const f of probe.findings) {
      if (f.severity !== 'ok') allCodes.add(f.code);
    }
  }

  return REPAIR_ACTIONS.filter(action =>
    action.addresses.some(code => allCodes.has(code)),
  );
}

/**
 * Attach applicable repair actions to individual findings so the frontend
 * can render "Fix" buttons directly alongside each finding.
 */
function attachRepairsToFindings(probes: ProbeResult[]): void {
  // Gather context needed to populate repair params
  const defaultProviderId = getDefaultProviderId();
  const providers = getAllProviders();
  const firstProvider = providers[0];

  for (const probe of probes) {
    for (const finding of probe.findings) {
      if (finding.severity === 'ok') continue;

      const applicable: Finding['repairActions'] = [];

      for (const action of REPAIR_ACTIONS) {
        if (!action.addresses.includes(finding.code)) continue;

        const params: Record<string, string> = {};

        switch (action.type) {
          case 'set-default-provider':
            if (firstProvider) params.providerId = firstProvider.id;
            else continue; // no provider to set
            break;
          case 'clear-stale-resume':
            // Don't try to extract truncated session IDs from detail text —
            // use the parameterless "clear all stale sessions" mode instead.
            // The repair route handles both single-session and bulk-clear.
            break;
          case 'switch-auth-style': {
            const targetPid = defaultProviderId || firstProvider?.id;
            if (!targetPid) continue;
            params.providerId = targetPid;
            // Detect current auth style from the provider's extra_env and suggest the opposite
            const targetProvider = getProvider(targetPid);
            if (targetProvider) {
              try {
                const env = JSON.parse(targetProvider.extra_env || '{}');
                const currentlyUsingToken = 'ANTHROPIC_AUTH_TOKEN' in env;
                params.authStyle = currentlyUsingToken ? 'api-key' : 'auth-token';
              } catch {
                params.authStyle = 'auth-token'; // safe default
              }
            }
            break;
          }
          case 'apply-provider-to-session':
            if (defaultProviderId) params.providerId = defaultProviderId;
            else continue;
            break;
          case 'reimport-env-config':
            // No params needed
            break;
        }

        applicable.push({
          id: action.type,
          label: action.label,
          description: action.description,
          params: Object.keys(params).length > 0 ? params : undefined,
        });
      }

      if (applicable.length > 0) {
        finding.repairActions = applicable;
      }
    }
  }
}

// ── Main Diagnosis ──────────────────────────────────────────────

/**
 * Run all diagnostic probes and return a unified diagnosis.
 */
/**
 * Run all diagnostic probes and return a unified diagnosis.
 *
 * The live probe (real CLI spawn) is run separately and NOT included by
 * default because it takes up to 15s and would block the Doctor UI.
 * Call runDiagnosisWithLiveProbe() or runLiveProbe() separately if needed.
 */
export async function runDiagnosis(): Promise<DiagnosisResult> {
  const start = Date.now();

  const probes = await Promise.all([
    runCliProbe(),
    runAuthProbe(),
    runProviderProbe(),
    runFeaturesProbe(),
    runNetworkProbe(),
  ]);

  let overallSeverity: Severity = 'ok';
  for (const p of probes) {
    overallSeverity = maxSeverity(overallSeverity, p.severity);
  }

  const repairs = computeRepairs(probes);
  attachRepairsToFindings(probes);

  const result: DiagnosisResult = {
    overallSeverity,
    probes,
    repairs,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - start,
  };

  lastDiagnosisResult = result;
  return result;
}

/**
 * Run the live probe separately. Returns the probe result which can be
 * appended to an existing diagnosis. Does NOT re-run the other probes.
 */
export { runLiveProbe };
