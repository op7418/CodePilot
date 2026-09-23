import { buildNormalizedFingerprint } from './contract';

export type UtilityProcessFailureReason =
  | 'utility_fatal_error'
  | 'utility_error'
  | 'unexpected_exit';

export interface UtilityProcessFailureMetrics {
  utilityRssBytes?: number | null;
  utilityHeapUsedBytes?: number | null;
  utilityHeapTotalBytes?: number | null;
  utilityHeapLimitBytes?: number | null;
  utilityExternalBytes?: number | null;
  utilityArrayBuffersBytes?: number | null;
  hostTotalKb?: number | null;
  hostFreeKb?: number | null;
  hostAvailableKb?: number | null;
  hostSwapTotalKb?: number | null;
  hostSwapFreeKb?: number | null;
}

export interface UtilityProcessFailureInput extends UtilityProcessFailureMetrics {
  reason: string;
  exitCode?: number | null;
  platform?: NodeJS.Platform | string;
}

export interface UtilityProcessFailureEvent {
  message: 'server.utility_process_failed';
  level: 'fatal';
  tags: Record<string, string>;
  extra: Record<string, string | number>;
  fingerprint: string[];
}

const WINDOWS_EXPECTED_SHUTDOWN_EXIT_CODES = new Set([
  0x4001_0004, // DBG_TERMINATE_PROCESS: commonly emitted during OS teardown.
  0xc000_026b, // STATUS_DLL_INIT_FAILED_LOGOFF: window station is shutting down.
]);

const NUMERIC_EXTRA_KEYS = [
  'utilityRssBytes',
  'utilityHeapUsedBytes',
  'utilityHeapTotalBytes',
  'utilityHeapLimitBytes',
  'utilityExternalBytes',
  'utilityArrayBuffersBytes',
  'hostTotalKb',
  'hostFreeKb',
  'hostAvailableKb',
  'hostSwapTotalKb',
  'hostSwapFreeKb',
] as const satisfies ReadonlyArray<keyof UtilityProcessFailureMetrics>;

// Electron documents utility exitCode as waitpid status on POSIX or
// GetExitCodeProcess on Windows. Preserve the platform value (including signed
// POSIX/launch-failure sentinels) while rejecting floats and values outside the
// union of signed int32 and unsigned Windows DWORD representations.
const MIN_PLATFORM_EXIT_CODE = -0x8000_0000;
const MAX_PLATFORM_EXIT_CODE = 0xffff_ffff;

function normalizeReason(reason: string): UtilityProcessFailureReason {
  if (reason === 'utility_fatal_error' || reason === 'utility_error') return reason;
  return 'unexpected_exit';
}

function categoryForReason(reason: UtilityProcessFailureReason): string {
  if (reason === 'utility_fatal_error') return 'UTILITY_PROCESS_FATAL_ERROR';
  if (reason === 'utility_error') return 'UTILITY_PROCESS_ERROR';
  return 'UTILITY_PROCESS_UNEXPECTED_EXIT';
}

function categoryForUnexpectedExit(
  exitCode: number | null | undefined,
  platform: NodeJS.Platform | string | undefined,
): string {
  if (!Number.isInteger(exitCode)) return 'UTILITY_PROCESS_UNEXPECTED_EXIT';
  if (exitCode === 0) return 'UTILITY_PROCESS_UNEXPECTED_CLEAN_EXIT';
  if (platform === 'win32' && Number(exitCode) > 0x7fff_ffff) {
    return 'UTILITY_PROCESS_PLATFORM_TERMINATION';
  }
  return 'UTILITY_PROCESS_NONZERO_EXIT';
}

export function isExpectedUtilityProcessExit(
  input: Pick<UtilityProcessFailureInput, 'reason' | 'exitCode' | 'platform'>,
): boolean {
  return normalizeReason(input.reason) === 'unexpected_exit'
    && input.platform === 'win32'
    && Number.isInteger(input.exitCode)
    && WINDOWS_EXPECTED_SHUTDOWN_EXIT_CODES.has(Number(input.exitCode));
}

function addFiniteNonNegative(
  output: Record<string, string | number>,
  key: string,
  value: number | null | undefined,
): void {
  if (!Number.isFinite(value) || Number(value) < 0) return;
  output[key] = Number(value);
}

function addPlatformExitCode(
  output: Record<string, string | number>,
  value: number | null | undefined,
): void {
  if (
    !Number.isInteger(value)
    || Number(value) < MIN_PLATFORM_EXIT_CODE
    || Number(value) > MAX_PLATFORM_EXIT_CODE
  ) return;
  output.exitCode = Number(value);
}

/**
 * Build the only Sentry payload allowed for a packaged Next utility failure.
 * The Electron diagnostic report is deliberately not accepted as input: it
 * may contain argv, environment variables and absolute paths. Callers can
 * provide only stable enums plus bounded numeric process/host observations.
 */
export function buildUtilityProcessFailureEvent(
  input: UtilityProcessFailureInput,
): UtilityProcessFailureEvent | null {
  const reason = normalizeReason(input.reason);
  if (isExpectedUtilityProcessExit(input)) return null;
  const category = reason === 'unexpected_exit'
    ? categoryForUnexpectedExit(input.exitCode, input.platform)
    : categoryForReason(reason);
  const extra: Record<string, string | number> = { lifecycleReason: reason };
  addPlatformExitCode(extra, input.exitCode);
  for (const key of NUMERIC_EXTRA_KEYS) {
    addFiniteNonNegative(extra, key, input[key]);
  }

  return {
    message: 'server.utility_process_failed',
    level: 'fatal',
    tags: {
      'error.category': category,
      'error.outcome': 'product_fault',
      'grouping.strategy': 'normalized',
      'runtime.id': 'packaged_server',
    },
    extra,
    fingerprint: buildNormalizedFingerprint({
      category,
      layer: 'electron_main',
      runtimeId: 'packaged_server',
    }),
  };
}
