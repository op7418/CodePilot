import { isTokenDanceBaseUrl, TOKENDANCE_RECOVERY_ERRORS } from './tokendance';
/**
 * Error Classifier — structured error categorization for Claude Code process errors.
 *
 * Replaces the ad-hoc if/else chain in claude-client.ts with a pattern-matching
 * classifier that produces actionable, user-facing error messages.
 */

import {
  buildNormalizedFingerprint,
  shouldUseDefaultStackGrouping,
  statusClass,
} from './telemetry/contract';
import { markProviderFailureHandled } from './telemetry/provider-marker';
import {
  createSafeTelemetryError,
  normalizeTelemetryFailure,
} from './telemetry/root-cause';

// ── Sentry integration (lazy, no-op when unavailable) ───────────

/**
 * Pure predicate: should this (category, error) be reported to Sentry?
 *
 * Side-effect-free and exported so tests can lock the semantics WITHOUT
 * importing `@sentry/node` (that import would pull the @opentelemetry chain
 * into the dev/test compile graph — see reportToSentry's guard and the
 * sentry-dev-guard contract).
 *
 *  1. category must be in the reportable allow-list.
 *  2. user-initiated abort/cancel is dropped — EXCEPT TIMEOUT_*, which the
 *     native runtime raises as an AbortError (a fired timeout budget aborts
 *     the combined signal; see agent-loop.ts:728). A timeout is a real
 *     failure, so the abort/cancel message filter must not swallow it.
 */
export function shouldReportToSentry(
  category: string,
  error: unknown,
  context: Pick<SentryReportContext, 'statusCode' | 'retryExhausted' | 'providerTest'> = {},
): boolean {
  return normalizeTelemetryFailure(category, error, context).shouldReport;
}

interface SentryReportContext {
  runtimeId?: string;
  providerProtocol?: string;
  providerClass?: string;
  statusCode?: number;
  retryExhausted?: boolean;
  callScene?: string;
  timeoutStage?: string;
  providerTest?: boolean;
}

function reportToSentry(category: string, error: unknown, context: SentryReportContext = {}) {
  // Every classified provider/native error is now owned by this boundary,
  // including zero-event outcomes. Prevent the Node SDK from auto-capturing
  // the original rich object after the caller rethrows it.
  markProviderFailureHandled(error);
  // Dev-server memory guardrail (2026-05-09): even though instrumentation.ts
  // skips Sentry.init in dev, this lazy import path would still pull
  // `@sentry/node` + the `@opentelemetry/*` chain into Turbopack's compile
  // graph the moment a reportable error fires (NATIVE_STREAM_ERROR /
  // MCP_CONNECTION_ERROR / PROVIDER_NOT_APPLIED / …). One unguarded code
  // path is enough to undo the entire dev memory cut, so we mirror the
  // instrumentation.ts contract here. Locked in by
  // `src/__tests__/unit/sentry-dev-guard.test.ts`.
  if (process.env.NODE_ENV !== 'development') {
    if (process.env.NODE_ENV !== 'production') return;
    if (process.env.NEXT_PUBLIC_CODEPILOT_CHANNEL !== 'stable') return;
    const normalized = normalizeTelemetryFailure(category, error, {
      retryExhausted: context.retryExhausted,
      providerTest: context.providerTest,
      statusCode: context.statusCode,
    });
    if (!normalized.shouldReport) return;

    // Fire-and-forget async import — never blocks the classifier
    import('@sentry/node').then((Sentry) => {
      if (!Sentry.isInitialized()) return;
      Sentry.withScope((scope) => {
        scope.setTag('error.category', normalized.category);
        scope.setTag('error.outcome', normalized.outcome);
        scope.setTag('error.runtime', context.runtimeId || 'unknown');
        scope.setTag('runtime.id', context.runtimeId || 'unknown');
        scope.setTag('provider.protocol', context.providerProtocol || 'unknown');
        scope.setTag('provider.class', context.providerClass || 'unknown');
        scope.setTag('status.class', statusClass(normalized.statusCode));
        scope.setExtras({
          callScene: context.callScene,
          retryExhausted: normalized.retryExhausted,
          timeoutStage: context.timeoutStage,
        });
        const useDefaultStackGrouping = shouldUseDefaultStackGrouping(normalized.outcome, error);
        if (normalized.outcome === 'unknown') scope.setTag('needs_classification', 'yes');
        if (!useDefaultStackGrouping) {
          scope.setTag('grouping.strategy', 'normalized');
          scope.setFingerprint(buildNormalizedFingerprint({
            category: normalized.category,
            layer: 'next_server',
            runtimeId: context.runtimeId,
            providerProtocol: context.providerProtocol,
            providerClass: context.providerClass,
            statusCode: normalized.statusCode,
          }));
        }
        if (useDefaultStackGrouping && error instanceof Error) {
          const safeMessage = normalized.outcome === 'product_fault'
            ? 'telemetry.product_fault'
            : 'telemetry.unknown_failure';
          Sentry.captureException(createSafeTelemetryError(error, safeMessage));
        } else {
          Sentry.captureMessage('telemetry.normalized_failure', 'error');
        }
      });
    }).catch(() => { /* Sentry not available */ });
  }
}

