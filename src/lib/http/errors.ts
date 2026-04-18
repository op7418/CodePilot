export type HttpClientErrorCode = 'timeout' | 'network' | 'http_status' | 'invalid_json' | 'unknown';

export interface HttpClientErrorOptions {
  code: HttpClientErrorCode;
  requestId: string;
  message: string;
  url: string;
  method: string;
  status?: number;
  retryable: boolean;
  attempt: number;
  cause?: unknown;
}

export class HttpClientError extends Error {
  readonly code: HttpClientErrorCode;
  readonly requestId: string;
  readonly status?: number;
  readonly url: string;
  readonly method: string;
  readonly retryable: boolean;
  readonly attempt: number;

  constructor(options: HttpClientErrorOptions) {
    super(options.message);
    this.name = 'HttpClientError';
    this.code = options.code;
    this.requestId = options.requestId;
    this.status = options.status;
    this.url = options.url;
    this.method = options.method;
    this.retryable = options.retryable;
    this.attempt = options.attempt;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function isLikelyNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { name?: string }).name === 'AbortError') return false;

  const withCode = error as { code?: string };
  if (typeof withCode.code === 'string') {
    const code = withCode.code.toUpperCase();
    if (
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN'
    ) {
      return true;
    }
  }

  const message = String((error as { message?: string }).message || '').toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('socket') ||
    message.includes('econn') ||
    message.includes('timeout') ||
    message.includes('enotfound')
  );
}
