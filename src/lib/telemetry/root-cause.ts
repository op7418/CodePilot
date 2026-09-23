import {
  classifyTelemetryOutcome,
  shouldSendErrorEnvelope,
  type TelemetryOutcomeKind,
} from './contract';

type UnknownRecord = Record<string, unknown>;

const MAX_CAUSE_DEPTH = 4;
const MAX_VISITED_NODES = 16;
const MAX_ARRAY_CAUSES = 4;
const MAX_INSPECTED_TEXT = 256;
const MAX_SAFE_STACK = 32_768;

const CHILD_FIELDS = ['cause', 'error', 'lastError', 'reason'] as const;
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET', 'ENETUNREACH', 'EHOSTUNREACH']);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'PROVIDER_REQUEST_TIMEOUT',
]);
const CREDENTIAL_CODES = new Set([
  'AUTHENTICATION_ERROR',
  'INVALID_API_KEY',
  'MISSING_API_KEY',
  'PERMISSION_DENIED',
  'NATIVE_CREDENTIALS_REQUIRED',
  'CLAUDE_SETTINGS_ONLY',
  'PROVIDER_CREDENTIALS_UNAVAILABLE',
  'PROVIDER_OAUTH_EXPIRED',
]);
const MODEL_CODES = new Set([
  'MODEL_NOT_FOUND',
  'MODEL_NOT_SUPPORTED',
  'UNSUPPORTED_MODEL',
  'PROVIDER_TRANSPORT_UNSUPPORTED',
]);
const PROVIDER_ERROR_TYPE_STATUS = new Map<string, number>([
  ['INVALID_REQUEST_ERROR', 400],
  ['AUTHENTICATION_ERROR', 401],
  ['BILLING_ERROR', 402],
  ['PERMISSION_ERROR', 403],
  ['NOT_FOUND_ERROR', 404],
  ['REQUEST_TOO_LARGE', 413],
  ['RATE_LIMIT_ERROR', 429],
  ['API_ERROR', 500],
  ['OVERLOADED_ERROR', 529],
]);
const CREDENTIAL_CATEGORIES = new Set([
  'NO_CREDENTIALS',
  'AUTH_REJECTED',
  'AUTH_FORBIDDEN',
  'AUTH_STYLE_MISMATCH',
  'OPENAI_AUTH_FAILED',
]);
const MODEL_CATEGORIES = new Set([
  'MODEL_NOT_AVAILABLE',
  'ENDPOINT_NOT_FOUND',
]);
const GENERIC_PROVIDER_CATEGORIES = new Set([
  'PROVIDER_FAILURE',
  'NATIVE_STREAM_ERROR',
  'MCP_CONNECTION_ERROR',
  'UNKNOWN',
]);

export type TelemetryRootCauseKind =
  | 'http_4xx'
  | 'http_5xx'
  | 'dns'
  | 'transport'
  | 'timeout'
  | 'credentials'
  | 'model_unsupported'
  | 'no_output'
  | 'cancelled'
  | 'other';

export interface NormalizedTelemetryFailure {
  category: string;
  outcome: TelemetryOutcomeKind;
  rootCause: TelemetryRootCauseKind;
  statusCode?: number;
  retryExhausted: boolean;
  /** False means this failure must not create any Sentry event or Issue. */
  shouldReport: boolean;
}

export interface NormalizeTelemetryFailureOptions {
  retryExhausted?: boolean;
  providerTest?: boolean;
  statusCode?: number;
}

interface InspectedRootCause {
  statusCode?: number;
  codes: Set<string>;
  messages: string[];
  names: string[];
}

function ownValue(record: UnknownRecord, key: string): unknown {
  try {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  return value as UnknownRecord;
}

function boundedString(value: unknown, maxLength = MAX_INSPECTED_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, maxLength);
}