/**
 * Report a native runtime error to Sentry.
 * Called from agent-loop.ts and MCP manager for errors that bypass the main classifier.
 */
export function reportNativeError(
  category: ClaudeErrorCategory,
  error: unknown,
  context?: {
    providerProtocol?: string;
    providerClass?: string;
    retryExhausted?: boolean;
    /** Accepted for existing callers but deliberately never sent. */
    modelId?: string;
    sessionId?: string;
    providerName?: string;
    baseUrl?: string;
  },
) {
  reportToSentry(category, error, {
    runtimeId: 'codepilot_runtime',
    providerProtocol: context?.providerProtocol,
    providerClass: context?.providerClass,
    retryExhausted: context?.retryExhausted,
  });
}

// ── Error categories ────────────────────────────────────────────

export type ClaudeErrorCategory =
  | 'CLI_NOT_FOUND'
  | 'EXECUTION_PERMISSION_DENIED'
  | 'NO_CREDENTIALS'
  | 'AUTH_REJECTED'
  | 'AUTH_FORBIDDEN'
  | 'AUTH_STYLE_MISMATCH'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'NETWORK_UNREACHABLE'
  | 'ENDPOINT_NOT_FOUND'
  | 'MODEL_NOT_AVAILABLE'
  | 'CONTEXT_TOO_LONG'
  | 'UNSUPPORTED_FEATURE'
  | 'CLI_VERSION_TOO_OLD'
  | 'CLI_INSTALL_CONFLICT'
  | 'MISSING_GIT_BASH'
  | 'RESUME_FAILED'
  | 'SESSION_STATE_ERROR'
  | 'PROVIDER_NOT_APPLIED'
  | 'PROCESS_CRASH'
  // Native Runtime categories
  | 'NATIVE_STREAM_ERROR'    // Agent loop streamText() failure
  | 'OPENAI_AUTH_FAILED'     // OpenAI OAuth token expired/invalid
  | 'MCP_CONNECTION_ERROR'   // MCP server connect/sync failure
  | 'EMPTY_RESPONSE'         // Model returned nothing (proxy rejection, unsupported model)
  // Native Runtime timeout reason codes (Phase 4 ① — src/lib/native-timeout.ts).
  // Assigned directly from the fired timeout budget, never regex-inferred.
  | 'TIMEOUT_CONNECT'        // No provider response headers within connectMs
  | 'TIMEOUT_FIRST_TOKEN'    // Response arrived but no model output within firstTokenMs
  | 'TIMEOUT_TOOL_EXECUTION' // One tool call exceeded toolExecutionMs
  | 'TIMEOUT_TOTAL_RUN'      // Whole run exceeded totalRunMs
  | 'UNKNOWN';

/** A concrete action the user can take to recover from an error */
export interface RecoveryAction {
  /** Button label */
  label: string;
  /** URL to open (external link) */
  url?: string;
  /** Internal action type */
  action?: 'open_settings' | 'retry' | 'new_conversation';
}

