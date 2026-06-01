/**
 * Error Classifier — structured error categorization for Claude Code process errors.
 *
 * Replaces the ad-hoc if/else chain in claude-client.ts with a pattern-matching
 * classifier that produces actionable, user-facing error messages.
 */

// ── Sentry integration (lazy, no-op when unavailable) ───────────

const SENTRY_REPORTABLE: Set<string> = new Set([
  // PROCESS_CRASH removed — too noisy (136+ events/day), mostly user config issues
  'UNKNOWN', 'CLI_NOT_FOUND', 'CLI_INSTALL_CONFLICT',
  'MISSING_GIT_BASH', 'PROVIDER_NOT_APPLIED', 'SESSION_STATE_ERROR',
  // Native Runtime errors
  'NATIVE_STREAM_ERROR', 'OPENAI_AUTH_FAILED', 'MCP_CONNECTION_ERROR',
]);

function reportToSentry(category: string, error: unknown, extra?: Record<string, unknown>) {
  if (!SENTRY_REPORTABLE.has(category)) return;
  // Skip aborted operations — these are user-initiated cancellations
  const msg = error instanceof Error ? error.message : String(error);
  if (/abort|cancel/i.test(msg)) return;

  // Fire-and-forget async import — never blocks the classifier
  import('@sentry/node').then((Sentry) => {
    Sentry.withScope((scope) => {
      scope.setTag('error.category', category);
      scope.setTag('error.provider', (extra?.providerName as string) || 'unknown');
      scope.setTag('error.runtime', (extra?.runtime as string) || 'unknown');
      if (extra?.baseUrl) scope.setTag('provider.baseUrl', extra.baseUrl as string);
      if (extra?.modelId) scope.setTag('model.id', extra.modelId as string);
      if (extra) scope.setExtras(extra);
      scope.setFingerprint([category, msg.slice(0, 100)]);
      if (error instanceof Error) {
        Sentry.captureException(error);
      } else {
        Sentry.captureMessage(String(error), 'error');
      }
    });
  }).catch(() => { /* Sentry not available */ });
}

/**
 * Report a native runtime error to Sentry.
 * Called from agent-loop.ts and MCP manager for errors that bypass the main classifier.
 */
export function reportNativeError(
  category: ClaudeErrorCategory,
  error: unknown,
  context?: { providerName?: string; modelId?: string; sessionId?: string; baseUrl?: string },
) {
  reportToSentry(category, error, { ...context, runtime: 'native' });
}

// ── Error categories ────────────────────────────────────────────

export type ClaudeErrorCategory =
  | 'CLI_NOT_FOUND'
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
  // ── CLI not found ──
  {
    category: 'CLI_NOT_FOUND',
    patterns: ['ENOENT', 'spawn', 'not found', 'No such file'],
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
    patterns: ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'fetch failed', 'network error', 'DNS', 'ENOTFOUND'],
    codes: ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'],
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
    providerName: ctx.providerName,
    baseUrl: ctx.baseUrl,
    rawMessage,
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
