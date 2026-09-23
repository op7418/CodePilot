/** Stable product error codes; messages are for the local UI, never telemetry grouping. */
export type ProviderTransportErrorCode =
  | 'NATIVE_CREDENTIALS_REQUIRED'
  | 'CLAUDE_SETTINGS_ONLY'
  | 'PROVIDER_CREDENTIALS_UNAVAILABLE'
  | 'PROVIDER_OAUTH_EXPIRED'
  | 'PROVIDER_TRANSPORT_UNSUPPORTED'
  | 'PROVIDER_REQUEST_TIMEOUT';

export class ProviderTransportError extends Error {
  constructor(public readonly code: ProviderTransportErrorCode, message: string) {
    super(message);
    this.name = 'ProviderTransportError';
  }
}