export interface ClassifiedError {
  category: ClaudeErrorCategory;
  /** User-facing message explaining what went wrong */
  userMessage: string;
  /** Actionable hint telling the user how to fix it */
  actionHint: string;
  /** Original raw error message */
  rawMessage: string;
  /** Provider name if available */
  providerName?: string;
  /** Additional detail (stderr, cause, etc.) */
  details?: string;
  /** Whether this error is likely transient and retryable */
  retryable: boolean;
  /** Structured recovery actions for UI buttons */
  recoveryActions?: RecoveryAction[];
}

// ── Classification context ──────────────────────────────────────

export interface ErrorContext {
  /** The raw Error object */
  error: unknown;
  /** Accumulated stderr output from the CLI process */
  stderr?: string;
  /** Provider name for error messages */
  providerName?: string;
  /** Provider base URL */
  baseUrl?: string;
  /** Whether images were attached */
  hasImages?: boolean;
  /** Whether thinking mode was enabled */
  thinkingEnabled?: boolean;
  /** Whether 1M context was enabled */
  context1mEnabled?: boolean;
  /** Whether effort was set */
  effortSet?: boolean;
  /** Provider meta info from preset (for recovery action URLs) */
  providerMeta?: {
    apiKeyUrl?: string;
    docsUrl?: string;
    pricingUrl?: string;
  };
  /** Diagnostic connection tests are user-invoked probes, never product faults. */
  providerTest?: boolean;
  /** True only after the caller's retry/fallback budget has been exhausted. */
  retryExhausted?: boolean;
}

// ── Pattern definitions ─────────────────────────────────────────

interface ErrorPattern {
  category: ClaudeErrorCategory;
  /** Patterns to match against error message + stderr */
  patterns: Array<string | RegExp>;
  /** Match against error code (ENOENT, ECONNREFUSED, etc.) */
  codes?: string[];
  userMessage: (ctx: ErrorContext) => string;
  actionHint: (ctx: ErrorContext) => string;
  retryable: boolean;
}

const providerHint = (ctx: ErrorContext) =>
  ctx.providerName ? ` (Provider: ${ctx.providerName})` : '';

