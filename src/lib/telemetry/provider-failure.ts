import type { ProviderCallScene } from '../provider-call-policy';
import type { ResolvedProvider } from '../provider-resolver';
import {
  buildNormalizedFingerprint,
  shouldUseDefaultStackGrouping,
  statusClass,
} from './contract';
import { markProviderFailureHandled } from './provider-marker';
import { telemetryCallScene } from './diagnostics';
import { telemetryReportBudget } from './report-budget';
import {
  createSafeTelemetryError,
  inspectTelemetryRootCause,
  normalizeTelemetryFailure,
  type NormalizedTelemetryFailure,
} from './root-cause';

export type ProviderFailureDescription = NormalizedTelemetryFailure;

export function providerFailureStatus(error: unknown): number | undefined {
  return inspectTelemetryRootCause(error).statusCode;
}

export function describeProviderFailure(
  error: unknown,
  callScene: ProviderCallScene,
  options: { retryExhausted?: boolean } = {},
): ProviderFailureDescription {
  return normalizeTelemetryFailure('PROVIDER_FAILURE', error, {
    providerTest: callScene === 'connection_test',
    // This shared catch is the terminal boundary after the AI SDK's own
    // retry budget. Tests may pass false to lock the pre-exhaustion policy.
    retryExhausted: options.retryExhausted ?? true,
  });
}

export interface ProviderTelemetryIdentity {
  providerProtocol: string;
  providerClass: string;
}

export function providerTelemetryIdentity(resolved?: ResolvedProvider): ProviderTelemetryIdentity {
  const providerClass = !resolved?.provider
    ? 'environment'
    : resolved.provider.preset_key
      ? 'managed'
      : 'configured';
  return {
    providerProtocol: resolved?.protocol || 'unknown',
    providerClass,
  };
}

function providerClass(resolved?: ResolvedProvider): string {
  return providerTelemetryIdentity(resolved).providerClass;
}

/** Capture once at the common provider boundary without prompt/result/body. */
export function reportProviderFailure(
  error: unknown,
  input: {
    callScene: ProviderCallScene;
    resolvedProvider?: ResolvedProvider;
    retryExhausted?: boolean;
  },
): void {
  // Mark before any async import or early return so the Node SDK cannot
  // auto-capture this same rich provider object (including responseBody).
  markProviderFailureHandled(error);
  if (process.env.NODE_ENV !== 'development') {
    if (
      process.env.NODE_ENV !== 'production'
      || process.env.NEXT_PUBLIC_CODEPILOT_CHANNEL !== 'stable'
    ) return;

    const description = describeProviderFailure(error, input.callScene, {
      retryExhausted: input.retryExhausted,
    });
    if (!description.shouldReport) return;

    import('@sentry/node').then((Sentry) => {
      if (!Sentry.isInitialized()) return;
      const protocol = input.resolvedProvider?.protocol || 'unknown';
      const classification = providerClass(input.resolvedProvider);
      const budget = telemetryReportBudget.take({ failure: description, callScene: input.callScene,
        providerProtocol: protocol, providerClass: classification, runtimeId: 'codepilot_runtime' });
      if (!budget.allowed) return;
      Sentry.withScope((scope) => {
        scope.setTag('error.category', description.category);
        scope.setTag('error.outcome', description.outcome);
        scope.setTag('error.runtime', 'codepilot_runtime');
        scope.setTag('runtime.id', 'codepilot_runtime');
        scope.setTag('provider.protocol', protocol);
        scope.setTag('provider.class', classification);
        scope.setTag('status.class', statusClass(description.statusCode));
        scope.setTag('failure.kind', description.rootCause);
        scope.setTag('call.scene', telemetryCallScene(input.callScene));
        scope.setExtras({
          callScene: input.callScene,
          retryExhausted: description.retryExhausted,
          ...(budget.suppressed ? { telemetrySuppressedCount: budget.suppressed } : {}),
        });
        const useDefaultStackGrouping = shouldUseDefaultStackGrouping(
          description.outcome,
          error,
        );
        if (description.outcome === 'unknown') scope.setTag('needs_classification', 'yes');
        if (useDefaultStackGrouping) {
          Sentry.captureException(createSafeTelemetryError(error as Error, 'provider.unknown_failure'));
        } else {
          scope.setTag('grouping.strategy', 'normalized');
          scope.setFingerprint(buildNormalizedFingerprint({
            category: description.category,
            layer: 'next_server',
            runtimeId: 'codepilot_runtime',
            providerProtocol: protocol,
            providerClass: classification,
            statusCode: description.statusCode,
          }));
          Sentry.captureMessage('provider.request_failed', 'error');
        }
      });
    }).catch(() => { /* telemetry cannot affect provider behavior */ });
  }
}
