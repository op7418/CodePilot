import { isMediaUserActionError } from '../media-error';
import {
  markTelemetryFailureHandled,
  toMarkableTelemetryFailure,
} from './provider-marker';
import { normalizeTelemetryFailure } from './root-cause';

/**
 * Preserve the exact failure object for the tool/runtime while preventing
 * framework auto-capture of expected user-action failures. Reportable
 * upstream and unknown faults deliberately remain unmarked.
 */
export function prepareMediaFailureForRethrow(
  error: unknown,
  fallbackMessage: string,
  options: { userCancelled?: boolean } = {},
): object {
  const failure = toMarkableTelemetryFailure(error, fallbackMessage);
  // This is the terminal tool boundary after the selected media SDK/request
  // has returned. There is no later application retry, so transient failures
  // reaching here have exhausted the operation's retry budget.
  const normalized = normalizeTelemetryFailure('PROVIDER_FAILURE', failure, {
    retryExhausted: true,
  });
  const expectedNonCancellation = !normalized.shouldReport
    && normalized.outcome !== 'user_cancelled';
  if (isMediaUserActionError(failure) || expectedNonCancellation || options.userCancelled === true) {
    markTelemetryFailureHandled(failure);
  }
  return failure;
}