function parseStatus(value: unknown): number | undefined {
  if (typeof value === 'string' && !/^\d{3}$/.test(value)) return undefined;
  const status = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function addNodeSignals(node: UnknownRecord, inspected: InspectedRootCause): void {
  if (inspected.statusCode === undefined) {
    inspected.statusCode = parseStatus(ownValue(node, 'statusCode'))
      ?? parseStatus(ownValue(node, 'status'));
    const response = asRecord(ownValue(node, 'response'));
    if (inspected.statusCode === undefined && response) {
      inspected.statusCode = parseStatus(ownValue(response, 'statusCode'))
        ?? parseStatus(ownValue(response, 'status'));
    }
  }

  const code = boundedString(ownValue(node, 'code'), 64);
  if (code && /^[a-z0-9_.-]{1,64}$/i.test(code)) inspected.codes.add(code.toUpperCase());

  // In-band provider SSE errors commonly retain only a low-cardinality
  // `type` enum; the adapter's APICallError/status wrapper exists only for
  // initial request failures. Treat the allow-listed enum like `code` and
  // recover the provider's documented HTTP semantics without reading bodies.
  const type = boundedString(ownValue(node, 'type'), 64);
  if (type && /^[a-z0-9_.-]{1,64}$/i.test(type)) {
    const normalizedType = type.toUpperCase();
    inspected.codes.add(normalizedType);
    if (inspected.statusCode === undefined) {
      inspected.statusCode = PROVIDER_ERROR_TYPE_STATUS.get(normalizedType);
    }
  }

  const name = boundedString(ownValue(node, 'name'), 96);
  if (name) inspected.names.push(name);

  const message = boundedString(ownValue(node, 'message'));
  if (message) inspected.messages.push(message);
}

/**
 * Inspect only a small allow-list of structured error fields. Response bodies,
 * request data, provider chunks, headers, paths, and arbitrary object fields
 * are never traversed or returned.
 */
export function inspectTelemetryRootCause(error: unknown): InspectedRootCause {
  const inspected: InspectedRootCause = {
    codes: new Set<string>(),
    messages: [],
    names: [],
  };
  const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const visited = new WeakSet<object>();
  let visitedNodes = 0;

  while (queue.length > 0 && visitedNodes < MAX_VISITED_NODES) {
    const current = queue.shift();
    if (!current || current.depth > MAX_CAUSE_DEPTH) continue;
    const node = asRecord(current.value);
    if (!node) continue;
    if (visited.has(node)) continue;
    visited.add(node);
    visitedNodes++;
    addNodeSignals(node, inspected);

    if (current.depth === MAX_CAUSE_DEPTH) continue;
    for (const field of CHILD_FIELDS) {
      const child = ownValue(node, field);
      if (child !== undefined) queue.push({ value: child, depth: current.depth + 1 });
    }
    const errors = ownValue(node, 'errors');
    try {
      if (Array.isArray(errors)) {
        for (const child of errors.slice(0, MAX_ARRAY_CAUSES)) {
          queue.push({ value: child, depth: current.depth + 1 });
        }
      }
    } catch {
      // A hostile Proxy must not affect the product error path.
    }
  }

  return inspected;
}

function hasCode(inspected: InspectedRootCause, codes: ReadonlySet<string>): boolean {
  for (const code of inspected.codes) if (codes.has(code)) return true;
  return false;
}

function combinedText(inspected: InspectedRootCause): string {
  return [...inspected.names, ...inspected.messages].join('\n').slice(0, MAX_INSPECTED_TEXT * 4);
}

function reportable(outcome: TelemetryOutcomeKind, retryExhausted: boolean): boolean {
  if (outcome === 'transient_upstream' && !retryExhausted) return false;
  return shouldSendErrorEnvelope(outcome);
}

/** Shared provider/native root-cause contract. The return value is enum-only. */
export function normalizeTelemetryFailure(
  category: string,
  error: unknown,
  options: NormalizeTelemetryFailureOptions = {},
): NormalizedTelemetryFailure {
  const retryExhausted = options.retryExhausted === true;
  if (options.providerTest) {
    return {
      category: 'PROVIDER_TEST_FAILED',
      outcome: 'provider_test_result',
      rootCause: 'other',
      retryExhausted,
      shouldReport: false,
    };
  }

  const inspected = inspectTelemetryRootCause(error);
  const statusCode = options.statusCode ?? inspected.statusCode;
  const text = combinedText(inspected);
  const genericProviderFailure = GENERIC_PROVIDER_CATEGORIES.has(category);
  const noOutput = inspected.names.some((name) => /^(?:AI_)?NoOutputGeneratedError$/.test(name))
    || category === 'EMPTY_RESPONSE'
    || (genericProviderFailure && /\bno output generated\b/i.test(text));
  const timeout = category.startsWith('TIMEOUT_')
    || hasCode(inspected, TIMEOUT_CODES)
    || (genericProviderFailure && /\b(?:timeout|timed out)\b/i.test(text));
  const dns = hasCode(inspected, DNS_CODES)
    || (genericProviderFailure && /\b(?:ENOTFOUND|EAI_AGAIN|getaddrinfo)\b/i.test(text));

  // Phase 6 freezes every structured HTTP 4xx, including 429, as an
  // actionable configuration/account/permission failure with zero Issue.
  if (statusCode !== undefined && statusCode >= 400 && statusCode <= 499) {
    return {
      category: 'PROVIDER_HTTP_4XX',
      outcome: 'user_action_required',
      rootCause: statusCode === 401 || statusCode === 403 ? 'credentials' : 'http_4xx',
      statusCode,
      retryExhausted,
      shouldReport: false,
    };
  }

  if (/abort|cancel/i.test(text) && !timeout) {
    return {
      category: 'PROVIDER_CANCELLED',
      outcome: 'user_cancelled',
      rootCause: 'cancelled',
      statusCode,
      retryExhausted,
      shouldReport: false,
    };
  }

  const credentials = CREDENTIAL_CATEGORIES.has(category)
    || hasCode(inspected, CREDENTIAL_CODES)
    || inspected.names.some((name) => name === 'AI_LoadAPIKeyError')
    || (genericProviderFailure
      && /\b(?:missing|invalid|no)\s+(?:api[ _-]?key|credentials?)\b|\b(?:unauthorized|forbidden|authentication failed)\b/i.test(text));
  if (credentials) {
    return {
      category: 'PROVIDER_CREDENTIALS_REQUIRED',
      outcome: 'user_action_required',
      rootCause: 'credentials',
      statusCode,
      retryExhausted,
      shouldReport: false,
    };
  }

  const unsupportedModel = MODEL_CATEGORIES.has(category)
    || hasCode(inspected, MODEL_CODES)
    || (genericProviderFailure
      && /\bmodel\b.{0,48}\b(?:not found|not supported|unsupported|does not exist|not available)\b/i.test(text));
  if (unsupportedModel) {
    return {
      category: 'PROVIDER_MODEL_UNSUPPORTED',
      outcome: 'user_action_required',
      rootCause: 'model_unsupported',
      statusCode,
      retryExhausted,
      shouldReport: false,
    };
  }

  if (statusCode !== undefined && statusCode >= 500) {
    const outcome: TelemetryOutcomeKind = 'transient_upstream';
    return {
      category: 'PROVIDER_HTTP_5XX',
      outcome,
      rootCause: 'http_5xx',
      statusCode,
      retryExhausted,
      shouldReport: reportable(outcome, retryExhausted),
    };
  }

  if (dns) {
    const outcome: TelemetryOutcomeKind = 'transient_upstream';
    return {
      category: 'PROVIDER_DNS_FAILURE',
      outcome,
      rootCause: 'dns',
      statusCode,
      retryExhausted,
      shouldReport: reportable(outcome, retryExhausted),
    };
  }

  if (timeout) {
    const outcome: TelemetryOutcomeKind = 'transient_upstream';
    return {
      category: category.startsWith('TIMEOUT_') ? category : 'PROVIDER_TIMEOUT',
      outcome,
      rootCause: 'timeout',
      statusCode,
      retryExhausted,
      shouldReport: reportable(outcome, retryExhausted),
    };
  }

  if (hasCode(inspected, TRANSPORT_CODES)) {
    const outcome: TelemetryOutcomeKind = 'transient_upstream';
    return {
      category: 'PROVIDER_TRANSPORT_FAILURE', outcome, rootCause: 'transport',
      statusCode, retryExhausted, shouldReport: reportable(outcome, retryExhausted),
    };
  }

  if (noOutput || category === 'EMPTY_RESPONSE') {
    const outcome: TelemetryOutcomeKind = 'provider_protocol_fault';
    return {
      category: 'EMPTY_RESPONSE',
      outcome,
      rootCause: 'no_output',
      statusCode,
      retryExhausted,
      shouldReport: reportable(outcome, retryExhausted),
    };
  }

  const outcome = classifyTelemetryOutcome(category, error, {
    retryExhausted,
    statusCode,
  });
  return {
    category,
    outcome,
    rootCause: 'other',
    statusCode,
    retryExhausted,
    shouldReport: reportable(outcome, retryExhausted),
  };
}

/**
 * Preserve stack frames for Sentry's default grouping without sending the
 * original provider message/cause graph. `beforeSend` still canonicalizes
 * local paths and removes frame context.
 */
export function createSafeTelemetryError(error: Error, safeMessage: string): Error {
  const safe = new Error(safeMessage);
  let stack: string | undefined;
  try {
    stack = typeof error.stack === 'string' ? error.stack : undefined;
  } catch {
    return safe;
  }
  if (!stack) return safe;
  // V8 embeds the complete (possibly multi-line) Error.message before the
  // first frame. Preserve only frame lines so response bodies or provider
  // chunks cannot survive on continuation lines of the stack header.
  const frameIndex = stack.split('\n').findIndex((line) => /^\s*at\b/.test(line));
  if (frameIndex < 0) return safe;
  const frames = stack.split('\n').slice(frameIndex).join('\n');
  safe.stack = `${safe.name}: ${safeMessage}\n${frames}`.slice(0, MAX_SAFE_STACK);
  return safe;
}
