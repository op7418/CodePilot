import { PROVIDER_CALL_SCENES } from '../provider-call-policy';

/** Low-cardinality telemetry dimensions. Never put caller-provided strings in these tags. */
const CALL_SCENES = new Set<string>(PROVIDER_CALL_SCENES);
const FAILURE_KINDS = new Set([
  'http_4xx', 'http_5xx', 'dns', 'transport', 'timeout', 'credentials', 'model_unsupported',
  'no_output', 'cancelled', 'other',
]);

export function telemetryCallScene(value: unknown): string {
  return typeof value === 'string' && CALL_SCENES.has(value) ? value : 'unknown';
}

export function telemetryFailureKind(value: unknown): string {
  return typeof value === 'string' && FAILURE_KINDS.has(value) ? value : 'other';
}