const ERROR_PATTERNS: ErrorPattern[] = [
  // ── Local process launch denied by the operating system ──
  // Keep the text patterns spawn/exec-specific: provider APIs also use
  // phrases such as "permission denied", which belong to AUTH_FORBIDDEN.
  {
    category: 'EXECUTION_PERMISSION_DENIED',
    patterns: [
      /(?:spawn|exec(?:file)?) [^\n]+ e(?:perm|acces)/i,
      /(?:spawn|exec(?:file)?)[^\n]+operation not permitted/i,
      /(?:spawn|exec(?:file)?)[^\n]+permission denied/i,
    ],
    userMessage: () => 'The operating system blocked CodePilot from starting a required process.',
    actionHint: () => 'Check the executable permissions and your system security or antivirus policy, then restart CodePilot. On a managed device, ask your administrator to allow the process.',
    retryable: false,
  },

  // ── CLI not found ──
  {
    category: 'CLI_NOT_FOUND',
    patterns: [
      /spawn(?:ing)? [^\n]+ enoent/i,
      /claude code (?:cli|executable|native binary)[^\n]*not found/i,
      /executable[^\n]*not found/i,
      'No such file',
    ],
    codes: ['ENOENT'],
    userMessage: () => 'Claude Code CLI not found.',
    actionHint: () => 'Please install Claude Code CLI and ensure it is available in your PATH. Run: npm install -g @anthropic-ai/claude-code',
    retryable: false,
  },

  // ── Missing Git Bash (Windows) ──
  {
    category: 'MISSING_GIT_BASH',
    patterns: ['git bash', 'bash.exe not found', 'git for windows'],
    userMessage: () => 'Git Bash is required on Windows but was not found.',
    actionHint: () => 'Install Git for Windows from https://git-scm.com/downloads and ensure bash.exe is on PATH.',
    retryable: false,
  },

  // ── No credentials ──
  //
  // `not logged in` / `please run /login` is the Claude Code CLI's native
  // error when settings.json is missing or its base URL/token combo is
  // rejected. In the CodePilot UI the CLI's /login flow is a dead-end, so
  // we surface the same user-friendly guidance as a true credentials-missing
  // case — open the Providers setup instead of telling users to run a
  // command that doesn't exist in the desktop app.
  {
    category: 'NO_CREDENTIALS',
    patterns: [
      'no api key', 'missing api key', 'ANTHROPIC_API_KEY is not set',
      'api key required', 'missing credentials',
      'not logged in', 'please run /login',
    ],
    userMessage: (ctx) => `No API credentials found${providerHint(ctx)}.`,
    actionHint: () => 'Go to Settings → Providers and add your API key, or set the ANTHROPIC_API_KEY environment variable.',
    retryable: false,
  },

  // ── Auth rejected (401) ──
  {
    category: 'AUTH_REJECTED',
    patterns: ['401', 'Unauthorized', 'invalid_api_key', 'invalid api key', 'authentication failed', 'authentication_error'],
    userMessage: (ctx) => `Authentication failed${providerHint(ctx)}.`,
    actionHint: () => 'Verify your API key is correct and has not expired. If using a third-party provider, check that the auth style (API Key vs Auth Token) matches.',
    retryable: false,
  },

  // ── Auth forbidden (403) ──
  {
    category: 'AUTH_FORBIDDEN',
    patterns: ['403', 'Forbidden', 'permission_error', 'access denied'],
    userMessage: (ctx) => `Access denied${providerHint(ctx)}.`,
    actionHint: () => 'Your API key may lack permissions for this operation. Check your plan limits or contact your provider.',
    retryable: false,
  },

  // ── Auth style mismatch ──
  {
    category: 'AUTH_STYLE_MISMATCH',
    patterns: ['x-api-key', 'bearer token', 'auth_token.*invalid', 'api_key.*invalid'],
    userMessage: (ctx) => `Auth style mismatch${providerHint(ctx)}.`,
    actionHint: () => 'This provider may require a different auth style. Try switching between "API Key" and "Auth Token" in provider settings.',
    retryable: false,
  },

  // ── Rate limited (429) ──
  {
    category: 'RATE_LIMITED',
    patterns: ['429', 'rate limit', 'Rate limit', 'too many requests', 'overloaded'],
    userMessage: () => 'Rate limit exceeded.',
    actionHint: () => 'Wait a moment before retrying. If this persists, consider upgrading your API plan.',
    retryable: true,
  },

  // ── Provider temporarily unavailable (503) ──
  {
    category: 'PROVIDER_UNAVAILABLE',
    patterns: ['503', 'service temporarily unavailable', 'service unavailable', 'temporarily unavailable'],
    userMessage: (ctx) => `Provider is temporarily unavailable${providerHint(ctx)}.`,
    actionHint: () => 'Retry later. If this happens only during connection testing, check that the model name mapping matches the provider-supported model IDs.',
    retryable: true,
  },

  // ── Model not available ──
  {
    category: 'MODEL_NOT_AVAILABLE',
    patterns: ['model_not_found', 'model not found', 'model_not_available', 'invalid model', 'does not exist', 'not_found_error.*model'],
    userMessage: (ctx) => `Model not available${providerHint(ctx)}.`,
    actionHint: () => 'The selected model may not be supported by this provider. Check the model name in provider settings or try a different model.',
    retryable: false,
  },

  // ── Context too long ──
  {
    category: 'CONTEXT_TOO_LONG',
    patterns: ['context_length', 'context window', 'too many tokens', 'max_tokens', 'prompt is too long'],
    userMessage: () => 'Conversation context is too long.',
    actionHint: () => 'Context is being auto-compressed. If this persists, try /compact or start a new conversation.',
    retryable: false, // Backend handles retry internally via reactive compact
  },

  // ── Unsupported feature (unknown option) ──
  {
    category: 'UNSUPPORTED_FEATURE',
    patterns: ['unknown option', 'unrecognized option', 'not supported', 'invalid option', 'unexpected argument'],
    userMessage: () => 'Your Claude Code CLI version does not support a requested feature.',
    actionHint: () => 'Update Claude Code CLI to the latest version: npm update -g @anthropic-ai/claude-code',
    retryable: false,
  },

  // ── CLI version too old ──
  {
    category: 'CLI_VERSION_TOO_OLD',
    patterns: ['version', 'upgrade required', 'minimum version'],
    userMessage: () => 'Your Claude Code CLI version is too old.',
    actionHint: () => 'Update to the latest version: npm update -g @anthropic-ai/claude-code',
    retryable: false,
  },

  // ── Network unreachable ──
  {
    category: 'NETWORK_UNREACHABLE',
    patterns: ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'fetch failed', 'network error', 'DNS', 'ENOTFOUND', 'EAI_AGAIN'],
    codes: ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'],
    userMessage: (ctx) => `Cannot connect to API endpoint${ctx.baseUrl ? ` (${ctx.baseUrl})` : ''}.`,
    actionHint: () => 'Check your network connection and the Base URL in provider settings.',
    retryable: true,
  },

  // ── Endpoint not found (404) ──
  {
    category: 'ENDPOINT_NOT_FOUND',
    patterns: ['404', 'Not Found', 'endpoint not found'],
    userMessage: (ctx) => `API endpoint not found${providerHint(ctx)}.`,
    actionHint: () => 'The Base URL may be incorrect. Check your provider settings and ensure the URL includes the correct path (e.g. /v1).',
    retryable: false,
  },

  // ── Resume failed ──
  // Must be before PROCESS_CRASH so session-related crashes don't get
  // misclassified as provider configuration problems.
  {
    category: 'RESUME_FAILED',
    patterns: [
      'resume failed',
      'session not found',
      'invalid session',
      'session expired',
      'could not resume',
      'failed to resume',
      'resume_failed',
      'conversation not found',
      // #629 (POC-B 2026-06-26) — third-party Anthropic proxies (GLM / MiMo /
      // DeepSeek / Aliyun) return "No conversation found with session ID: <sid>"
      // for a stale resume. 'conversation not found' has the wrong word order and
      // the session-id regex below needs "not found" AFTER the id (here it's
      // before), so neither matches. See docs/research/issue-629-resume-error-shape-poc/.
      'no conversation found',
      /session\s+id\s+.*\s*(invalid|expired|not found|missing)/,
    ],
    userMessage: () => 'Failed to resume previous conversation.',
    actionHint: () => 'The conversation will start fresh automatically. No action needed.',
    retryable: false,
  },

  // ── Session state error ──
  // Catches stale/corrupt session state that causes CLI crashes.
  // Must be before PROCESS_CRASH to prevent misclassification as provider issues.
  {
    category: 'SESSION_STATE_ERROR',
    patterns: [
      'stale session',
      'stale sdk_session',
      'session state',
      'session_state',
      'corrupt session',
      'session mismatch',
      'session context',
      /sdk_session_id.*(?:invalid|stale|expired|corrupt|mismatch)/,
      /(?:invalid|stale|expired|corrupt)\s*(?:session|sdk_session)/,
    ],
    userMessage: () => 'Session state is invalid or corrupted.',
    actionHint: () => 'The stored session state has become stale. Please start a new conversation, or retry — the session will be automatically reset.',
    retryable: true,
  },

  // ── Process crash (exit code) ──
  {
    category: 'PROCESS_CRASH',
    patterns: [/exited with code \d+/, /exit code \d+/],
    userMessage: (ctx) => {
      const hints: string[] = [];
      hints.push('Invalid or missing API Key');
      hints.push('Incorrect Base URL configuration');
      hints.push('Network connectivity issues');
      if (ctx.hasImages) hints.push('Provider may not support image/vision input');
      if (ctx.thinkingEnabled) hints.push('Thinking mode may not be supported');
      if (ctx.context1mEnabled) hints.push('1M context may not be supported');
      return `Claude Code process exited with an error${providerHint(ctx)}. Common causes:\n• ${hints.join('\n• ')}`;
    },
    actionHint: () => 'Check your API key and provider settings. Run Provider Doctor in Settings for detailed diagnostics.',
    retryable: false,
  },
];

