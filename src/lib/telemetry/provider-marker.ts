const PROVIDER_TELEMETRY_HANDLED = Symbol.for('codepilot.telemetry.provider-handled');
const PROVIDER_TELEMETRY_HANDLED_SET = Symbol.for('codepilot.telemetry.provider-handled-set');

const markerGlobal = globalThis as unknown as Record<PropertyKey, unknown>;
const existingHandledFailures = markerGlobal[PROVIDER_TELEMETRY_HANDLED_SET];
const handledFailures = existingHandledFailures instanceof WeakSet
  ? existingHandledFailures as WeakSet<object>
  : new WeakSet<object>();
markerGlobal[PROVIDER_TELEMETRY_HANDLED_SET] = handledFailures;

type MarkedFailure = { [PROVIDER_TELEMETRY_HANDLED]?: true };

/** Ensure even primitive boundary failures can be marked before a shared rethrow. */
export function toMarkableTelemetryFailure(error: unknown, fallbackMessage = 'Non-Error boundary failure'): object {
  if (error && (typeof error === 'object' || typeof error === 'function')) return error;
  const wrapped = new Error(typeof error === 'string' ? error : fallbackMessage);
  Object.defineProperty(wrapped, 'cause', {
    value: error,
    enumerable: false,
    configurable: false,
  });
  return wrapped;
}

export function markTelemetryFailureHandled(error: unknown): void {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return;
  handledFailures.add(error);
  try {
    if ((error as MarkedFailure)[PROVIDER_TELEMETRY_HANDLED]) return;
    Object.defineProperty(error, PROVIDER_TELEMETRY_HANDLED, {
      value: true,
      enumerable: false,
      configurable: false,
    });
  } catch {
    // Frozen SDK errors and hostile proxies still remain covered by the
    // process-local WeakSet. Telemetry must never alter the product failure.
  }
}

export function isTelemetryFailureHandled(error: unknown): boolean {
  let current = error;
  const visited = new WeakSet<object>();
  for (let depth = 0; depth <= 4; depth++) {
    if (!current || (typeof current !== 'object' && typeof current !== 'function')) return false;
    const object = current as object;
    if (visited.has(object)) return false;
    visited.add(object);
    if (handledFailures.has(object)) return true;
    try {
      if (Boolean((current as MarkedFailure)[PROVIDER_TELEMETRY_HANDLED])) return true;
      // Only inspect an own data-property. Never execute a custom getter or
      // traverse arbitrary SDK response/request fields at the telemetry gate.
      current = Object.getOwnPropertyDescriptor(object, 'cause')?.value;
    } catch {
      return false;
    }
  }
  return false;
}

// Backward-compatible provider names. The marker is intentionally shared by
// every terminal boundary whose rich error has already been classified.
export const toMarkableProviderFailure = toMarkableTelemetryFailure;
export const markProviderFailureHandled = markTelemetryFailureHandled;
export const isProviderFailureHandled = isTelemetryFailureHandled;
