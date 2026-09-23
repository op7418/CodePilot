import type { TelemetryLayer } from './contract';
import { telemetryCallScene, telemetryFailureKind } from './diagnostics';

type UnknownRecord = Record<string, unknown>;

const ALLOWED_TAGS = new Set([
  'app.channel',
  'error.category',
  'error.outcome',
  'error.runtime',
  'grouping.strategy',
  'needs_classification',
  'os.arch',
  'os.platform',
  'provider.class',
  'provider.protocol',
  'runtime.id',
  'runtime.layer',
  'status.class',
  'call.scene',
  'failure.kind',
]);

const ALLOWED_EXTRAS = new Set([
  'callScene',
  'childRole',
  'exitCode',
  'hostAvailableKb',
  'hostFreeKb',
  'hostSwapFreeKb',
  'hostSwapTotalKb',
  'hostTotalKb',
  'lifecycleReason',
  'originalLength',
  'retryExhausted',
  'signal',
  'timeoutStage',
  'truncated',
  'telemetrySuppressedCount',
  'utilityArrayBuffersBytes',
  'utilityExternalBytes',
  'utilityHeapLimitBytes',
  'utilityHeapTotalBytes',
  'utilityHeapUsedBytes',
  'utilityRssBytes',
]);

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|key|token)-[a-z0-9_-]{8,}\b/gi,
  /\b(?:api[_-]?key|authorization|bearer|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/g,
];

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' ? value as UnknownRecord : undefined;
}