// ── Session-related keywords for PROCESS_CRASH refinement ────
// When a process crash stderr contains these keywords, the error is likely
// a session state issue rather than a provider configuration problem.
const SESSION_RELATED_KEYWORDS = [
  'resume', 'session', 'sdk_session', 'conversation_id',
  'stale', 'corrupt', 'session_id',
];

// ── Classifier ──────────────────────────────────────────────────

/**
 * Classify an error from the Claude Code process into a structured error
 * with user-facing message and actionable hints.
 */
export function classifyError(ctx: ErrorContext): ClassifiedError {
  const error = ctx.error;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const errorCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  const stderrContent = ctx.stderr || '';
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const extraDetail = stderrContent || (cause instanceof Error ? cause.message : cause ? String(cause) : '');

  // The relay preserves an upstream recovery header as a stable marker.
  // Keep its precise user action instead of collapsing balance/quota into auth.
  if (isTokenDanceBaseUrl(ctx.baseUrl)) {
    const combined = `${rawMessage}\n${stderrContent}\n${extraDetail}`;
    for (const [action, message] of Object.entries(TOKENDANCE_RECOVERY_ERRORS)) {
      if (combined.includes(message)) {
        return {
          category: action === 'reauthorize_api_key' ? 'AUTH_REJECTED' : 'UNKNOWN',
          userMessage: message, actionHint: '', rawMessage, providerName: ctx.providerName,
          retryable: false,
          recoveryActions: action === 'top_up_balance'
            ? [{ label: 'TokenDance', url: 'https://tokendance.space/' }]
            : [{ label: 'TokenDance', action: 'open_settings' }],
        };
      }
    }
  }

  // Combined text to search through
  const searchText = `${rawMessage}\n${stderrContent}\n${extraDetail}`.toLowerCase();

  for (const pattern of ERROR_PATTERNS) {
    // Check error code first (most specific)
    if (pattern.codes && errorCode && pattern.codes.includes(errorCode)) {
      return buildResult(pattern, ctx, rawMessage, extraDetail);
    }

    // Check patterns against combined text
    const matched = pattern.patterns.some(p => {
      if (typeof p === 'string') {
        return searchText.includes(p.toLowerCase());
      }
      return p.test(searchText);
    });

    if (matched) {
      // Refinement: if matched as PROCESS_CRASH but stderr contains
      // session-related keywords, reclassify as SESSION_STATE_ERROR
      // to avoid misleading "check API Key / Base URL" prompts.
      if (pattern.category === 'PROCESS_CRASH') {
        const hasSessionKeywords = SESSION_RELATED_KEYWORDS.some(kw =>
          searchText.includes(kw),
        );
        if (hasSessionKeywords) {
          return {
            category: 'SESSION_STATE_ERROR',
            userMessage: 'Session state is invalid or corrupted.',
            actionHint: 'The stored session state has become stale. Please start a new conversation, or retry — the session will be automatically reset.',
            rawMessage,
            providerName: ctx.providerName,
            details: extraDetail || undefined,
            retryable: true,
            recoveryActions: buildRecoveryActions('SESSION_STATE_ERROR', ctx),
          };
        }
      }
      return buildResult(pattern, ctx, rawMessage, extraDetail);
    }
  }

  // Fallback: unknown error
  return {
    category: 'UNKNOWN',
    userMessage: `An unexpected error occurred${providerHint(ctx)}.`,
    actionHint: 'Check the error details below. If the problem persists, run Provider Doctor in Settings.',
    rawMessage,
    providerName: ctx.providerName,
    details: extraDetail || undefined,
    retryable: false,
    recoveryActions: buildRecoveryActions('UNKNOWN', ctx),
  };
}

