export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export type UpdaterUnsupportedReason =
  | 'not_packaged'
  | 'unofficial_build'
  | 'channel_not_stable'
  | 'platform_not_supported'
  | 'publisher_verification_unknown'
  | 'linux_trust_not_enabled'
  | null;

export type UpdaterPublisherVerification =
  | 'authenticode'
  | 'none'
  | 'unknown'
  | 'not_applicable';

export type UpdaterErrorCode =
  | 'offline'
  | 'metadata_invalid'
  | 'signature_invalid'
  | 'download_failed'
  | 'install_failed'
  | 'active_work'
  | 'activity_unavailable'
  | 'cli_update_running'
  | 'internal';

export interface UpdaterSnapshot {
  supported: boolean;
  unsupportedReason: UpdaterUnsupportedReason;
  phase: UpdaterPhase;
  currentVersion: string;
  targetVersion: string | null;
  channel: string;
  packageType: 'mac' | 'nsis' | 'appimage' | 'package-manager' | 'unknown';
  publisherVerification: UpdaterPublisherVerification;
  progressPercent: number | null;
  transferredBytes: number | null;
  totalBytes: number | null;
  releaseName: string;
  releaseNotes: string;
  releaseDate: string;
  errorCode: UpdaterErrorCode | null;
  checkedAt: string | null;
}

export function resolveUpdaterPublisherVerification(
  platform: NodeJS.Platform,
  appUpdateConfig: unknown,
): UpdaterPublisherVerification {
  if (platform !== 'win32') return 'not_applicable';
  if (!appUpdateConfig || typeof appUpdateConfig !== 'object' || Array.isArray(appUpdateConfig)) {
    return 'unknown';
  }
  const config = appUpdateConfig as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(config, 'publisherName')) return 'none';
  const publisherName = config.publisherName;
  if (typeof publisherName === 'string' && publisherName.trim()) return 'authenticode';
  if (Array.isArray(publisherName) && publisherName.some((value) => typeof value === 'string' && value.trim())) {
    return 'authenticode';
  }
  return 'unknown';
}

export interface UpdaterInstallResult {
  ok: boolean;
  blockers?: Array<'chat' | 'bridge' | 'task'>;
  errorCode?: UpdaterErrorCode;
}

export function resolveUpdaterSupport(input: {
  isPackaged: boolean;
  officialBuild: boolean;
  channel: string;
  platform: NodeJS.Platform;
  appImagePath?: string;
}): Pick<UpdaterSnapshot, 'supported' | 'unsupportedReason' | 'packageType'> {
  const packageType = input.platform === 'darwin'
    ? 'mac'
    : input.platform === 'win32'
      ? 'nsis'
      : input.platform === 'linux' && input.appImagePath
        ? 'appimage'
        : input.platform === 'linux'
          ? 'package-manager'
          : 'unknown';
  if (!input.isPackaged) return { supported: false, unsupportedReason: 'not_packaged', packageType };
  if (!input.officialBuild) return { supported: false, unsupportedReason: 'unofficial_build', packageType };
  if (input.channel !== 'stable' && input.channel !== 'preview') {
    return { supported: false, unsupportedReason: 'channel_not_stable', packageType };
  }
  if (input.platform === 'linux') {
    return { supported: false, unsupportedReason: 'linux_trust_not_enabled', packageType };
  }
  if (input.platform !== 'darwin' && input.platform !== 'win32') {
    return { supported: false, unsupportedReason: 'platform_not_supported', packageType };
  }
  return { supported: true, unsupportedReason: null, packageType };
}

/** Main-owned mapping to electron-builder's generated channel metadata names. */
export function resolveUpdaterFeedChannel(channel: string): 'latest' | 'preview' | null {
  if (channel === 'stable') return 'latest';
  if (channel === 'preview') return 'preview';
  return null;
}

export function classifyUpdaterError(error: unknown): UpdaterErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|network|offline/i.test(message)) return 'offline';
  if (/signature|publisher|code sign|certificate/i.test(message)) return 'signature_invalid';
  if (/latest.*ya?ml|metadata|sha512|checksum|invalid.*update/i.test(message)) return 'metadata_invalid';
  if (/download|differential|blockmap/i.test(message)) return 'download_failed';
  return 'internal';
}

export function updaterInitialDelay(randomValue: number): number {
  const bounded = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0.5;
  return 30_000 + Math.floor(bounded * 90_000);
}

export function updaterRetryDelay(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.min(4, Math.floor(consecutiveFailures) - 1));
  return Math.min(60 * 60 * 1000, 5 * 60 * 1000 * (2 ** exponent));
}

/**
 * Create the one-shot gate shared by updater Promise and emitter error paths.
 * A real retry first leaves the error phase, so phase=error means only that
 * this operation's equivalent failure has already been recorded.
 */
export function createUpdaterFailureReporter(
  getPhase: () => UpdaterPhase,
  recordError: (error: unknown) => void,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    if (getPhase() === 'error') return false;
    recordError(error);
    return true;
  };
}

/** Attach a terminal rejection handler synchronously to an auto-download. */
export async function consumeUpdaterDownloadPromise(
  promise: Promise<unknown>,
  reportError: (error: unknown) => unknown,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    reportError(error);
  }
}

export function boundedUpdateText(value: unknown, maxLength = 20_000): string {
  if (typeof value === 'string') return value.slice(0, maxLength);
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) => (entry && typeof entry === 'object' && 'note' in entry ? String(entry.note) : ''))
    .filter(Boolean)
    .join('\n\n')
    .slice(0, maxLength);
}