export function sanitizeText(value: unknown, maxLength = 512): string {
  let text = typeof value === 'string' ? value : String(value ?? '');
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  text = text
    .replace(/https?:\/\/[^\s)\]}]+/gi, '[url]')
    .replace(/file:\/\/[^\r\n]+/gi, '[local-path]')
    .replace(/(?:\/Users\/|\/home\/)[^\r\n]+/g, '[local-path]')
    .replace(/[A-Za-z]:\\Users\\[^\r\n]+/g, '[local-path]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[id]')
    .replace(/\b[0-9a-f]{24,}\b/gi, '[id]');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)} [truncated length=${text.length}]`;
}

export function canonicalizeSourcePath(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\/Users\/[^/]+/g, '/Users/<user>')
    .replace(/\/home\/[^/]+/g, '/home/<user>')
    .replace(/[A-Za-z]:\\Users\\[^\\]+/g, 'C:\\Users\\<user>');
}

function sanitizeExceptionValues(exception: unknown): void {
  const exceptionRecord = asRecord(exception);
  const values = exceptionRecord?.values;
  if (!Array.isArray(values)) return;
  for (const item of values) {
    const value = asRecord(item);
    if (!value) continue;
    if ('value' in value) value.value = sanitizeText(value.value);
    const frames = asRecord(value.stacktrace)?.frames;
    if (!Array.isArray(frames)) continue;
    for (const itemFrame of frames) {
      const frame = asRecord(itemFrame);
      if (!frame) continue;
      if ('filename' in frame) frame.filename = canonicalizeSourcePath(frame.filename);
      if ('abs_path' in frame) frame.abs_path = canonicalizeSourcePath(frame.abs_path);
      if ('module' in frame) frame.module = canonicalizeSourcePath(frame.module);
      delete frame.vars;
      delete frame.pre_context;
      delete frame.post_context;
    }
  }
}

function sanitizeBreadcrumbs(breadcrumbs: unknown): UnknownRecord[] | undefined {
  if (!Array.isArray(breadcrumbs)) return undefined;
  const output: UnknownRecord[] = [];
  for (const item of breadcrumbs) {
    const crumb = asRecord(item);
    if (!crumb) continue;
    const category = String(crumb.category ?? '');
    if (category === 'console' || category === 'ui.input') continue;
    const next: UnknownRecord = {
      category: sanitizeText(category, 64),
      level: crumb.level,
      timestamp: crumb.timestamp,
    };
    if (category === 'fetch' || category === 'xhr' || category === 'http') {
      const data = asRecord(crumb.data);
      next.data = {
        method: sanitizeText(data?.method ?? '', 16),
        status_code: data?.status_code,
        url: sanitizeUrlPath(data?.url),
      };
    } else if (crumb.message) {
      next.message = sanitizeText(crumb.message, 256);
    }
    output.push(next);
  }
  return output;
}

export function sanitizeUrlPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = new URL(value, 'http://codepilot.local');
    return parsed.pathname.replace(/\b[0-9a-f]{16,}\b/gi, '[id]').slice(0, 256);
  } catch {
    return undefined;
  }
}

function sanitizeDebugMeta(debugMeta: unknown): void {
  const record = asRecord(debugMeta);
  if (!record || !Array.isArray(record.images)) return;
  for (const image of record.images) {
    const imageRecord = asRecord(image);
    if (!imageRecord) continue;
    if ('code_file' in imageRecord) imageRecord.code_file = canonicalizeSourcePath(imageRecord.code_file);
    if ('debug_file' in imageRecord) imageRecord.debug_file = canonicalizeSourcePath(imageRecord.debug_file);
  }
}

export interface SanitizeTelemetryOptions {
  layer: TelemetryLayer;
  channel: string;
  platform?: string;
  arch?: string;
}

/**
 * Default-deny Sentry event policy. The caller may add only stable enum tags
 * and bounded scalar extras before passing the event through this function.
 */
export function sanitizeTelemetryEvent<T extends object>(
  event: T,
  options: SanitizeTelemetryOptions,
): T {
  const mutable = event as UnknownRecord;
  // Deleting `user` is not enough for server SDK events: Relay may infer the
  // connecting IP and materialize user/geo after beforeSend. An explicit null
  // is the protocol tombstone for "do not infer" while still removing every
  // identity field supplied by callers.
  mutable.user = { ip_address: null };
  delete mutable.server_name;
  delete mutable.modules;
  if ('message' in mutable) mutable.message = sanitizeText(mutable.message);
  sanitizeExceptionValues(mutable.exception);
  sanitizeDebugMeta(mutable.debug_meta);

  const request = asRecord(mutable.request);
  mutable.request = request ? {
    method: request.method,
    url: sanitizeUrlPath(request.url),
  } : undefined;

  mutable.breadcrumbs = sanitizeBreadcrumbs(mutable.breadcrumbs);

  const tags = asRecord(mutable.tags) ?? {};
  const filteredTags: UnknownRecord = {
    'app.channel': options.channel,
    'runtime.layer': options.layer,
  };
  if (options.platform) filteredTags['os.platform'] = sanitizeText(options.platform, 32);
  if (options.arch) filteredTags['os.arch'] = sanitizeText(options.arch, 32);
  for (const [key, value] of Object.entries(tags)) {
    if (key === 'call.scene') { filteredTags[key] = telemetryCallScene(value); continue; }
    if (key === 'failure.kind') { filteredTags[key] = telemetryFailureKind(value); continue; }
    if (ALLOWED_TAGS.has(key)) filteredTags[key] = sanitizeText(value, 64);
  }
  mutable.tags = filteredTags;

  const extra = asRecord(mutable.extra) ?? {};
  const filteredExtra: UnknownRecord = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!ALLOWED_EXTRAS.has(key)) continue;
    if (key === 'telemetrySuppressedCount') {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000) filteredExtra[key] = value;
      continue;
    }
    filteredExtra[key] = typeof value === 'string' ? sanitizeText(value, 128) : value;
  }
  mutable.extra = filteredExtra;

  const contexts = asRecord(mutable.contexts);
  if (contexts) {
    const filteredContexts: UnknownRecord = {};
    const allowedContextFields: Record<string, string[]> = {
      app: ['build', 'name', 'version'],
      browser: ['name', 'version'],
      device: ['arch'],
      os: ['name', 'version'],
      runtime: ['name', 'version'],
    };
    for (const key of ['app', 'browser', 'device', 'os', 'runtime']) {
      const context = asRecord(contexts[key]);
      if (!context) continue;
      const cleaned: UnknownRecord = {};
      for (const field of allowedContextFields[key]) {
        if (context[field] !== undefined) cleaned[field] = sanitizeText(context[field], 64);
      }
      filteredContexts[key] = cleaned;
    }
    mutable.contexts = filteredContexts;
  }

  if (asRecord(mutable.tags)?.['grouping.strategy'] !== 'normalized') {
    delete mutable.fingerprint;
  }
  return event;
}

export function sanitizeTelemetryBreadcrumb<T extends object>(breadcrumb: T): T | null {
  const sanitized = sanitizeBreadcrumbs([breadcrumb]);
  return sanitized?.[0] as T | undefined ?? null;
}