/**
 * #629 — decide whether an is_error RESULT's `errors[]` indicates a stale/bad
 * resume (session-state) that SHOULD clear sdk_session_id, vs a transient error
 * (rate-limit / auth / budget) that must NOT (clearing would force a fresh
 * session and drop SDK-side context). Pure: feeds `errors.join('\n')` through
 * classifyError; true only for RESUME_FAILED / SESSION_STATE_ERROR. Empty / null
 * → false (no text signal; caller may fall back to a non-text heuristic).
 *
 * Verified shape (POC-B 2026-06-26, docs/research/issue-629-resume-error-shape-poc):
 * GLM / MiMo / DeepSeek / Aliyun Anthropic proxies all return
 * errors[0] = "No conversation found with session ID: <sid>".
 */
export function isSessionStateResultError(
  errors: readonly string[] | null | undefined,
  ctx?: Pick<ErrorContext, 'providerName' | 'baseUrl'>,
): boolean {
  if (!errors || errors.length === 0) return false;
  const { category } = classifyError({ error: errors.join('\n'), ...ctx });
  return category === 'RESUME_FAILED' || category === 'SESSION_STATE_ERROR';
}

function buildRecoveryActions(category: ClaudeErrorCategory, ctx: ErrorContext): RecoveryAction[] {
  const actions: RecoveryAction[] = [];
  const meta = ctx.providerMeta;

  switch (category) {
    case 'AUTH_REJECTED':
    case 'AUTH_FORBIDDEN':
    case 'AUTH_STYLE_MISMATCH':
    case 'NO_CREDENTIALS':
      if (meta?.apiKeyUrl) actions.push({ label: 'Get API Key', url: meta.apiKeyUrl });
      actions.push({ label: 'Open Settings', action: 'open_settings' });
      break;
    case 'RATE_LIMITED':
    case 'PROVIDER_UNAVAILABLE':
      actions.push({ label: 'Retry', action: 'retry' });
      if (meta?.pricingUrl) actions.push({ label: 'Upgrade Plan', url: meta.pricingUrl });
      if (meta?.docsUrl) actions.push({ label: 'View Docs', url: meta.docsUrl });
      break;
    case 'MODEL_NOT_AVAILABLE':
    case 'ENDPOINT_NOT_FOUND':
    case 'NETWORK_UNREACHABLE':
      if (meta?.docsUrl) actions.push({ label: 'View Docs', url: meta.docsUrl });
      actions.push({ label: 'Open Settings', action: 'open_settings' });
      break;
    case 'RESUME_FAILED':
    case 'SESSION_STATE_ERROR':
      actions.push({ label: 'New Conversation', action: 'new_conversation' });
      break;
    case 'PROCESS_CRASH':
      if (meta?.apiKeyUrl) actions.push({ label: 'Check API Key', url: meta.apiKeyUrl });
      if (meta?.docsUrl) actions.push({ label: 'View Docs', url: meta.docsUrl });
      actions.push({ label: 'Open Settings', action: 'open_settings' });
      break;
    case 'EXECUTION_PERMISSION_DENIED':
      // There is no safe cross-platform deep link for OS/antivirus policy.
      // The classifier's actionHint is the complete recovery instruction.
      break;
    default:
      actions.push({ label: 'Open Settings', action: 'open_settings' });
      break;
  }

  return actions;
}

