export type MediaUserActionErrorCode =
  | 'MEDIA_SOURCE_NOT_FOUND'
  | 'MEDIA_PROVIDER_NOT_CONFIGURED'
  | 'MEDIA_PROVIDER_UNAVAILABLE'
  | 'MEDIA_AUTH_REQUIRED'
  | 'MEDIA_INPUT_UNSUPPORTED';

/** A media failure the user can resolve without a CodePilot code change. */
export class MediaUserActionError extends Error {
  readonly code: MediaUserActionErrorCode;

  constructor(code: MediaUserActionErrorCode, message: string) {
    super(message);
    this.name = 'MediaUserActionError';
    this.code = code;
  }
}

export function isMediaUserActionError(error: unknown): error is MediaUserActionError {
  return error instanceof MediaUserActionError;
}