function buildResult(
  pattern: ErrorPattern,
  ctx: ErrorContext,
  rawMessage: string,
  extraDetail: string,
): ClassifiedError {
  const category = pattern.category;

  // Report severe errors to Sentry (non-blocking, ignores expected errors like RATE_LIMITED)
  reportToSentry(category, ctx.error, {
    runtimeId: 'claude_code',
    providerTest: ctx.providerTest,
    retryExhausted: ctx.retryExhausted,
  });

  return {
    category,
    userMessage: pattern.userMessage(ctx),
    actionHint: pattern.actionHint(ctx),
    rawMessage,
    providerName: ctx.providerName,
    details: extraDetail || undefined,
    retryable: pattern.retryable,
    recoveryActions: buildRecoveryActions(category, ctx),
  };
}

// ── Formatting helper ───────────────────────────────────────────

/**
 * Format a ClassifiedError into a user-friendly string for SSE error events.
 */
export function formatClassifiedError(err: ClassifiedError): string {
  let msg = err.userMessage;
  if (err.actionHint) {
    msg += `\n\n**What to do:** ${err.actionHint}`;
  }
  if (err.details) {
    msg += `\n\nDetails: ${err.details}`;
  }
  msg += `\n\nOriginal error: ${err.rawMessage}`;
  return msg;
}

/**
 * Serialize a ClassifiedError to a JSON string suitable for SSE error events.
 * Frontend can parse this to extract structured error information.
 */
export function serializeClassifiedError(err: ClassifiedError): string {
  return JSON.stringify({
    category: err.category,
    userMessage: err.userMessage,
    actionHint: err.actionHint,
    retryable: err.retryable,
    providerName: err.providerName,
    details: err.details,
    rawMessage: err.rawMessage,
    recoveryActions: err.recoveryActions,
  });
}
